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

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST ||
  envConfig.CREDENTIAL_PROXY_HOST ||
  detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }

  // No safe interface found. Refuse to fall back to 0.0.0.0 — the credential
  // proxy serves real API keys with no authentication. Binding to all
  // interfaces would expose them to anyone on the network. The user must opt
  // in explicitly via CREDENTIAL_PROXY_HOST (e.g. a podman/CNI bridge IP).
  throw new Error(
    'Cannot detect a safe credential proxy bind address: no docker0 bridge ' +
      'and not running on macOS/WSL. Refusing to bind to 0.0.0.0 because the ' +
      'credential proxy has no authentication and would expose real Anthropic ' +
      'credentials to the network. Set CREDENTIAL_PROXY_HOST in .env to the ' +
      'container-runtime bridge IP (or 127.0.0.1 if your runtime routes ' +
      'host.docker.internal to loopback).',
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
