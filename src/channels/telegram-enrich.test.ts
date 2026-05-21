import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  queueEnrich,
  _test_primeCache,
  _test_getQueueSize,
  _test_resetState,
} from './telegram-enrich.js';
import * as db from '../db.js';

vi.mock('../db.js', () => ({
  upsertContact: vi.fn(),
}));

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
});
