import { describe, it, expect } from 'vitest';
import { parseStringPromise } from 'xml2js';
import {
  buildMetaBlock,
  escapeXmlAttr,
  escapeXmlText,
} from './telegram-meta.js';

/**
 * Smoke-parse the meta fragment to confirm strict XML well-formedness.
 * Plan Task 8b-1 Step 1 requires `xml2js.parseStringPromise` for every new
 * test in addition to substring assertions — catches unclosed tags, missing
 * spaces between attributes, duplicate attribute names, illegal XML chars,
 * and wrong nesting that `.toContain()` would miss. Wrap in <root> because
 * meta is a fragment (multiple sibling tags are possible).
 */
async function smokeParseXml(metaBlock: string): Promise<void> {
  await parseStringPromise(`<root>${metaBlock}</root>`);
}

describe('escapeXmlAttr', () => {
  it('escapes all 5 special chars', () => {
    expect(escapeXmlAttr('a&b<c>d"e\'f')).toBe(
      'a&amp;b&lt;c&gt;d&quot;e&apos;f',
    );
  });
  it('returns string for non-string inputs', () => {
    expect(escapeXmlAttr(42)).toBe('42');
    expect(escapeXmlAttr(undefined)).toBe('');
    expect(escapeXmlAttr(null)).toBe('');
  });
});

describe('escapeXmlText', () => {
  it('escapes only & < >', () => {
    expect(escapeXmlText('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d"e\'f');
  });
});

describe('buildMetaBlock — minimal message', () => {
  it('emits <m id date> for a plain text message', async () => {
    const msg = {
      message_id: 42,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'hi',
    };
    const xml = `<root>${buildMetaBlock(msg as any)}</root>`;
    const parsed = await parseStringPromise(xml);
    expect(parsed.root.m[0].$.id).toBe('42');
    expect(parsed.root.m[0].$.date).toMatch(/^2025-/);
  });
});

describe('buildMetaBlock — XML injection fixture (mandated at spec line 105)', () => {
  it('round-trips through strict XML parser when sender name contains " < > & \'', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'Bob' },
      from: { id: 1, is_bot: false, first_name: 'Bob "the builder" <hr@x>' },
    };
    const xml = `<root>${buildMetaBlock(msg as any)}</root>`;
    await expect(parseStringPromise(xml)).resolves.toBeDefined();
  });
});

describe('buildMetaBlock — <from> vs <sender_chat> mutex', () => {
  it('emits <sender_chat> NOT <from> when sender_chat is set', () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: -100, type: 'supergroup' as const, title: 'G' },
      sender_chat: {
        id: -100,
        type: 'channel' as const,
        title: 'Durov',
        username: 'durov',
      },
      from: { id: 1, is_bot: true, first_name: 'GroupAnonymousBot' },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<sender_chat');
    expect(meta).not.toContain('<from');
  });
});

describe('buildMetaBlock — <from> attributes', () => {
  it('emits id, un, name (first+last), is_bot, premium, lang for a fully-populated from', async () => {
    const msg = {
      message_id: 7,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: {
        id: 42,
        is_bot: false,
        first_name: 'Вася',
        last_name: 'Иванов',
        username: 'vasya',
        is_premium: true,
        language_code: 'ru',
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<from');
    expect(meta).toContain('id="42"');
    expect(meta).toContain('un="vasya"');
    expect(meta).toContain('name="Вася Иванов"');
    expect(meta).toContain('is_bot="0"');
    expect(meta).toContain('premium="1"');
    expect(meta).toContain('lang="ru"');
  });

  it('emits only id+is_bot when other from fields are absent', () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 99, is_bot: true, first_name: 'Bot' },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('id="99"');
    expect(meta).toContain('is_bot="1"');
    expect(meta).toContain('name="Bot"');
    expect(meta).not.toContain('un=');
    expect(meta).not.toContain('premium=');
    expect(meta).not.toContain('lang=');
  });
});

