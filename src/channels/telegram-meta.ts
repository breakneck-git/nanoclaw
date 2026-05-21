import type { Message, MessageEntity, MessageOrigin } from 'grammy/types';
import { safeTruncate } from '../safe-truncate.js';

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
 * Task 8a scope: minimal skeleton — <m id date media_group_id edited>, <from> vs
 * <sender_chat> mutex. Full Bot API 7.0+ tag coverage lands in Tasks 8b-1/2/3.
 *
 * Invariant: EVERY attribute value passes through escapeXmlAttr — even numeric and
 * enum-safe values today, because Task 8b copy-paste will extend this pattern to
 * user-controlled strings (<media>, <location>, <contact>, <entities>) where any
 * unescaped interpolation would be an XML-injection foothold. escapeXmlAttr is a
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
    attrs.push(`snippet="${escapeXmlAttr(safeTruncate(snippetSource, 500))}"`);
  }
  return `<reply ${attrs.join(' ')}/>`;
}

/** Render external <reply external="1" .../> from message.external_reply.
 *  Task 8b-1 scope: opening tag + origin attributes only (self-closed).
 *  Tasks 8b-2/3 will extend to wrap nested media/contact/location/etc. payload. */
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
  return `<reply ${attrs.join(' ')}/>`;
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
  message: Message,
  extras: BuildMetaBlockExtras | undefined,
): string | null {
  if ('photo' in message && message.photo && message.photo.length > 0) {
    // PhotoSize[] is sorted ascending; the largest is what view_media will fetch.
    const largest = message.photo[message.photo.length - 1];
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
  if ('video' in message && message.video) {
    const v = message.video;
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
  if ('voice' in message && message.voice) {
    const v = message.voice;
    const attrs = [`type="voice"`, `file_id="${escapeXmlAttr(v.file_id)}"`];
    if (v.mime_type) attrs.push(`mime="${escapeXmlAttr(v.mime_type)}"`);
    if (v.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(v.file_unique_id)}"`);
    if (v.duration) attrs.push(`duration="${escapeXmlAttr(v.duration)}"`);
    if (v.file_size) attrs.push(`size="${escapeXmlAttr(v.file_size)}"`);
    appendTranscriptAttrs(attrs, extras);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('audio' in message && message.audio) {
    const a = message.audio;
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
  if ('document' in message && message.document) {
    const d = message.document;
    const attrs = [`type="document"`, `file_id="${escapeXmlAttr(d.file_id)}"`];
    if (d.mime_type) attrs.push(`mime="${escapeXmlAttr(d.mime_type)}"`);
    if (d.file_unique_id)
      attrs.push(`file_unique_id="${escapeXmlAttr(d.file_unique_id)}"`);
    if (d.file_name) attrs.push(`name="${escapeXmlAttr(d.file_name)}"`);
    if (d.file_size) attrs.push(`size="${escapeXmlAttr(d.file_size)}"`);
    return `<media ${attrs.join(' ')}/>`;
  }
  if ('sticker' in message && message.sticker) {
    const s = message.sticker;
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
  if ('animation' in message && message.animation) {
    const a = message.animation;
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
  if ('video_note' in message && message.video_note) {
    const vn = message.video_note;
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
    attrs.push(`transcript="${escapeXmlAttr(safeTruncate(t.text, 2000))}"`);
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
