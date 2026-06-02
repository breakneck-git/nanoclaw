/**
 * Overload-retry policy for the agent-runner.
 *
 * When a call to Anthropic stays overloaded (429/503/529) past the SDK's and
 * the proxy's own retries, the harness re-runs the whole turn on this backoff
 * and notifies the user after the 2nd retry. Kept as pure functions so the
 * policy is unit-testable without spinning up the SDK / a container.
 */

// Backoff (ms) before each retry: 1, 4, 8, 16, 32, 64s — 6 retries, ~125s.
export const OVERLOAD_BACKOFF_MS = [1000, 4000, 8000, 16000, 32000, 64000];

// Send the "please wait" notice after this many failed attempts. Attempt 0 is
// the initial try, so 2 means "after the 2nd retry".
export const OVERLOAD_NOTIFY_AFTER_ATTEMPT = 2;

const OVERLOAD_PATTERN = /(\b(429|503|529)\b)|overloaded/i;

/**
 * True when an error/result text is a transient Anthropic overload worth
 * retrying (429/503/529, or the word "overloaded"). Callers must already know
 * the result was an error (is_error / a throw) — this only classifies
 * retryability, so matching "529" inside otherwise-normal text is harmless.
 */
export function isOverloadError(text: string | null | undefined): boolean {
  return !!text && OVERLOAD_PATTERN.test(text);
}

export interface OverloadRetryStep {
  /** No retries left — give up and surface the error. */
  exhausted: boolean;
  /** Send the "please wait" notice now (once). */
  notify: boolean;
  /** Wait this many ms before the next attempt; null when exhausted. */
  nextWaitMs: number | null;
}

/**
 * Decide what to do after a just-completed attempt failed with an overload.
 * `attempt` is 0 for the initial try, 1 for the 1st retry, and so on. The
 * returned `nextWaitMs` is the delay before attempt `attempt + 1`.
 */
export function overloadRetryStep(attempt: number): OverloadRetryStep {
  const exhausted = attempt >= OVERLOAD_BACKOFF_MS.length;
  return {
    exhausted,
    notify: attempt === OVERLOAD_NOTIFY_AFTER_ATTEMPT,
    nextWaitMs: exhausted ? null : OVERLOAD_BACKOFF_MS[attempt],
  };
}
