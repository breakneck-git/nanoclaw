import https from 'https';
import http from 'http';
import FormData from 'form-data';
import { Api, Bot, type Context } from 'grammy';
import type { Message } from 'grammy/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import {
  upsertContact,
  promoteContactIdent,
  isFirstInboundInTopic,
} from '../db.js';
import { generateTopicTitle } from '../topic-naming.js';
import { titleFromMessage } from '../topic-titler.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from '../sender-allowlist.js';
import { queueEnrich } from './telegram-enrich.js';
import { buildMetaBlock, type BuildMetaBlockExtras } from './telegram-meta.js';

/**
 * Test-only re-export at module scope so tests can drive the contact pipeline
 * without instantiating a Bot. Delegates to the private implementation below.
 */
export function _testProcessContactsFromContext(
  ctx: Context,
  scope: string,
): void {
  return processContactsFromContext(ctx, scope);
}

/**
 * Test-only re-export of the `botSenderId` accessor. Mirrors the instance
 * method's logic with no this-binding, so tests can pass a minimal `{ bot }`
 * shim without constructing a TelegramChannel.
 */
export function _testBotSenderId(self: {
  bot: { botInfo?: { id: number } } | null;
}): string | undefined {
  return self.bot?.botInfo?.id ? String(self.bot.botInfo.id) : undefined;
}

/**
 * Walk a grammy `Context` for every channel that may carry a contact identity
 * (sender, forward, reply, vCard, text-mention, bare @mention) and persist
 * each one via `upsertContact`/`promoteContactIdent`/`queueEnrich`.
 *
 * Called per inbound update (all 4 wired kinds — `message`, `edited_message`,
 * `channel_post`, `edited_channel_post`) BEFORE `onMessage` delivers the
 * NewMessage to the orchestrator. Uses `ctx.msg` — grammy's omnibus accessor
 * (Context.d.ts:222-227) — to handle every wired update kind uniformly.
 *
 * `scope` is the per-group contact namespace (`group.folder` for ordinary
 * groups, `'main'` for the main control group, mirroring the
 * isMain-precedent at `src/container-runner.ts:884`). All seven triggers
 * receive the same scope.
 *
 * Module-scope (NOT a `TelegramChannel` method) because the test-only
 * re-export above needs to import it from module scope, and the function
 * itself is pure (no `this` access — every dependency comes through `ctx`).
 */
