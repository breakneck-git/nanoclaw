import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, db, storeChatMetadata } from './db.js';
import { getAvailableGroups, _setRegisteredGroups } from './index.js';
import { routeOutbound } from './router.js';
import { logger } from './logger.js';
import type { Channel } from './types.js';

beforeEach(() => {
  _initTestDatabase();
  _setRegisteredGroups({});
});

// --- JID ownership patterns ---

describe('JID ownership patterns', () => {
  // These test the patterns that will become ownsJid() on the Channel interface

  it('WhatsApp group JID: ends with @g.us', () => {
    const jid = '12345678@g.us';
    expect(jid.endsWith('@g.us')).toBe(true);
  });

  it('WhatsApp DM JID: ends with @s.whatsapp.net', () => {
    const jid = '12345678@s.whatsapp.net';
    expect(jid.endsWith('@s.whatsapp.net')).toBe(true);
  });
});

// --- getAvailableGroups ---

describe('getAvailableGroups', () => {
  it('returns only groups, excludes DMs', () => {
    storeChatMetadata(
      'group1@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group 1',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'user@s.whatsapp.net',
      '2024-01-01T00:00:02.000Z',
      'User DM',
      'whatsapp',
      false,
    );
    storeChatMetadata(
      'group2@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group 2',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.jid)).toContain('group1@g.us');
    expect(groups.map((g) => g.jid)).toContain('group2@g.us');
    expect(groups.map((g) => g.jid)).not.toContain('user@s.whatsapp.net');
  });

  it('excludes __group_sync__ sentinel', () => {
    storeChatMetadata('__group_sync__', '2024-01-01T00:00:00.000Z');
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:01.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('marks registered groups correctly', () => {
    storeChatMetadata(
      'reg@g.us',
      '2024-01-01T00:00:01.000Z',
      'Registered',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'unreg@g.us',
      '2024-01-01T00:00:02.000Z',
      'Unregistered',
      'whatsapp',
      true,
    );

    _setRegisteredGroups({
      'reg@g.us': {
        name: 'Registered',
        folder: 'registered',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    });

    const groups = getAvailableGroups();
    const reg = groups.find((g) => g.jid === 'reg@g.us');
    const unreg = groups.find((g) => g.jid === 'unreg@g.us');

    expect(reg?.isRegistered).toBe(true);
    expect(unreg?.isRegistered).toBe(false);
  });

  it('returns groups ordered by most recent activity', () => {
    storeChatMetadata(
      'old@g.us',
      '2024-01-01T00:00:01.000Z',
      'Old',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'new@g.us',
      '2024-01-01T00:00:05.000Z',
      'New',
      'whatsapp',
      true,
    );
    storeChatMetadata(
      'mid@g.us',
      '2024-01-01T00:00:03.000Z',
      'Mid',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups[0].jid).toBe('new@g.us');
    expect(groups[1].jid).toBe('mid@g.us');
    expect(groups[2].jid).toBe('old@g.us');
  });

  it('excludes non-group chats regardless of JID format', () => {
    // Unknown JID format stored without is_group should not appear
    storeChatMetadata(
      'unknown-format-123',
      '2024-01-01T00:00:01.000Z',
      'Unknown',
    );
    // Explicitly non-group with unusual JID
    storeChatMetadata(
      'custom:abc',
      '2024-01-01T00:00:02.000Z',
      'Custom DM',
      'custom',
      false,
    );
    // A real group for contrast
    storeChatMetadata(
      'group@g.us',
      '2024-01-01T00:00:03.000Z',
      'Group',
      'whatsapp',
      true,
    );

    const groups = getAvailableGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].jid).toBe('group@g.us');
  });

  it('returns empty array when no chats exist', () => {
    const groups = getAvailableGroups();
    expect(groups).toHaveLength(0);
  });
});

// --- routeOutbound — SEND/STORE isolation (Task 13) ---

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'test',
    connect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ messageId: 'tg-default' }),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn().mockReturnValue(true),
    disconnect: vi.fn(),
    botSenderId: vi.fn().mockReturnValue('bot-default'),
    ...overrides,
  } as Channel;
}

