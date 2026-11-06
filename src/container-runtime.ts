/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envConfig = readEnvFile([
  'CREDENTIAL_PROXY_HOST',
  'CONTAINER_HOST_GATEWAY',
  'CONTAINER_RUNTIME',
]);

export type ContainerRuntime = 'container' | 'docker';

/**
 * Pick the runtime: CONTAINER_RUNTIME (same name container/build.sh reads)
 * wins; otherwise Apple container on macOS, docker everywhere else.
 */
export function resolveContainerRuntime(
  platform: NodeJS.Platform,
  override?: string,
): ContainerRuntime {
  if (override) {
    if (override === 'container' || override === 'docker') return override;
    throw new Error(
      `Unknown CONTAINER_RUNTIME "${override}" — use "container" or "docker"`,
    );
  }
  return platform === 'darwin' ? 'container' : 'docker';
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN: ContainerRuntime = resolveContainerRuntime(
  os.platform(),
  process.env.CONTAINER_RUNTIME || envConfig.CONTAINER_RUNTIME,
);

/** Command that succeeds only when the runtime is up. */
export function statusCommand(rt: ContainerRuntime): string {
  return rt === 'docker' ? 'docker info' : 'container system status';
}

/** Command that starts the runtime; null when systemd owns it (docker). */
export function startCommand(rt: ContainerRuntime): string | null {
  return rt === 'docker' ? null : 'container system start';
}

/** Command listing running containers, in the shape parseRunningNanoclaw reads. */
export function listRunningCommand(rt: ContainerRuntime): string {
  return rt === 'docker'
    ? "docker ps --filter name=nanoclaw- --format '{{.Names}}'"
    : 'container ls --format json';
}

/** Names of running nanoclaw-* containers from listRunningCommand output. */
export function parseRunningNanoclaw(
  rt: ContainerRuntime,
  stdout: string,
): string[] {
  if (rt === 'docker') {
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((n) => n.startsWith('nanoclaw-'));
  }
  const containers: { status: string; configuration: { id: string } }[] =
    JSON.parse(stdout || '[]');
  return containers
    .filter(
      (c) =>
        c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
    )
    .map((c) => c.configuration.id);
}

/** Hostname/IP containers use to reach the host machine.
 * Apple Container: 192.168.64.1 (vmnet gateway)
 * Docker Desktop:  host.docker.internal
 * Override via CONTAINER_HOST_GATEWAY env var.
 */
export const CONTAINER_HOST_GATEWAY =
  process.env.CONTAINER_HOST_GATEWAY ||
  envConfig.CONTAINER_HOST_GATEWAY ||
  'host.docker.internal';

export interface ProxyBindProbe {
  platform: NodeJS.Platform;
  isWsl: boolean;
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Gateway IP of docker's default bridge network, or null if unknown. */
  bridgeGateway: () => string | null;
}

/**
 * Address the credential proxy binds to (when CREDENTIAL_PROXY_HOST is unset).
 * macOS / WSL: 127.0.0.1 — the runtime VM routes host.docker.internal to loopback.
 * Bare-metal Linux: the docker0 bridge IP, so only containers can reach it.
 *   docker0 with no running containers is NO-CARRIER and os.networkInterfaces()
 *   omits it, so fall back to the bridge gateway docker itself reports.
 * Never 0.0.0.0: the proxy has no authentication and serves real credentials.
 */
export function chooseProxyBindHost(p: ProxyBindProbe): string {
  if (p.platform === 'darwin' || p.isWsl) return '127.0.0.1';

  const ipv4 = p.ifaces['docker0']?.find((a) => a.family === 'IPv4');
  if (ipv4) return ipv4.address;

  const gateway = p.bridgeGateway();
  if (gateway) return gateway;

  throw new Error(
    'Cannot detect a safe credential proxy bind address: no docker0 bridge ' +
      'and not running on macOS/WSL. Refusing to bind to 0.0.0.0 because the ' +
      'credential proxy has no authentication and would expose real Anthropic ' +
      'credentials to the network. Set CREDENTIAL_PROXY_HOST in .env to the ' +
      'container-runtime bridge IP (or 127.0.0.1 if your runtime routes ' +
      'host.docker.internal to loopback).',
  );
}

function dockerBridgeGateway(): string | null {
  try {
    const out = execSync(
      "docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}'",
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 },
    );
    return (
      out
        .trim()
        .split(/\s+/)
        .find((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) ?? null
    );
  } catch (err) {
    logger.warn({ err }, 'docker network inspect bridge failed');
    return null;
  }
}

/** Resolve the proxy bind address. Call after the container runtime is up. */
export function proxyBindHost(): string {
  return (
    process.env.CREDENTIAL_PROXY_HOST ||
    envConfig.CREDENTIAL_PROXY_HOST ||
    chooseProxyBindHost({
      platform: os.platform(),
      // Check /proc, not env vars — WSL_DISTRO_NAME isn't set under systemd.
      isWsl: fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'),
      ifaces: os.networkInterfaces(),
      bridgeGateway: dockerBridgeGateway,
    })
  );
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(statusCommand(CONTAINER_RUNTIME_BIN), { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      const start = startCommand(CONTAINER_RUNTIME_BIN);
      if (!start) {
        throw new Error(
          'Docker is not running (check: systemctl status docker)',
        );
      }
      execSync(start, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      const [step1, step2] =
        CONTAINER_RUNTIME_BIN === 'docker'
          ? ['Ensure Docker is installed', 'Run: systemctl start docker']
          : [
              'Ensure Apple Container is installed',
              'Run: container system start',
            ];
      console.error(`║  1. ${step1.padEnd(59)}║`);
      console.error(`║  2. ${step2.padEnd(59)}║`);
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(listRunningCommand(CONTAINER_RUNTIME_BIN), {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans = parseRunningNanoclaw(CONTAINER_RUNTIME_BIN, output);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
