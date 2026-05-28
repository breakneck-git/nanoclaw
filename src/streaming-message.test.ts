/**
 * Behavior tests for the StreamingMessage class (native-draft renderer).
 *
 * StreamingMessage throttles a stream of `append(chunk)` calls into a small
 * number of `sendDraft(text)` pushes, where each push carries the WHOLE visible
 * buffer so far (Telegram's sendMessageDraft replaces the bubble). It hides
 * `<internal>...</internal>` blocks (cross-chunk safe) and clamps the preview to
 * DRAFT_MAX_LEN. The draft is an ephemeral preview — `finish()` simply stops
 * further updates; the real persisted message is sent separately by the
 * orchestrator, so finish() neither flushes nor persists anything.
 *
 * The implementation uses real `setTimeout`/`Date.now`, so we drive it with
 * `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StreamingMessage,
  DRAFT_THROTTLE_MS,
  DRAFT_MAX_LEN,
} from './streaming-message.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makeDeps(sendImpl?: (text: string) => Promise<void>) {
  const sendDraft = vi.fn(sendImpl ?? (async (_text: string) => {}));
  return { sendDraft };
}

describe('StreamingMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throttles a single append into one sendDraft after the throttle window', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('Hello');
    // Nothing fires synchronously — the push is always scheduled on a timer.
    expect(deps.sendDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);

    expect(deps.sendDraft).toHaveBeenCalledTimes(1);
    expect(deps.sendDraft).toHaveBeenCalledWith('Hello');
  });

  it('coalesces appends inside the throttle window into a single push', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('Hello ');
    sm.append('world');
    expect(deps.sendDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);

    expect(deps.sendDraft).toHaveBeenCalledTimes(1);
    expect(deps.sendDraft).toHaveBeenCalledWith('Hello world');
  });

  it('each push carries the full accumulated buffer (cumulative, not deltas)', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('first');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);
    expect(deps.sendDraft).toHaveBeenNthCalledWith(1, 'first');

    sm.append(' second');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);

    expect(deps.sendDraft).toHaveBeenCalledTimes(2);
    expect(deps.sendDraft).toHaveBeenNthCalledWith(2, 'first second');
  });

  it('strips an <internal>...</internal> block inside a single chunk', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('before <internal>thinking</internal> after');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);

    expect(deps.sendDraft).toHaveBeenCalledWith('before  after');
  });

  it('handles an <internal> block split across multiple chunks', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    // First chunk opens the tag but does not close it. The visible text up to
    // this point is just "visible ".
    sm.append('visible <internal>secret ');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);
    expect(deps.sendDraft).toHaveBeenNthCalledWith(1, 'visible ');

    // Second chunk closes the tag and adds more visible text.
    sm.append('more secret</internal> after');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);

    expect(deps.sendDraft).toHaveBeenNthCalledWith(2, 'visible  after');
  });

  it('defers a chunk that ends on a partial tag prefix until the next append', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    // Trailing "<" is a prefix of "<internal>" → deferred, not yet visible.
    sm.append('compare a <');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);
    expect(deps.sendDraft).toHaveBeenNthCalledWith(1, 'compare a ');

    // Next chunk resolves it to literal text — the "<" surfaces now.
    sm.append('b');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);
    expect(deps.sendDraft).toHaveBeenNthCalledWith(2, 'compare a <b');
  });

  it('clamps the preview to DRAFT_MAX_LEN characters', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('A'.repeat(DRAFT_MAX_LEN + 1000));
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);

    expect(deps.sendDraft).toHaveBeenCalledTimes(1);
    const sent = deps.sendDraft.mock.calls[0][0];
    expect(sent.length).toBe(DRAFT_MAX_LEN);
    expect(sent).toBe('A'.repeat(DRAFT_MAX_LEN));
  });

  it('does not push when the visible buffer is empty (only <internal> content)', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('<internal>only thinking</internal>');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS * 2);

    expect(deps.sendDraft).not.toHaveBeenCalled();
  });

  it('finish() before the throttle fires cancels the pending push (draft is ephemeral)', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('immediate');
    // Don't advance — the throttle window has NOT elapsed.
    expect(deps.sendDraft).not.toHaveBeenCalled();

    sm.finish();
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS * 2);

    // No push: the real message is sent by the orchestrator, not the draft.
    expect(deps.sendDraft).not.toHaveBeenCalled();
  });

  it('after finish(), additional append() calls do not trigger further pushes', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('first');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);
    expect(deps.sendDraft).toHaveBeenCalledTimes(1);

    sm.finish();
    sm.append('second');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS * 3);

    expect(deps.sendDraft).toHaveBeenCalledTimes(1);
  });

  it('finish() is idempotent — a second call is a no-op and does not throw', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('x');
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);
    expect(deps.sendDraft).toHaveBeenCalledTimes(1);

    sm.finish();
    sm.finish();
    expect(deps.sendDraft).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected sendDraft so it never escapes append/flush', async () => {
    const deps = makeDeps(async () => {
      throw new Error('Bad Request: draft expired');
    });
    const sm = new StreamingMessage(deps);

    sm.append('boom');
    // Must not throw / reject out of the throttled flush.
    await vi.advanceTimersByTimeAsync(DRAFT_THROTTLE_MS);

    expect(deps.sendDraft).toHaveBeenCalledTimes(1);
  });
});