describe('routeOutbound — SEND/STORE isolation', () => {
  it('SEND success → STORE called with messageId from sendMessage', async () => {
    const channel = makeChannel({
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'tg-123' }),
      botSenderId: vi.fn().mockReturnValue('bot42'),
    });

    await routeOutbound([channel], 'tg:1', 'hello');

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'tg:1',
      'hello',
      undefined,
    );
    const row = db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ?`)
      .get('tg:1') as {
      id: string;
      sender: string;
      content: string;
      is_bot_message: number;
      meta: string | null;
    };
    expect(row).toBeDefined();
    expect(row.id).toBe('tg-123');
    expect(row.sender).toBe('bot42');
    expect(row.content).toBe('hello');
    expect(row.is_bot_message).toBe(1);
    expect(row.meta).toBeNull();
  });

  it('SEND throws → routeOutbound throws → STORE NOT called', async () => {
    const channel = makeChannel({
      sendMessage: vi.fn().mockRejectedValue(new Error('send failed')),
      botSenderId: vi.fn().mockReturnValue('bot42'),
    });

    await expect(routeOutbound([channel], 'tg:1', 'hello')).rejects.toThrow(
      'send failed',
    );

    const row = db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ?`)
      .get('tg:1');
    expect(row).toBeUndefined();
  });

  it('SEND succeeds but STORE throws → does NOT propagate (logged only)', async () => {
    const channel = makeChannel({
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'tg-xyz' }),
      botSenderId: vi.fn().mockReturnValue('bot42'),
    });

    // Drop the messages table so the internal INSERT throws. STORE failure
    // must NOT propagate; routeOutbound must still resolve. The messageId
    // from the successful send is surfaced regardless of the DB hiccup
    // (StreamingMessage needs it to drive subsequent edits).
    db.prepare('DROP TABLE messages').run();
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(
      routeOutbound([channel], 'tg:1', 'hello'),
    ).resolves.toEqual({ messageId: 'tg-xyz' });
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('Channel without botSenderId method → senderId falls back to "bot"', async () => {
    // Build a channel object literal w/o botSenderId — exercises the
    // `channel.botSenderId?.()` optional-call path.
    const channel: Channel = {
      name: 'test',
      connect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'tg-1' }),
      isConnected: vi.fn().mockReturnValue(true),
      ownsJid: vi.fn().mockReturnValue(true),
      disconnect: vi.fn(),
      // No botSenderId method
    };

    await routeOutbound([channel], 'tg:1', 'hello');

    const row = db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ?`)
      .get('tg:1') as { id: string; sender: string };
    expect(row.id).toBe('tg-1');
    // storeOutboundMessage falls back to literal 'bot' when senderId is undefined.
    expect(row.sender).toBe('bot');
  });

  it('No matching channel → throws "No channel for JID"', async () => {
    await expect(routeOutbound([], 'tg:1', 'hello')).rejects.toThrow(
      /No channel/,
    );
  });

  it('sendMessage returns void (no messageId) → synthetic id assigned', async () => {
    const channel = makeChannel({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      botSenderId: vi.fn().mockReturnValue('bot42'),
    });

    await routeOutbound([channel], 'tg:1', 'hello');

    const row = db
      .prepare(`SELECT * FROM messages WHERE chat_jid = ?`)
      .get('tg:1') as { id: string; sender: string; meta: string | null };
    expect(row.id).toMatch(/^out-/);
    expect(row.sender).toBe('bot42');
    expect(row.meta).toBe('<m kind="outbound-synthetic"/>');
  });

  it('returns { messageId } when sendMessage produces one (for StreamingMessage)', async () => {
    // StreamingMessage needs the messageId from its first send to drive
    // subsequent edits — routeOutbound surfaces it through the return value.
    const channel = makeChannel({
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'tg-42' }),
      botSenderId: vi.fn().mockReturnValue('bot42'),
    });

    const res = await routeOutbound([channel], 'tg:1', 'hello');
    expect(res).toEqual({ messageId: 'tg-42' });
  });

  it('returns void when sendMessage returns no messageId', async () => {
    const channel = makeChannel({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      botSenderId: vi.fn().mockReturnValue('bot42'),
    });

    const res = await routeOutbound([channel], 'tg:1', 'hello');
    expect(res).toBeUndefined();
  });
});
