import { describe, it, expect } from 'vitest';

import {
  isMissingSessionError,
  resultErrorText,
  withMissingSessionFallback,
} from './missing-session.js';

const DEAD = '1667f42f-a7da-4107-baa9-c348dd662d25';

describe('isMissingSessionError', () => {
  it('matches the SDK error for a resumed session whose transcript is gone', () => {
    expect(
      isMissingSessionError(`No conversation found with session ID: ${DEAD}`),
    ).toBe(true);
    expect(
      isMissingSessionError(
        `Claude Code returned an error result: No conversation found with session ID: ${DEAD}`,
      ),
    ).toBe(true);
  });

  it('does NOT match other errors or empty input', () => {
    expect(isMissingSessionError('API Error: 529 overloaded')).toBe(false);
    expect(isMissingSessionError('error_max_turns')).toBe(false);
    expect(isMissingSessionError(null)).toBe(false);
    expect(isMissingSessionError(undefined)).toBe(false);
    expect(isMissingSessionError('')).toBe(false);
  });
});

describe('resultErrorText', () => {
  it('joins `errors` for error subtypes (they carry no `result` text)', () => {
    expect(
      resultErrorText({
        subtype: 'error_during_execution',
        errors: [`No conversation found with session ID: ${DEAD}`, 'second'],
      }),
    ).toBe(`No conversation found with session ID: ${DEAD}; second`);
  });

  it('returns `result` for a success-subtype error (e.g. API Error text)', () => {
    expect(
      resultErrorText({ subtype: 'success', result: 'API Error: 529' }),
    ).toBe('API Error: 529');
  });

  it('returns null when there is no text at all', () => {
    expect(resultErrorText({ subtype: 'error_during_execution' })).toBeNull();
    expect(resultErrorText({ subtype: 'success' })).toBeNull();
  });
});

describe('withMissingSessionFallback', () => {
  it('re-runs the turn without resume when the resumed session is missing', async () => {
    const calls: Array<string | undefined> = [];
    const out = await withMissingSessionFallback(DEAD, async (sid) => {
      calls.push(sid);
      return sid ? { missingSession: true } : { missingSession: false, text: 'hi' };
    });
    expect(calls).toEqual([DEAD, undefined]);
    expect(out.sessionId).toBeUndefined();
    expect(out.result).toEqual({ missingSession: false, text: 'hi' });
  });

  it('treats a thrown missing-session error the same way', async () => {
    const calls: Array<string | undefined> = [];
    const out = await withMissingSessionFallback(DEAD, async (sid) => {
      calls.push(sid);
      if (sid) {
        throw new Error(
          `Claude Code returned an error result: No conversation found with session ID: ${sid}`,
        );
      }
      return { missingSession: false };
    });
    expect(calls).toEqual([DEAD, undefined]);
    expect(out.sessionId).toBeUndefined();
    expect(out.result.missingSession).toBe(false);
  });

  it('runs once and keeps the session when it exists', async () => {
    const calls: Array<string | undefined> = [];
    const out = await withMissingSessionFallback(DEAD, async (sid) => {
      calls.push(sid);
      return { missingSession: false };
    });
    expect(calls).toEqual([DEAD]);
    expect(out.sessionId).toBe(DEAD);
  });

  it('does not loop: a fresh session reporting missing is returned as-is', async () => {
    const calls: Array<string | undefined> = [];
    const out = await withMissingSessionFallback(undefined, async (sid) => {
      calls.push(sid);
      return { missingSession: true };
    });
    expect(calls).toEqual([undefined]);
    expect(out.result.missingSession).toBe(true);
  });

  it('propagates unrelated errors', async () => {
    await expect(
      withMissingSessionFallback(DEAD, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
