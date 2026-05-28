/**
 * StreamingMessage — renders the container's token-level stream as a native
 * Telegram "draft" (sendMessageDraft, Bot API 9.5). The draft is an ephemeral,
 * animated preview bubble that updates in place as tokens arrive — the
 * purpose-built streaming primitive (smooth, no edit rate-limit, native
 * rendering, shows inside forum topics).
 *
 * Division of labour:
 *   - This class drives the LIVE PREVIEW only. It accumulates partial chunks,
 *     hides `<internal>...</internal>` reasoning (cross-chunk safe), and pushes
 *     the running text to the draft on a light throttle.
 *   - The orchestrator (src/index.ts) sends the REAL, PERSISTED message via
 *     routeOutbound when the turn's result event fires. The draft is a preview
 *     and is never stored — the real message supersedes it (and Telegram
 *     auto-expires an un-finalized draft after ~30s).
 *
 * Contract:
 *   - `append(chunk)` is non-blocking, never throws, coalesces bursts.
 *   - `finish()` stops further draft updates and seals the instance. After
 *     finish(), appends are ignored. Idempotent.
 */
import { logger } from './logger.js';

// Native drafts have no documented edit rate-limit, but pushing on every token
// (hundreds/sec) is wasteful. A small throttle batches bursts while staying
// far smoother than the old 1.2s editMessage debounce.
export const DRAFT_THROTTLE_MS = 350;
// Telegram caps sendMessageDraft text at 4096 chars. The live preview clamps to
// this; the final persisted message (sent by the orchestrator) carries the full
// text and is split across messages by the channel as needed.
export const DRAFT_MAX_LEN = 4096;

const INTERNAL_OPEN = '<internal>';
const INTERNAL_CLOSE = '</internal>';

export interface StreamingMessageDeps {
  /** Push the current visible text to the live draft bubble. Never throws. */
  sendDraft: (text: string) => Promise<void>;
}

export class StreamingMessage {
  // Visible text accumulated so far (internal blocks already stripped). Each
  // draft update sends this whole value — sendMessageDraft replaces the bubble.
  private buffer = '';
  // Cross-chunk `<internal>` state: a tag opened in chunk N closes when
  // `</internal>` arrives in chunk N+1.
  private insideInternal = false;
  // Bytes deferred because they could be the start of a tag (e.g. `<inte`).
  private pendingPrefix = '';

  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  // True when `buffer` changed since the last draft push.
  private dirty = false;
  private closed = false;

  constructor(private deps: StreamingMessageDeps) {}

  /**
   * Append a raw text chunk from the SDK stream. Non-blocking. Strips
   * `<internal>...</internal>` (the agent's hidden reasoning), cross-chunk
   * safe, then schedules a throttled draft update.
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

    this.pendingPrefix = combined.slice(i);
    this.insideInternal = inside;
    if (newVisible) {
      this.buffer += newVisible;
      this.dirty = true;
      this.scheduleDraft();
    }
  }

  private scheduleDraft(): void {
    if (this.throttleTimer || this.closed || !this.dirty) return;
    const elapsed = Date.now() - this.lastSentAt;
    const delay = Math.max(0, DRAFT_THROTTLE_MS - elapsed);
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      void this.flushDraft();
    }, delay);
  }

  private async flushDraft(): Promise<void> {
    if (this.closed || !this.dirty || this.buffer.length === 0) return;
    this.dirty = false;
    this.lastSentAt = Date.now();
    const text = this.buffer.slice(0, DRAFT_MAX_LEN);
    try {
      await this.deps.sendDraft(text);
    } catch (err) {
      // deps.sendDraft is expected to swallow its own errors; this is a
      // belt-and-suspenders guard so a rejected promise never escapes.
      logger.debug(
        { err: String(err) },
        'StreamingMessage: sendDraft rejected',
      );
    }
  }

  /**
   * Stop further draft updates and seal the instance. Idempotent. We do NOT
   * push a final draft or persist anything — the orchestrator sends the real
   * message via routeOutbound right after this, which supersedes the draft.
   */
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }
}
