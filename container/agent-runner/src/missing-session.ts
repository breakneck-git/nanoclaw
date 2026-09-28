/**
 * Recovery from resuming a session whose transcript no longer exists.
 *
 * The host stores one session ID per group and passes it back as `resume`.
 * If the transcript was deleted (by the user, by Claude Code cleanup, …) the
 * SDK fails the turn with "No conversation found with session ID: <id>".
 * Without recovery every retry resumes the same dead ID and the message is
 * eventually dropped. Instead: forget the session and run the turn fresh.
 * Kept as pure functions so the policy is unit-testable without the SDK.
 */

const MISSING_SESSION_PATTERN = /No conversation found with session ID/i;

export function isMissingSessionError(text: string | null | undefined): boolean {
  return !!text && MISSING_SESSION_PATTERN.test(text);
}

/**
 * Error text of an `is_error` result message. Error subtypes
 * (error_during_execution, …) carry no `result`, only `errors[]` — the SDK
 * itself joins them with "; " when it rethrows.
 */
export function resultErrorText(message: {
  subtype?: string;
  result?: string;
  errors?: string[];
}): string | null {
  if (message.subtype === 'success') return message.result || null;
  return message.errors?.length ? message.errors.join('; ') : null;
}

/**
 * Run a turn with `sessionId`; if that session is missing (reported as a
 * result or thrown), run it once more with no session. Returns the result and
 * the session ID the turn actually ran with (undefined after a fallback).
 */
export async function withMissingSessionFallback<R extends { missingSession?: boolean }>(
  sessionId: string | undefined,
  run: (sessionId: string | undefined) => Promise<R>,
  onDrop?: (deadSessionId: string) => void,
): Promise<{ result: R; sessionId: string | undefined }> {
  if (sessionId) {
    try {
      const result = await run(sessionId);
      if (!result.missingSession) return { result, sessionId };
    } catch (err) {
      if (!isMissingSessionError(err instanceof Error ? err.message : String(err))) throw err;
    }
    onDrop?.(sessionId);
  }
  return { result: await run(undefined), sessionId: undefined };
}
