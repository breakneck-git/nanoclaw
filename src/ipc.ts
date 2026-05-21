import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  deleteTask,
  getContactsForGroup,
  getTaskById,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import {
  AnnotateContactPayload,
  AnnotateResponse,
  handleAnnotateContactRequest,
  handleLookupMessagesRequest,
  LookupMessagesPayload,
  LookupResponse,
  processAnnotateContact,
  processLookupMessages,
} from './ipc-lookup-handler.js';
import { ViewMediaPayload, ViewMediaResponse } from './ipc-media-handler.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Re-export the handlers and their response types so tests + other modules
// import everything through `./ipc.js`.
export {
  handleAnnotateContactRequest,
  handleLookupMessagesRequest,
  processAnnotateContact,
  processLookupMessages,
};
export type {
  AnnotateContactPayload,
  AnnotateResponse,
  LookupMessagesPayload,
  LookupResponse,
};

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
  ) => Promise<{ messageId?: string } | void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  /**
   * Optional: dispatch a view_media IPC request. Provided by the orchestrator
   * when a Telegram channel is connected (it resolves the grammy Bot and the
   * authorized JID set, then delegates to `handleViewMediaRequest`). Absent
   * when no media-capable channel is wired in — the watcher then leaves
   * media-requests/ files in place for the sweep to TIMEOUT.
   */
  viewMedia?: (
    payload: ViewMediaPayload,
    requestingGroupJids: string[],
  ) => Promise<ViewMediaResponse>;
  /**
   * Optional: dispatch a lookup_messages IPC request. Provided when the
   * orchestrator wants to expose message history lookups to agents (Task 19).
   * The callback resolves `requestingGroupJids` from `registeredGroups`,
   * enriches the payload, and delegates to `handleLookupMessagesRequest`.
   */
  lookupMessages?: (
    payload: LookupMessagesPayload,
    requestingGroupJids: string[],
  ) => Promise<LookupResponse>;
  /**
   * Optional: dispatch an annotate_contact IPC request. Provided when the
   * orchestrator wants to expose contact annotation to agents (Task 19).
   * The callback delegates to `handleAnnotateContactRequest` which enforces
   * the CROSS_GROUP_REJECTED scope guard.
   */
  annotateContact?: (
    payload: AnnotateContactPayload,
    group: string,
  ) => Promise<AnnotateResponse>;
}

let ipcWatcherRunning = false;

// Per-file retry counter for transient send failures. Cleared on success or
// permanent quarantine. Caps unbounded retry of a file targeted at a chat
// that's permanently unreachable.
const ipcRetryCounts = new Map<string, number>();
const IPC_MAX_RETRIES = 5;

/**
 * Atomic host→container IPC response writer.
 *
 * Writes `payload` as JSON to
 * `<ipcRootDir>/<group>/<responseDirName>/<reqId>.json` using a temp+rename
 * pattern (`<final>.tmp.<pid>` → `<final>`). The temp suffix includes
 * `process.pid` so multiple host processes sharing the same group cannot
 * collide on the same temp file (defensive — current architecture is single
 * host process, but cheap insurance).
 *
 * Atomicity relies on same-FS rename semantics: the temp file MUST live on
 * the same filesystem as the final path (it does — both are under the same
 * group/response-dir). Cross-FS rename would degrade to copy+unlink and
 * lose atomicity.
 *
 * The in-container watcher reads the response file as a unit, so partial
 * writes must never be visible. rename(2) provides that guarantee.
 */
