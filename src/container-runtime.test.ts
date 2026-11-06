import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pin the runtime so the command-shape tests below are the same on macOS and
// Linux; per-platform selection is covered by resolveContainerRuntime tests.
vi.hoisted(() => {
  process.env.CONTAINER_RUNTIME = 'container';
});

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  resolveContainerRuntime,
  listRunningCommand,
  parseRunningNanoclaw,
  statusCommand,
  startCommand,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  chooseProxyBindHost,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('resolveContainerRuntime', () => {
  it('uses Apple container on macOS and docker elsewhere', () => {
    expect(resolveContainerRuntime('darwin')).toBe('container');
    expect(resolveContainerRuntime('linux')).toBe('docker');
  });

  it('lets CONTAINER_RUNTIME override the platform default', () => {
    expect(resolveContainerRuntime('darwin', 'docker')).toBe('docker');
    expect(resolveContainerRuntime('linux', 'container')).toBe('container');
  });

  it('treats an empty override as unset', () => {
    expect(resolveContainerRuntime('linux', '')).toBe('docker');
  });

  it('rejects an unknown runtime', () => {
    expect(() => resolveContainerRuntime('linux', 'podman')).toThrow(/podman/);
  });
});

describe('runtime commands', () => {
  it('docker: lists running nanoclaw containers by name', () => {
    expect(listRunningCommand('docker')).toBe(
      "docker ps --filter name=nanoclaw- --format '{{.Names}}'",
    );
    expect(statusCommand('docker')).toBe('docker info');
    expect(startCommand('docker')).toBeNull();
  });

  it('container: keeps the Apple container commands', () => {
    expect(listRunningCommand('container')).toBe('container ls --format json');
    expect(statusCommand('container')).toBe('container system status');
    expect(startCommand('container')).toBe('container system start');
  });
});

describe('parseRunningNanoclaw', () => {
  it('docker: takes nanoclaw- names from one-per-line output', () => {
    expect(
      parseRunningNanoclaw(
        'docker',
        'nanoclaw-main-1\nother-thing\nnanoclaw-dana-2\n',
      ),
    ).toEqual(['nanoclaw-main-1', 'nanoclaw-dana-2']);
    expect(parseRunningNanoclaw('docker', '')).toEqual([]);
  });

  it('container: takes running nanoclaw- ids from JSON output', () => {
    const out = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-a-1' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-b-2' } },
      { status: 'running', configuration: { id: 'other' } },
    ]);
    expect(parseRunningNanoclaw('container', out)).toEqual(['nanoclaw-a-1']);
    expect(parseRunningNanoclaw('container', '')).toEqual([]);
  });
});

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} system status`,
      { stdio: 'pipe' },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('auto-starts when system status fails', () => {
    // First call (system status) fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    // Second call (system start) succeeds
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} system start`,
      { stdio: 'pipe', timeout: 30000 },
    );
    expect(logger.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers from JSON output', () => {
    // Apple Container ls returns JSON
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-group1-111' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-group2-222' } },
      { status: 'running', configuration: { id: 'nanoclaw-group3-333' } },
      { status: 'running', configuration: { id: 'other-container' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ls + 2 stop calls (only running nanoclaw- containers)
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group3-333`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group3-333'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-a-1' } },
      { status: 'running', configuration: { id: 'nanoclaw-b-2' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- chooseProxyBindHost ---

describe('chooseProxyBindHost', () => {
  const docker0Up = {
    docker0: [
      {
        address: '172.17.0.1',
        family: 'IPv4' as const,
        netmask: '255.255.0.0',
        mac: '00:00:00:00:00:00',
        internal: false,
        cidr: '172.17.0.1/16',
      },
    ],
  };
  const noGateway = () => null;

  it('uses loopback on macOS', () => {
    expect(
      chooseProxyBindHost({
        platform: 'darwin',
        isWsl: false,
        ifaces: {},
        bridgeGateway: noGateway,
      }),
    ).toBe('127.0.0.1');
  });

  it('uses the docker0 address when the interface is listed', () => {
    expect(
      chooseProxyBindHost({
        platform: 'linux',
        isWsl: false,
        ifaces: docker0Up,
        bridgeGateway: () => '10.9.9.9',
      }),
    ).toBe('172.17.0.1');
  });

  // docker0 with no running containers is NO-CARRIER, and Node's
  // os.networkInterfaces() omits it — the state right after a host reboot.
  it('falls back to the docker bridge gateway when docker0 is not listed', () => {
    expect(
      chooseProxyBindHost({
        platform: 'linux',
        isWsl: false,
        ifaces: { lo: [] },
        bridgeGateway: () => '172.17.0.1',
      }),
    ).toBe('172.17.0.1');
  });

  it('refuses to guess when neither docker0 nor the bridge gateway is known', () => {
    expect(() =>
      chooseProxyBindHost({
        platform: 'linux',
        isWsl: false,
        ifaces: { lo: [] },
        bridgeGateway: noGateway,
      }),
    ).toThrow(/CREDENTIAL_PROXY_HOST/);
  });
});
