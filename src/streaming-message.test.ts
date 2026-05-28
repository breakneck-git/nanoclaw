/**
 * Behavior tests for the StreamingMessage class.
 *
 * StreamingMessage debounces a stream of `append(chunk)` calls into a small
 * number of Telegram sendMessage/editMessage calls, hides `<internal>...`
 * blocks from the visible buffer (cross-chunk safe), and splits into a fresh
 * Telegram message when the running buffer would exceed the per-message cap.
 *
 * The implementation uses real `setTimeout` so we drive it with
 * `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamingMessage, FLUSH_DEBOUNCE_MS } from './streaming-message.js';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makeDeps(
  opts: {
    sendImpl?: (text: string) => Promise<string | undefined>;
    editImpl?: (id: string, text: string) => Promise<void>;
  } = {},
) {
  const sendMessage = vi.fn(
    opts.sendImpl ?? (async (_text: string) => 'msg-1'),
  );
  const editMessage = vi.fn(opts.editImpl ?? (async () => {}));
  return { sendMessage, editMessage };
}

describe('StreamingMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces a single append into one sendMessage call after the debounce window', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('Hello');
    // Nothing fires synchronously.
    expect(deps.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('Hello');
    expect(deps.editMessage).not.toHaveBeenCalled();
  });

  it('coalesces two appends inside the debounce window into a single flush', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('Hello ');
    sm.append('world');
    expect(deps.sendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('Hello world');
  });

  it('subsequent flushes use editMessage with the returned messageId', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('first');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);

    sm.append(' second');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    expect(deps.editMessage).toHaveBeenCalledTimes(1);
    expect(deps.editMessage).toHaveBeenCalledWith('msg-1', 'first second');
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('strips an <internal>...</internal> block inside a single chunk', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('before <internal>thinking</internal> after');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    expect(deps.sendMessage).toHaveBeenCalledWith('before  after');
  });

  it('handles an <internal> block split across multiple chunks', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    // First chunk opens the tag but does not close it. The buffer must NOT
    // include the partial tag content yet — the visible text up to this point
    // is just "visible ".
    sm.append('visible <internal>secret ');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    // The first flush goes out with just the visible prefix.
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('visible ');

    // Second chunk closes the tag and adds more visible text.
    sm.append('more secret</internal> after');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    expect(deps.editMessage).toHaveBeenCalledTimes(1);
    expect(deps.editMessage).toHaveBeenCalledWith('msg-1', 'visible  after');
  });

  it('overflow (> MAX_MESSAGE_LEN): splits into a new message, edit head + send tail', async () => {
    // Generate text that crosses the 3500 cap on a single flush.
    let sendIds = 0;
    const deps = makeDeps({
      sendImpl: async () => {
        sendIds++;
        return `msg-${sendIds}`;
      },
    });
    const sm = new StreamingMessage(deps);

    const big = 'A'.repeat(3000);
    sm.append(big);
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    // First flush: under cap → single sendMessage.
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenLastCalledWith('A'.repeat(3000));

    // Next chunk pushes total over the cap.
    sm.append('B'.repeat(1000));
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    // Head (first 3500) edited into msg-1, tail (remaining 500) sent as new.
    expect(deps.editMessage).toHaveBeenCalledTimes(1);
    const [editedId, editedText] = deps.editMessage.mock.calls[0];
    expect(editedId).toBe('msg-1');
    expect(editedText.length).toBe(3500);
    expect(editedText).toBe('A'.repeat(3000) + 'B'.repeat(500));

    // Tail goes out as a fresh sendMessage with the remaining 500 Bs.
    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
    expect(deps.sendMessage).toHaveBeenLastCalledWith('B'.repeat(500));
  });

  it('swallows "message is not modified" errors silently', async () => {
    const deps = makeDeps({
      editImpl: async () => {
        const err = new Error(
          'Bad Request: message is not modified: specified new message content',
        );
        throw err;
      },
    });
    const sm = new StreamingMessage(deps);

    sm.append('first');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    // Re-send identical content — edit will throw the benign error.
    sm.append('');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);

    // No throw bubbled up — the test just survives.
    // (No assertion on logger.error: the contract is that the benign case is
    // swallowed at warn or below, not error.)
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('finish() forces the remaining buffer to flush even if the debounce timer has not fired', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('immediate');
    // Don't advance timers — the debounce window has NOT elapsed.
    expect(deps.sendMessage).not.toHaveBeenCalled();

    await sm.finish();

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('immediate');
  });

  it('finish() is idempotent — second call is a no-op', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('x');
    await sm.finish();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);

    await sm.finish();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('after finish(), additional append() calls do not trigger further sends', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('first');
    await sm.finish();
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);

    sm.append('second');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS * 3);
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.editMessage).not.toHaveBeenCalled();
  });

  it('hasSent reflects whether sendMessage produced an id yet', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    expect(sm.hasSent).toBe(false);
    sm.append('x');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    expect(sm.hasSent).toBe(true);
  });

  it('does not flush when the visible buffer is empty (e.g. only <internal> content)', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    sm.append('<internal>only thinking</internal>');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS * 2);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.editMessage).not.toHaveBeenCalled();
    expect(sm.hasSent).toBe(false);
  });

  // Bug-A regression: a reply whose final tokens end on a tag-prefix (`<`,
  // `</`, `<i`…) used to leave those chars stranded in pendingPrefix, lost
  // forever because finish() only flushed `buffer`.
  it('flushes trailing pendingPrefix that turned out to be literal text (ends in "<")', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    // Last char "<" is a prefix of "<internal>" → deferred to pendingPrefix.
    sm.append('compare a <');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    // First flush sends only the un-deferred part.
    expect(deps.sendMessage).toHaveBeenCalledWith('compare a ');

    await sm.finish();
    // finish() must reconcile the deferred "<" into the final text.
    expect(deps.editMessage).toHaveBeenLastCalledWith('msg-1', 'compare a <');
  });

  it('drops trailing pendingPrefix when the stream ends inside an unclosed <internal>', async () => {
    const deps = makeDeps();
    const sm = new StreamingMessage(deps);

    // Open internal, then end mid-close-tag. Nothing visible should survive.
    sm.append('hi <internal>secret</intern');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    await sm.finish();

    // Only "hi " is visible; the unclosed-internal tail is dropped.
    const allText = [
      ...deps.sendMessage.mock.calls.map((c) => c[0]),
      ...deps.editMessage.mock.calls.map((c) => c[1]),
    ].join('|');
    expect(allText).not.toContain('secret');
    expect(allText).not.toContain('</intern');
    expect(deps.sendMessage).toHaveBeenCalledWith('hi ');
  });

  // Bug-D regression: when the send fails (messageId never assigned), finish()
  // must still persist the full text so the agent's own history isn't lost.
  it('persistFinal runs with undefined messageId when the send failed', async () => {
    const finalizeStore = vi.fn();
    const sm = new StreamingMessage({
      sendMessage: async () => undefined, // simulate send failure (no id)
      editMessage: async () => {},
      finalizeStore,
    });

    sm.append('the whole reply');
    await vi.advanceTimersByTimeAsync(FLUSH_DEBOUNCE_MS);
    await sm.finish();

    expect(finalizeStore).toHaveBeenCalledWith(undefined, 'the whole reply');
  });
});
