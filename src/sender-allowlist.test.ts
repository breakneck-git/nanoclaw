import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  SenderAllowlistConfig,
  shouldDropMessage,
} from './sender-allowlist.js';

let tmpDir: string;

function cfgPath(name = 'sender-allowlist.json'): string {
  return path.join(tmpDir, name);
}

function writeConfig(config: unknown, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, JSON.stringify(config));
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowlist-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSenderAllowlist', () => {
  it('returns allow-all defaults when file is missing', () => {
    const cfg = loadSenderAllowlist(cfgPath());
    expect(cfg.default.allow).toBe('*');
    expect(cfg.default.mode).toBe('trigger');
    expect(cfg.logDenied).toBe(true);
  });

  it('loads allow=* config', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: false,
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
    expect(cfg.logDenied).toBe(false);
  });

  it('loads allow=[] (deny all)', () => {
    const p = writeConfig({
      default: { allow: [], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual([]);
  });

  it('loads allow=[list]', () => {
    const p = writeConfig({
      default: { allow: ['alice', 'bob'], mode: 'drop' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toEqual(['alice', 'bob']);
    expect(cfg.default.mode).toBe('drop');
  });

  it('per-chat override beats default', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: { 'group-a': { allow: ['alice'], mode: 'drop' } },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['group-a'].allow).toEqual(['alice']);
    expect(cfg.chats['group-a'].mode).toBe('drop');
  });

  it('returns allow-all on invalid JSON', () => {
    const p = cfgPath();
    fs.writeFileSync(p, '{ not valid json }}}');
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('returns allow-all on invalid schema', () => {
    const p = writeConfig({ default: { oops: true } });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*');
  });

  it('rejects non-string allow array items', () => {
    const p = writeConfig({
      default: { allow: [123, null, true], mode: 'trigger' },
      chats: {},
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.default.allow).toBe('*'); // falls back to default
  });

  it('skips invalid per-chat entries', () => {
    const p = writeConfig({
      default: { allow: '*', mode: 'trigger' },
      chats: {
        good: { allow: ['alice'], mode: 'trigger' },
        bad: { allow: 123 },
      },
    });
    const cfg = loadSenderAllowlist(p);
    expect(cfg.chats['good']).toBeDefined();
    expect(cfg.chats['bad']).toBeUndefined();
  });
});

describe('isSenderAllowed', () => {
  it('allow=* allows any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(true);
  });

  it('allow=[] denies any sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'anyone', cfg)).toBe(false);
  });

  it('allow=[list] allows exact match only', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice', 'bob'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'alice', cfg)).toBe(true);
    expect(isSenderAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('uses per-chat entry over default', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: ['alice'], mode: 'trigger' } },
      logDenied: true,
    };
    expect(isSenderAllowed('g1', 'bob', cfg)).toBe(false);
    expect(isSenderAllowed('g2', 'bob', cfg)).toBe(true);
  });
});

describe('shouldDropMessage', () => {
  it('returns false for trigger mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(false);
  });

  it('returns true for drop mode', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'drop' },
      chats: {},
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
  });

  it('per-chat mode override', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: '*', mode: 'trigger' },
      chats: { g1: { allow: '*', mode: 'drop' } },
      logDenied: true,
    };
    expect(shouldDropMessage('g1', cfg)).toBe(true);
    expect(shouldDropMessage('g2', cfg)).toBe(false);
  });
});

describe('isTriggerAllowed', () => {
  it('allows trigger for allowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'alice', cfg)).toBe(true);
  });

  it('denies trigger for disallowed sender', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    expect(isTriggerAllowed('g1', 'eve', cfg)).toBe(false);
  });

  it('logs when logDenied is true', () => {
    const cfg: SenderAllowlistConfig = {
      default: { allow: ['alice'], mode: 'trigger' },
      chats: {},
      logDenied: true,
    };
    isTriggerAllowed('g1', 'eve', cfg);
    // Logger.debug is called — we just verify no crash; logger is a real pino instance
  });
});

