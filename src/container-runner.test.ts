import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const OUTPUT_PARTIAL_START_MARKER = '---NANOCLAW_PARTIAL_START---';
const OUTPUT_PARTIAL_END_MARKER = '---NANOCLAW_PARTIAL_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  buildContainerArgs,
  buildVolumeMounts,
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

function emitPartialMarker(
  proc: ReturnType<typeof createFakeProcess>,
  payload: { text?: unknown } | string,
) {
  // Caller may pass a string to inject malformed JSON.
  const body =
    typeof payload === 'string' ? payload : JSON.stringify(payload);
  proc.stdout.push(
    `${OUTPUT_PARTIAL_START_MARKER}\n${body}\n${OUTPUT_PARTIAL_END_MARKER}\n`,
  );
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

// ---------------------------------------------------------------------------
// Token-level streaming — PARTIAL marker parsing.
//
// The container emits PARTIAL_START..PARTIAL_END blocks as the agent streams
// `text_delta` events from the SDK. The host parses them in the same stdout
// loop as the legacy OUTPUT_* markers and forwards `text` chunks to
// onPartialOutput. The orchestrator turns those chunks into Telegram edit
// calls via StreamingMessage. Tests below pin down the parsing seam without
// involving the channel layer.
// ---------------------------------------------------------------------------
describe('container-runner partial marker parsing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('forwards a single PARTIAL block to onPartialOutput with the text chunk', async () => {
    const onOutput = vi.fn(async () => {});
    const onPartialOutput = vi.fn(async (_chunk: string) => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onPartialOutput,
    );

    emitPartialMarker(fakeProc, { text: 'Hello ' });
    await vi.advanceTimersByTimeAsync(10);

    expect(onPartialOutput).toHaveBeenCalledTimes(1);
    expect(onPartialOutput).toHaveBeenCalledWith('Hello ');

    // Settle the agent so the outer promise resolves.
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Hello world',
      newSessionId: 'session-p1',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('interleaves multiple PARTIAL blocks before a final OUTPUT block', async () => {
    const onOutput = vi.fn(async () => {});
    const onPartialOutput = vi.fn(async (_chunk: string) => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onPartialOutput,
    );

    emitPartialMarker(fakeProc, { text: 'Hel' });
    emitPartialMarker(fakeProc, { text: 'lo ' });
    emitPartialMarker(fakeProc, { text: 'world' });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Hello world',
      newSessionId: 'session-p2',
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(onPartialOutput).toHaveBeenCalledTimes(3);
    expect(onPartialOutput.mock.calls.map((c) => c[0])).toEqual([
      'Hel',
      'lo ',
      'world',
    ]);
    expect(onOutput).toHaveBeenCalledTimes(1);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('ignores PARTIAL blocks with malformed JSON without crashing the parser', async () => {
    const onOutput = vi.fn(async () => {});
    const onPartialOutput = vi.fn(async (_chunk: string) => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onPartialOutput,
    );

    // Malformed body — must not throw, must not call onPartialOutput.
    emitPartialMarker(fakeProc, 'not valid json {');
    // A well-formed one right after — must still be delivered.
    emitPartialMarker(fakeProc, { text: 'after' });

    await vi.advanceTimersByTimeAsync(10);

    expect(onPartialOutput).toHaveBeenCalledTimes(1);
    expect(onPartialOutput).toHaveBeenCalledWith('after');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      newSessionId: 'session-p3',
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('ignores PARTIAL blocks whose `text` field is missing or non-string', async () => {
    const onOutput = vi.fn(async () => {});
    const onPartialOutput = vi.fn(async (_chunk: string) => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onPartialOutput,
    );

    emitPartialMarker(fakeProc, {}); // missing text
    emitPartialMarker(fakeProc, { text: 123 }); // wrong type
    emitPartialMarker(fakeProc, { text: '' }); // empty (per spec, no-op)
    emitPartialMarker(fakeProc, { text: 'real' });

    await vi.advanceTimersByTimeAsync(10);

    expect(onPartialOutput).toHaveBeenCalledTimes(1);
    expect(onPartialOutput).toHaveBeenCalledWith('real');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('does NOT mark a partial-only stream as "hadStreamingOutput"; timeout still errors', async () => {
    const onOutput = vi.fn(async () => {});
    const onPartialOutput = vi.fn(async (_chunk: string) => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onPartialOutput,
    );

    // Stream a few partials but never emit a full OUTPUT result.
    emitPartialMarker(fakeProc, { text: 'streaming…' });
    await vi.advanceTimersByTimeAsync(10);

    // Hard timeout fires before any final result.
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // Partials alone do not satisfy "had output" — caller must see error so
    // the cursor rolls back and the user's message isn't silently dropped.
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });

  it('survives onPartialOutput throwing without dropping subsequent partials', async () => {
    const onOutput = vi.fn(async () => {});
    let callCount = 0;
    // Typed as (chunk: string) => Promise<void> so .mock.calls[i][0] is string,
    // not the empty tuple TS would infer from a zero-arg lambda.
    const onPartialOutput = vi.fn(async (_chunk: string) => {
      callCount++;
      if (callCount === 1) throw new Error('telegram api boom');
    });
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onPartialOutput,
    );

    emitPartialMarker(fakeProc, { text: 'first' });
    emitPartialMarker(fakeProc, { text: 'second' });
    await vi.advanceTimersByTimeAsync(10);

    // Both calls happened — the throw on call 1 did not wedge the loop.
    expect(onPartialOutput).toHaveBeenCalledTimes(2);
    expect(onPartialOutput.mock.calls[0][0]).toBe('first');
    expect(onPartialOutput.mock.calls[1][0]).toBe('second');

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
    });
    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});

// ---------------------------------------------------------------------------
// buildContainerArgs — NANOCLAW_ENABLE_MCP env injection
//
// The test exercises the host-side translation of `group.enabledMcp` into the
// `docker run -e NANOCLAW_ENABLE_MCP=...` argv pair. The container side
// applies the filter to mcpServers at startup (covered by the container test
// in container/agent-runner/src/mcp-whitelist.test.ts). Together they form
// the per-group MCP isolation seam used to keep restricted users (e.g. Dana)
// out of the main user's MCP plugins.
// ---------------------------------------------------------------------------
describe('buildContainerArgs NANOCLAW_ENABLE_MCP env injection', () => {
  it('pushes NANOCLAW_ENABLE_MCP=<csv> when group.enabledMcp is a populated array', () => {
    const { args } = buildContainerArgs([], 'nc-test', false, {
      enabledMcp: ['nanoclaw'],
    });
    // The -e flag is followed by its value as a separate argv token — the
    // expected pair is `-e NANOCLAW_ENABLE_MCP=nanoclaw`. We assert both
    // the presence of the pair and the absence of accidental duplication
    // (a previous bug had the migration writer producing two entries).
    const idx = args.indexOf('NANOCLAW_ENABLE_MCP=nanoclaw');
    expect(idx).toBeGreaterThan(0);
    expect(args[idx - 1]).toBe('-e');
    const occurrences = args.filter((a) =>
      a.startsWith('NANOCLAW_ENABLE_MCP='),
    );
    expect(occurrences).toHaveLength(1);
  });

  it('serializes a multi-entry whitelist as a comma-separated csv', () => {
    const { args } = buildContainerArgs([], 'nc-test', false, {
      enabledMcp: ['nanoclaw', 'gmail', 'notion'],
    });
    expect(args).toContain('NANOCLAW_ENABLE_MCP=nanoclaw,gmail,notion');
  });

  it('honors empty-array as explicit lockdown (only mcp__nanoclaw__* eligible)', () => {
    // Empty array → empty value. The container interprets this as "no extra
    // MCP servers besides the always-included `nanoclaw`". Distinct from the
    // undefined case below (legacy / all enabled).
    const { args } = buildContainerArgs([], 'nc-test', false, {
      enabledMcp: [],
    });
    expect(args).toContain('NANOCLAW_ENABLE_MCP=');
  });

  it('OMITS the env var when group.enabledMcp is undefined (legacy / main group)', () => {
    const { args } = buildContainerArgs([], 'nc-test', true, {
      enabledMcp: undefined,
    });
    expect(args.some((a) => a.startsWith('NANOCLAW_ENABLE_MCP='))).toBe(false);
  });

  it('OMITS the env var when group arg is omitted entirely (back-compat)', () => {
    const { args } = buildContainerArgs([], 'nc-test', false);
    expect(args.some((a) => a.startsWith('NANOCLAW_ENABLE_MCP='))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildVolumeMounts — per-group credential isolation (Part A of per-group
// credentials MVP).
//
// Background: gmail-mcp and google-calendar-mcp OAuth token files used to be
// mounted from $HOME for every group. That meant Dana's container (and any
// other non-main group) got read/write access to the main user's tokens —
// either could refresh, rotate, or read them. Cross-contamination risk.
//
// New rule:
//   - Main group  → mount from $HOME (unchanged, preserves backward compat).
//   - Other groups → mount from groups/<folder>/.gmail-mcp/ and
//                    groups/<folder>/.config/google-calendar-mcp/.
//   - Per-group dirs are auto-created when missing so the mount always
//     succeeds; the MCP server itself populates them when the user goes
//     through OAuth in that container (separate follow-up task).
// ---------------------------------------------------------------------------
describe('buildVolumeMounts per-group credential isolation', () => {
  // The default `fs.existsSync(() => false)` mock makes every "if dir exists"
  // branch take the "doesn't exist" path. The gmail-mcp branch is gated by
  // `fs.existsSync(gmailDir)`, so for tests that need to assert the mount is
  // present, we toggle existsSync to return true for that path.
  const home = os.homedir();
  const mainGmailHostPath = path.join(home, '.gmail-mcp');
  const mainCalendarHostPath = path.join(
    home,
    '.config',
    'google-calendar-mcp',
  );

  it('main group: gmail-mcp mount points to HOME (backward compat preserved)', () => {
    // Make HOME's .gmail-mcp "exist" so the existing branch fires.
    vi.mocked(fs.existsSync).mockImplementation(
      (p: fs.PathLike) => String(p) === mainGmailHostPath,
    );

    const mounts = buildVolumeMounts(
      {
        name: 'Main',
        folder: 'telegram_main',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        isMain: true,
      },
      true,
    );

    const gmailMount = mounts.find(
      (m) => m.containerPath === '/home/node/.gmail-mcp',
    );
    expect(gmailMount).toBeDefined();
    expect(gmailMount!.hostPath).toBe(mainGmailHostPath);
  });

  it('main group: google-calendar mount points to HOME (backward compat preserved)', () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);

    const mounts = buildVolumeMounts(
      {
        name: 'Main',
        folder: 'telegram_main',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
        isMain: true,
      },
      true,
    );

    const calMount = mounts.find(
      (m) => m.containerPath === '/home/node/.config/google-calendar-mcp',
    );
    expect(calMount).toBeDefined();
    expect(calMount!.hostPath).toBe(mainCalendarHostPath);
  });

  it('non-main group: gmail-mcp mount points to groups/<folder>/.gmail-mcp, NOT HOME', () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);

    const mounts = buildVolumeMounts(
      {
        name: 'Dana',
        folder: 'telegram_dana',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      false,
    );

    const gmailMount = mounts.find(
      (m) => m.containerPath === '/home/node/.gmail-mcp',
    );
    expect(gmailMount).toBeDefined();
    // Per-group, not HOME — this is the security fix.
    expect(gmailMount!.hostPath).not.toBe(mainGmailHostPath);
    expect(gmailMount!.hostPath).toContain('telegram_dana');
    expect(gmailMount!.hostPath).toContain('.gmail-mcp');
  });

  it('non-main group: google-calendar mount points to groups/<folder>/.config/google-calendar-mcp, NOT HOME', () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);

    const mounts = buildVolumeMounts(
      {
        name: 'Dana',
        folder: 'telegram_dana',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      false,
    );

    const calMount = mounts.find(
      (m) => m.containerPath === '/home/node/.config/google-calendar-mcp',
    );
    expect(calMount).toBeDefined();
    expect(calMount!.hostPath).not.toBe(mainCalendarHostPath);
    expect(calMount!.hostPath).toContain('telegram_dana');
    expect(calMount!.hostPath).toContain('google-calendar-mcp');
  });

  it('non-main group: auto-creates per-group .gmail-mcp directory when missing (so mount succeeds)', () => {
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    const mkdirSpy = vi.mocked(fs.mkdirSync);
    mkdirSpy.mockClear();

    buildVolumeMounts(
      {
        name: 'Dana',
        folder: 'telegram_dana',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      false,
    );

    // mkdirSync should be called for the per-group .gmail-mcp path with
    // recursive:true. We don't pin the exact path string (resolveGroupFolderPath
    // builds it from GROUPS_DIR + folder), only the suffix.
    const gmailMkdir = mkdirSpy.mock.calls.find(([p]) =>
      String(p).endsWith(path.join('telegram_dana', '.gmail-mcp')),
    );
    expect(gmailMkdir).toBeDefined();
    expect(gmailMkdir![1]).toEqual({ recursive: true });
  });

  it('non-main group: NEVER mounts main user HOME .gmail-mcp (no fallback to cross-user creds)', () => {
    // Toggle existsSync so HOME's .gmail-mcp APPEARS to exist (the dangerous
    // case — old code would silently fall through and mount it for everyone).
    vi.mocked(fs.existsSync).mockImplementation(
      (p: fs.PathLike) =>
        String(p) === mainGmailHostPath || String(p) === mainCalendarHostPath,
    );

    const mounts = buildVolumeMounts(
      {
        name: 'Dana',
        folder: 'telegram_dana',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      false,
    );

    // Defense against regression: no mount points at HOME for non-main groups.
    const homeMounts = mounts.filter(
      (m) =>
        m.hostPath === mainGmailHostPath || m.hostPath === mainCalendarHostPath,
    );
    expect(homeMounts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildContainerArgs per-group env file (Part B).
//
// Non-main groups can override NOTION_API_KEY / GOOGLE_MAPS_API_KEY via a
// per-group env file at data/env/<folder>.env. The save_credential MCP tool
// writes that file when the user pastes a credential into chat. Main group
// continues to read only the global .env / process.env — never per-group.
// ---------------------------------------------------------------------------
describe('buildContainerArgs per-group env file (Part B)', () => {
  // Set NODE-level env vars to control "global" values during these tests.
  const ORIGINAL_NOTION = process.env.NOTION_API_KEY;
  const ORIGINAL_MAPS = process.env.GOOGLE_MAPS_API_KEY;

  beforeEach(() => {
    delete process.env.NOTION_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    vi.mocked(fs.readFileSync).mockImplementation(() => '');
  });

  afterEach(() => {
    if (ORIGINAL_NOTION !== undefined) {
      process.env.NOTION_API_KEY = ORIGINAL_NOTION;
    }
    if (ORIGINAL_MAPS !== undefined) {
      process.env.GOOGLE_MAPS_API_KEY = ORIGINAL_MAPS;
    }
  });

  it('non-main group: per-group env file overrides global NOTION_API_KEY', () => {
    // Global says "global_val"; per-group file says "her_secret". Per-group wins.
    process.env.NOTION_API_KEY = 'global_val';
    const perGroupEnvPath = path.join(
      '/tmp/nanoclaw-test-data',
      'env',
      'telegram_dana.env',
    );
    vi.mocked(fs.existsSync).mockImplementation(
      (p: fs.PathLike) => String(p) === perGroupEnvPath,
    );
    vi.mocked(fs.readFileSync).mockImplementation(
      (p: fs.PathOrFileDescriptor) => {
        if (String(p) === perGroupEnvPath) {
          return 'NOTION_API_KEY=her_secret\n';
        }
        return '';
      },
    );
    const writeSpy = vi.mocked(fs.writeFileSync);
    writeSpy.mockClear();

    buildContainerArgs(
      [],
      'nc-dana',
      false,
      { enabledMcp: ['nanoclaw', 'notion'] },
      'telegram_dana',
    );

    // The env-file is written by buildContainerArgs via writeFileSync. Find
    // the call whose content contains NOTION_API_KEY=her_secret.
    const envFileWrite = writeSpy.mock.calls.find(
      ([, data]) =>
        typeof data === 'string' && data.includes('NOTION_API_KEY=her_secret'),
    );
    expect(envFileWrite).toBeDefined();
    // And the global value must NOT be the one written.
    const wroteGlobal = writeSpy.mock.calls.some(
      ([, data]) =>
        typeof data === 'string' && data.includes('NOTION_API_KEY=global_val'),
    );
    expect(wroteGlobal).toBe(false);
  });

  it('non-main group without per-group env file: falls back to global', () => {
    process.env.NOTION_API_KEY = 'global_val';
    vi.mocked(fs.existsSync).mockImplementation(() => false);
    const writeSpy = vi.mocked(fs.writeFileSync);
    writeSpy.mockClear();

    buildContainerArgs(
      [],
      'nc-dana',
      false,
      { enabledMcp: ['nanoclaw', 'notion'] },
      'telegram_dana',
    );

    const envFileWrite = writeSpy.mock.calls.find(
      ([, data]) =>
        typeof data === 'string' && data.includes('NOTION_API_KEY=global_val'),
    );
    expect(envFileWrite).toBeDefined();
  });

  it('main group: per-group env file is NEVER loaded (only global)', () => {
    process.env.NOTION_API_KEY = 'global_val';
    const perGroupEnvPath = path.join(
      '/tmp/nanoclaw-test-data',
      'env',
      'telegram_main.env',
    );
    // Per-group file "exists" with a different value — main must still use
    // the global one.
    vi.mocked(fs.existsSync).mockImplementation(
      (p: fs.PathLike) => String(p) === perGroupEnvPath,
    );
    vi.mocked(fs.readFileSync).mockImplementation(
      (p: fs.PathOrFileDescriptor) => {
        if (String(p) === perGroupEnvPath) {
          return 'NOTION_API_KEY=should_not_be_used\n';
        }
        return '';
      },
    );
    const writeSpy = vi.mocked(fs.writeFileSync);
    writeSpy.mockClear();

    buildContainerArgs(
      [],
      'nc-main',
      true,
      { enabledMcp: undefined },
      'telegram_main',
    );

    // Main writes the GLOBAL value, never the per-group one.
    const wroteGlobal = writeSpy.mock.calls.some(
      ([, data]) =>
        typeof data === 'string' && data.includes('NOTION_API_KEY=global_val'),
    );
    expect(wroteGlobal).toBe(true);
    const wrotePerGroup = writeSpy.mock.calls.some(
      ([, data]) =>
        typeof data === 'string' &&
        data.includes('NOTION_API_KEY=should_not_be_used'),
    );
    expect(wrotePerGroup).toBe(false);
  });
});
