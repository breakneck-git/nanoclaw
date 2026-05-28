/**
 * StreamingMessage — Telegram-side renderer for the container's token-level
 * stream. Hides the messy details from the orchestrator: it owns one
 * Telegram message at a time, debounces edits to stay under Telegram's
 * ~1 edit/sec/chat rate limit, hides `<internal>...</internal>` blocks
 * from the visible text (cross-chunk safe), and splits into a fresh
 * message when the running buffer would exceed the per-message cap.
 *
 * Contract:
 *   - `append(chunk)` adds raw text from the SDK stream. It is non-blocking
 *     and never throws. Multiple appends inside the debounce window
 *     coalesce into a single edit.
 *   - `finish()` forces the final flush and seals the instance. After
 *     finish(), additional appends are silently ignored. Idempotent.
 *   - `hasSent` is true once `sendMessage` has produced a messageId.
 *     The orchestrator uses it to suppress the result-event delivery
 *     (no need to re-send what the user already saw).
 */
import { logger } from './logger.js';

export const FLUSH_DEBOUNCE_MS = 1200; // Telegram bot: ~1 edit/sec/chat is safe
export const MAX_MESSAGE_LEN = 3500; // headroom under Telegram's 4096 cap

const INTERNAL_OPEN = '<internal>';
const INTERNAL_CLOSE = '</internal>';

export interface StreamingMessageDeps {
  /** Send a fresh outbound message. Returns the channel-side messageId when known. */
  sendMessage: (text: string) => Promise<string | undefined>;
  /** Edit an existing outbound message. */
  editMessage: (messageId: string, text: string) => Promise<void>;
}

export class StreamingMessage {
  // Visible text accumulated so far for the CURRENT outbound message. Each
  // flush sends or edits with this entire value (Telegram editMessageText
  // replaces the body, it doesn't append).
  private buffer = '';
  // Tracks state across chunks so a `<internal>` opened in chunk N closes
  // correctly when `</internal>` arrives in chunk N+1.
  private insideInternal = false;
  // When a chunk ends with what could be the start of an `<internal>` or
  // `</internal>` tag (e.g. `<inte`), we defer those chars until the next
  // chunk so we don't accidentally treat a partial tag as visible text.
  private pendingPrefix = '';

  private messageId: string | undefined = undefined;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  // Serialises send/edit calls — Telegram complains if two edits race the
  // same messageId and `.then(...)` chaining is the simplest serialiser.
  private pendingFlush: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private deps: StreamingMessageDeps) {}

  /**
   * Append a raw text chunk from the SDK stream. Non-blocking. Schedules a
   * debounced flush — multiple appends inside FLUSH_DEBOUNCE_MS coalesce.
   *
   * Strips `<internal>...</internal>` blocks (the agent uses them for
   * inner reasoning the user should not see). Cross-chunk safe via
   * `pendingPrefix`.
   */
  append(chunk: string): void {
    if (this.closed) return;
    const combined = this.pendingPrefix + chunk;
    const tagLen = Math.max(INTERNAL_OPEN.length, INTERNAL_CLOSE.length);

    let i = 0;
    let inside = this.insideInternal;
    let newVisible = '';

    while (i < combined.length) {
      if (!inside && combined.startsWith(INTERNAL_OPEN, i)) {
        inside = true;
        i += INTERNAL_OPEN.length;
        continue;
      }
      if (inside && combined.startsWith(INTERNAL_CLOSE, i)) {
        inside = false;
        i += INTERNAL_CLOSE.length;
        continue;
      }
      // Could the remaining slice be a partial tag we shouldn't commit yet?
      const remaining = combined.length - i;
      if (remaining < tagLen) {
        const slice = combined.slice(i);
        const possibleOpen = !inside && INTERNAL_OPEN.startsWith(slice);
        const possibleClose = inside && INTERNAL_CLOSE.startsWith(slice);
        if (possibleOpen || possibleClose) {
          break; // Defer slice to next append.
        }
      }
      if (!inside) newVisible += combined[i];
      i++;
    }

    this.buffer += newVisible;
    this.pendingPrefix = combined.slice(i);
    this.insideInternal = inside;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    if (this.closed) return;
    const elapsed = Date.now() - this.lastFlushAt;
    const delay = Math.max(0, FLUSH_DEBOUNCE_MS - elapsed);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Serialise: chain onto the previous flush so two flushes can never
      // race. Errors are caught inside flush() — but defensively swallow
      // here too so a rejected pendingFlush can't poison future appends.
      this.pendingFlush = this.pendingFlush
        .then(() => this.flush())
        .catch((err) => {
          logger.warn({ err: String(err) }, 'StreamingMessage: pendingFlush rejected');
        });
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    this.lastFlushAt = Date.now();
    const text = this.buffer;

    if (text.length > MAX_MESSAGE_LEN) {
      await this.flushOverflow(text);
      return;
    }

    try {
      if (this.messageId) {
        await this.deps.editMessage(this.messageId, text);
      } else {
        this.messageId = await this.deps.sendMessage(text);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Benign: editing with the same content. Telegram throws but it's a
      // no-op for our purposes — the message body is already what we want.
      if (/message is not modified/i.test(msg)) return;
      logger.warn({ err: msg }, 'StreamingMessage: flush failed');
    }
  }

  /**
   * Overflow path — edit the current message with the first MAX chars, then
   * open a brand-new Telegram message for the rest. The instance's "current
   * message" pointer moves to the tail; future appends extend it.
   *
   * `insideInternal` and `pendingPrefix` are intentionally NOT reset — they
   * reflect the parser state going forward, which is independent of which
   * Telegram message we're rendering into.
   */
  private async flushOverflow(text: string): Promise<void> {
    const head = text.slice(0, MAX_MESSAGE_LEN);
    const tail = text.slice(MAX_MESSAGE_LEN);

    // Seal the old message with the head.
    try {
      if (this.messageId) {
        await this.deps.editMessage(this.messageId, head);
      } else {
        this.messageId = await this.deps.sendMessage(head);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/message is not modified/i.test(msg)) {
        logger.warn({ err: msg }, 'StreamingMessage: head flush failed');
      }
    }

    // Open a fresh message for the tail. Reset the buffer to tail so future
    // edits target the new message body.
    this.buffer = tail;
    this.messageId = undefined;
    try {
      this.messageId = await this.deps.sendMessage(tail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'StreamingMessage: tail send failed');
    }
  }

  /**
   * Force the final flush and seal the instance. Idempotent. After this,
   * additional `append()` calls are silently ignored.
   *
   * Awaits any in-flight pendingFlush, then forces one more flush of the
   * remaining buffer (defends against the case where `append()` arrived
   * inside the debounce window but `finish()` is called before the timer
   * fires).
   */
  async finish(): Promise<void> {
    if (this.closed) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain anything already queued.
    await this.pendingFlush;
    // If the buffer still has unflushed content (likely — the debounce timer
    // never fired), force one final flush.
    if (this.buffer.length > 0) {
      // Don't go through scheduleFlush — we want to await this one.
      await this.flush();
    }
    this.closed = true;
  }

  /** Whether anything was actually sent. Used to suppress the result-event delivery. */
  get hasSent(): boolean {
    return this.messageId !== undefined;
  }
}