function processContactsFromContext(ctx: Context, scope: string): void {
  const msg = ctx.msg;
  if (!msg) return;

  // Trigger 1: sender. `sender_chat` and `from` are mutually exclusive per
  // spec line 193-194 — when `sender_chat` is set (e.g. anonymous group
  // admin), `from` carries the placeholder GroupAnonymousBot and must be
  // skipped to avoid spurious upserts.
  if (msg.sender_chat) {
    const sc = msg.sender_chat;
    upsertContact(
      scope,
      {
        kind: sc.type === 'channel' ? 'channel' : 'chat',
        title: 'title' in sc ? sc.title : null,
        is_bot: 0,
      },
      {
        identity: {
          tg_id: String(sc.id),
          username: 'username' in sc ? (sc.username ?? undefined) : undefined,
        },
        source: 'sender',
      },
    );
  } else if (msg.from) {
    // Promote-then-upsert ordering: if a |un: row exists for this user,
    // merge it into the |id: row first so the subsequent upsert lands on
    // the merged identity (matches `promoteContactIdent` contract).
    if (msg.from.username) {
      promoteContactIdent(scope, msg.from.username, String(msg.from.id));
    }
    upsertContact(
      scope,
      {
        kind: 'user',
        first_name: msg.from.first_name ?? null,
        last_name: msg.from.last_name ?? null,
        is_bot: msg.from.is_bot ? 1 : 0,
      },
      {
        identity: {
          tg_id: String(msg.from.id),
          username: msg.from.username ?? undefined,
        },
        source: 'sender',
      },
    );
  }

  // Trigger 2: forward_origin (Bot API 7.0+ discriminated union).
  if (msg.forward_origin) {
    const o = msg.forward_origin;
    if (o.type === 'user') {
      const u = o.sender_user;
      if (u.username) promoteContactIdent(scope, u.username, String(u.id));
      upsertContact(
        scope,
        {
          kind: 'user',
          first_name: u.first_name ?? null,
          last_name: u.last_name ?? null,
          is_bot: u.is_bot ? 1 : 0,
        },
        {
          identity: {
            tg_id: String(u.id),
            username: u.username ?? undefined,
          },
          source: 'forward',
        },
      );
    } else if (o.type === 'chat') {
      const c = o.sender_chat;
      upsertContact(
        scope,
        {
          kind: c.type === 'channel' ? 'channel' : 'chat',
          title: 'title' in c ? c.title : null,
          is_bot: 0,
        },
        {
          identity: {
            tg_id: String(c.id),
            username: 'username' in c ? (c.username ?? undefined) : undefined,
          },
          source: 'forward',
        },
      );
    } else if (o.type === 'channel') {
      const c = o.chat;
      // Channel forward → message link is derivable when the channel is
      // public (has a `username`). Private channels (no username) omit `link`.
      const link = c.username
        ? `https://t.me/${c.username}/${o.message_id}`
        : null;
      upsertContact(
        scope,
        {
          kind: 'channel',
          title: c.title,
          link,
          is_bot: 0,
        },
        {
          identity: {
            tg_id: String(c.id),
            username: c.username ?? undefined,
          },
          source: 'forward',
        },
      );
    }
    // o.type === 'hidden_user' → only `sender_user_name` (string) is
    // available, no identity column can be derived → skip.
  }

  // Trigger 3a: in-chat reply author.
  if (msg.reply_to_message?.from) {
    const u = msg.reply_to_message.from;
    if (u.username) promoteContactIdent(scope, u.username, String(u.id));
    upsertContact(
      scope,
      {
        kind: 'user',
        first_name: u.first_name ?? null,
        last_name: u.last_name ?? null,
        is_bot: u.is_bot ? 1 : 0,
      },
      {
        identity: {
          tg_id: String(u.id),
          username: u.username ?? undefined,
        },
        source: 'reply',
      },
    );
  }

  // Trigger 3b: cross-chat external_reply origin author.
  if (msg.external_reply?.origin) {
    const o = msg.external_reply.origin;
    if (o.type === 'user') {
      const u = o.sender_user;
      if (u.username) promoteContactIdent(scope, u.username, String(u.id));
      upsertContact(
        scope,
        {
          kind: 'user',
          first_name: u.first_name ?? null,
          last_name: u.last_name ?? null,
          is_bot: u.is_bot ? 1 : 0,
        },
        {
          identity: {
            tg_id: String(u.id),
            username: u.username ?? undefined,
          },
          source: 'reply',
        },
      );
    } else if (o.type === 'chat') {
      const c = o.sender_chat;
      upsertContact(
        scope,
        {
          kind: c.type === 'channel' ? 'channel' : 'chat',
          title: 'title' in c ? c.title : null,
          is_bot: 0,
        },
        {
          identity: {
            tg_id: String(c.id),
            username: 'username' in c ? (c.username ?? undefined) : undefined,
          },
          source: 'reply',
        },
      );
    } else if (o.type === 'channel') {
      const c = o.chat;
      upsertContact(
        scope,
        {
          kind: 'channel',
          title: c.title,
          is_bot: 0,
        },
        {
          identity: {
            tg_id: String(c.id),
            username: c.username ?? undefined,
          },
          source: 'reply',
        },
      );
    }
    // o.type === 'hidden_user' → no identity → skip (same as trigger 2).
  }

  // Trigger 4: vCard / shared phone contact.
  if (msg.contact) {
    const c = msg.contact;
    upsertContact(
      scope,
      {
        kind: 'user',
        first_name: c.first_name ?? null,
        last_name: c.last_name ?? null,
        phone: c.phone_number ?? null,
        is_bot: 0,
      },
      {
        // `user_id` only present when the contact is a registered Telegram
        // user. Otherwise fall back to a name-based ident.
        identity: c.user_id
          ? { tg_id: String(c.user_id) }
          : { name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() },
        source: 'vcard',
      },
    );
  }

  // Trigger 5 + 6: walk entities + caption_entities for typed mentions.
  const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])];
  for (const e of entities) {
    if (e.type === 'text_mention') {
      const u = e.user;
      if (u.username) promoteContactIdent(scope, u.username, String(u.id));
      upsertContact(
        scope,
        {
          kind: 'user',
          first_name: u.first_name ?? null,
          last_name: u.last_name ?? null,
          is_bot: u.is_bot ? 1 : 0,
        },
        {
          identity: {
            tg_id: String(u.id),
            username: u.username ?? undefined,
          },
          source: 'text_mention',
        },
      );
    }
  }
  // Bare `@username` mentions don't carry a User payload — we only know the
  // string. Queue an enrich via getChat (rate-limited, cached).
  const text = msg.text ?? msg.caption ?? '';
  for (const e of entities) {
    if (e.type === 'mention') {
      // Strip the leading '@' — entity slice is `@username`.
      const username = text.slice(e.offset + 1, e.offset + e.length);
      if (username) queueEnrich(scope, username);
    }
  }
}

