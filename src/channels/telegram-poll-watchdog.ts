/**
 * Liveness watchdog for grammy's built-in long-polling loop.
 *
 * grammy retries `getUpdates` forever on network errors, so a transient blip
 * does NOT stop polling. The failure mode we actually hit is subtler: the loop
 * can park indefinitely on `await getUpdates` when the underlying connection
 * goes half-open (established TCP, server silent, no client-side timeout). When
 * that happens `bot.isRunning()` stays `true`, no new updates are ever fetched,
 * and the bot goes silent until the process is restarted by hand.
 *
 * This watchdog is mechanism-agnostic: it only asks "did a getUpdates happen
 * recently?". `recordPoll()` is invoked from an API transformer on every
 * getUpdates call; `check()` runs on a timer and invokes `onStall` once when the
 * gap since the last poll exceeds the threshold. In production `onStall` logs
 * and exits the process so launchd/systemd restarts it with a fresh connection.
 *
 * Suspend/resume: on a laptop the host sleeps, which freezes the event loop.
 * No getUpdates happens for the length of the sleep, but that is the machine
 * being off — not a dead connection — and exiting on every wake produced dozens
 * of pointless restarts. The discriminator is the watchdog's OWN timer: if
 * `check()` also stopped running, the process was suspended (re-arm and carry
 * on); if it kept ticking on schedule while polls dried up, polling really is
 * stalled (exit). A genuine stall that follows a resume is still caught by the
 * next window.
 *
 * Time is injected (`now`) so the logic is fully deterministic under test.
 */
export interface PollWatchdogDeps {
  /** Monotonic-ish clock in milliseconds (e.g. `Date.now`). */
  now: () => number;
  /** Max allowed gap between getUpdates calls before the loop is "stalled". */
  stallThresholdMs: number;
  /**
   * Gap between two consecutive `check()` calls above which the process is
   * considered to have been suspended rather than merely idle. Set comfortably
   * above the timer interval (e.g. 3x) so ordinary scheduling jitter, GC pauses
   * and busy event loops don't read as a suspension.
   */
  freezeThresholdMs: number;
  /** Called once per stall with the elapsed time since the last poll. */
  onStall: (sinceMs: number) => void;
  /** Called when a suspension is detected, with its duration. */
  onFreeze?: (frozenMs: number) => void;
}

export class PollWatchdog {
  private lastPollAt: number;
  private lastCheckAt: number;
  private stalled = false;

  constructor(private readonly deps: PollWatchdogDeps) {
    const now = deps.now();
    this.lastPollAt = now;
    this.lastCheckAt = now;
  }

  /** Record that a getUpdates call just happened; re-arms the watchdog. */
  recordPoll(): void {
    this.lastPollAt = this.deps.now();
    this.stalled = false;
  }

  /** Evaluate liveness; fires `onStall` at most once per stall episode. */
  check(): void {
    const now = this.deps.now();
    const sinceCheckMs = now - this.lastCheckAt;
    this.lastCheckAt = now;

    // The timer itself skipped: the whole process was suspended (host sleep),
    // so the missing polls are expected. Re-arm instead of tearing the process
    // down — polling resumes on its own, and a real stall after the resume is
    // caught by the next window.
    if (sinceCheckMs > this.deps.freezeThresholdMs) {
      this.lastPollAt = now;
      this.stalled = false;
      this.deps.onFreeze?.(sinceCheckMs);
      return;
    }

    const sinceMs = now - this.lastPollAt;
    if (sinceMs > this.deps.stallThresholdMs && !this.stalled) {
      this.stalled = true;
      this.deps.onStall(sinceMs);
    }
  }
}
