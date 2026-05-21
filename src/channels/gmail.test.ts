import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

import { GmailChannel, GmailChannelOpts } from './gmail.js';

function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  };
}

describe('GmailChannel', () => {
  let channel: GmailChannel;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
      expect(channel.ownsJid('user@s.whatsapp.net')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(channel.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GmailChannel(makeOpts(), 30000);
      expect(ch.name).toBe('gmail');
    });

    it('defaults to unread query when no filter configured', () => {
      const ch = new GmailChannel(makeOpts());
      const query = (
        ch as unknown as { buildQuery: () => string }
      ).buildQuery();
      expect(query).toBe('is:unread category:primary');
    });

    it('defaults with no options provided', () => {
      const ch = new GmailChannel(makeOpts());
      expect(ch.name).toBe('gmail');
    });
  });

  describe('sendMessage id fallback', () => {
    // googleapis Schema$Message.id is `string | null | undefined`, but the
    // type system claim doesn't prevent ''. `?? undefined` would NOT fire on
    // empty string — an empty-id reply would survive into messages.id PRIMARY
    // KEY and the NEXT empty-id send would INSERT OR REPLACE the prior row.
    // The fix is `rawId && rawId.length > 0 ? rawId : undefined` so '' also
    // falls through to the synthetic-id path.

    interface SendableChannel {
      gmail: { users: { messages: { send: ReturnType<typeof vi.fn> } } };
      threadMeta: Map<string, unknown>;
      userEmail: string;
    }

    function rigSendable(
      ch: GmailChannel,
      sendReturn: { data: { id: string | null | undefined } },
    ): ReturnType<typeof vi.fn> {
      const sendMock = vi.fn().mockResolvedValue(sendReturn);
      const priv = ch as unknown as SendableChannel;
      priv.gmail = {
        users: { messages: { send: sendMock } },
      };
      priv.userEmail = 'bot@example.com';
      priv.threadMeta.set('thread-abc', {
        sender: 'alice@example.com',
        senderName: 'Alice',
        subject: 'Hi',
        messageId: '<orig@gmail>',
      });
      return sendMock;
    }

    it('valid id: returns messageId', async () => {
      const ch = new GmailChannel(makeOpts());
      rigSendable(ch, { data: { id: 'gmail-id-123' } });
      const out = await ch.sendMessage('gmail:thread-abc', 'hello');
      expect(out).toEqual({ messageId: 'gmail-id-123' });
    });

    it('null id: returns undefined', async () => {
      const ch = new GmailChannel(makeOpts());
      rigSendable(ch, { data: { id: null } });
      const out = await ch.sendMessage('gmail:thread-abc', 'hello');
      expect(out).toEqual({ messageId: undefined });
    });

    it("empty-string id '' (round-10 regression case): returns undefined via truthy check", async () => {
      const ch = new GmailChannel(makeOpts());
      rigSendable(ch, { data: { id: '' } });
      const out = await ch.sendMessage('gmail:thread-abc', 'hello');
      expect(out).toEqual({ messageId: undefined });
    });
  });

  describe('botSenderId', () => {
    it('returns configured userEmail when set', () => {
      const ch = new GmailChannel(makeOpts());
      (ch as unknown as { userEmail: string }).userEmail = 'alice@example.com';
      expect(ch.botSenderId()).toBe('alice@example.com');
    });

    it('returns undefined when not connected', () => {
      const ch = new GmailChannel(makeOpts());
      // userEmail defaults to '' before connect
      expect(ch.botSenderId()).toBeUndefined();
    });
  });
});
