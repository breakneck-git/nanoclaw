import type {
  Animation,
  Audio,
  Contact,
  Document,
  LinkPreviewOptions,
  Location,
  Message,
  MessageEntity,
  MessageOrigin,
  PhotoSize,
  Poll,
  Sticker,
  Story,
  User,
  Venue,
  Video,
  VideoNote,
  Voice,
} from 'grammy/types';
import { safeTruncate } from '../safe-truncate.js';

/**
 * Max code points for reply snippet text. Telegram truncates aggressively;
 * 500 keeps the snippet readable in agent context without consuming budget.
 */
const REPLY_SNIPPET_MAX_CODEPOINTS = 500;

/**
 * Max code points for voice / video_note transcripts. Truncating by code points
 * (not UTF-16 units) avoids splitting surrogate pairs — an orphan high surrogate
 * crashes Claude API JSON serialization with `no low surrogate in string`.
 */
const TRANSCRIPT_MAX_CODEPOINTS = 2000;

/**
 * Subset of Message/ExternalReplyInfo media fields. Both shapes have these as
 * optional fields with identical leaf types, so a single union lets buildMediaTag
 * accept either input without runtime change.
 */
type MediaHolder = {
  photo?: PhotoSize[];
  video?: Video;
  voice?: Voice;
  audio?: Audio;
  document?: Document;
  sticker?: Sticker;
  animation?: Animation;
  video_note?: VideoNote;
};

/**
 * Subset of Message/ExternalReplyInfo location fields. Venue takes precedence
 * over plain location (carries title + address). Both shapes have these as
 * optional fields with identical leaf types.
 */
type LocationHolder = {
  location?: Location;
  venue?: Venue;
};