describe('fail-closed multi-tenant production config shape', () => {
  // Synthetic stand-ins for the real-world config: one main user with three
  // accounts (A, B, C) and one restricted user (R). The real per-install IDs
  // live in ~/.config/nanoclaw/sender-allowlist.json (NOT in the repo). The
  // test is structural: it locks in fail-closed default + per-chat trigger
  // gating + cross-chat isolation, which is the shape that survives any
  // change of identifiers.
  function buildMultiTenantConfig(): string {
    const p = cfgPath('multi-tenant.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        default: { allow: [], mode: 'drop' },
        chats: {
          'tg:MAIN_A': { allow: ['MAIN_A'], mode: 'trigger' },
          'tg:MAIN_B': { allow: ['MAIN_B'], mode: 'trigger' },
          'tg:MAIN_C': { allow: ['MAIN_C'], mode: 'trigger' },
          'tg:RESTRICTED': { allow: ['RESTRICTED'], mode: 'trigger' },
        },
        logDenied: true,
      }),
    );
    return p;
  }

  it('random chat (no entry) falls back to drop mode and denies all senders', () => {
    const cfg = loadSenderAllowlist(buildMultiTenantConfig());
    // A random person DMing the bot — chat not listed → default applies.
    expect(shouldDropMessage('tg:RANDOM_PERSON', cfg)).toBe(true);
    expect(isSenderAllowed('tg:RANDOM_PERSON', 'anyone', cfg)).toBe(false);
    expect(isSenderAllowed('tg:RANDOM_PERSON', 'MAIN_A', cfg)).toBe(false);
  });

  it("restricted user's chat allows ONLY her sender id, no main user account ids", () => {
    const cfg = loadSenderAllowlist(buildMultiTenantConfig());
    expect(isSenderAllowed('tg:RESTRICTED', 'RESTRICTED', cfg)).toBe(true);
    // Critical: main user's three sender ids must NOT be authorized.
    expect(isSenderAllowed('tg:RESTRICTED', 'MAIN_A', cfg)).toBe(false);
    expect(isSenderAllowed('tg:RESTRICTED', 'MAIN_B', cfg)).toBe(false);
    expect(isSenderAllowed('tg:RESTRICTED', 'MAIN_C', cfg)).toBe(false);
    // And the restricted chat is in trigger mode (messages persist; only
    // agent invocation gated).
    expect(shouldDropMessage('tg:RESTRICTED', cfg)).toBe(false);
  });

  it("main user's three chats authorize each of his sender ids independently", () => {
    const cfg = loadSenderAllowlist(buildMultiTenantConfig());
    expect(isSenderAllowed('tg:MAIN_A', 'MAIN_A', cfg)).toBe(true);
    expect(isSenderAllowed('tg:MAIN_B', 'MAIN_B', cfg)).toBe(true);
    expect(isSenderAllowed('tg:MAIN_C', 'MAIN_C', cfg)).toBe(true);
    // Cross-account: posting in account A's chat as account B is not allowed
    // by the per-chat allow list — proves no sender is implicitly trusted
    // across chats.
    expect(isSenderAllowed('tg:MAIN_A', 'MAIN_B', cfg)).toBe(false);
    expect(isSenderAllowed('tg:MAIN_A', 'RESTRICTED', cfg)).toBe(false);
  });

  it("restricted user's sender cannot trigger main user's chats", () => {
    const cfg = loadSenderAllowlist(buildMultiTenantConfig());
    expect(isSenderAllowed('tg:MAIN_A', 'RESTRICTED', cfg)).toBe(false);
    expect(isSenderAllowed('tg:MAIN_B', 'RESTRICTED', cfg)).toBe(false);
    expect(isSenderAllowed('tg:MAIN_C', 'RESTRICTED', cfg)).toBe(false);
  });
});
