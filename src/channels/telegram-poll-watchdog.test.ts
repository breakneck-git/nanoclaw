import { describe, it, expect, vi } from 'vitest';

import { PollWatchdog } from './telegram-poll-watchdog.js';

/**
 * The watchdog guards against grammy's long-poll loop parking forever — e.g.
 * `await getUpdates` black-holing on a half-open TCP connection, which leaves
 * `bot.isRunning()` true while no updates are ever fetched again. `recordPoll`
 * is called on every getUpdates; `check` fires `onStall` when too much time has
 * elapsed since the last poll. Time is injected so the tests are deterministic.
 */
describe('PollWatchdog', () => {
  it('does not signal a stall while polls keep arriving within the threshold', () => {
    let now = 1000;
    const onStall = vi.fn();
    const wd = new PollWatchdog({
      now: () => now,
      stallThresholdMs: 90_000,
      onStall,
    });

    now = 30_000;
    wd.recordPoll();
    now = 60_000; // 30s since last poll — under threshold
    wd.check();

    expect(onStall).not.toHaveBeenCalled();
  });

  it('signals a stall when no poll has happened for longer than the threshold', () => {
    let now = 0;
    const onStall = vi.fn();
    const wd = new PollWatchdog({
      now: () => now,
      stallThresholdMs: 90_000,
      onStall,
    });

    now = 90_001; // never recorded a poll since construction
    wd.check();

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toBe(90_001); // sinceMs
  });

  it('recordPoll resets the stall timer', () => {
    let now = 0;
    const onStall = vi.fn();
    const wd = new PollWatchdog({
      now: () => now,
      stallThresholdMs: 90_000,
      onStall,
    });

    now = 50_000;
    wd.recordPoll();
    now = 90_001; // only 40s since the last poll
    wd.check();

    expect(onStall).not.toHaveBeenCalled();
  });

  it('signals each stall only once until polling resumes', () => {
    let now = 0;
    const onStall = vi.fn();
    const wd = new PollWatchdog({
      now: () => now,
      stallThresholdMs: 90_000,
      onStall,
    });

    now = 100_000;
    wd.check(); // first detection
    now = 150_000;
    wd.check(); // still stalled — must not re-fire
    expect(onStall).toHaveBeenCalledTimes(1);

    now = 160_000;
    wd.recordPoll(); // polling resumed, re-arm
    now = 260_000; // stalled again
    wd.check();
    expect(onStall).toHaveBeenCalledTimes(2);
  });
});
