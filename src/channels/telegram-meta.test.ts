import { describe, it, expect } from 'vitest';
import { parseStringPromise } from 'xml2js';
import {
  buildMetaBlock,
  escapeXmlAttr,
  escapeXmlText,
} from './telegram-meta.js';

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
