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
 * Time is injected (`now`) so the logic is fully deterministic under test.
 */
export interface PollWatchdogDeps {
  /** Monotonic-ish clock in milliseconds (e.g. `Date.now`). */
  now: () => number;
  /** Max allowed gap between getUpdates calls before the loop is "stalled". */
  stallThresholdMs: number;
  /** Called once per stall with the elapsed time since the last poll. */
  onStall: (sinceMs: number) => void;
}

export class PollWatchdog {
  private lastPollAt: number;
  private stalled = false;

  constructor(private readonly deps: PollWatchdogDeps) {
    this.lastPollAt = deps.now();
  }

  /** Record that a getUpdates call just happened; re-arms the watchdog. */
  recordPoll(): void {
    this.lastPollAt = this.deps.now();
    this.stalled = false;
  }

  /** Evaluate liveness; fires `onStall` at most once per stall episode. */
  check(): void {
    const sinceMs = this.deps.now() - this.lastPollAt;
    if (sinceMs > this.deps.stallThresholdMs && !this.stalled) {
      this.stalled = true;
      this.deps.onStall(sinceMs);
    }
  }
}
