import https from 'https';
import http from 'http';
import FormData from 'form-data';
import { downloadImage, processImage } from '../image.js';
import { Api, Bot } from 'grammy';
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
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
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

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
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
      this.opts.onMessage(chatJid, {
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

      // Pick the largest available photo size
      const photos = ctx.message.photo;
      const fileId = photos?.[photos.length - 1]?.file_id;

      let images:
        | import('../container-runner.js').ImageAttachment[]
        | undefined;
      if (fileId) {
        try {
          // Get download URL from Telegram
          const fileInfo = await ctx.api.getFile(fileId);
          const url = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;
          const buffer = await downloadImage(url);
          if (buffer) {
            const img = await processImage(buffer);
            if (img) {
              images = [img];
              logger.info(
                { chatJid, senderName },
                'Photo processed for agent vision',
              );
            }
          }
        } catch (err) {
          logger.warn({ chatJid, err }, 'Failed to process photo');
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${fwd}${reply}[Photo]${caption}`,
        timestamp,
        is_from_me: false,
        images,
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

      if (groqKey && fileId) {
        const audioBuffer = await downloadTelegramFile(this.botToken, fileId);
        if (audioBuffer) {
          const transcript = await transcribeWithGroq(audioBuffer, groqKey);
          if (transcript) {
            content = `${fwd}${reply}[Voice message]: ${transcript}${caption}`;
            logger.info({ chatJid, senderName }, 'Voice message transcribed');
          } else {
            logger.warn(
              { chatJid },
              'Groq transcription returned empty result',
            );
          }
        } else {
          logger.warn(
            { chatJid },
            'Failed to download voice file from Telegram',
          );
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
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
  ): Promise<void> {
    const threadId = opts?.threadId;
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
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
      for (const chunk of splitForTelegram(text, MAX_LENGTH)) {
        await sendTelegramMessage(this.bot.api, numericId, chunk, options);
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
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
