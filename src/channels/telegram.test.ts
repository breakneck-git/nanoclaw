import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'grammy';
import {
  _testProcessContactsFromContext,
  _testBotSenderId,
  _test_sendTelegramMessage,
  TelegramChannel,
} from './telegram.js';
import * as db from '../db.js';
import * as enrich from './telegram-enrich.js';

vi.mock('../db.js', () => ({
  upsertContact: vi.fn(),
  promoteContactIdent: vi.fn(),
}));
vi.mock('./telegram-enrich.js', () => ({
  queueEnrich: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// Helper: minimal Context-shaped object with `.msg` accessor populated.
// grammy's real Context defines `.msg` as a getter; for the host pipeline we
// only need property access, so a plain literal with `msg` set works as a
// `Context` proxy at runtime — cast `as unknown as Context` for the call.
function makeCtx(msg: Record<string, unknown>): Context {
  return { msg } as unknown as Context;
}

describe('processContactsFromContext — all 7 triggers', () => {
  beforeEach(() => {
    vi.mocked(db.upsertContact).mockClear();
    vi.mocked(db.promoteContactIdent).mockClear();
    vi.mocked(enrich.queueEnrich).mockClear();
  });

  it('trigger 1: msg.from (with username) → promoteContactIdent + upsertContact source=sender', () => {
    const ctx = makeCtx({
      from: {
        id: 42,
        is_bot: false,
        first_name: 'Вася',
        last_name: 'Иванов',
        username: 'vasya',
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    // promoteContactIdent called BEFORE upsertContact with un + tg_id
    expect(db.promoteContactIdent).toHaveBeenCalledWith('g', 'vasya', '42');
    expect(db.upsertContact).toHaveBeenCalledTimes(1);
    const [scope, patch, opts] = vi.mocked(db.upsertContact).mock.calls[0];
    expect(scope).toBe('g');
    expect(patch).toMatchObject({
      kind: 'user',
      first_name: 'Вася',
      last_name: 'Иванов',
      is_bot: 0,
    });
    expect(opts.source).toBe('sender');
    expect(opts.identity).toEqual({ tg_id: '42', username: 'vasya' });
  });

  it('trigger 1: msg.sender_chat → upsertContact source=sender (username in identity, not patch)', () => {
    const ctx = makeCtx({
      sender_chat: {
        id: -1001,
        type: 'channel',
        title: 'My Channel',
        username: 'mychannel',
      },
      // `from` would be GroupAnonymousBot in real Telegram, but mutex per spec
      // line 193-194 → sender_chat path skips `from`.
      from: { id: 1, is_bot: true, first_name: 'GroupAnonymousBot' },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.promoteContactIdent).not.toHaveBeenCalled();
    expect(db.upsertContact).toHaveBeenCalledTimes(1);
    const [scope, patch, opts] = vi.mocked(db.upsertContact).mock.calls[0];
    expect(scope).toBe('g');
    expect(patch).toMatchObject({
      kind: 'channel',
      title: 'My Channel',
      is_bot: 0,
    });
    expect(opts.source).toBe('sender');
    expect(opts.identity).toEqual({
      tg_id: '-1001',
      username: 'mychannel',
    });
    // Username goes into identity (so ident = scope|id:-1001 with username
    // column populated), NOT into patch (ContactPatch type has no username).
    expect(patch).not.toHaveProperty('username');
  });

  it('trigger 2: forward_origin type=user → upsertContact source=forward', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      forward_origin: {
        type: 'user',
        date: 1747731600,
        sender_user: {
          id: 99,
          is_bot: false,
          first_name: 'Petya',
          username: 'petya',
        },
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    // First call = sender trigger 1, second call = forward trigger 2
    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const fwdCall = vi.mocked(db.upsertContact).mock.calls[1];
    expect(fwdCall[0]).toBe('g');
    expect(fwdCall[1]).toMatchObject({
      kind: 'user',
      first_name: 'Petya',
      is_bot: 0,
    });
    expect(fwdCall[2].source).toBe('forward');
    expect(fwdCall[2].identity).toEqual({ tg_id: '99', username: 'petya' });
    // promoteContactIdent was called for forward.sender_user too
    expect(db.promoteContactIdent).toHaveBeenCalledWith('g', 'petya', '99');
  });

  it('trigger 2: forward_origin type=hidden_user → no row created (only sender_user_name)', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      forward_origin: {
        type: 'hidden_user',
        date: 1747731600,
        sender_user_name: 'AnonUser',
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    // Only the sender (trigger 1 from `from`) is upserted; hidden_user has no
    // identity that could form a row, so trigger 2 skips it.
    expect(db.upsertContact).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.upsertContact).mock.calls[0][2].source).toBe('sender');
  });

  it('trigger 2: forward_origin type=chat (anonymous admin) → upsertContact with kind=chat source=forward', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      forward_origin: {
        type: 'chat',
        date: 1747731600,
        sender_chat: {
          id: -100,
          type: 'supergroup',
          title: 'Internal',
        },
        author_signature: 'Pavel',
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const fwd = vi.mocked(db.upsertContact).mock.calls[1];
    expect(fwd[1]).toMatchObject({
      kind: 'chat',
      title: 'Internal',
      is_bot: 0,
    });
    expect(fwd[2].source).toBe('forward');
    expect(fwd[2].identity).toEqual({ tg_id: '-100', username: undefined });
  });

  it('trigger 2: forward_origin type=channel → upsertContact source=forward + link derivable', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      forward_origin: {
        type: 'channel',
        date: 1747731600,
        chat: {
          id: -1001,
          type: 'channel',
          title: 'Durov',
          username: 'durov',
        },
        message_id: 123,
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const fwd = vi.mocked(db.upsertContact).mock.calls[1];
    expect(fwd[1]).toMatchObject({
      kind: 'channel',
      title: 'Durov',
      link: 'https://t.me/durov/123',
      is_bot: 0,
    });
    expect(fwd[2].source).toBe('forward');
    expect(fwd[2].identity).toEqual({ tg_id: '-1001', username: 'durov' });
  });

  it('trigger 3: reply_to_message.from → upsertContact source=reply', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      reply_to_message: {
        message_id: 10,
        from: {
          id: 88,
          is_bot: false,
          first_name: 'Alice',
          username: 'alice',
        },
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const reply = vi.mocked(db.upsertContact).mock.calls[1];
    expect(reply[1]).toMatchObject({
      kind: 'user',
      first_name: 'Alice',
      is_bot: 0,
    });
    expect(reply[2].source).toBe('reply');
    expect(reply[2].identity).toEqual({ tg_id: '88', username: 'alice' });
    expect(db.promoteContactIdent).toHaveBeenCalledWith('g', 'alice', '88');
  });

  it('trigger 3: external_reply.origin type=user → upsertContact source=reply', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      external_reply: {
        origin: {
          type: 'user',
          date: 1747731600,
          sender_user: {
            id: 77,
            is_bot: false,
            first_name: 'Bob',
            username: 'bob',
          },
        },
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const reply = vi.mocked(db.upsertContact).mock.calls[1];
    expect(reply[1]).toMatchObject({
      kind: 'user',
      first_name: 'Bob',
      is_bot: 0,
    });
    expect(reply[2].source).toBe('reply');
    expect(reply[2].identity).toEqual({ tg_id: '77', username: 'bob' });
  });

  it('trigger 3: external_reply.origin type=chat (anonymous admin) → upsertContact source=reply with kind=chat', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      external_reply: {
        origin: {
          type: 'chat',
          date: 1747731600,
          sender_chat: {
            id: -200,
            type: 'supergroup',
            title: 'External Group',
          },
        },
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const reply = vi.mocked(db.upsertContact).mock.calls[1];
    expect(reply[1]).toMatchObject({
      kind: 'chat',
      title: 'External Group',
      is_bot: 0,
    });
    expect(reply[2].source).toBe('reply');
    expect(reply[2].identity).toEqual({ tg_id: '-200', username: undefined });
  });

  it('trigger 3: external_reply.origin type=channel → upsertContact source=reply with kind=channel', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      external_reply: {
        origin: {
          type: 'channel',
          date: 1747731600,
          chat: {
            id: -300,
            type: 'channel',
            title: 'Ext Channel',
            username: 'extchan',
          },
          message_id: 9,
        },
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const reply = vi.mocked(db.upsertContact).mock.calls[1];
    expect(reply[1]).toMatchObject({
      kind: 'channel',
      title: 'Ext Channel',
      is_bot: 0,
    });
    expect(reply[2].source).toBe('reply');
    expect(reply[2].identity).toEqual({ tg_id: '-300', username: 'extchan' });
  });

  it('trigger 3: external_reply.origin type=hidden_user → NO upsert', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      external_reply: {
        origin: {
          type: 'hidden_user',
          date: 1747731600,
          sender_user_name: 'AnonReplyAuthor',
        },
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    // Only sender (trigger 1) — external hidden_user has no row-forming identity
    expect(db.upsertContact).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.upsertContact).mock.calls[0][2].source).toBe('sender');
  });

  it('trigger 4: msg.contact → upsertContact source=vcard with phone (identity from user_id when present)', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      contact: {
        phone_number: '+79001234567',
        first_name: 'John',
        last_name: 'Smith',
        user_id: 555,
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const vc = vi.mocked(db.upsertContact).mock.calls[1];
    expect(vc[1]).toMatchObject({
      kind: 'user',
      first_name: 'John',
      last_name: 'Smith',
      phone: '+79001234567',
      is_bot: 0,
    });
    expect(vc[2].source).toBe('vcard');
    expect(vc[2].identity).toEqual({ tg_id: '555' });
  });

  it('trigger 4: msg.contact without user_id falls back to name identity', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      contact: {
        phone_number: '+12025550199',
        first_name: 'Jane',
        last_name: 'Doe',
        // no user_id
      },
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const vc = vi.mocked(db.upsertContact).mock.calls[1];
    expect(vc[2].source).toBe('vcard');
    expect(vc[2].identity).toEqual({ name: 'Jane Doe' });
  });

  it('trigger 5: entity type=text_mention → upsertContact source=text_mention for each entity', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      text: 'hello Carl and Dora',
      entities: [
        {
          type: 'text_mention',
          offset: 6,
          length: 4,
          user: {
            id: 201,
            is_bot: false,
            first_name: 'Carl',
            username: 'carl',
          },
        },
        {
          type: 'text_mention',
          offset: 15,
          length: 4,
          user: {
            id: 202,
            is_bot: false,
            first_name: 'Dora',
          },
        },
      ],
    });
    _testProcessContactsFromContext(ctx, 'g');

    // 1 sender + 2 text_mentions
    expect(db.upsertContact).toHaveBeenCalledTimes(3);
    const tm1 = vi.mocked(db.upsertContact).mock.calls[1];
    expect(tm1[1]).toMatchObject({ first_name: 'Carl', is_bot: 0 });
    expect(tm1[2].source).toBe('text_mention');
    expect(tm1[2].identity).toEqual({ tg_id: '201', username: 'carl' });
    expect(db.promoteContactIdent).toHaveBeenCalledWith('g', 'carl', '201');

    const tm2 = vi.mocked(db.upsertContact).mock.calls[2];
    expect(tm2[1]).toMatchObject({ first_name: 'Dora', is_bot: 0 });
    expect(tm2[2].source).toBe('text_mention');
    expect(tm2[2].identity).toEqual({ tg_id: '202', username: undefined });
  });

  it('trigger 6: entity type=mention (bare @username) → queueEnrich for each entity', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      text: 'hello @alice and @bob_dev',
      entities: [
        { type: 'mention', offset: 6, length: 6 }, // '@alice'
        { type: 'mention', offset: 17, length: 8 }, // '@bob_dev'
      ],
    });
    _testProcessContactsFromContext(ctx, 'g');

    expect(enrich.queueEnrich).toHaveBeenCalledTimes(2);
    expect(enrich.queueEnrich).toHaveBeenNthCalledWith(1, 'g', 'alice');
    expect(enrich.queueEnrich).toHaveBeenNthCalledWith(2, 'g', 'bob_dev');
  });

  it('caption_entities are also scanned for text_mention and mention', () => {
    const ctx = makeCtx({
      from: { id: 1, is_bot: false, first_name: 'Me' },
      caption: 'photo by @alice',
      caption_entities: [
        { type: 'mention', offset: 9, length: 6 }, // '@alice'
      ],
    });
    _testProcessContactsFromContext(ctx, 'g');
    expect(enrich.queueEnrich).toHaveBeenCalledWith('g', 'alice');
  });

  it('returns early when ctx.msg is undefined', () => {
    const ctx = makeCtx({});
    delete (ctx as unknown as { msg?: unknown }).msg;
    _testProcessContactsFromContext(ctx, 'g');
    expect(db.upsertContact).not.toHaveBeenCalled();
    expect(db.promoteContactIdent).not.toHaveBeenCalled();
    expect(enrich.queueEnrich).not.toHaveBeenCalled();
  });
});

