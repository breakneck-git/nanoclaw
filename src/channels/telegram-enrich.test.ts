import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GrammyError } from 'grammy';
import {
  queueEnrich,
  startEnrichWorker,
  _test_primeCache,
  _test_getQueueSize,
  _test_resetState,
  _test_getCacheRecord,
} from './telegram-enrich.js';
import * as db from '../db.js';

vi.mock('../db.js', () => ({
  upsertContact: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

function makeGrammyError(code: number, description: string): GrammyError {
  return new GrammyError(
    `Call to 'getChat' failed!`,
    { ok: false, error_code: code, description },
    'getChat',
    {},
  );
}

describe('telegram-enrich', () => {
  beforeEach(() => {
    _test_resetState();
    vi.mocked(db.upsertContact).mockClear();
  });

  it('(a) dedupes 100 calls for same scope+username into 1 queue entry', () => {
    for (let i = 0; i < 100; i++) queueEnrich('group-A', 'vasya');
    expect(_test_getQueueSize()).toBe(1);
  });

  it('(b) cache hit within 24h success TTL is no-op on the queue', () => {
    _test_primeCache('vasya', {
      kind: 'success',
      ts: Date.now() - 23 * 3600_000,
      data: { bio: 'engineer' },
    });
    queueEnrich('group-A', 'vasya');
    expect(_test_getQueueSize()).toBe(0);
  });

  it('(c) cache miss after 25h re-queues', () => {
    _test_primeCache('vasya', {
      kind: 'success',
      ts: Date.now() - 25 * 3600_000,
      data: {},
    });
    queueEnrich('group-A', 'vasya');
    expect(_test_getQueueSize()).toBe(1);
  });

  it('(d) failure 6d23h ago does NOT re-queue (7d failure TTL)', () => {
    _test_primeCache('vasya', {
      kind: 'failure',
      ts: Date.now() - (6 * 24 + 23) * 3600_000,
    });
    queueEnrich('group-A', 'vasya');
    expect(_test_getQueueSize()).toBe(0);
  });

  it('(e) cross-scope cache hit applies upsertContact per-scope (round-10 fix)', () => {
    _test_primeCache('vasya', {
      kind: 'success',
      ts: Date.now(),
      data: { bio: 'engineer', kind: 'user' },
    });
    queueEnrich('group-A', 'vasya');
    queueEnrich('group-B', 'vasya');
    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(db.upsertContact).mock.calls;
    expect(calls[0][0]).toBe('group-A');
    expect(calls[1][0]).toBe('group-B');
    // upsertContact signature: (scope, patch, opts)
    expect(calls[0][1]).toMatchObject({ bio: 'engineer', kind: 'user' });
    expect(calls[0][2].source).toBe('getChat');
    expect(calls[0][2].enriched).toBe(1);
    expect(calls[0][2].identity).toMatchObject({ username: 'vasya' });
  });

  describe('worker error discrimination + cache recheck', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('(f) worker: 400 GrammyError caches failure record', async () => {
      const getChat = vi
        .fn()
        .mockRejectedValue(makeGrammyError(400, 'Bad Request: chat not found'));
      const bot = { api: { getChat } } as never;
      const handle = startEnrichWorker(bot, {} as never);
      try {
        queueEnrich('group-A', 'ghost');
        await vi.advanceTimersByTimeAsync(1000);
        // Drain microtasks from the rejected promise.
        await Promise.resolve();
        await Promise.resolve();
        expect(getChat).toHaveBeenCalledTimes(1);
        const rec = _test_getCacheRecord('ghost');
        expect(rec?.kind).toBe('failure');
        expect(db.upsertContact).not.toHaveBeenCalled();
      } finally {
        handle.stop();
      }
    });

    it('(g) worker: 5xx/network error does NOT cache failure (will retry)', async () => {
      const getChat = vi.fn().mockRejectedValue(new Error('network timeout'));
      const bot = { api: { getChat } } as never;
      const handle = startEnrichWorker(bot, {} as never);
      try {
        queueEnrich('group-A', 'glitchy');
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        await Promise.resolve();
        expect(getChat).toHaveBeenCalledTimes(1);
        const rec = _test_getCacheRecord('glitchy');
        expect(rec).toBeUndefined();
        expect(db.upsertContact).not.toHaveBeenCalled();
      } finally {
        handle.stop();
      }
    });

    it('(h) worker: skips API call when cache populated mid-drain (sibling scope already resolved)', async () => {
      // Two scopes enqueue same username; first tick resolves it, second
      // tick must NOT re-call getChat — it should use the cached patch.
      const getChat = vi.fn().mockResolvedValue({
        id: 123,
        type: 'private',
        first_name: 'Vasya',
        bio: 'engineer',
      });
      const bot = { api: { getChat } } as never;
      const handle = startEnrichWorker(bot, {} as never);
      try {
        queueEnrich('group-A', 'vasya');
        // queueEnrich for a different scope while A's entry is still queued
        queueEnrich('group-B', 'vasya');
        expect(_test_getQueueSize()).toBe(2);

        // Tick 1: drain entry for group-A (rate limit = 1/s, one entry/tick).
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        await Promise.resolve();
        expect(getChat).toHaveBeenCalledTimes(1);

        // Tick 2: drain entry for group-B — cache is warm, must skip API.
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.resolve();
        await Promise.resolve();
        expect(getChat).toHaveBeenCalledTimes(1); // STILL one call
        expect(db.upsertContact).toHaveBeenCalledTimes(2);
        const calls = vi.mocked(db.upsertContact).mock.calls;
        expect(calls[0][0]).toBe('group-A');
        expect(calls[1][0]).toBe('group-B');
      } finally {
        handle.stop();
      }
    });
  });
});
