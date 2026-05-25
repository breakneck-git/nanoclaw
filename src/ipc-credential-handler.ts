/**
 * Host-side `save_credential` IPC handler (per-group credentials MVP).
 *
 * Two entry shapes mirror the lookup/annotate handlers:
 *
 *   - `processSaveCredential(payload)` — pure-ish (writes to disk, but no
 *     IPC bookkeeping). Used by the watcher loop, which has already renamed
 *     the request to `.processing` and parsed JSON.
 *
 *   - `handleSaveCredentialRequest(ipcRoot, group, reqId)` — file-driven,
 *     used by tests. Reads request, calls the pure processor, writes the
 *     response atomically, unlinks the request.
 *
 * Response shape conforms to MCP `CallToolResult`:
 *   { isError?, _meta: { error_code?, retryable? }, content: [...] }
 *
 * Error codes used:
 *   - UNSUPPORTED_SERVICE — `service` not in the supported set
 *     (currently `notion`, `google-maps`). OAuth-based services
 *     (gmail, calendar, drive) need a separate Device Code Flow tool;
 *     this handler does not accept them.
 *   - INVALID_VALUE — value is empty or contains characters that would
 *     corrupt the env file (newlines, NULs). We reject rather than escape
 *     so the original credential reaches the container verbatim — every
 *     known credential format (Notion `secret_…`, Google `AIza…`) is
 *     ASCII alphanumeric + a short list of safe symbols.
 *   - INVALID_GROUP_FOLDER — `groupFolder` fails `isValidGroupFolder`.
 *     The watcher SHOULD derive `groupFolder` from the IPC path, so this
 *     is defense in depth.
 *   - CROSS_GROUP_REJECTED — caller's claimed `groupFolder` (payload) does
 *     not match the dispatch group (IPC path). Same pattern as
 *     ipc-lookup-handler's CROSS_GROUP_REJECTED guard.
 *   - UPSTREAM_ERROR — unexpected fs failure caught in the catch path
 *     (retryable).
 *
 * SECURITY:
 *   - The credential value is NEVER logged anywhere. Logs include the
 *     service name, env-var key, and group folder only.
 *   - The response text NEVER echoes the value back. The model only needs
 *     "saved <service> for <folder>" — it already has the value from its
 *     own input.
 *   - The env file is written with mode 0600 (owner read/write only) using
 *     a temp+rename atomic pattern.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import {
  writeIpcResponseAtomic,
} from './ipc.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Response types (mirror MCP CallToolResult + lookup/annotate response shapes)
// ---------------------------------------------------------------------------

export interface SaveCredentialContent {
  type: 'text';
  text: string;
}

export interface SaveCredentialResponse {
  isError?: boolean;
  _meta: {
    error_code?: string;
    retryable?: boolean;
  };
  content: SaveCredentialContent[];
}

export interface SaveCredentialPayload {
  reqId?: string;
  service: 'notion' | 'google-maps';
  value: string;
  groupFolder: string;
}

// ---------------------------------------------------------------------------
// Supported services → env-var name mapping. Adding OAuth-based services
// here is wrong — they require Device Code Flow (separate follow-up task).
// ---------------------------------------------------------------------------
const SERVICE_TO_ENV_KEY: Record<string, string> = {
  notion: 'NOTION_API_KEY',
  'google-maps': 'GOOGLE_MAPS_API_KEY',
};

// Characters allowed in credential values. Newlines would corrupt the env
// file format; NUL is never legitimate; we conservatively reject any
// control character. The set is open enough for all known token formats
// (Notion `secret_…`, Google `AIza…`, etc.) which are URL-safe base64-ish.
const INVALID_VALUE_RE = /[\x00-\x1F\x7F]/;

function errorResponse(
  code: string,
  message: string,
  retryable: boolean = false,
): SaveCredentialResponse {
  return {
    isError: true,
    _meta: { error_code: code, retryable },
    content: [{ type: 'text', text: `${code}: ${message}` }],
  };
}

/**
 * Pure-ish payload-driven save_credential processor. Writes the per-group
 * env file at `${DATA_DIR}/env/<folder>.env` with mode 0600 and returns the
 * MCP-shaped response. Never logs or echoes the credential value.
 *
 * The caller (watcher) is responsible for verifying that `payload.groupFolder`
 * matches the dispatch group derived from the IPC path. We additionally
 * reject path-traversal–style folders here as defense in depth.
 */
