import { describe, it, expect, vi } from 'vitest';

import { PollWatchdog } from './telegram-poll-watchdog.js';

/**
 * The watchdog guards against grammy's long-poll loop parking forever — e.g.
 * `await getUpdates` black-holing on a half-open TCP connection, which leaves
 * `bot.isRunning()` true while no updates are ever fetched again.
 *
 * It must NOT fire when the whole process was frozen (macOS sleep suspends the
 * event loop, so no getUpdates happens for the length of the sleep through no
 * fault of the connection). The discriminator is whether the watchdog's own
 * timer kept ticking: if `check()` itself stopped running, the process was
 * suspended; if it ticked on schedule while polls dried up, polling is stalled.
 *
 * Time is injected so the tests are deterministic.
 */
const INTERVAL = 30_000;
const STALL = 90_000;
const FREEZE = 90_000;

function setup() {
  const clock = { t: 0 };
  const onStall = vi.fn();
  const onFreeze = vi.fn();
  const wd = new PollWatchdog({
    now: () => clock.t,
    stallThresholdMs: STALL,
    freezeThresholdMs: FREEZE,
    onStall,
    onFreeze,
  });
  /** Advance time the way the real 30s setInterval would: tick by tick. */
  const tick = (ms: number) => {
    const end = clock.t + ms;
    while (clock.t + INTERVAL <= end) {
      clock.t += INTERVAL;
      wd.check();
    }
    if (clock.t < end) {
      clock.t = end;
      wd.check();
    }
  };
  /** Advance time WITHOUT any check() — models a suspended event loop. */
  const freeze = (ms: number) => {
    clock.t += ms;
  };
  return { clock, wd, onStall, onFreeze, tick, freeze };
}

describe('PollWatchdog', () => {
  it('does not signal a stall while polls keep arriving', () => {
    const { wd, onStall, tick } = setup();

    for (let i = 0; i < 10; i++) {
      wd.recordPoll();
      tick(INTERVAL);
    }

    expect(onStall).not.toHaveBeenCalled();
  });

  it('signals a stall when the timer keeps ticking but polling dries up', () => {
    const { onStall, tick } = setup();

    tick(STALL + INTERVAL); // timer ran the whole time; no recordPoll

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toBeGreaterThan(STALL);
  });

  it('recordPoll resets the stall timer', () => {
    const { wd, onStall, tick } = setup();

    tick(60_000);
    wd.recordPoll();
    tick(60_000); // only 60s since the last poll

    expect(onStall).not.toHaveBeenCalled();
  });

  it('signals each stall only once until polling resumes', () => {
    const { wd, onStall, tick } = setup();

    tick(STALL + INTERVAL);
    expect(onStall).toHaveBeenCalledTimes(1);
    tick(STALL + INTERVAL); // still stalled — must not re-fire
    expect(onStall).toHaveBeenCalledTimes(1);

    wd.recordPoll(); // polling resumed, re-arm
    tick(STALL + INTERVAL); // stalled again
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  // ---- suspend/resume (macOS sleep) -------------------------------------

  it('does NOT signal a stall when the process itself was suspended', () => {
    const { wd, onStall, freeze } = setup();

    // Laptop lid closed for 20 minutes: no polls AND no timer ticks.
    freeze(20 * 60_000);
    wd.check(); // first tick after resume

    expect(onStall).not.toHaveBeenCalled();
  });

  it('reports the suspension via onFreeze with its duration', () => {
    const { wd, onFreeze, freeze } = setup();

    freeze(20 * 60_000);
    wd.check();

    expect(onFreeze).toHaveBeenCalledTimes(1);
    expect(onFreeze.mock.calls[0][0]).toBeGreaterThanOrEqual(20 * 60_000);
  });

  it('re-arms after a suspension so the next window starts clean', () => {
    const { wd, onStall, freeze, tick } = setup();

    freeze(20 * 60_000);
    wd.check();
    tick(60_000); // 60s of healthy ticking, still under the stall threshold

    expect(onStall).not.toHaveBeenCalled();
  });

  it('still detects a genuine stall that follows a suspension', () => {
    const { wd, onStall, freeze, tick } = setup();

    freeze(20 * 60_000);
    wd.check(); // resume
    tick(STALL + INTERVAL); // now awake, ticking, but no polls

    expect(onStall).toHaveBeenCalledTimes(1);
  });
});