export function escapeXmlAttr(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;') // MUST be first to avoid double-escape
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeXmlText(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Optional context the channel layer can pass to buildMetaBlock — populated
 * elsewhere (e.g. voice transcription pipeline in src/channels/telegram.ts).
 * Purely additive so existing callers that don't yet supply extras keep working.
 */
export interface BuildMetaBlockExtras {
  transcript?: {
    text?: string;
    status: 'ok' | 'failed' | 'missing_key' | 'skipped';
  };
}

/**
 * Build the structured <m>...</m> XML block from a Telegram Message.
 * Returns the raw block (no enclosing root). Caller stores in messages.meta column.
 *
 * Full Bot API 7.0+ tag coverage as of Task 8b-3:
 *   <m id date [media_group_id] [edited] [auto_fwd]>
 *     <from>|<sender_chat>   (mutex per spec line 193-194)
 *     [<fwd>]                (forward_origin discriminated union)
 *     [<reply external="0|1">]   (in-chat OR external_reply, in-chat wins)
 *     [<reply_to_story>]
 *     [<quote>]
 *     [<entities>...]
 *     [<media>]              (photo/video/voice/audio/document/sticker/animation/video_note mutex)
 *     [<contact>]
 *     [<location>]           (venue precedence over plain location)
 *     [<poll>]               (question + type only; options dropped per spec)
 *     [<story>]              (sent-story; distinct from reply_to_story above)
 *     [<via_bot>]
 *     [<link_preview>]       (emitted only when ≥1 LinkPreviewOptions field explicitly set)
 *   </m>
 *
 * Invariant: EVERY attribute value passes through escapeXmlAttr — even numeric and
 * enum-safe values, because user-controlled strings (<media>, <location>, <contact>,
 * <entities>) demand universal escaping to prevent XML injection. escapeXmlAttr is a
 * no-op on digits and ISO date strings, so the universal wrap is free.
 *
 * Note on <from name="..."> attribute: concatenates first_name + ' ' + last_name
 * when both present (matches typical agent prompt format). If last_name absent,
 * name = first_name alone.
 */
export function buildMetaBlock(
  message: Message,
  extras?: BuildMetaBlockExtras,
): string {
  const parts: string[] = [];
  const mAttrs: string[] = [`id="${escapeXmlAttr(message.message_id)}"`];
  mAttrs.push(
    `date="${escapeXmlAttr(new Date(message.date * 1000).toISOString())}"`,
  );
  if ('media_group_id' in message && message.media_group_id) {
    mAttrs.push(`media_group_id="${escapeXmlAttr(message.media_group_id)}"`);
  }
  if ('edit_date' in message && message.edit_date) {
    mAttrs.push(
      `edited="${escapeXmlAttr(new Date(message.edit_date * 1000).toISOString())}"`,
    );
  }
  if ('is_automatic_forward' in message && message.is_automatic_forward) {
    mAttrs.push(`auto_fwd="${escapeXmlAttr(1)}"`);
  }
  parts.push(`<m ${mAttrs.join(' ')}>`);

  // <from> vs <sender_chat> mutex per spec line 193-194
  if ('sender_chat' in message && message.sender_chat) {
    const sc = message.sender_chat;
    const scAttrs = [
      `id="${escapeXmlAttr(sc.id)}"`,
      `kind="${escapeXmlAttr(sc.type)}"`,
    ];
    if ('title' in sc && sc.title)
      scAttrs.push(`title="${escapeXmlAttr(sc.title)}"`);
    if ('username' in sc && sc.username)
      scAttrs.push(`un="${escapeXmlAttr(sc.username)}"`);
    parts.push(`<sender_chat ${scAttrs.join(' ')}/>`);
  } else if (message.from) {
    const f = message.from;
    const fAttrs = [
      `id="${escapeXmlAttr(f.id)}"`,
      `is_bot="${escapeXmlAttr(f.is_bot ? 1 : 0)}"`,
    ];
    if (f.username) fAttrs.push(`un="${escapeXmlAttr(f.username)}"`);
    if (f.first_name)
      fAttrs.push(
        `name="${escapeXmlAttr(f.first_name)}${f.last_name ? ' ' + escapeXmlAttr(f.last_name) : ''}"`,
      );
    if (f.is_premium) fAttrs.push(`premium="${escapeXmlAttr(1)}"`);
    if (f.language_code)
      fAttrs.push(`lang="${escapeXmlAttr(f.language_code)}"`);
    parts.push(`<from ${fAttrs.join(' ')}/>`);
  }

  // <fwd>: forwarded message origin (Bot API 7.0+)
  if ('forward_origin' in message && message.forward_origin) {
    parts.push(buildFwdTag(message.forward_origin));
  }

  // <reply>: in-chat reply (precedence) OR cross-chat external_reply.
  // Per Bot API both can coexist; in-chat wins.
  if ('reply_to_message' in message && message.reply_to_message) {
    parts.push(buildInChatReplyTag(message.reply_to_message));
  } else if ('external_reply' in message && message.external_reply) {
    parts.push(buildExternalReplyTag(message.external_reply));
  }

  // <reply_to_story>: top-level sibling of <reply>, NOT nested
  if ('reply_to_story' in message && message.reply_to_story) {
    const rts = message.reply_to_story;
    parts.push(
      `<reply_to_story chat_id="${escapeXmlAttr(rts.chat.id)}" story_id="${escapeXmlAttr(rts.id)}"/>`,
    );
  }

  // <quote>: user-selected quote substring (Bot API 7.0+)
  if ('quote' in message && message.quote) {
    parts.push(`<quote>${escapeXmlText(message.quote.text)}</quote>`);
  }

  // <entities>: union of message.entities + message.caption_entities, deduped
  const entitiesText: string =
    ('text' in message && typeof message.text === 'string'
      ? message.text
      : undefined) ??
    ('caption' in message && typeof message.caption === 'string'
      ? message.caption
      : undefined) ??
    '';
  const entityChildren = buildEntityChildren(
    [
      ...(('entities' in message && message.entities) || []),
      ...(('caption_entities' in message && message.caption_entities) || []),
    ],
    entitiesText,
  );
  if (entityChildren.length > 0) {
    parts.push(`<entities>${entityChildren.join('')}</entities>`);
  }

  // <media>: photo/video/voice/audio/document/sticker/animation/video_note
  // (mutex — Telegram sets at most one of these per message).
  const mediaTag = buildMediaTag(message, extras);
  if (mediaTag) parts.push(mediaTag);

  // <contact>: phone contact attachment
  if ('contact' in message && message.contact) {
    parts.push(buildContactTag(message.contact));
  }

  // <location>: venue wins over plain location (venue carries title + address)
  const locationTag = buildLocationTag(message);
  if (locationTag) parts.push(locationTag);

  // <poll>: question + type only, options dropped
  if ('poll' in message && message.poll) {
    parts.push(buildPollTag(message.poll));
  }

  // <story>: a sent/shared story (NOT reply_to_story — that's already above)
  if ('story' in message && message.story) {
    parts.push(buildStoryTag(message.story));
  }

  // <via_bot>: inline-mode bot the message was sent through
  if ('via_bot' in message && message.via_bot) {
    parts.push(buildViaBotTag(message.via_bot));
  }

  // <link_preview>: emitted ONLY when ≥1 field explicitly set on link_preview_options
  if ('link_preview_options' in message && message.link_preview_options) {
    const lp = buildLinkPreviewTag(message.link_preview_options);
    if (lp) parts.push(lp);
  }

  parts.push(`</m>`);
  return parts.join('');
}

/** Render <fwd kind="..."/> from a MessageOrigin discriminator.
 *  Each known-case branch computes orig_date locally — hoisting it above the
 *  switch would crash with `RangeError: Invalid time value` on a future
 *  unknown origin type that lacks `date`, defeating the default branch's intent. */
function buildFwdTag(origin: MessageOrigin): string {
  switch (origin.type) {
    case 'user': {
      const orig_date = new Date(origin.date * 1000).toISOString();
      const u = origin.sender_user;
      const attrs = [
        `kind="user"`,
        `id="${escapeXmlAttr(u.id)}"`,
        `is_bot="${escapeXmlAttr(u.is_bot ? 1 : 0)}"`,
      ];
      if (u.username) attrs.push(`un="${escapeXmlAttr(u.username)}"`);
      if (u.first_name)
        attrs.push(
          `name="${escapeXmlAttr(u.first_name)}${u.last_name ? ' ' + escapeXmlAttr(u.last_name) : ''}"`,
        );
      attrs.push(`orig_date="${escapeXmlAttr(orig_date)}"`);
      return `<fwd ${attrs.join(' ')}/>`;
    }
    case 'hidden_user': {
      const orig_date = new Date(origin.date * 1000).toISOString();
      return `<fwd kind="hidden_user" sig="${escapeXmlAttr(origin.sender_user_name)}" orig_date="${escapeXmlAttr(orig_date)}"/>`;
    }
    case 'chat': {
      const orig_date = new Date(origin.date * 1000).toISOString();
      const sc = origin.sender_chat;
      const attrs = [`kind="chat"`, `chat_id="${escapeXmlAttr(sc.id)}"`];
      if ('username' in sc && sc.username)
        attrs.push(`un="${escapeXmlAttr(sc.username)}"`);
      if ('title' in sc && sc.title)
        attrs.push(`title="${escapeXmlAttr(sc.title)}"`);
      if (origin.author_signature)
        attrs.push(`sig="${escapeXmlAttr(origin.author_signature)}"`);
      attrs.push(`orig_date="${escapeXmlAttr(orig_date)}"`);
      return `<fwd ${attrs.join(' ')}/>`;
    }
    case 'channel': {
      const orig_date = new Date(origin.date * 1000).toISOString();
      const ch = origin.chat;
      const attrs = [`kind="channel"`, `chat_id="${escapeXmlAttr(ch.id)}"`];
      if (ch.username) attrs.push(`un="${escapeXmlAttr(ch.username)}"`);
      if (ch.title) attrs.push(`title="${escapeXmlAttr(ch.title)}"`);
      if (origin.author_signature)
        attrs.push(`sig="${escapeXmlAttr(origin.author_signature)}"`);
      attrs.push(`orig_date="${escapeXmlAttr(orig_date)}"`);
      attrs.push(`orig_msg_id="${escapeXmlAttr(origin.message_id)}"`);
      if (ch.username) {
        attrs.push(
          `link="${escapeXmlAttr(`https://t.me/${ch.username}/${origin.message_id}`)}"`,
        );
      }
      return `<fwd ${attrs.join(' ')}/>`;
    }
    default: {
      // Future Bot API origin types — capture verbatim.
      return `<fwd kind="unknown" raw="${escapeXmlAttr(JSON.stringify(origin))}"/>`;
    }
  }
}

/** Render in-chat <reply external="0" .../> from message.reply_to_message. */
function buildInChatReplyTag(
  reply: NonNullable<Message['reply_to_message']>,
): string {
  const attrs = [`external="0"`, `mid="${escapeXmlAttr(reply.message_id)}"`];
  if (reply.from) {
    const f = reply.from;
    attrs.push(`from_id="${escapeXmlAttr(f.id)}"`);
    if (f.username) attrs.push(`un="${escapeXmlAttr(f.username)}"`);
    if (f.first_name)
      attrs.push(
        `name="${escapeXmlAttr(f.first_name)}${f.last_name ? ' ' + escapeXmlAttr(f.last_name) : ''}"`,
      );
    attrs.push(`is_bot="${escapeXmlAttr(f.is_bot ? 1 : 0)}"`);
  }
  const snippetSource: string =
    ('text' in reply && typeof reply.text === 'string'
      ? reply.text
      : undefined) ??
    ('caption' in reply && typeof reply.caption === 'string'
      ? reply.caption
      : undefined) ??
    '';
  if (snippetSource) {
    attrs.push(
      `snippet="${escapeXmlAttr(safeTruncate(snippetSource, REPLY_SNIPPET_MAX_CODEPOINTS))}"`,
    );
  }
  return `<reply ${attrs.join(' ')}/>`;
}

/** Render external <reply external="1" .../> from message.external_reply.
 *  Emits origin attributes + nested payload tags (media/contact/location/poll/story/link_preview).
 *  When no payload fields are set, emits self-closed form. */
function buildExternalReplyTag(
  reply: NonNullable<Message['external_reply']>,
): string {
  const attrs: string[] = [`external="1"`];
  const origin = reply.origin;
  // orig_date computed per-case so a future unknown origin without `date`
  // does not crash with RangeError before the default branch is reached.
  switch (origin.type) {
    case 'user': {
      const orig_date = new Date(origin.date * 1000).toISOString();
      const u = origin.sender_user;
      attrs.push(`kind="user"`);
      attrs.push(`id="${escapeXmlAttr(u.id)}"`);
      if (u.username) attrs.push(`un="${escapeXmlAttr(u.username)}"`);
      if (u.first_name)
        attrs.push(
          `name="${escapeXmlAttr(u.first_name)}${u.last_name ? ' ' + escapeXmlAttr(u.last_name) : ''}"`,
        );
      attrs.push(`is_bot="${escapeXmlAttr(u.is_bot ? 1 : 0)}"`);
      attrs.push(`orig_date="${escapeXmlAttr(orig_date)}"`);
      break;
    }
    case 'hidden_user': {
      const orig_date = new Date(origin.date * 1000).toISOString();
      attrs.push(`kind="hidden_user"`);
      attrs.push(`sig="${escapeXmlAttr(origin.sender_user_name)}"`);
      attrs.push(`orig_date="${escapeXmlAttr(orig_date)}"`);
      break;
    }
    case 'chat': {
      const orig_date = new Date(origin.date * 1000).toISOString();
      const sc = origin.sender_chat;
      attrs.push(`kind="chat"`);
      attrs.push(`chat_id="${escapeXmlAttr(sc.id)}"`);
      if ('username' in sc && sc.username)
        attrs.push(`un="${escapeXmlAttr(sc.username)}"`);
      if ('title' in sc && sc.title)
        attrs.push(`title="${escapeXmlAttr(sc.title)}"`);
      if (origin.author_signature)
        attrs.push(`sig="${escapeXmlAttr(origin.author_signature)}"`);
      attrs.push(`orig_date="${escapeXmlAttr(orig_date)}"`);
      break;
    }
    case 'channel': {
      const orig_date = new Date(origin.date * 1000).toISOString();
      const ch = origin.chat;
      attrs.push(`kind="channel"`);
      attrs.push(`chat_id="${escapeXmlAttr(ch.id)}"`);
      if (ch.username) attrs.push(`un="${escapeXmlAttr(ch.username)}"`);
      if (ch.title) attrs.push(`title="${escapeXmlAttr(ch.title)}"`);
      if (origin.author_signature)
        attrs.push(`sig="${escapeXmlAttr(origin.author_signature)}"`);
      attrs.push(`orig_date="${escapeXmlAttr(orig_date)}"`);
      attrs.push(`orig_msg_id="${escapeXmlAttr(origin.message_id)}"`);
      if (ch.username) {
        attrs.push(
          `link="${escapeXmlAttr(`https://t.me/${ch.username}/${origin.message_id}`)}"`,
        );
      }
      break;
    }
    default: {
      attrs.push(`kind="unknown"`);
      attrs.push(`raw="${escapeXmlAttr(JSON.stringify(origin))}"`);
      break;
    }
  }

  // Nested payload tags — spec line 196 (origin attrs + ALL payload tags).
  // Voice/video_note transcripts are not currently surfaced for external replies
  // (the transcription pipeline only fires on the inbound message), so the
  // second arg to buildMediaTag is undefined.
  const childParts: string[] = [];
  const mediaTag = buildMediaTag(reply, undefined);
  if (mediaTag) childParts.push(mediaTag);
  if (reply.contact) childParts.push(buildContactTag(reply.contact));
  const locationTag = buildLocationTag(reply);
  if (locationTag) childParts.push(locationTag);
  if (reply.poll) childParts.push(buildPollTag(reply.poll));
  if (reply.story) childParts.push(buildStoryTag(reply.story));
  if (reply.link_preview_options) {
    const lp = buildLinkPreviewTag(reply.link_preview_options);
    if (lp) childParts.push(lp);
  }

  if (childParts.length === 0) {
    // Preserve self-closed form when no payload — backward compat with Task 8b-1.
    return `<reply ${attrs.join(' ')}/>`;
  }
  return `<reply ${attrs.join(' ')}>${childParts.join('')}</reply>`;
}

/**
 * Render <media .../> for whichever single media field is set on the message
 * (Telegram populates at most one). Returns null when no media is present so the
 * caller can skip emission entirely (spec line 188 — omit empty tags).
 *
 * Sticker mime cascade (spec line 199, priority order, first match wins):
 *   1. is_animated === true  → application/x-tgsticker
 *   2. is_video === true     → video/webm
 *   3. else                  → image/webp
 * sticker_kind is orthogonal to mime — both emitted from sticker.type ∈
 * {regular, mask, custom_emoji}. Photos synthesize image/jpeg (Telegram never
 * reports a mime for photos).
 *
 * Voice and video_note pull transcript text + status from `extras.transcript`
 * — populated by the channel layer's transcription pipeline (Task 10 wiring).
 * Transcript text is safeTruncate'd to 2000 code points so surrogate pairs
 * survive the boundary cut (orphan high surrogates poison Claude API requests).
 */
function buildMediaTag(
  holder: MediaHolder,
  extras: BuildMetaBlockExtras | undefined,
): string | null {
  if ('photo' in holder && holder.photo && holder.photo.length > 0) {
    // PhotoSize[] is sorted ascending; the largest is what view_media will fetch.
    const largest = holder.photo[holder.photo.length - 1];
    const attrs = [
      `type="photo"`,
      `file_id="${escapeXmlAttr(largest.file_id)}"`,
      `mime="image/jpeg"`,
    ];
    if (largest.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(largest.file_unique_id)}"`);
    if (largest.width) attrs.push(`w="${escapeXmlAttr(largest.width)}"`);
    if (largest.height) attrs.push(`h="${escapeXmlAttr(largest.height)}"`);
    if (largest.file_size)
      attrs.push(`size="${escapeXmlAttr(largest.file_size)}"`);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('video' in holder && holder.video) {
    const v = holder.video;
    const attrs = [`type="video"`, `file_id="${escapeXmlAttr(v.file_id)}"`];
    if (v.mime_type) attrs.push(`mime="${escapeXmlAttr(v.mime_type)}"`);
    if (v.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(v.file_unique_id)}"`);
    if (v.width) attrs.push(`w="${escapeXmlAttr(v.width)}"`);
    if (v.height) attrs.push(`h="${escapeXmlAttr(v.height)}"`);
    if (v.duration) attrs.push(`duration="${escapeXmlAttr(v.duration)}"`);
    if (v.file_size) attrs.push(`size="${escapeXmlAttr(v.file_size)}"`);
    if (v.file_name) attrs.push(`name="${escapeXmlAttr(v.file_name)}"`);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('voice' in holder && holder.voice) {
    const v = holder.voice;
    const attrs = [`type="voice"`, `file_id="${escapeXmlAttr(v.file_id)}"`];
    if (v.mime_type) attrs.push(`mime="${escapeXmlAttr(v.mime_type)}"`);
    if (v.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(v.file_unique_id)}"`);
    if (v.duration) attrs.push(`duration="${escapeXmlAttr(v.duration)}"`);
    if (v.file_size) attrs.push(`size="${escapeXmlAttr(v.file_size)}"`);
    appendTranscriptAttrs(attrs, extras);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('audio' in holder && holder.audio) {
    const a = holder.audio;
    const attrs = [`type="audio"`, `file_id="${escapeXmlAttr(a.file_id)}"`];
    if (a.mime_type) attrs.push(`mime="${escapeXmlAttr(a.mime_type)}"`);
    if (a.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(a.file_unique_id)}"`);
    if (a.duration) attrs.push(`duration="${escapeXmlAttr(a.duration)}"`);
    if (a.file_size) attrs.push(`size="${escapeXmlAttr(a.file_size)}"`);
    if (a.title) attrs.push(`title="${escapeXmlAttr(a.title)}"`);
    if (a.performer) attrs.push(`performer="${escapeXmlAttr(a.performer)}"`);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('document' in holder && holder.document) {
    const d = holder.document;
    const attrs = [`type="document"`, `file_id="${escapeXmlAttr(d.file_id)}"`];
    if (d.mime_type) attrs.push(`mime="${escapeXmlAttr(d.mime_type)}"`);
    if (d.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(d.file_unique_id)}"`);
    if (d.file_name) attrs.push(`name="${escapeXmlAttr(d.file_name)}"`);
    if (d.file_size) attrs.push(`size="${escapeXmlAttr(d.file_size)}"`);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('sticker' in holder && holder.sticker) {
    const s = holder.sticker;
    // Mime cascade — DO NOT trust s.mime_type / sticker doesn't reliably set it.
    // Priority is fixed per spec; first truthy flag wins.
    const mime = s.is_animated
      ? 'application/x-tgsticker'
      : s.is_video
        ? 'video/webm'
        : 'image/webp';
    const attrs = [
      `type="sticker"`,
      `file_id="${escapeXmlAttr(s.file_id)}"`,
      `mime="${escapeXmlAttr(mime)}"`,
      `sticker_kind="${escapeXmlAttr(s.type)}"`,
    ];
    if (s.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(s.file_unique_id)}"`);
    if (s.width) attrs.push(`w="${escapeXmlAttr(s.width)}"`);
    if (s.height) attrs.push(`h="${escapeXmlAttr(s.height)}"`);
    if (s.emoji) attrs.push(`emoji="${escapeXmlAttr(s.emoji)}"`);
    if (s.set_name) attrs.push(`set_name="${escapeXmlAttr(s.set_name)}"`);
    if (s.file_size) attrs.push(`size="${escapeXmlAttr(s.file_size)}"`);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('animation' in holder && holder.animation) {
    const a = holder.animation;
    const attrs = [`type="animation"`, `file_id="${escapeXmlAttr(a.file_id)}"`];
    if (a.mime_type) attrs.push(`mime="${escapeXmlAttr(a.mime_type)}"`);
    if (a.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(a.file_unique_id)}"`);
    if (a.width) attrs.push(`w="${escapeXmlAttr(a.width)}"`);
    if (a.height) attrs.push(`h="${escapeXmlAttr(a.height)}"`);
    if (a.duration) attrs.push(`duration="${escapeXmlAttr(a.duration)}"`);
    if (a.file_size) attrs.push(`size="${escapeXmlAttr(a.file_size)}"`);
    if (a.file_name) attrs.push(`name="${escapeXmlAttr(a.file_name)}"`);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('video_note' in holder && holder.video_note) {
    const vn = holder.video_note;
    const attrs = [
      `type="video_note"`,
      `file_id="${escapeXmlAttr(vn.file_id)}"`,
    ];
    // video_note has no mime_type field in Bot API — intentionally absent here.
    if (vn.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(vn.file_unique_id)}"`);
    if (vn.length) attrs.push(`length="${escapeXmlAttr(vn.length)}"`);
    if (vn.duration) attrs.push(`duration="${escapeXmlAttr(vn.duration)}"`);
    if (vn.file_size) attrs.push(`size="${escapeXmlAttr(vn.file_size)}"`);
    appendTranscriptAttrs(attrs, extras);
    return `<media ${attrs.join(' ')}/>`;
  }
  return null;
}

/** Append transcript_status (always when extras.transcript set) and transcript
 *  text (only when status === 'ok' AND text is non-empty). Text passes through
 *  safeTruncate(2000) so a 🐬 at the boundary isn't split into an orphan high
 *  surrogate that crashes Claude API JSON-serialization downstream. */
function appendTranscriptAttrs(
  attrs: string[],
  extras: BuildMetaBlockExtras | undefined,
): void {
  if (!extras?.transcript) return;
  const t = extras.transcript;
  attrs.push(`transcript_status="${escapeXmlAttr(t.status)}"`);
  if (t.status === 'ok' && t.text) {
    attrs.push(
      `transcript="${escapeXmlAttr(safeTruncate(t.text, TRANSCRIPT_MAX_CODEPOINTS))}"`,
    );
  }
}

/**
 * Build entity child XML strings from MessageEntity[] + source text.
 * Drops formatting entities (bold/italic/code/etc.) and dedupes by (offset,length,type).
 * Returns empty array when nothing survives filtering — caller skips <entities> wrapper.
 */
function buildEntityChildren(
  entities: MessageEntity[],
  text: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entities) {
    const key = `${e.type}:${e.offset}:${e.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tag = renderEntity(e, text);
    if (tag) out.push(tag);
  }
  return out;
}

/** Render a single entity tag. Returns empty string for formatting entities (dropped). */
function renderEntity(e: MessageEntity, text: string): string {
  const fullSlice = text.slice(e.offset, e.offset + e.length);
  switch (e.type) {
    case 'url':
      return `<url>${escapeXmlText(fullSlice)}</url>`;
    case 'mention':
      // Strip leading '@'
      return `<mention>${escapeXmlText(fullSlice.startsWith('@') ? fullSlice.slice(1) : fullSlice)}</mention>`;
    case 'hashtag':
      return `<hashtag>${escapeXmlText(fullSlice.startsWith('#') ? fullSlice.slice(1) : fullSlice)}</hashtag>`;
    case 'cashtag':
      return `<cashtag>${escapeXmlText(fullSlice.startsWith('$') ? fullSlice.slice(1) : fullSlice)}</cashtag>`;
    case 'bot_command':
      return `<bot_command>${escapeXmlText(fullSlice)}</bot_command>`;
    case 'phone_number':
      return `<phone_number>${escapeXmlText(fullSlice)}</phone_number>`;
    case 'email':
      return `<email>${escapeXmlText(fullSlice)}</email>`;
    case 'text_link':
      return `<text_link href="${escapeXmlAttr(e.url)}">${escapeXmlText(fullSlice)}</text_link>`;
    case 'text_mention': {
      const u = e.user;
      const attrs: string[] = [`id="${escapeXmlAttr(u.id)}"`];
      if (u.username) attrs.push(`un="${escapeXmlAttr(u.username)}"`);
      if (u.first_name)
        attrs.push(
          `name="${escapeXmlAttr(u.first_name)}${u.last_name ? ' ' + escapeXmlAttr(u.last_name) : ''}"`,
        );
      attrs.push(`is_bot="${escapeXmlAttr(u.is_bot ? 1 : 0)}"`);
      return `<text_mention ${attrs.join(' ')}/>`;
    }
    case 'custom_emoji':
      return `<custom_emoji id="${escapeXmlAttr(e.custom_emoji_id)}"/>`;
    // Formatting entities — explicitly dropped per spec
    case 'bold':
    case 'italic':
    case 'underline':
    case 'strikethrough':
    case 'spoiler':
    case 'code':
    case 'pre':
    case 'blockquote':
    case 'expandable_blockquote':
      return '';
    default:
      return '';
  }
}

/** Render <contact phone="..." name="..." user_id="..." vcard_raw="..."/>.
 *  Only phone + name are guaranteed; user_id and vcard are optional per Bot API. */
function buildContactTag(contact: Contact): string {
  const attrs: string[] = [`phone="${escapeXmlAttr(contact.phone_number)}"`];
  if (contact.first_name) {
    attrs.push(
      `name="${escapeXmlAttr(contact.first_name)}${contact.last_name ? ' ' + escapeXmlAttr(contact.last_name) : ''}"`,
    );
  }
  if (contact.user_id)
    attrs.push(`user_id="${escapeXmlAttr(contact.user_id)}"`);
  if (contact.vcard) attrs.push(`vcard_raw="${escapeXmlAttr(contact.vcard)}"`);
  return `<contact ${attrs.join(' ')}/>`;
}

/** Render <location/> from holder.venue (preferred — title+address present) or
 *  holder.location (lat/lon only). Returns null when neither is set. Accepts
 *  either Message or ExternalReplyInfo via LocationHolder union. */
function buildLocationTag(holder: LocationHolder): string | null {
  if ('venue' in holder && holder.venue) {
    const v = holder.venue;
    const attrs = [
      `lat="${escapeXmlAttr(v.location.latitude)}"`,
      `lon="${escapeXmlAttr(v.location.longitude)}"`,
      `title="${escapeXmlAttr(v.title)}"`,
      `address="${escapeXmlAttr(v.address)}"`,
    ];
    return `<location ${attrs.join(' ')}/>`;
  }
  if ('location' in holder && holder.location) {
    const l = holder.location;
    const attrs = [
      `lat="${escapeXmlAttr(l.latitude)}"`,
      `lon="${escapeXmlAttr(l.longitude)}"`,
    ];
    return `<location ${attrs.join(' ')}/>`;
  }
  return null;
}

/** Render <poll question="..." type="regular|quiz"/>. Options are intentionally
 *  dropped per spec — only metadata survives. */
function buildPollTag(poll: Poll): string {
  const attrs = [
    `question="${escapeXmlAttr(poll.question)}"`,
    `type="${escapeXmlAttr(poll.type)}"`,
  ];
  return `<poll ${attrs.join(' ')}/>`;
}

/** Render <story chat_id="..." story_id="..."/> from message.story. */
function buildStoryTag(story: Story): string {
  return `<story chat_id="${escapeXmlAttr(story.chat.id)}" story_id="${escapeXmlAttr(story.id)}"/>`;
}

/** Render <via_bot id="..." un="..." name="..."/>. Skips is_bot (always true by
 *  definition for via_bot — redundant). */
function buildViaBotTag(via_bot: User): string {
  const attrs: string[] = [`id="${escapeXmlAttr(via_bot.id)}"`];
  if (via_bot.username) attrs.push(`un="${escapeXmlAttr(via_bot.username)}"`);
  if (via_bot.first_name)
    attrs.push(
      `name="${escapeXmlAttr(via_bot.first_name)}${via_bot.last_name ? ' ' + escapeXmlAttr(via_bot.last_name) : ''}"`,
    );
  return `<via_bot ${attrs.join(' ')}/>`;
}

/** Render <link_preview .../> from message.link_preview_options. Returns null
 *  when none of {is_disabled, url, prefer_small_media, prefer_large_media,
 *  show_above_text} is explicitly set — spec line 207 round-10 disambiguation.
 *  An empty {} (e.g. default preview metadata stripped by Telegram) MUST NOT
 *  emit a tag. */
function buildLinkPreviewTag(opt: LinkPreviewOptions): string | null {
  const hasAnyField =
    opt.is_disabled !== undefined ||
    opt.url !== undefined ||
    opt.prefer_small_media !== undefined ||
    opt.prefer_large_media !== undefined ||
    opt.show_above_text !== undefined;
  if (!hasAnyField) return null;
  const attrs: string[] = [];
  if (opt.url) attrs.push(`url="${escapeXmlAttr(opt.url)}"`);
  if (opt.is_disabled) attrs.push(`disabled="${escapeXmlAttr(1)}"`);
  if (opt.show_above_text) attrs.push(`above_text="${escapeXmlAttr(1)}"`);
  if (opt.prefer_small_media) attrs.push(`small="${escapeXmlAttr(1)}"`);
  if (opt.prefer_large_media) attrs.push(`large="${escapeXmlAttr(1)}"`);
  // Predicate above guarantees ≥1 field set, but all five could be `false` /
  // empty-string — in that case the predicate fires but no boolean attribute
  // value triggers an `if (x)` push. Emit a tag without attributes still — it
  // signals "preview metadata present but all-false", which is informationally
  // distinct from no metadata at all.
  return attrs.length > 0
    ? `<link_preview ${attrs.join(' ')}/>`
    : `<link_preview/>`;
}