export function writeIpcResponseAtomic(
  ipcRootDir: string,
  group: string,
  responseDirName: string,
  reqId: string,
  payload: unknown,
): void {
  const responsePath = path.join(
    ipcRootDir,
    group,
    responseDirName,
    `${reqId}.json`,
  );
  const tmp = `${responsePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, responsePath);
}

/**
 * Convenience: atomic write to `media-responses/<reqId>.json`.
 * Used by the media-download IPC handler (Tasks 18/19).
 */
export function writeMediaResponseAtomic(
  ipcRootDir: string,
  group: string,
  reqId: string,
  payload: unknown,
): void {
  writeIpcResponseAtomic(ipcRootDir, group, 'media-responses', reqId, payload);
}

/**
 * Convenience: atomic write to `lookup-responses/<reqId>.json`.
 * Used by the contact-lookup IPC handler (Tasks 18/19).
 */
export function writeLookupResponseAtomic(
  ipcRootDir: string,
  group: string,
  reqId: string,
  payload: unknown,
): void {
  writeIpcResponseAtomic(ipcRootDir, group, 'lookup-responses', reqId, payload);
}

/**
 * Convenience: atomic write to `contact-write-responses/<reqId>.json`.
 * Used by the contact-write IPC handler (Tasks 18/19).
 */
export function writeContactWriteResponseAtomic(
  ipcRootDir: string,
  group: string,
  reqId: string,
  payload: unknown,
): void {
  writeIpcResponseAtomic(
    ipcRootDir,
    group,
    'contact-write-responses',
    reqId,
    payload,
  );
}

/**
 * Debounced per-scope `contacts.json` snapshot writer (Task 16c).
 *
 * Whenever a contact is upserted into a scope, `onContactUpsert(ipcRoot, scope)`
 * is called. We schedule a 500ms trailing-edge timer for that scope: if more
 * upserts arrive within the window, the timer resets. When it finally fires,
 * we write `<ipcRoot>/<scope>/contacts.json` atomically.
 *
 * **Round-10 main-UNION cross-trigger.** The main scope's snapshot is the
 * UNION of all contacts across every scope. If only non-main scopes upsert,
 * main's debounce timer never gets touched, so its snapshot stays stale.
 * Fix: every non-main `onContactUpsert(_, scope)` ALSO schedules main's timer.
 *
 * State is module-scope (per-process) — intentional. Tests use
 * `vi.useFakeTimers()` for isolation.
 */
const SNAPSHOT_DEBOUNCE_MS = 500;
const snapshotTimers = new Map<string, NodeJS.Timeout>(); // key: `${ipcRoot}|${scope}`

function writeContactsSnapshot(ipcRootDir: string, scope: string): void {
  const contacts = getContactsForGroup({
    scope,
    includeUnion: scope === 'main',
  });
  const dir = path.join(ipcRootDir, scope);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, 'contacts.json');
  const tmp = `${finalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(contacts, null, 2));
  fs.renameSync(tmp, finalPath);
}

function scheduleSnapshot(ipcRootDir: string, scope: string): void {
  const key = `${ipcRootDir}|${scope}`;
  const existing = snapshotTimers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    snapshotTimers.delete(key);
    try {
      writeContactsSnapshot(ipcRootDir, scope);
    } catch (err) {
      logger.error({ err, ipcRootDir, scope }, 'writeContactsSnapshot failed');
    }
  }, SNAPSHOT_DEBOUNCE_MS);
  snapshotTimers.set(key, t);
}

export function onContactUpsert(ipcRootDir: string, scope: string): void {
  scheduleSnapshot(ipcRootDir, scope);
  // Round-10 fix: when only non-main scopes upsert, main's debounce never
  // fires, leaving the UNION snapshot stale. Cross-trigger main timer too.
  if (scope !== 'main') {
    scheduleSnapshot(ipcRootDir, 'main');
  }
}

export function flushAllSnapshots(ipcRootDir: string): void {
  // Fire any pending timers synchronously for the given ipcRoot. Called on
  // SIGTERM so pending writes hit disk before the process exits.
  for (const [key, timer] of snapshotTimers.entries()) {
    const [keyRoot, keyScope] = key.split('|');
    if (keyRoot !== ipcRootDir) continue;
    clearTimeout(timer);
    snapshotTimers.delete(key);
    try {
      writeContactsSnapshot(ipcRootDir, keyScope);
    } catch (err) {
      logger.error(
        { err, scope: keyScope },
        'flushAllSnapshots: writeContactsSnapshot failed',
      );
    }
  }
}

/**
 * Sweep stale IPC request/response files for a single group.
 *
 * Scans `<ipcRootDir>/<group>/<subdir>/` for any subdir whose name ends in
 * `-requests` or `-responses` (e.g. `media-requests`, `media-responses`).
 * The `errors/` directory is operator-review quarantine and is NEVER swept —
 * it's naturally excluded by the regex filter.
 *
 * Rules:
 *  - `.processing` files older than 600s in a request-dir are renamed back
 *    to `<reqId>.json` (orphan recovery — the watcher crashed mid-download).
 *  - Other `.processing` files are skipped (in-flight).
 *  - Request files older than 180s get a TIMEOUT response written (only when
 *    no response file already exists — interlock against watcher/sweep race),
 *    then the request is unlinked.
 *  - Response files older than 180s are unlinked unconditionally.
 */
