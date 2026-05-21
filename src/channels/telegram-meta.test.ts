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

describe('buildMetaBlock — <media> for all 8 types', () => {
  it.each([
    {
      type: 'photo',
      fixture: {
        photo: [
          {
            file_id: 'photo123',
            file_unique_id: 'pu1',
            width: 1280,
            height: 960,
            file_size: 5000,
          },
        ],
      },
      expectedMime: 'image/jpeg',
    },
    {
      type: 'video',
      fixture: {
        video: {
          file_id: 'vid123',
          file_unique_id: 'vu1',
          width: 1920,
          height: 1080,
          duration: 30,
          mime_type: 'video/mp4',
          file_size: 50000,
        },
      },
      expectedMime: 'video/mp4',
    },
    {
      type: 'voice',
      fixture: {
        voice: {
          file_id: 'voice123',
          file_unique_id: 'voiceu1',
          duration: 10,
          mime_type: 'audio/ogg',
          file_size: 8000,
        },
      },
      expectedMime: 'audio/ogg',
    },
    {
      type: 'audio',
      fixture: {
        audio: {
          file_id: 'audio123',
          file_unique_id: 'au1',
          duration: 180,
          mime_type: 'audio/mpeg',
          title: 'Song',
          performer: 'Band',
          file_size: 4000000,
        },
      },
      expectedMime: 'audio/mpeg',
    },
    {
      type: 'document',
      fixture: {
        document: {
          file_id: 'doc123',
          file_unique_id: 'du1',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          file_size: 20480,
        },
      },
      expectedMime: 'application/pdf',
    },
    {
      type: 'sticker',
      fixture: {
        sticker: {
          file_id: 'sticker123',
          file_unique_id: 'su1',
          width: 512,
          height: 512,
          type: 'regular',
          emoji: '🐬',
          is_animated: false,
          is_video: false,
        },
      },
      expectedMime: 'image/webp',
    },
    {
      type: 'animation',
      fixture: {
        animation: {
          file_id: 'anim123',
          file_unique_id: 'aniu1',
          width: 480,
          height: 270,
          duration: 5,
          mime_type: 'video/mp4',
          file_size: 100000,
        },
      },
      expectedMime: 'video/mp4',
    },
    {
      type: 'video_note',
      fixture: {
        video_note: {
          file_id: 'vnote123',
          file_unique_id: 'vnu1',
          length: 240,
          duration: 8,
          file_size: 50000,
        },
      },
      expectedMime: undefined,
    },
  ])(
    'emits <media type="$type"> with file_id and expected mime',
    async ({ type, fixture, expectedMime }) => {
      const msg = {
        message_id: 1,
        date: 1747731600,
        chat: { id: 1, type: 'private' as const, first_name: 'X' },
        ...fixture,
      };
      const meta = buildMetaBlock(msg as any);
      expect(meta).toContain(`<media type="${type}"`);
      expect(meta).toContain('file_id=');
      if (expectedMime) {
        expect(meta).toContain(`mime="${expectedMime}"`);
      } else {
        expect(meta).not.toContain('mime=');
      }
      await smokeParseXml(meta);
    },
  );

  it('photo: uses last (largest) PhotoSize for file_id + dimensions', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      photo: [
        {
          file_id: 'thumb_id',
          file_unique_id: 'thumb_u',
          width: 90,
          height: 67,
          file_size: 1500,
        },
        {
          file_id: 'medium_id',
          file_unique_id: 'medium_u',
          width: 320,
          height: 240,
          file_size: 8000,
        },
        {
          file_id: 'largest_id',
          file_unique_id: 'largest_u',
          width: 1280,
          height: 960,
          file_size: 50000,
        },
      ],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('file_id="largest_id"');
    expect(meta).toContain('file_unique_id="largest_u"');
    expect(meta).toContain('w="1280"');
    expect(meta).toContain('h="960"');
    expect(meta).toContain('size="50000"');
    expect(meta).not.toContain('thumb_id');
    expect(meta).not.toContain('medium_id');
    await smokeParseXml(meta);
  });

  it('document: emits name attribute from file_name', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      document: {
        file_id: 'doc123',
        file_unique_id: 'du1',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
        file_size: 20480,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('name="report.pdf"');
    expect(meta).toContain('size="20480"');
    await smokeParseXml(meta);
  });

  it('audio: emits title and performer attributes', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      audio: {
        file_id: 'audio123',
        file_unique_id: 'au1',
        duration: 180,
        mime_type: 'audio/mpeg',
        title: 'Song',
        performer: 'Band',
        file_size: 4000000,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('title="Song"');
    expect(meta).toContain('performer="Band"');
    expect(meta).toContain('duration="180"');
    await smokeParseXml(meta);
  });

  it('video_note: emits length attribute (square video diameter)', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      video_note: {
        file_id: 'vnote123',
        file_unique_id: 'vnu1',
        length: 240,
        duration: 8,
        file_size: 50000,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('length="240"');
    expect(meta).toContain('duration="8"');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — sticker mime cascade', () => {
  it('is_animated=true → application/x-tgsticker (wins over is_video)', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      sticker: {
        file_id: 'sticker123',
        file_unique_id: 'su1',
        width: 512,
        height: 512,
        type: 'regular' as const,
        is_animated: true,
        is_video: true, // proves animated wins over video
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('mime="application/x-tgsticker"');
    expect(meta).not.toContain('mime="video/webm"');
    expect(meta).not.toContain('mime="image/webp"');
    await smokeParseXml(meta);
  });
  it('is_video=true → video/webm (when is_animated false)', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      sticker: {
        file_id: 'sticker123',
        file_unique_id: 'su1',
        width: 512,
        height: 512,
        type: 'regular' as const,
        is_animated: false,
        is_video: true,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('mime="video/webm"');
    expect(meta).not.toContain('mime="application/x-tgsticker"');
    expect(meta).not.toContain('mime="image/webp"');
    await smokeParseXml(meta);
  });
  it('else → image/webp', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      sticker: {
        file_id: 'sticker123',
        file_unique_id: 'su1',
        width: 512,
        height: 512,
        type: 'regular' as const,
        is_animated: false,
        is_video: false,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('mime="image/webp"');
    expect(meta).not.toContain('mime="application/x-tgsticker"');
    expect(meta).not.toContain('mime="video/webm"');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — sticker_kind orthogonal', () => {
  it('emits sticker_kind="regular" alongside mime cascade', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      sticker: {
        file_id: 'sticker123',
        file_unique_id: 'su1',
        width: 512,
        height: 512,
        type: 'regular' as const,
        is_animated: false,
        is_video: false,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('sticker_kind="regular"');
    expect(meta).toContain('mime="image/webp"');
    await smokeParseXml(meta);
  });
  it('emits sticker_kind="mask"', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      sticker: {
        file_id: 'sticker123',
        file_unique_id: 'su1',
        width: 512,
        height: 512,
        type: 'mask' as const,
        is_animated: false,
        is_video: false,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('sticker_kind="mask"');
    await smokeParseXml(meta);
  });
  it('emits sticker_kind="custom_emoji"', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      sticker: {
        file_id: 'sticker123',
        file_unique_id: 'su1',
        width: 512,
        height: 512,
        type: 'custom_emoji' as const,
        is_animated: false,
        is_video: false,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('sticker_kind="custom_emoji"');
    await smokeParseXml(meta);
  });
  it('emits emoji and set_name when present', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      sticker: {
        file_id: 'sticker123',
        file_unique_id: 'su1',
        width: 512,
        height: 512,
        type: 'regular' as const,
        emoji: '🐬',
        set_name: 'MyPack',
        is_animated: false,
        is_video: false,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('emoji="🐬"');
    expect(meta).toContain('set_name="MyPack"');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — voice/video_note transcript', () => {
  it('voice: emits transcript_status="ok" + transcript attribute when extras.transcript.status="ok"', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      voice: {
        file_id: 'voice123',
        file_unique_id: 'voiceu1',
        duration: 10,
        mime_type: 'audio/ogg',
        file_size: 8000,
      },
    };
    const meta = buildMetaBlock(msg as any, {
      transcript: { status: 'ok', text: 'hello world' },
    });
    expect(meta).toContain('transcript_status="ok"');
    expect(meta).toContain('transcript="hello world"');
    await smokeParseXml(meta);
  });
  it('voice: emits transcript_status="failed" without transcript attribute', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      voice: {
        file_id: 'voice123',
        file_unique_id: 'voiceu1',
        duration: 10,
        mime_type: 'audio/ogg',
        file_size: 8000,
      },
    };
    const meta = buildMetaBlock(msg as any, {
      transcript: { status: 'failed' },
    });
    expect(meta).toContain('transcript_status="failed"');
    expect(meta).not.toContain('transcript="');
    await smokeParseXml(meta);
  });
  it('voice: emits transcript_status="missing_key"', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      voice: {
        file_id: 'voice123',
        file_unique_id: 'voiceu1',
        duration: 10,
        mime_type: 'audio/ogg',
        file_size: 8000,
      },
    };
    const meta = buildMetaBlock(msg as any, {
      transcript: { status: 'missing_key' },
    });
    expect(meta).toContain('transcript_status="missing_key"');
    expect(meta).not.toContain('transcript="');
    await smokeParseXml(meta);
  });
  it('voice: emits transcript_status="skipped"', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      voice: {
        file_id: 'voice123',
        file_unique_id: 'voiceu1',
        duration: 10,
        mime_type: 'audio/ogg',
        file_size: 8000,
      },
    };
    const meta = buildMetaBlock(msg as any, {
      transcript: { status: 'skipped' },
    });
    expect(meta).toContain('transcript_status="skipped"');
    expect(meta).not.toContain('transcript="');
    await smokeParseXml(meta);
  });
  it('voice: omits transcript attributes when extras undefined', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      voice: {
        file_id: 'voice123',
        file_unique_id: 'voiceu1',
        duration: 10,
        mime_type: 'audio/ogg',
        file_size: 8000,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).not.toContain('transcript_status=');
    expect(meta).not.toContain('transcript=');
    await smokeParseXml(meta);
  });
  it('video_note: emits transcript_status + transcript', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      video_note: {
        file_id: 'vnote123',
        file_unique_id: 'vnu1',
        length: 240,
        duration: 8,
        file_size: 50000,
      },
    };
    const meta = buildMetaBlock(msg as any, {
      transcript: { status: 'ok', text: 'recorded clip' },
    });
    expect(meta).toContain('<media type="video_note"');
    expect(meta).toContain('transcript_status="ok"');
    expect(meta).toContain('transcript="recorded clip"');
    await smokeParseXml(meta);
  });
  it('transcript truncates safely (no orphan surrogate at boundary)', async () => {
    // 1999 ASCII chars + 🐬 (2 UTF-16 code units = 1 code point).
    // Total = 2000 code points; safeTruncate(.., 2000) returns intact string.
    // For the orphan test, use 2000 ASCII chars + 🐬 → safeTruncate(.., 2000)
    // must drop the 🐬 entirely, not split it.
    const longText = 'a'.repeat(2000) + '🐬';
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      voice: {
        file_id: 'voice123',
        file_unique_id: 'voiceu1',
        duration: 10,
        mime_type: 'audio/ogg',
        file_size: 8000,
      },
    };
    const meta = buildMetaBlock(msg as any, {
      transcript: { status: 'ok', text: longText },
    });
    const m = meta.match(/transcript="([^"]*)"/);
    expect(m).not.toBeNull();
    const transcriptAttr = m![1];
    const lastCharCode = transcriptAttr.charCodeAt(transcriptAttr.length - 1);
    expect(lastCharCode >= 0xd800 && lastCharCode <= 0xdbff).toBe(false);
    await smokeParseXml(meta);
  });
  it('transcript: escapes XML special chars in text', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      voice: {
        file_id: 'voice123',
        file_unique_id: 'voiceu1',
        duration: 10,
        mime_type: 'audio/ogg',
        file_size: 8000,
      },
    };
    const meta = buildMetaBlock(msg as any, {
      transcript: { status: 'ok', text: 'hello "world" <tag> & end' },
    });
    expect(meta).toContain(
      'transcript="hello &quot;world&quot; &lt;tag&gt; &amp; end"',
    );
    await smokeParseXml(meta);
  });
  it('non-voice/video_note types: extras.transcript ignored', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      video: {
        file_id: 'vid123',
        file_unique_id: 'vu1',
        width: 1920,
        height: 1080,
        duration: 30,
        mime_type: 'video/mp4',
        file_size: 50000,
      },
    };
    const meta = buildMetaBlock(msg as any, {
      transcript: { status: 'ok', text: 'ignored' },
    });
    expect(meta).not.toContain('transcript_status=');
    expect(meta).not.toContain('transcript=');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <contact>', () => {
  it('emits phone, name (first+last), user_id, vcard_raw when all set', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      contact: {
        phone_number: '+79991234567',
        first_name: 'Иван',
        last_name: 'Иванов',
        user_id: 888,
        vcard: 'BEGIN:VCARD\nVERSION:3.0\nEND:VCARD',
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<contact');
    expect(meta).toContain('phone="+79991234567"');
    expect(meta).toContain('name="Иван Иванов"');
    expect(meta).toContain('user_id="888"');
    expect(meta).toContain('vcard_raw="BEGIN:VCARD');
    await smokeParseXml(meta);
  });
  it('emits only phone + name when optional fields omitted', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      contact: {
        phone_number: '+79991234567',
        first_name: 'Иван',
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<contact');
    expect(meta).toContain('phone="+79991234567"');
    expect(meta).toContain('name="Иван"');
    expect(meta).not.toContain('user_id=');
    expect(meta).not.toContain('vcard_raw=');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <location>', () => {
  it('emits lat/lon from message.location (no venue → no title/address)', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      location: { latitude: 55.75, longitude: 37.61 },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<location');
    expect(meta).toContain('lat="55.75"');
    expect(meta).toContain('lon="37.61"');
    expect(meta).not.toContain('title=');
    expect(meta).not.toContain('address=');
    await smokeParseXml(meta);
  });
  it('venue: emits lat/lon/title/address (precedence over plain location)', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      location: { latitude: 55.75, longitude: 37.61 },
      venue: {
        location: { latitude: 55.75, longitude: 37.61 },
        title: 'Кафе',
        address: 'ул. Ленина 1',
      },
    };
    const meta = buildMetaBlock(msg as any);
    const locTags = (meta.match(/<location\b/g) || []).length;
    expect(locTags).toBe(1); // venue wins, only one <location> emitted
    expect(meta).toContain('lat="55.75"');
    expect(meta).toContain('lon="37.61"');
    expect(meta).toContain('title="Кафе"');
    expect(meta).toContain('address="ул. Ленина 1"');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <poll>', () => {
  it('emits question + type, drops options', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      poll: {
        id: 'p1',
        question: 'Где встретимся?',
        options: [
          { text: 'Кафе', voter_count: 3 },
          { text: 'Парк', voter_count: 5 },
        ],
        total_voter_count: 8,
        is_closed: false,
        is_anonymous: true,
        type: 'regular' as const,
        allows_multiple_answers: false,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<poll');
    expect(meta).toContain('question="Где встретимся?"');
    expect(meta).toContain('type="regular"');
    expect(meta).not.toContain('Кафе');
    expect(meta).not.toContain('Парк');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <story>', () => {
  it('emits chat_id + story_id from message.story', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      story: {
        chat: { id: -1001, type: 'channel' as const, title: 'C' },
        id: 77,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<story');
    expect(meta).toContain('chat_id="-1001"');
    expect(meta).toContain('story_id="77"');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <via_bot>', () => {
  it('emits id/un/name when via_bot fully populated', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      via_bot: {
        id: 123456,
        is_bot: true,
        first_name: 'GIF',
        last_name: 'Bot',
        username: 'gif',
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<via_bot');
    expect(meta).toContain('id="123456"');
    expect(meta).toContain('un="gif"');
    expect(meta).toContain('name="GIF Bot"');
    // is_bot is redundant on via_bot (always true by definition) — must not be emitted on <via_bot>
    expect(meta).not.toMatch(/<via_bot[^>]*\bis_bot=/);
    await smokeParseXml(meta);
  });
  it('omits un attribute when via_bot has no username', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      via_bot: {
        id: 123456,
        is_bot: true,
        first_name: 'Anon',
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<via_bot');
    expect(meta).toContain('id="123456"');
    expect(meta).toContain('name="Anon"');
    expect(meta).not.toMatch(/<via_bot[^>]*\bun=/);
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <link_preview>', () => {
  it('emits url + disabled when both set', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'check https://example.com',
      link_preview_options: {
        url: 'https://example.com',
        is_disabled: true,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<link_preview');
    expect(meta).toContain('url="https://example.com"');
    expect(meta).toContain('disabled="1"');
    await smokeParseXml(meta);
  });
  it('emits small + large when prefer_small_media + prefer_large_media set', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'check https://example.com',
      link_preview_options: {
        prefer_small_media: true,
        prefer_large_media: true,
        show_above_text: true,
      },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<link_preview');
    expect(meta).toContain('small="1"');
    expect(meta).toContain('large="1"');
    expect(meta).toContain('above_text="1"');
    await smokeParseXml(meta);
  });
  it('NEGATIVE: link_preview_options undefined → no <link_preview> tag', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'hello',
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).not.toContain('<link_preview');
    await smokeParseXml(meta);
  });
  it('NEGATIVE: link_preview_options = {} (no fields set) → no <link_preview> tag', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      text: 'hello',
      link_preview_options: {},
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).not.toContain('<link_preview');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <m auto_fwd="1"> attribute', () => {
  it('emits auto_fwd="1" when is_automatic_forward=true', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      is_automatic_forward: true,
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toMatch(/<m\b[^>]*\bauto_fwd="1"/);
    await smokeParseXml(meta);
  });
  it('NEGATIVE: auto_fwd attribute absent when is_automatic_forward unset', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).not.toContain('auto_fwd=');
    await smokeParseXml(meta);
  });
});

describe('buildMetaBlock — <m> attribute regressions (Task 8a already-implemented)', () => {
  it('emits edited="ISO" attribute when edit_date set', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      edit_date: 1747731700,
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toMatch(/<m\b[^>]*\bedited="20\d\d-\d\d-\d\dT/);
    await smokeParseXml(meta);
  });
  it('emits media_group_id attribute when media_group_id set', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'X' },
      from: { id: 1, is_bot: false, first_name: 'X' },
      media_group_id: 'album-abc-123',
      photo: [
        {
          file_id: 'p1',
          file_unique_id: 'pu1',
          width: 100,
          height: 100,
        },
      ],
    };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toMatch(/<m\b[^>]*\bmedia_group_id="album-abc-123"/);
    await smokeParseXml(meta);
  });
});
