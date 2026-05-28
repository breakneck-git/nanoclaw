import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startTypingKeepalive } from './typing-keepalive.js';
import type { Channel } from './types.js';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function fakeChannel(): Channel & { setTyping: ReturnType<typeof vi.fn> } {
  return {
    name: 'fake',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: vi.fn(),
    setTyping: vi.fn().mockResolvedValue(undefined),
  };
}

describe('startTypingKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('fires immediately on start', () => {
    const ch = fakeChannel();
    const h = startTypingKeepalive(ch, 'tg:1');
    expect(ch.setTyping).toHaveBeenCalledTimes(1);
    expect(ch.setTyping).toHaveBeenCalledWith('tg:1', true, {
      threadId: undefined,
    });
    h.stop();
  });

  it('re-pings every 4 seconds', () => {
    const ch = fakeChannel();
    const h = startTypingKeepalive(ch, 'tg:1');
    expect(ch.setTyping).toHaveBeenCalledTimes(1); // immediate
    vi.advanceTimersByTime(3999);
    expect(ch.setTyping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    expect(ch.setTyping).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4000);
    expect(ch.setTyping).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it('passes threadId on every refresh', () => {
    const ch = fakeChannel();
    const h = startTypingKeepalive(ch, 'tg:1', '42');
    expect(ch.setTyping).toHaveBeenCalledWith('tg:1', true, { threadId: '42' });
    vi.advanceTimersByTime(4000);
    expect(ch.setTyping).toHaveBeenLastCalledWith('tg:1', true, {
      threadId: '42',
    });
    h.stop();
  });

  it('stops refreshing after stop()', () => {
    const ch = fakeChannel();
    const h = startTypingKeepalive(ch, 'tg:1');
    expect(ch.setTyping).toHaveBeenCalledTimes(1);
    h.stop();
    vi.advanceTimersByTime(10_000);
    expect(ch.setTyping).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent', () => {
    const ch = fakeChannel();
    const h = startTypingKeepalive(ch, 'tg:1');
    h.stop();
    expect(() => h.stop()).not.toThrow();
    h.stop();
    vi.advanceTimersByTime(10_000);
    expect(ch.setTyping).toHaveBeenCalledTimes(1);
  });

  it('no-op when channel lacks setTyping', () => {
    const ch = { ...fakeChannel(), setTyping: undefined } as unknown as Channel;
    const h = startTypingKeepalive(ch, 'tg:1');
    expect(() => h.stop()).not.toThrow();
  });

  it('no-op when channel is undefined', () => {
    const h = startTypingKeepalive(undefined, 'tg:1');
    expect(() => h.stop()).not.toThrow();
  });

  it('does not crash when channel.setTyping rejects', () => {
    const ch = fakeChannel();
    ch.setTyping.mockRejectedValueOnce(new Error('Telegram 429'));
    const h = startTypingKeepalive(ch, 'tg:1');
    // Should not throw synchronously
    expect(() => vi.advanceTimersByTime(4000)).not.toThrow();
    h.stop();
  });
});