async function downloadTelegramFile(
  botToken: string,
  fileId: string,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const filePath = json.result?.file_path;
            if (!filePath) return resolve(null);

            https
              .get(
                `https://api.telegram.org/file/bot${botToken}/${filePath}`,
                (fileRes) => {
                  const chunks: Buffer[] = [];
                  fileRes.on('data', (c) => chunks.push(c));
                  fileRes.on('end', () => resolve(Buffer.concat(chunks)));
                  fileRes.on('error', () => resolve(null));
                },
              )
              .on('error', () => resolve(null));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
  });
}

async function transcribeWithGroq(
  audioBuffer: Buffer,
  groqApiKey: string,
): Promise<string | null> {
  const form = new FormData();
  form.append('file', audioBuffer, {
    filename: 'voice.ogg',
    contentType: 'audio/ogg',
  });
  form.append('model', 'whisper-large-v3-turbo');

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${groqApiKey}`,
          ...form.getHeaders(),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.text || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    form.pipe(req);
  });
}

/**
 * Build a "[Reply to Name: "quote"]" prefix from the replied-to message.
 * Covers text, caption, and non-text media stubs.
 */
function replyContext(replyMsg: Message | undefined): string {
  if (!replyMsg) return '';
  const name =
    replyMsg.from?.first_name ||
    replyMsg.from?.username ||
    (replyMsg.from?.id ? replyMsg.from.id.toString() : 'Unknown');
  const raw =
    replyMsg.text ||
    replyMsg.caption ||
    (replyMsg.sticker ? `[Sticker ${replyMsg.sticker.emoji || ''}]` : '') ||
    (replyMsg.photo ? '[Photo]' : '') ||
    (replyMsg.voice ? '[Voice message]' : '') ||
    (replyMsg.video ? '[Video]' : '') ||
    (replyMsg.audio ? '[Audio]' : '') ||
    (replyMsg.document
      ? `[Document: ${replyMsg.document.file_name || 'file'}]`
      : '') ||
    '[message]';
  const snippet = raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
  return `[Reply to ${name}: "${snippet}"]\n`;
}

/**
 * Build a "[Forwarded from ...]" prefix using forward_origin (Bot API 7.0+)
 * with fallback to legacy forward_from / forward_from_chat / forward_sender_name.
 */
function forwardContext(msg: Message): string {
  const m = msg as any;
  const origin = m.forward_origin;
  if (origin) {
    switch (origin.type) {
      case 'user':
        return `[Forwarded from ${origin.sender_user.first_name || origin.sender_user.username}]\n`;
      case 'hidden_user':
        return `[Forwarded from ${origin.sender_user_name}]\n`;
      case 'chat': {
        const chat = origin.sender_chat;
        return `[Forwarded from ${chat.title || chat.username}]\n`;
      }
      case 'channel': {
        const ch = origin.chat;
        const sig = origin.author_signature
          ? ` (${origin.author_signature})`
          : '';
        const link =
          ch.username && origin.message_id
            ? ` | https://t.me/${ch.username}/${origin.message_id}`
            : '';
        return `[Forwarded from channel "${ch.title || ch.username}"${sig}${link}]\n`;
      }
    }
  }
  // Legacy fields
  if (m.forward_from) {
    const u = m.forward_from;
    return `[Forwarded from ${u.first_name || u.username}]\n`;
  }
  if (m.forward_from_chat) {
    const c = m.forward_from_chat;
    return `[Forwarded from ${c.title || c.username}]\n`;
  }
  if (m.forward_sender_name) {
    return `[Forwarded from ${m.forward_sender_name}]\n`;
  }
  return '';
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Split text into chunks ≤ maxLen UTF-16 code units, never cutting between
 * a high and a low surrogate. JSON.stringify of an orphan high surrogate
 * emits `\uD83D` (verified on Node v22) which Telegram rejects with 400.
 */