describe('botSenderId', () => {
  it('returns String(bot.botInfo.id) when populated', () => {
    expect(_testBotSenderId({ bot: { botInfo: { id: 12345 } } } as any)).toBe(
      '12345',
    );
  });
  it('returns undefined when bot is null', () => {
    expect(_testBotSenderId({ bot: null } as any)).toBeUndefined();
  });
  it('returns undefined when botInfo missing', () => {
    expect(_testBotSenderId({ bot: {} } as any)).toBeUndefined();
  });
});

describe('deliverInbound — exception isolation', () => {
  // Source-inspection tests: deliverInbound is a private method on
  // TelegramChannel which needs a full Bot to instantiate. Instead of
  // constructing one, we verify structurally that the wrapper exists.
  // These fail loudly if anyone removes the try/catch around the contact
  // pipeline or meta builder — a regression that would silently drop
  // inbound messages whenever the contact pipeline throws.
  const telegramSrc = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), './telegram.ts'),
    'utf-8',
  );

  it('deliverInbound wraps processContactsFromContext in try/catch', () => {
    const match = telegramSrc.match(
      /deliverInbound[\s\S]+?try\s*{[\s\S]+?processContactsFromContext[\s\S]+?}\s*catch/,
    );
    expect(match).not.toBeNull();
  });

  it('deliverInbound wraps buildMetaBlock in try/catch', () => {
    const match = telegramSrc.match(
      /deliverInbound[\s\S]+?try\s*{[\s\S]+?buildMetaBlock[\s\S]+?}\s*catch/,
    );
    expect(match).not.toBeNull();
  });

  it('deliverInbound gates on sender-allowlist BEFORE processContactsFromContext', () => {
    // The allowlist drop gate must run before the contact pipeline so a
    // dropped sender's display name/phone never lands in the contacts
    // table. Source inspection: shouldDropMessage / isSenderAllowed must
    // appear, AND must precede the processContactsFromContext call.
    const body = telegramSrc.match(/private deliverInbound[\s\S]+?(?=\n  \w)/);
    expect(body).not.toBeNull();
    const text = body![0];
    const dropIdx = text.indexOf('shouldDropMessage');
    const allowIdx = text.indexOf('isSenderAllowed');
    const contactsIdx = text.indexOf('processContactsFromContext');
    expect(dropIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(-1);
    expect(contactsIdx).toBeGreaterThan(-1);
    // Both gates appear BEFORE the contact pipeline call.
    expect(dropIdx).toBeLessThan(contactsIdx);
    expect(allowIdx).toBeLessThan(contactsIdx);
  });
});