describe('buildMetaBlock — <fwd>', () => {
  it('user kind: emits id un name is_bot from sender_user', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      forward_origin: {
        type: 'user' as const,
        date: 1747731600,
        sender_user: {
          id: 99,
          is_bot: false,
          first_name: 'V',
          username: 'v',
        },
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<fwd');
    expect(meta).toContain('kind="user"');
    expect(meta).toContain('id="99"');
    expect(meta).toContain('un="v"');
    expect(meta).toContain('name="V"');
    expect(meta).toContain('is_bot="0"');
    await smokeParseXml(meta);
  });
  it('hidden_user kind: emits sig from sender_user_name (no id)', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      forward_origin: {
        type: 'hidden_user' as const,
        date: 1747731600,
        sender_user_name: 'AnonymousUser',
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('kind="hidden_user"');
    expect(meta).toContain('sig="AnonymousUser"');
    expect(meta).not.toMatch(/<fwd[^>]*\sid=/);
    await smokeParseXml(meta);
  });
  it('chat kind: anonymous group admin, emits sig from author_signature', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: -100, type: 'supergroup' as const, title: 'G' },
      from: { id: 1, is_bot: true, first_name: 'GroupAnonymousBot' },
      forward_origin: {
        type: 'chat' as const,
        date: 1747731600,
        sender_chat: {
          id: -100,
          type: 'supergroup' as const,
          title: 'Internal',
        },
        author_signature: 'Pavel',
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('kind="chat"');
    expect(meta).toContain('chat_id="-100"');
    expect(meta).toContain('sig="Pavel"');
    await smokeParseXml(meta);
  });
  it('channel kind: emits chat_id un title link orig_msg_id', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      forward_origin: {
        type: 'channel' as const,
        date: 1747731600,
        chat: {
          id: -1001,
          type: 'channel' as const,
          title: 'Durov',
          username: 'durov',
        },
        message_id: 123,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('kind="channel"');
    expect(meta).toContain('un="durov"');
    expect(meta).toContain('title="Durov"');
    expect(meta).toContain('link="https://t.me/durov/123"');
    expect(meta).toContain('orig_msg_id="123"');
    await smokeParseXml(meta);
  });
  it('unknown kind: emits raw= with escaped JSON.stringify(origin)', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      forward_origin: {
        type: 'future_unknown_kind' as any,
        date: 1747731600,
      } as any,
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('kind="unknown"');
    expect(meta).toContain('raw=');
    await smokeParseXml(meta);
  });
  it('unknown kind: does not throw when origin lacks date field', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      forward_origin: { type: 'future_unknown_kind', some_field: 'x' } as any,
    };
    expect(() => buildMetaBlock(msg as any)).not.toThrow();
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<fwd kind="unknown"');
    expect(meta).toContain('raw=');
    await smokeParseXml(meta);
  });
  it('chat kind: omits un and title when sender_chat has no username/title', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      forward_origin: {
        type: 'chat' as const,
        date: 1747731600,
        sender_chat: { id: -100, type: 'group' as const, title: '' }, // empty title
        author_signature: 'Anon',
      } as any,
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<fwd kind="chat"');
    expect(meta).not.toContain('un=""');
    expect(meta).not.toContain('title=""');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <reply>', () => {
  it('in-chat reply: external="0" with mid + from_id + snippet', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      reply_to_message: {
        message_id: 4,
        date: 1747731500,
        chat: { id: 1, type: 'private' as const, first_name: 'X' },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        text: 'original message text',
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<reply');
    expect(meta).toContain('external="0"');
    expect(meta).toContain('mid="4"');
    expect(meta).toContain('from_id="42"');
    expect(meta).toContain('snippet="original message text"');
    await smokeParseXml(meta);
  });
  it('external_reply: external="1" with origin attributes', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      external_reply: {
        origin: {
          type: 'user' as const,
          date: 1747731500,
          sender_user: {
            id: 99,
            is_bot: false,
            first_name: 'V',
            username: 'v',
          },
        },
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<reply');
    expect(meta).toContain('external="1"');
    await smokeParseXml(meta);
  });
  it('in-chat reply: snippet truncation preserves surrogate pairs (no orphan high surrogate)', async () => {
    const longText = 'a'.repeat(499) + '🐬'; // 501 code units; char 500 = U+D83D (high surrogate)
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      reply_to_message: {
        message_id: 99,
        date: 1747731600,
        chat: { id: 1, type: 'private' as const, first_name: 'X' },
        text: longText,
      },
    };
    const meta = buildMetaBlock(msg as any);
    // Extract snippet attribute and confirm no orphan high surrogate
    const m = meta.match(/snippet="([^"]*)"/);
    expect(m).not.toBeNull();
    const snippet = m![1];
    // Last code unit must not be an unpaired high surrogate (0xD800-0xDBFF)
    const lastCharCode = snippet.charCodeAt(snippet.length - 1);
    expect(lastCharCode >= 0xd800 && lastCharCode <= 0xdbff).toBe(false);
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <reply_to_story>', () => {
  it('top-level emission from message.reply_to_story', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      reply_to_story: {
        chat: { id: -100, type: 'channel' as const, title: 'C' },
        id: 42,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<reply_to_story');
    expect(meta).toContain('chat_id="-100"');
    expect(meta).toContain('story_id="42"');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <quote>', () => {
  it('emits escaped text content (not attribute)', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      quote: { text: 'quoted <fragment> & rest', position: 0 },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<quote>quoted &lt;fragment&gt; &amp; rest</quote>');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <entities>', () => {
  it('emits canonical entity types from message.entities', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'check https://example.com and @vasya #news /start@bot +79991234567 me@x.com $BTC',
      entities: [
        { type: 'url' as const, offset: 6, length: 19 },
        { type: 'mention' as const, offset: 30, length: 6 },
        { type: 'hashtag' as const, offset: 37, length: 5 },
        { type: 'bot_command' as const, offset: 43, length: 10 },
        { type: 'phone_number' as const, offset: 54, length: 12 },
        { type: 'email' as const, offset: 67, length: 8 },
        { type: 'cashtag' as const, offset: 76, length: 4 },
      ],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<entities>');
    expect(meta).toContain('<url>https://example.com</url>');
    expect(meta).toContain('<mention>vasya</mention>');
    expect(meta).toContain('<hashtag>news</hashtag>');
    expect(meta).toContain('<bot_command>/start@bot</bot_command>');
    expect(meta).toContain('<phone_number>+79991234567</phone_number>');
    expect(meta).toContain('<email>me@x.com</email>');
    expect(meta).toContain('<cashtag>BTC</cashtag>');
    await smokeParseXml(meta);
  });
  it('emits text_link with href attribute and inner text', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'click here',
      entities: [
        {
          type: 'text_link' as const,
          offset: 6,
          length: 4,
          url: 'https://example.com',
        },
      ],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain(
      '<text_link href="https://example.com">here</text_link>',
    );
    await smokeParseXml(meta);
  });
  it('emits text_mention with user attributes', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'hello Ivan',
      entities: [
        {
          type: 'text_mention' as const,
          offset: 6,
          length: 4,
          user: {
            id: 111,
            is_bot: false,
            first_name: 'Иван',
            username: 'ivan',
          },
        },
      ],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<text_mention');
    expect(meta).toContain('id="111"');
    expect(meta).toContain('un="ivan"');
    expect(meta).toContain('name="Иван"');
    await smokeParseXml(meta);
  });
  it('text_mention: omits un attribute when user has no username', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      text: '@user',
      entities: [
        {
          type: 'text_mention' as const,
          offset: 0,
          length: 5,
          user: { id: 111, is_bot: false, first_name: 'NoHandle' },
        },
      ],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<text_mention');
    expect(meta).not.toContain('un=""');
    await smokeParseXml(meta);
  });
  it('emits custom_emoji with id', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: '😀',
      entities: [
        {
          type: 'custom_emoji' as const,
          offset: 0,
          length: 1,
          custom_emoji_id: '5368324170671202286',
        },
      ],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<custom_emoji id="5368324170671202286"/>');
    await smokeParseXml(meta);
  });
  it('drops formatting entities (bold/italic/code/etc.)', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'hello world',
      entities: [
        { type: 'bold' as const, offset: 0, length: 5 },
        { type: 'italic' as const, offset: 6, length: 5 },
      ],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).not.toContain('<entities'); // empty after filtering — entire block omitted
    expect(meta).not.toContain('<bold');
    await smokeParseXml(meta);
  });
  it('merges caption_entities into the same <entities> block', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      caption: 'hi @vasya',
      caption_entities: [{ type: 'mention' as const, offset: 3, length: 6 }],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<entities>');
    expect(meta).toContain('<mention>vasya</mention>');
    await smokeParseXml(meta);
  });
  it('dedupes entities by (offset, length, type)', async () => {
    const msg = {
      message_id: 5,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'hi @vasya',
      entities: [{ type: 'mention' as const, offset: 3, length: 6 }],
      caption_entities: [{ type: 'mention' as const, offset: 3, length: 6 }],
    };
    const meta = buildMetaBlock(msg as any);
    const mentions = (meta.match(/<mention>/g) || []).length;
    expect(mentions).toBe(1);
    await smokeParseXml(meta);
  });
});