function splitForTelegram(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + maxLen, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      // High-surrogate: back up one code unit so the pair travels together.
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    // Guard against pathological inputs where backing up doesn't advance.
    if (end <= pos) end = pos + 1;
    chunks.push(text.slice(pos, end));
    pos = end;
  }
  return chunks;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text
 * only when Telegram explicitly rejected the Markdown parsing. Transport
 * errors (429 rate limit, 5xx, network) propagate so the caller's retry /
 * backoff machinery decides — a plain-text retry would just hit the same
 * transport failure and consume the rate-limit budget twice.
 *
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 *
 * Returns the sent message's id as a string (grammy types it as a number on
 * `Message.TextMessage.message_id`; coerce for the channel contract).
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<{ messageId: string }> {
  let result: Message.TextMessage;
  try {
    result = await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Narrow catch: only retry plain when Telegram rejected the *parsing*
    // of the Markdown. For transport errors (429, 5xx, network) re-throw
    // so the caller's retry/backoff machinery decides.
    const e = err as { error_code?: number; description?: string };
    const isMarkdownParseError =
      e?.error_code === 400 &&
      /can't parse entities|entity/i.test(e.description ?? '');
    if (!isMarkdownParseError) throw err;
    logger.debug({ err }, 'Markdown parse failed, falling back to plain text');
    result = await api.sendMessage(chatId, text, options);
  }
  return { messageId: String(result.message_id) };
}

/**
 * Test-only re-export at module scope. Exposes the narrowed-catch helper so
 * tests can drive Markdown→plain fallback paths without instantiating a Bot.
 */