describe('sendTelegramMessage narrowed catch', () => {
  it('Markdown 400 parse-error retries plain', async () => {
    const api = {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce({
          error_code: 400,
          description: "Bad Request: can't parse entities: ...",
        })
        .mockResolvedValueOnce({ message_id: 7 } as any),
    };
    const r = await _test_sendTelegramMessage(api as any, 1, 'text');
    expect(r.messageId).toBe('7');
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('429 rate-limit propagates WITHOUT retry', async () => {
    const api = {
      sendMessage: vi.fn().mockRejectedValue({
        error_code: 429,
        description: 'Too Many Requests',
      }),
    };
    await expect(
      _test_sendTelegramMessage(api as any, 1, 'text'),
    ).rejects.toMatchObject({ error_code: 429 });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('503 service unavailable propagates WITHOUT retry', async () => {
    const api = {
      sendMessage: vi.fn().mockRejectedValue({
        error_code: 503,
        description: 'Service Unavailable',
      }),
    };
    await expect(
      _test_sendTelegramMessage(api as any, 1, 'text'),
    ).rejects.toMatchObject({ error_code: 503 });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('plain network error (no error_code) propagates WITHOUT retry', async () => {
    const networkErr = new Error('ECONNRESET');
    const api = { sendMessage: vi.fn().mockRejectedValue(networkErr) };
    await expect(
      _test_sendTelegramMessage(api as any, 1, 'text'),
    ).rejects.toThrow('ECONNRESET');
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("400 'chat not found' (non-parse) propagates WITHOUT retry", async () => {
    const api = {
      sendMessage: vi.fn().mockRejectedValue({
        error_code: 400,
        description: 'Bad Request: chat not found',
      }),
    };
    await expect(
      _test_sendTelegramMessage(api as any, 1, 'text'),
    ).rejects.toMatchObject({
      error_code: 400,
      description: expect.stringMatching(/chat not found/),
    });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('TelegramChannel.sendMessage multi-chunk', () => {
  // Construct a TelegramChannel with the bot stubbed at the private field via
  // `as any`. The opts object only needs the three required callbacks; their
  // implementations don't matter for sendMessage tests.
  function makeChannel(sendMessage: ReturnType<typeof vi.fn>): {
    channel: TelegramChannel;
    sendMessageMock: ReturnType<typeof vi.fn>;
  } {
    const channel = new TelegramChannel('test-token', {
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    (channel as any).bot = { api: { sendMessage } };
    return { channel, sendMessageMock: sendMessage };
  }

  it("single chunk: returns that chunk's messageId", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 5 } as any);
    const { channel, sendMessageMock } = makeChannel(sendMessage);
    const result = await channel.sendMessage('tg:42', 'short text');
    expect(result).toEqual({ messageId: '5' });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('multi-chunk: returns FIRST chunk messageId, sends all chunks', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 100 } as any)
      .mockResolvedValueOnce({ message_id: 101 } as any);
    const { channel, sendMessageMock } = makeChannel(sendMessage);
    // 5000 chars > MAX_LENGTH (4096) → splits into 2 chunks
    const longText = 'x'.repeat(5000);
    const result = await channel.sendMessage('tg:42', longText);
    expect(result).toEqual({ messageId: '100' });
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it('partial failure (chunk 2 throws): throw propagates, chunk 1 messageId not returned (known limitation)', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 200 } as any)
      .mockRejectedValueOnce(new Error('Telegram API error during chunk 2'));
    const { channel, sendMessageMock } = makeChannel(sendMessage);
    const longText = 'y'.repeat(5000);
    await expect(channel.sendMessage('tg:42', longText)).rejects.toThrow(
      'Telegram API error during chunk 2',
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });
});
