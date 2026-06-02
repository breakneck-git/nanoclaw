import { describe, it, expect } from 'vitest';

import {
  isOverloadError,
  overloadRetryStep,
  OVERLOAD_BACKOFF_MS,
  OVERLOAD_NOTIFY_AFTER_ATTEMPT,
} from './overload-retry.js';

describe('isOverloadError', () => {
  it('matches transient overloads (429/503/529/overloaded)', () => {
    expect(
      isOverloadError(
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe(true);
    expect(isOverloadError('API Error: 503 service unavailable')).toBe(true);
    expect(isOverloadError('API Error: 429 rate limit')).toBe(true);
    expect(isOverloadError('The server is Overloaded')).toBe(true);
  });

  it('does NOT match non-transient errors or empty input', () => {
    expect(isOverloadError('API Error: 400 invalid request')).toBe(false);
    expect(isOverloadError('error_max_turns: reached limit')).toBe(false);
    expect(isOverloadError('permission denied')).toBe(false);
    expect(isOverloadError(null)).toBe(false);
    expect(isOverloadError(undefined)).toBe(false);
    expect(isOverloadError('')).toBe(false);
  });
});

describe('overloadRetryStep', () => {
  it('schedules 6 retries at 1/4/8/16/32/64s', () => {
    expect(OVERLOAD_BACKOFF_MS).toEqual([
      1000, 4000, 8000, 16000, 32000, 64000,
    ]);
    expect(overloadRetryStep(0).nextWaitMs).toBe(1000);
    expect(overloadRetryStep(1).nextWaitMs).toBe(4000);
    expect(overloadRetryStep(2).nextWaitMs).toBe(8000);
    expect(overloadRetryStep(3).nextWaitMs).toBe(16000);
    expect(overloadRetryStep(4).nextWaitMs).toBe(32000);
    expect(overloadRetryStep(5).nextWaitMs).toBe(64000);
  });

  it('notifies the user only after the 2nd retry', () => {
    expect(OVERLOAD_NOTIFY_AFTER_ATTEMPT).toBe(2);
    for (let a = 0; a <= 6; a++) {
      expect(overloadRetryStep(a).notify).toBe(a === 2);
    }
  });

  it('is exhausted only after the 6th retry (attempt 6)', () => {
    for (let a = 0; a < OVERLOAD_BACKOFF_MS.length; a++) {
      expect(overloadRetryStep(a).exhausted).toBe(false);
    }
    expect(overloadRetryStep(6).exhausted).toBe(true);
    expect(overloadRetryStep(6).nextWaitMs).toBeNull();
  });

  it('spans ~125s total across all retries', () => {
    const total = OVERLOAD_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe(125000);
  });
});
