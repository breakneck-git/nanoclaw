import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';

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
    const { args } = buildContainerArgs(
      [],
      'nc-test',
      false,
      { enabledMcp: ['nanoclaw'] },
    );
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
    const { args } = buildContainerArgs(
      [],
      'nc-test',
      false,
      { enabledMcp: ['nanoclaw', 'gmail', 'notion'] },
    );
    expect(args).toContain('NANOCLAW_ENABLE_MCP=nanoclaw,gmail,notion');
  });

  it('honors empty-array as explicit lockdown (only mcp__nanoclaw__* eligible)', () => {
    // Empty array → empty value. The container interprets this as "no extra
    // MCP servers besides the always-included `nanoclaw`". Distinct from the
    // undefined case below (legacy / all enabled).
    const { args } = buildContainerArgs(
      [],
      'nc-test',
      false,
      { enabledMcp: [] },
    );
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