export function runSweepOnce(ipcRootDir: string, group: string): void {
  const ipcRoot = path.join(ipcRootDir, group);
  if (!fs.existsSync(ipcRoot)) return;
  const subdirs = fs
    .readdirSync(ipcRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-(requests|responses)$/.test(d.name))
    .map((d) => path.join(ipcRoot, d.name));
  for (const dir of subdirs) {
    const isRequestDir = /-requests$/.test(path.basename(dir));
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      const ageMs = Date.now() - stat.mtimeMs;

      // Round-7: orphan .processing recovery (watcher crashed mid-download).
      if (isRequestDir && f.endsWith('.processing') && ageMs > 600_000) {
        const reqPath = full.replace(/\.processing$/, '');
        fs.renameSync(full, reqPath);
        continue;
      }
      // Skip in-flight requests (watcher renamed to .processing).
      if (f.endsWith('.processing')) continue;

      if (ageMs > 180_000) {
        if (isRequestDir) {
          // Write TIMEOUT response ONLY if no response file exists yet
          // (round-6 interlock against watcher/sweep race).
          const reqId = f.replace(/\.json$/, '');
          const responsePath = path.join(
            ipcRoot,
            path.basename(dir).replace('-requests', '-responses'),
            `${reqId}.json`,
          );
          if (!fs.existsSync(responsePath)) {
            fs.writeFileSync(
              responsePath + '.tmp',
              JSON.stringify({
                isError: true,
                _meta: { error_code: 'TIMEOUT', retryable: true },
                content: [{ type: 'text', text: 'TIMEOUT: sweep' }],
              }),
            );
            fs.renameSync(responsePath + '.tmp', responsePath);
          }
          fs.unlinkSync(full);
        } else {
          // Response dir: unlink unconditionally.
          fs.unlinkSync(full);
        }
      }
    }
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            // Parse stage: malformed JSON / missing fields → permanent
            // quarantine. The file isn't recoverable on retry, so move it
            // out of the way so the watcher doesn't loop on it.
            let data: { type?: string; chatJid?: string; text?: string };
            try {
              data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'IPC message parse failed — quarantining',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              try {
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                /* best effort */
              }
              continue;
            }
            // Send stage: transient channel failure (network, rate limit,
            // bot kicked) must NOT quarantine — leave the file in place so
            // the next poll retries. After IPC_MAX_RETRIES the file is
            // moved aside so a single dead chat doesn't wedge the queue.
            try {
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
              ipcRetryCounts.delete(filePath);
            } catch (err) {
              const attempts = (ipcRetryCounts.get(filePath) || 0) + 1;
              ipcRetryCounts.set(filePath, attempts);
              if (attempts >= IPC_MAX_RETRIES) {
                logger.error(
                  { file, sourceGroup, err, attempts },
                  'IPC send failed too many times — quarantining',
                );
                const errorDir = path.join(ipcBaseDir, 'errors');
                try {
                  fs.mkdirSync(errorDir, { recursive: true });
                  fs.renameSync(
                    filePath,
                    path.join(errorDir, `${sourceGroup}-${file}`),
                  );
                } catch {
                  /* best effort */
                }
                ipcRetryCounts.delete(filePath);
              } else {
                logger.warn(
                  { file, sourceGroup, err, attempts },
                  'IPC send failed — will retry on next poll',
                );
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process media-requests from this group's IPC directory (Task 18).
      // Uses the .processing interlock so the sweep doesn't race-cancel an
      // in-flight download. When `deps.viewMedia` is unset (no media channel
      // wired in), the watcher leaves files alone and the sweep eventually
      // emits TIMEOUT.
      try {
        const mediaReqDir = path.join(
          ipcBaseDir,
          sourceGroup,
          'media-requests',
        );
        if (deps.viewMedia && fs.existsSync(mediaReqDir)) {
          const mediaFiles = fs
            .readdirSync(mediaReqDir)
            .filter((f) => f.endsWith('.json'));
          // Compute the JID list for this folder once per sweep iteration.
          const requestingGroupJids = Object.entries(registeredGroups)
            .filter(([, g]) => g.folder === sourceGroup)
            .map(([jid]) => jid);
          for (const file of mediaFiles) {
            const filePath = path.join(mediaReqDir, file);
            const processingPath = `${filePath}.processing`;
            // .processing interlock: atomically rename before reading so
            // concurrent sweep ticks don't re-enter.
            try {
              fs.renameSync(filePath, processingPath);
            } catch {
              // Another tick claimed the file (or it disappeared). Skip.
              continue;
            }
            let payload: ViewMediaPayload | null = null;
            try {
              const raw = fs.readFileSync(processingPath, 'utf-8');
              payload = JSON.parse(raw) as ViewMediaPayload;
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'view_media parse failed — quarantining',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              try {
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  processingPath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                /* best effort */
              }
              continue;
            }
            const reqId = payload.reqId || file.replace(/\.json$/, '');
            try {
              const response = await deps.viewMedia(
                payload,
                requestingGroupJids,
              );
              writeMediaResponseAtomic(
                ipcBaseDir,
                sourceGroup,
                reqId,
                response,
              );
              fs.unlinkSync(processingPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'view_media handler threw — writing UPSTREAM_ERROR',
              );
              writeMediaResponseAtomic(ipcBaseDir, sourceGroup, reqId, {
                isError: true,
                _meta: { error_code: 'UPSTREAM_ERROR', retryable: true },
                content: [
                  {
                    type: 'text',
                    text: `UPSTREAM_ERROR: handler threw — ${(err as Error).message}`,
                  },
                ],
              });
              try {
                fs.unlinkSync(processingPath);
              } catch {
                /* best effort */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC media-requests directory',
        );
      }

      // Process lookup-requests from this group's IPC directory (Task 19).
      // Same .processing interlock pattern as media-requests above.
      try {
        const lookupReqDir = path.join(
          ipcBaseDir,
          sourceGroup,
          'lookup-requests',
        );
        if (deps.lookupMessages && fs.existsSync(lookupReqDir)) {
          const lookupFiles = fs
            .readdirSync(lookupReqDir)
            .filter((f) => f.endsWith('.json'));
          const requestingGroupJids = Object.entries(registeredGroups)
            .filter(([, g]) => g.folder === sourceGroup)
            .map(([jid]) => jid);
          for (const file of lookupFiles) {
            const filePath = path.join(lookupReqDir, file);
            const processingPath = `${filePath}.processing`;
            try {
              fs.renameSync(filePath, processingPath);
            } catch {
              continue;
            }
            let payload: LookupMessagesPayload | null = null;
            try {
              const raw = fs.readFileSync(processingPath, 'utf-8');
              payload = JSON.parse(raw) as LookupMessagesPayload;
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'lookup_messages parse failed — quarantining',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              try {
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  processingPath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                /* best effort */
              }
              continue;
            }
            const reqId = payload.reqId || file.replace(/\.json$/, '');
            try {
              const response = await deps.lookupMessages(
                payload,
                requestingGroupJids,
              );
              writeLookupResponseAtomic(
                ipcBaseDir,
                sourceGroup,
                reqId,
                response,
              );
              try {
                fs.unlinkSync(processingPath);
              } catch {
                /* best effort */
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'lookup_messages handler threw — writing UPSTREAM_ERROR',
              );
              writeLookupResponseAtomic(ipcBaseDir, sourceGroup, reqId, {
                isError: true,
                _meta: { error_code: 'UPSTREAM_ERROR', retryable: true },
                content: [
                  {
                    type: 'text',
                    text: `UPSTREAM_ERROR: handler threw — ${(err as Error).message}`,
                  },
                ],
              });
              try {
                fs.unlinkSync(processingPath);
              } catch {
                /* best effort */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC lookup-requests directory',
        );
      }

      // Process contact-write-requests from this group's IPC directory (Task 19).
      // Same .processing interlock pattern as media-requests above.
      try {
        const contactWriteReqDir = path.join(
          ipcBaseDir,
          sourceGroup,
          'contact-write-requests',
        );
        if (deps.annotateContact && fs.existsSync(contactWriteReqDir)) {
          const writeFiles = fs
            .readdirSync(contactWriteReqDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of writeFiles) {
            const filePath = path.join(contactWriteReqDir, file);
            const processingPath = `${filePath}.processing`;
            try {
              fs.renameSync(filePath, processingPath);
            } catch {
              continue;
            }
            let payload: AnnotateContactPayload | null = null;
            try {
              const raw = fs.readFileSync(processingPath, 'utf-8');
              payload = JSON.parse(raw) as AnnotateContactPayload;
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'annotate_contact parse failed — quarantining',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              try {
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  processingPath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                /* best effort */
              }
              continue;
            }
            const reqId = payload.reqId || file.replace(/\.json$/, '');
            try {
              const response = await deps.annotateContact(payload, sourceGroup);
              writeContactWriteResponseAtomic(
                ipcBaseDir,
                sourceGroup,
                reqId,
                response,
              );
              try {
                fs.unlinkSync(processingPath);
              } catch {
                /* best effort */
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'annotate_contact handler threw — writing UPSTREAM_ERROR',
              );
              writeContactWriteResponseAtomic(ipcBaseDir, sourceGroup, reqId, {
                isError: true,
                _meta: { error_code: 'UPSTREAM_ERROR', retryable: true },
                content: [
                  {
                    type: 'text',
                    text: `UPSTREAM_ERROR: handler threw — ${(err as Error).message}`,
                  },
                ],
              });
              try {
                fs.unlinkSync(processingPath);
              } catch {
                /* best effort */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC contact-write-requests directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
