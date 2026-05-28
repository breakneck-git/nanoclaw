/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { readEnvFile, readPerGroupEnvFile } from './env.js';
import { refreshGoogleTokens } from './google-token-refresh.js';
import { validateAdditionalMounts } from './mount-security.js';

const secretsEnv = readEnvFile(['NOTION_API_KEY', 'GOOGLE_MAPS_API_KEY']);
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
// Token-level streaming markers — emitted by the container while a turn is
// still in progress so the host can render typing-style updates without
// waiting for the final result. Inline duplication of the constants on the
// container side (container/agent-runner/src/index.ts) is intentional; they
// must stay in sync by convention.
const OUTPUT_PARTIAL_START_MARKER = '---NANOCLAW_PARTIAL_START---';
const OUTPUT_PARTIAL_END_MARKER = '---NANOCLAW_PARTIAL_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * @internal — exported for unit tests. Builds the volume-mount list for the
 * container. The interesting per-group security seam is the
 * gmail-mcp / google-calendar token directories: see the inline comment in
 * the "Gmail credentials directory" branch below.
 */
export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // .env is shadowed inside the container via mount --bind in entrypoint.sh
    // (Apple Container only supports directory mounts, not file mounts).

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    //
    // Non-main groups (including restricted users like Dana) DO NOT receive:
    //   - the project root mount (no access to src/, store/messages.db,
    //     .env, or any host code/secrets);
    //   - any IPC namespace other than their own (`groupIpcDir` below is
    //     resolved from THIS group's folder, so the path is unique);
    //   - any other group's `groups/<name>/` directory.
    // The aggregated DB views are only reachable via the IPC handlers, which
    // enforce CROSS_GROUP_REJECTED on every cross-scope read/write.
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Gmail + Google-Calendar credentials directories.
  //
  // SECURITY — per-group token isolation (per-group credentials MVP):
  // The gmail-mcp and google-calendar-mcp tools store OAuth tokens on disk
  // and may refresh/rotate them at runtime. Mounting the SAME directory into
  // every container would let any restricted user (e.g. Dana) read or rotate
  // the main user's tokens — a cross-user credential leak.
  //
  // Rule:
  //   - Main group (isMain=true)  → mount from $HOME, unchanged. Preserves
  //                                  backward compatibility for the operator's
  //                                  own setup.
  //   - Non-main groups           → mount from groups/<folder>/.gmail-mcp/
  //                                  and groups/<folder>/.config/google-
  //                                  calendar-mcp/. NEVER fall back to $HOME
  //                                  even if the per-group dir doesn't exist
  //                                  yet — we create an empty one so the
  //                                  mount succeeds and the MCP server can
  //                                  populate it via its own OAuth flow
  //                                  (separate follow-up task).
  const homeDir = os.homedir();
  if (isMain) {
    const gmailDir = path.join(homeDir, '.gmail-mcp');
    if (fs.existsSync(gmailDir)) {
      mounts.push({
        hostPath: gmailDir,
        containerPath: '/home/node/.gmail-mcp',
        readonly: false, // MCP may need to refresh OAuth tokens
      });
    }

    // Google Calendar MCP stores OAuth tokens in ~/.config/google-calendar-mcp/tokens.json
    const calendarTokenDir = path.join(
      homeDir,
      '.config',
      'google-calendar-mcp',
    );
    fs.mkdirSync(calendarTokenDir, { recursive: true });
    mounts.push({
      hostPath: calendarTokenDir,
      containerPath: '/home/node/.config/google-calendar-mcp',
      readonly: false,
    });
  } else {
    // Per-group token dirs — auto-create so the bind mount always succeeds.
    const perGroupGmailDir = path.join(groupDir, '.gmail-mcp');
    fs.mkdirSync(perGroupGmailDir, { recursive: true });
    mounts.push({
      hostPath: perGroupGmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: false,
    });

    const perGroupCalendarDir = path.join(
      groupDir,
      '.config',
      'google-calendar-mcp',
    );
    fs.mkdirSync(perGroupCalendarDir, { recursive: true });
    mounts.push({
      hostPath: perGroupCalendarDir,
      containerPath: '/home/node/.config/google-calendar-mcp',
      readonly: false,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  // Rich-message-capture: request/response queues for in-container tools
  // that need to call back to the host. Three namespaces:
  //   - media-*          (file download / attachment fetch)
  //   - lookup-*         (contact lookup by JID/phone)
  //   - contact-write-*  (contact upsert / display-name set)
  // All six dirs MUST exist at group setup time so the watcher and the
  // in-container tools never race on first use. The sweep in src/ipc.ts
  // (runSweepOnce) handles stale-file cleanup; errors/ is operator-review
  // quarantine and is never swept.
  fs.mkdirSync(path.join(groupIpcDir, 'media-requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'media-responses'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'lookup-requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'lookup-responses'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'contact-write-requests'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'contact-write-responses'), {
    recursive: true,
  });
  // Per-group credentials MVP: save_credential MCP tool request/response.
  // Separate namespace from contact-write so payload validation and security
  // posture stay independent.
  fs.mkdirSync(path.join(groupIpcDir, 'credential-requests'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'credential-responses'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'errors'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other groups.
  // Then pre-compile TypeScript on the host so the container can skip compilation
  // at startup (~30s saved per cold start).
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const agentRunnerTsconfig = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'tsconfig.json',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  const groupAgentDistDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-dist',
  );

  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const distIndex = path.join(groupAgentDistDir, 'index.js');

    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);

    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }

    // Pre-compile on host if source changed or dist missing
    const needsCompile =
      needsCopy ||
      !fs.existsSync(distIndex) ||
      (fs.existsSync(cachedIndex) &&
        fs.statSync(cachedIndex).mtimeMs > fs.statSync(distIndex).mtimeMs);

    if (needsCompile && fs.existsSync(agentRunnerTsconfig)) {
      try {
        fs.mkdirSync(groupAgentDistDir, { recursive: true });
        // Write a per-group tsconfig that compiles the flattened source
        // layout in groupAgentRunnerDir. Using the shared tsconfig via
        // --project would resolve `include` relative to its own directory
        // and compile the original shared source instead of the per-group
        // copy — defeating the whole point.
        const perGroupTsconfig = path.join(
          groupAgentRunnerDir,
          'tsconfig.json',
        );
        fs.writeFileSync(
          perGroupTsconfig,
          JSON.stringify(
            {
              compilerOptions: {
                target: 'ES2022',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                rootDir: '.',
                outDir: groupAgentDistDir,
                strict: true,
                esModuleInterop: true,
                skipLibCheck: true,
                declaration: true,
              },
              include: ['**/*.ts'],
              exclude: ['node_modules'],
            },
            null,
            2,
          ),
        );
        execSync(`npx tsc --project "${perGroupTsconfig}"`, {
          stdio: 'pipe',
          timeout: 60_000,
        });
        logger.info({ group: group.name }, 'Agent-runner pre-compiled on host');
      } catch (err) {
        logger.warn(
          { group: group.name, err },
          'Host pre-compilation failed, container will compile at startup',
        );
        // Non-fatal: container falls back to runtime compilation
      }
    }
  }

  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Mount pre-compiled JS so container skips runtime TypeScript compilation
  if (fs.existsSync(path.join(groupAgentDistDir, 'index.js'))) {
    mounts.push({
      hostPath: groupAgentDistDir,
      containerPath: '/tmp/agent-dist',
      readonly: false,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * @internal — exported for unit tests. Builds the `docker run` argv we hand
 * to `spawn`, plus the temp env-file path the caller must clean up. The
 * `group` arg is only used to look at `group.enabledMcp`; everything else
 * (folder, name) is already baked into `mounts` + `containerName` by the
 * caller. Pass `undefined` (or omit) to skip the MCP whitelist env var
 * — that's the legacy contract: "no whitelist → register every server".
 */
export function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  group?: Pick<RegisteredGroup, 'enabledMcp'>,
  groupFolder?: string,
): { args: string[]; envFilePath: string | null } {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Per-group MCP whitelist. When unset (legacy / main group / older
  // registrations), the container falls back to "all MCP servers enabled" —
  // matching pre-migration behavior. When set, the container only registers
  // the listed servers plus `nanoclaw` (which is hard-required by the agent
  // loop and added unconditionally inside the container).
  //
  // The empty-array case (`[]`) is honored explicitly: it serializes to the
  // empty string and the container code treats it as "no MCP server other
  // than nanoclaw" — useful for the strictest isolated groups.
  if (group?.enabledMcp !== undefined) {
    args.push('-e', `NANOCLAW_ENABLE_MCP=${group.enabledMcp.join(',')}`);
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Third-party MCP secrets go into an --env-file so they don't leak via `ps aux`.
  // Caller is responsible for unlinking the file after the container exits.
  //
  // Per-group credentials MVP: for non-main groups, read
  // data/env/<folder>.env and let its values OVERRIDE the global env. Main
  // group always uses global values only — per-group overrides are an
  // isolation feature for restricted users (e.g. Dana) who must use THEIR
  // OWN Notion / Maps keys, not the operator's.
  let notionKey = process.env.NOTION_API_KEY || secretsEnv.NOTION_API_KEY;
  let googleMapsKey =
    process.env.GOOGLE_MAPS_API_KEY || secretsEnv.GOOGLE_MAPS_API_KEY;
  if (!isMain && groupFolder) {
    const perGroup = readPerGroupEnvFile(groupFolder);
    if (perGroup.NOTION_API_KEY) notionKey = perGroup.NOTION_API_KEY;
    if (perGroup.GOOGLE_MAPS_API_KEY)
      googleMapsKey = perGroup.GOOGLE_MAPS_API_KEY;
  }
  let envFilePath: string | null = null;
  const envFileLines: string[] = [];
  if (notionKey) envFileLines.push(`NOTION_API_KEY=${notionKey}`);
  if (googleMapsKey) envFileLines.push(`GOOGLE_MAPS_API_KEY=${googleMapsKey}`);
  if (envFileLines.length > 0) {
    const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
    envFilePath = path.join(envDir, 'secrets.env');
    fs.writeFileSync(envFilePath, envFileLines.join('\n') + '\n', {
      mode: 0o600,
    });
    args.push('--env-file', envFilePath);
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    if (isMain) {
      // Main containers start as root so the entrypoint can mount --bind
      // to shadow .env. Privileges are dropped via setpriv in entrypoint.sh.
      args.push('-e', `RUN_UID=${hostUid}`);
      args.push('-e', `RUN_GID=${hostGid}`);
    } else {
      args.push('--user', `${hostUid}:${hostGid}`);
    }
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return { args, envFilePath };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onPartialOutput?: (chunk: string) => Promise<void> | void,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const tMark = (label: string): void => {
    logger.debug(
      { group: group.name, label, elapsedMs: Date.now() - startTime },
      'startup-timing',
    );
  };
  tMark('enter-runContainerAgent');

  // Refresh expired Google tokens before starting the container
  await refreshGoogleTokens();
  tMark('after-refreshGoogleTokens');

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  tMark('after-buildVolumeMounts');
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const { args: containerArgs, envFilePath } = buildContainerArgs(
    mounts,
    containerName,
    input.isMain,
    group,
    group.folder,
  );
  tMark('after-buildContainerArgs');

  let envFileCleaned = false;
  const cleanupEnvFile = () => {
    if (envFileCleaned || !envFilePath) return;
    envFileCleaned = true;
    try {
      fs.unlinkSync(envFilePath);
      fs.rmdirSync(path.dirname(envFilePath));
    } catch (err) {
      logger.warn(
        { envFilePath, err: err instanceof Error ? err.message : String(err) },
        'Failed to remove container env-file',
      );
    }
  };

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tMark('after-spawn');

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let firstStdoutLogged = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      if (!firstStdoutLogged) {
        firstStdoutLogged = true;
        tMark('first-stdout-chunk');
      }

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers (both final OUTPUT_* and live PARTIAL_*)
      if (onOutput || onPartialOutput) {
        parseBuffer += chunk;
        // Loop: at each step find the EARLIEST opening marker (either OUTPUT
        // or PARTIAL). If the matching closing marker isn't in the buffer yet,
        // wait for more data. Interleaved parsing matters: the container emits
        // PARTIAL frames every few tokens during a turn, then OUTPUT at the
        // end — without interleaving, partials behind a stalled OUTPUT search
        // would never get drained.
        while (true) {
          const outIdx = parseBuffer.indexOf(OUTPUT_START_MARKER);
          const partIdx = parseBuffer.indexOf(OUTPUT_PARTIAL_START_MARKER);
          // Nothing pending — wait for the next chunk.
          if (outIdx === -1 && partIdx === -1) break;

          // Pick whichever marker appears first in the buffer.
          const usePartial =
            partIdx !== -1 && (outIdx === -1 || partIdx < outIdx);
          const startMarker = usePartial
            ? OUTPUT_PARTIAL_START_MARKER
            : OUTPUT_START_MARKER;
          const endMarker = usePartial
            ? OUTPUT_PARTIAL_END_MARKER
            : OUTPUT_END_MARKER;
          const startIdx = usePartial ? partIdx : outIdx;

          const endIdx = parseBuffer.indexOf(endMarker, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + startMarker.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + endMarker.length);

          if (usePartial) {
            // PARTIAL block: deliver `text` chunk to onPartialOutput. We
            // intentionally do NOT mark hadStreamingOutput or reset the
            // timeout from partials — those signals are reserved for full
            // result blocks. A partial-only stream that never produces a
            // result must still trip the hard timeout.
            if (!onPartialOutput) continue;
            try {
              const parsed = JSON.parse(jsonStr) as { text?: unknown };
              const text = parsed?.text;
              if (typeof text !== 'string' || text.length === 0) continue;
              // Fire-and-forget — don't await. Same rationale as outputChain
              // on the full-result path: a slow Telegram edit must not block
              // the per-chunk parse loop. Errors are logged and swallowed so
              // a single bad chunk doesn't wedge subsequent ones.
              const partialResult = onPartialOutput(text);
              if (partialResult && typeof partialResult.then === 'function') {
                partialResult.catch((err: unknown) => {
                  logger.warn(
                    { group: group.name, err },
                    'Streaming onPartialOutput callback failed; continuing',
                  );
                });
              }
            } catch (err) {
              logger.warn(
                { group: group.name, error: err },
                'Failed to parse streamed partial chunk',
              );
            }
            continue;
          }

          // OUTPUT block: full result, drives session bookkeeping.
          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            if (!onOutput) continue;
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            // Capture failures in the streaming callback (e.g. channel send
            // errors) so a single bad onOutput call doesn't permanently
            // reject outputChain and wedge runContainerAgent — its on-close
            // resolver awaits this chain via .then() without onRejected, so
            // a rejection would leave the outer Promise pending forever.
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  { group: group.name, err },
                  'Streaming onOutput callback failed; continuing chain',
                );
              });
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      cleanupEnvFile();
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      cleanupEnvFile();
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