export const _test_sendTelegramMessage = sendTelegramMessage;

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Returns the bot's own Telegram user ID as a string, or undefined if the
   * Bot hasn't finished init (`bot.botInfo` is populated after `connect`'s
   * `onStart`). Mirrors the optional `Channel.botSenderId()` contract so the
   * orchestrator can mark outbound rows with the bot's identity.
   */
  botSenderId(): string | undefined {
    return this.bot?.botInfo?.id ? String(this.bot.botInfo.id) : undefined;
  }

  /**
   * Derive the contacts namespace for a chat. Main control group → `'main'`
   * (matches `getContactsForGroup({ scope: 'main', includeUnion: true })`
   * convention); ordinary groups → their folder slug.
   */
  private scopeForGroup(group: RegisteredGroup): string {
    return group.isMain ? 'main' : group.folder;
  }

  /**
   * Final delivery chokepoint for every wired update kind. Runs the contact
   * pipeline + builds the meta block + attaches it to the NewMessage before
   * calling `opts.onMessage`. Each existing type-specific handler builds the
   * content + assembles the partial NewMessage, then routes through here so
   * the meta and contact persistence happen uniformly.
   *
   * `extras` is forwarded to `buildMetaBlock` — voice handlers pass
   * `transcript` so the meta carries the transcription status.
   */
  private deliverInbound(
    ctx: Context,
    chatJid: string,
    group: RegisteredGroup,
    newMsg: import('../types.js').NewMessage,
    extras?: BuildMetaBlockExtras,
  ): void {
    // Sender allowlist pre-gate: when the per-chat (or default) entry is
    // mode='drop' and the sender is not in the allow list, drop EVERYTHING:
    //   - no contact upsert (otherwise a random sender's display name + phone
    //     leaks into the contacts table even when the message is dropped);
    //   - no meta build / onMessage call;
    //   - no DB write.
    //
    // Bot-originated messages (`is_from_me`) bypass this gate; the orchestrator
    // emits them and there's no external sender to authorize.
    //
    // The downstream `onMessage` callback in src/index.ts ALSO enforces the
    // same gate (defense in depth) — but doing it here additionally prevents
    // the contact-pipeline side effect that runs above the onMessage call.
    if (!newMsg.is_from_me && !newMsg.is_bot_message) {
      const cfg = loadSenderAllowlist();
      if (
        shouldDropMessage(chatJid, cfg) &&
        !isSenderAllowed(chatJid, newMsg.sender, cfg)
      ) {
        if (cfg.logDenied) {
          logger.debug(
            { chatJid, sender: newMsg.sender },
            'telegram: deliverInbound dropping message (sender-allowlist drop mode)',
          );
        }
        return;
      }
    }

    const scope = this.scopeForGroup(group);
    // The contact pipeline is best-effort observability — its failure
    // (SQLITE_BUSY, schema mismatch, NOT NULL constraint) must never drop
    // the user's actual message. Wrap separately from meta so a meta
    // builder bug doesn't suppress contact persistence either.
    try {
      processContactsFromContext(ctx, scope);
    } catch (err) {
      logger.warn(
        { err: String(err), chatJid },
        'processContactsFromContext failed; delivering message anyway',
      );
    }
    let meta: string | undefined;
    try {
      meta = ctx.msg ? buildMetaBlock(ctx.msg, extras) : undefined;
    } catch (err) {
      logger.warn(
        { err: String(err), chatJid },
        'buildMetaBlock failed; delivering message without meta',
      );
    }
    this.opts.onMessage(chatJid, {
      ...newMsg,
      meta: meta ?? newMsg.meta,
    });
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content =
        forwardContext(ctx.message) +
        replyContext(ctx.message.reply_to_message as Message | undefined) +
        ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram entity offsets are relative to `ctx.message.text`, NOT to the
      // forward/reply-prefixed `content` we just built — substring against
      // `content` would shift the slice and either miss the mention (forward
      // case → bot ignored) or grab unrelated bytes (false positive).
      // Also require offset === 0 so an in-passing reference like
      // "tell @andy_ai_bot to do X" inside a longer sentence doesn't summon
      // the agent. We only treat a leading @-mention as an explicit summon.
      const botUsername = ctx.me?.username?.toLowerCase();
      const rawText = ctx.message.text || '';
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const startMention = entities.find(
          (e) => e.type === 'mention' && e.offset === 0,
        );
        const isBotMentioned =
          !!startMention &&
          rawText
            .substring(
              startMention.offset,
              startMention.offset + startMention.length,
            )
            .toLowerCase() === `@${botUsername}`;
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // If this is the very first inbound message in a forum topic that still
      // carries Telegram's placeholder name ("New Chat" on macOS), rename the
      // topic to a meaningful title derived from the message body. We do this
      // BEFORE storeMessage so the "first-in-topic" check is honest. Best-
      // effort: any API error is logged at warn and never crashes delivery.
      if (threadId !== undefined && this.bot) {
        const threadIdStr = threadId.toString();
        const bot = this.bot;
        if (isFirstInboundInTopic(chatJid, threadIdStr)) {
          // Fire-and-forget: LLM titler first (semantic, via Claude Haiku),
          // fall back to string-trim if the API is unreachable. The whole
          // rename runs off the critical path — delivery proceeds in
          // parallel.
          (async () => {
            const llmTitle = await titleFromMessage(ctx.message.text);
            const title = llmTitle ?? generateTopicTitle(ctx.message.text);
            if (!title) return;
            try {
              await bot.api.editForumTopic(ctx.chat.id, threadId, {
                name: title,
              });
              logger.info(
                {
                  chatJid,
                  threadId: threadIdStr,
                  title,
                  source: llmTitle ? 'llm' : 'fallback',
                },
                'Renamed Telegram forum topic',
              );
            } catch (err) {
              logger.warn(
                {
                  chatJid,
                  threadId: threadIdStr,
                  err: err instanceof Error ? err.message : String(err),
                },
                'editForumTopic failed (bot may lack can_manage_topics admin right)',
              );
            }
          })();
        }
      }

      // Deliver message — startMessageLoop() will pick it up
      this.deliverInbound(ctx, chatJid, group, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const fwd = forwardContext(ctx.message as unknown as Message);
      const reply = replyContext(
        ctx.message.reply_to_message as Message | undefined,
      );

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.deliverInbound(ctx, chatJid, group, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${fwd}${reply}${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const fwd = forwardContext(ctx.message as unknown as Message);
      const reply = replyContext(
        ctx.message.reply_to_message as Message | undefined,
      );
      const isGroupChat =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroupChat,
      );

      // Photo metadata (file_id, etc.) is emitted via buildMetaBlock as
      // <media type="photo" file_id="..."/>. Agent calls view_media on demand
      // when it needs to actually see the image — no eager base64 inlining.
      this.deliverInbound(ctx, chatJid, group, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${fwd}${reply}[Photo]${caption}`,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const envVars = readEnvFile(['GROQ_API_KEY']);
      const groqKey = process.env.GROQ_API_KEY || envVars.GROQ_API_KEY;
      const fileId = ctx.message.voice?.file_id;
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const fwd = forwardContext(ctx.message as unknown as Message);
      const reply = replyContext(
        ctx.message.reply_to_message as Message | undefined,
      );
      const isGroupChat =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroupChat,
      );

      let content = `${fwd}${reply}[Voice message]${caption}`;
      // Track transcription outcome for the meta block (carries status to
      // the agent so it can distinguish "no audio downloaded" from "audio
      // present but Groq returned empty").
      let transcriptStatus: 'ok' | 'failed' | 'missing_key' | 'skipped' =
        'skipped';
      let transcriptText: string | undefined;

      if (!groqKey) {
        transcriptStatus = 'missing_key';
      } else if (groqKey && fileId) {
        const audioBuffer = await downloadTelegramFile(this.botToken, fileId);
        if (audioBuffer) {
          const transcript = await transcribeWithGroq(audioBuffer, groqKey);
          if (transcript) {
            content = `${fwd}${reply}[Voice message]: ${transcript}${caption}`;
            transcriptStatus = 'ok';
            transcriptText = transcript;
            logger.info({ chatJid, senderName }, 'Voice message transcribed');
          } else {
            transcriptStatus = 'failed';
            logger.warn(
              { chatJid },
              'Groq transcription returned empty result',
            );
          }
        } else {
          transcriptStatus = 'failed';
          logger.warn(
            { chatJid },
            'Failed to download voice file from Telegram',
          );
        }
      }

      this.deliverInbound(
        ctx,
        chatJid,
        group,
        {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        },
        { transcript: { status: transcriptStatus, text: transcriptText } },
      );
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Edits and channel posts share the same delivery path: run contact
    // pipeline + emit meta block, content body is whatever text/caption the
    // edited or channel message carries (or a stub when neither is set).
    // These are NEW handlers (not in the existing surface) — they do NOT
    // overlap with `bot.on('message:*')` because grammy registers each
    // update-kind handler independently (no fall-through between `message`
    // and `edited_message`/`channel_post`/`edited_channel_post`).
    const deliverEditedOrChannel = (
      ctx: Context,
      msg: Message,
      placeholder: string,
    ) => {
      const chatJid = `tg:${ctx.chat?.id ?? msg.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const timestamp = new Date(msg.date * 1000).toISOString();
      const senderName =
        msg.from?.first_name ||
        msg.from?.username ||
        msg.from?.id?.toString() ||
        ('sender_chat' in msg && msg.sender_chat && 'title' in msg.sender_chat
          ? msg.sender_chat.title
          : undefined) ||
        'Unknown';
      const content = msg.text ?? msg.caption ?? placeholder;
      const isGroupChat =
        ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroupChat,
      );
      this.deliverInbound(ctx, chatJid, group, {
        id: msg.message_id.toString(),
        chat_jid: chatJid,
        sender:
          msg.from?.id?.toString() ||
          ('sender_chat' in msg && msg.sender_chat
            ? String(msg.sender_chat.id)
            : ''),
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('edited_message', (ctx) => {
      if (!ctx.editedMessage) return;
      deliverEditedOrChannel(ctx, ctx.editedMessage, '[edited media]');
    });
    this.bot.on('channel_post', (ctx) => {
      if (!ctx.channelPost) return;
      deliverEditedOrChannel(ctx, ctx.channelPost, '[channel post]');
    });
    this.bot.on('edited_channel_post', (ctx) => {
      if (!ctx.editedChannelPost) return;
      deliverEditedOrChannel(
        ctx,
        ctx.editedChannelPost,
        '[edited channel post]',
      );
    });

    // Handle errors: on 409 conflict restart polling with exponential backoff
    // (happens when a previous instance's long-poll hasn't timed out yet)
    let conflictRetryCount = 0;
    const scheduleConflictRetry = () => {
      const delayMs = Math.min(35_000 * 2 ** conflictRetryCount, 300_000);
      conflictRetryCount++;
      logger.warn(
        { attempt: conflictRetryCount, delayMs },
        'Telegram 409 conflict — retrying polling',
      );
      setTimeout(() => {
        if (!this.bot) return;
        this.bot.start().then(
          () => {
            logger.info('Telegram polling restarted after 409');
            conflictRetryCount = 0;
          },
          (err) => {
            const is409 = (err as { error_code?: number })?.error_code === 409;
            if (is409) {
              scheduleConflictRetry();
            } else {
              logger.error(
                { err: (err as Error)?.message ?? String(err) },
                'Telegram bot restart failed',
              );
            }
          },
        );
      }, delayMs);
    };

    this.bot.catch((err) => {
      const is409 = (err as { error_code?: number })?.error_code === 409;
      if (is409) {
        scheduleConflictRetry();
      } else {
        logger.error({ err: err.message }, 'Telegram bot error');
      }
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: { threadId?: string },
  ): Promise<{ messageId?: string }> {
    const threadId = opts?.threadId;
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return { messageId: undefined };
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 UTF-16 code-unit limit per message. Naive
      // slice(i, i+4096) cuts surrogate pairs (e.g. emoji at offset 4095
      // leaves an orphan high surrogate) — the API rejects that as invalid
      // UTF-8 and the fallback retry sends the same garbage. Back off by 1
      // when the boundary lands on a high surrogate.
      const MAX_LENGTH = 4096;
      const chunks = splitForTelegram(text, MAX_LENGTH);
      let firstId: string | undefined;
      for (let i = 0; i < chunks.length; i++) {
        // No try/catch here — any throw aborts further chunks AND propagates
        // to the caller (routeOutbound), which means streamingSendFailed
        // triggers and the cursor rolls back. Chunks 0..i-1 are already
        // delivered; that is the documented partial-delivery known
        // limitation.
        const r = await sendTelegramMessage(
          this.bot.api,
          numericId,
          chunks[i],
          options,
        );
        if (i === 0) firstId = r.messageId;
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
      return { messageId: firstId };
    } catch (err) {
      // Log AND propagate so callers (router, scheduler, IPC, agent stream)
      // don't advance state machines as if the message was delivered.
      logger.error({ jid, err }, 'Failed to send Telegram message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