export function processSaveCredential(
  payload: SaveCredentialPayload,
): SaveCredentialResponse {
  const envKey = SERVICE_TO_ENV_KEY[payload.service];
  if (!envKey) {
    return errorResponse(
      'UNSUPPORTED_SERVICE',
      `service must be one of: ${Object.keys(SERVICE_TO_ENV_KEY).join(', ')}`,
    );
  }

  if (!payload.value || payload.value.length === 0) {
    return errorResponse('INVALID_VALUE', 'value must be non-empty');
  }
  if (INVALID_VALUE_RE.test(payload.value)) {
    return errorResponse(
      'INVALID_VALUE',
      'value contains control characters or newlines',
    );
  }

  if (!isValidGroupFolder(payload.groupFolder)) {
    return errorResponse(
      'INVALID_GROUP_FOLDER',
      'groupFolder failed validation',
    );
  }

  const envDir = path.join(DATA_DIR, 'env');
  try {
    fs.mkdirSync(envDir, { recursive: true });
    const envPath = path.join(envDir, `${payload.groupFolder}.env`);

    // Read existing lines (if any), drop the line that starts with `<envKey>=`,
    // then append the new key=value line.
    let lines: string[] = [];
    if (fs.existsSync(envPath)) {
      lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    }
    const keyPrefix = `${envKey}=`;
    const filtered = lines.filter(
      (line) => line.length > 0 && !line.startsWith(keyPrefix),
    );
    filtered.push(`${keyPrefix}${payload.value}`);

    // Atomic write with 0600. Same-FS rename guarantees atomicity.
    const tmp = `${envPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, filtered.join('\n') + '\n', { mode: 0o600 });
    // chmod again after rename — writeFileSync's mode is honored on create
    // only, but some platforms still apply umask. Explicit chmod after the
    // rename keeps the final file at 0600 regardless.
    fs.renameSync(tmp, envPath);
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      /* best effort — write succeeded, chmod is belt-and-suspenders */
    }

    // NOTE: the credential value is intentionally absent from this log call.
    // Only metadata (service, group, env-var name) is recorded.
    logger.info(
      { service: payload.service, group: payload.groupFolder, envKey },
      'Per-group credential saved (value masked)',
    );

    return {
      _meta: { retryable: false },
      content: [
        {
          type: 'text',
          // Intentionally do NOT echo the value. The agent already has it.
          text: `Saved ${payload.service} credential for group ${payload.groupFolder}. The new value activates on the next container restart — wait a few seconds before testing.`,
        },
      ],
    };
  } catch (err) {
    // Log the error meta only — not the value.
    logger.error(
      { service: payload.service, group: payload.groupFolder, err },
      'processSaveCredential write failed',
    );
    return errorResponse(
      'UPSTREAM_ERROR',
      `failed to write per-group env file: ${(err as Error).message}`,
      true,
    );
  }
}

/**
 * File-driven entry point. Reads
 * `<ipcRoot>/<group>/credential-requests/<reqId>.json`, enforces the
 * CROSS_GROUP_REJECTED scope guard (`group` from path must match
 * `payload.groupFolder`), calls `processSaveCredential`, writes the
 * response atomically, unlinks the request.
 */
export async function handleSaveCredentialRequest(
  ipcRoot: string,
  group: string,
  reqId: string,
): Promise<SaveCredentialResponse> {
  const reqPath = path.join(
    ipcRoot,
    group,
    'credential-requests',
    `${reqId}.json`,
  );
  const raw = fs.readFileSync(reqPath, 'utf-8');
  const payload = JSON.parse(raw) as SaveCredentialPayload;

  // CROSS_GROUP_REJECTED: the watcher derives the dispatch group from the
  // IPC path. The agent could claim a different `groupFolder` in the
  // payload — we reject that mismatch defensively.
  let response: SaveCredentialResponse;
  if (payload.groupFolder !== group) {
    response = errorResponse(
      'CROSS_GROUP_REJECTED',
      `payload.groupFolder='${payload.groupFolder}' does not match dispatch group='${group}'`,
    );
  } else {
    response = processSaveCredential(payload);
  }

  writeIpcResponseAtomic(
    ipcRoot,
    group,
    'credential-responses',
    reqId,
    response,
  );
  try {
    fs.unlinkSync(reqPath);
  } catch {
    /* best effort — sweep may have already taken it */
  }
  return response;
}
