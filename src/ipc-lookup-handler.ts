/**
 * Host-side `lookup_messages` and `annotate_contact` IPC handlers (Task 19).
 *
 * Two entry shapes:
 *
 *   - `processLookupMessages(payload, requestingGroupJids)` /
 *     `processAnnotateContact(payload, group)` — pure, payload-driven, no FS.
 *     Used by the watcher loop, which has already renamed the request to
 *     `.processing` and parsed the JSON. Returns the MCP-shaped response;
 *     the watcher writes it atomically and cleans up the `.processing` file.
 *
 *   - `handleLookupMessagesRequest(ipcRoot, group, reqId)` /
 *     `handleAnnotateContactRequest(ipcRoot, group, reqId)` — file-driven,
 *     used by tests. Reads the request, calls the pure processor, writes the
 *     response atomically, unlinks the request.
 *
 * Response shape conforms to MCP `CallToolResult`:
 *   { isError?, _meta: { error_code?, retryable?, retry_after_ms? }, content: [...] }
 * On error, the model-facing canonical signal is the `text` prefix
 * `"<CODE>: <human-readable message>"` per the rich-message-capture spec.
 *
 * Error codes used:
 *   - CROSS_GROUP_REJECTED — annotate identifier points at a contact owned
 *     by a different scope (security invariant, non-retryable).
 *   - NOT_FOUND — annotate identifier does not match any known contact in
 *     any scope (non-retryable; nothing to annotate).
 *   - UPSTREAM_ERROR — programmer/DB error caught in the catch path
 *     (retryable).
 */
import fs from 'fs';
import path from 'path';

import {
  annotateContact,
  getContactScopeByIdentity,
  LookupRow,
  lookupMessages,
} from './db.js';
import {
  onContactUpsert,
  writeContactWriteResponseAtomic,
  writeLookupResponseAtomic,
} from './ipc.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Response types (mirror MCP CallToolResult; align with view_media handler).
// ---------------------------------------------------------------------------

export interface LookupContent {
  type: 'text';
  text: string;
}

export interface LookupResponse {
  isError?: boolean;
  _meta: {
    error_code?: string;
    retryable?: boolean;
  };
  content: LookupContent[];
}

export interface AnnotateContent {
  type: 'text';
  text: string;
}

export interface AnnotateResponse {
  isError?: boolean;
  _meta: {
    error_code?: string;
    retryable?: boolean;
  };
  content: AnnotateContent[];
}

// ---------------------------------------------------------------------------
// Payload shapes (loose — the container client may send either nested or flat
// identifier fields; we normalize in `resolveIdentifier`).
// ---------------------------------------------------------------------------

export interface LookupMessagesPayload {
  reqId?: string;
  // Tests + the watcher both populate `groupJids` directly; the container
  // client doesn't — but the watcher enriches the payload before dispatch.
  groupJids?: string[];
  tg_message_id?: string;
  sender_id?: string;
  since?: string;
  until?: string;
  query?: string;
  include_bot?: boolean;
  // Some callers use `includeBot` (tests). Accept both.
  includeBot?: boolean;
  limit?: number;
  chatJid?: string;
  groupFolder?: string;
}

export interface AnnotateContactPayload {
  reqId?: string;
  // Tests use nested `identifier`; container client uses flat fields. Accept
  // either via resolveIdentifier below.
  identifier?: {
    ident?: string;
    username?: string;
    tg_id?: string;
  };
  ident?: string;
  username?: string;
  tg_id?: string;
  notes?: string;
  tags?: string;
  chatJid?: string;
  groupFolder?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveIdentifier(payload: AnnotateContactPayload): {
  ident?: string;
  username?: string;
  tg_id?: string;
} {
  // Prefer nested `identifier` (spec/tests). Fall back to flat fields the
  // container client currently sends.
  return {
    ident: payload.identifier?.ident ?? payload.ident,
    username: payload.identifier?.username ?? payload.username,
    tg_id: payload.identifier?.tg_id ?? payload.tg_id,
  };
}

function formatLookupRows(rows: LookupRow[]): string {
  if (rows.length === 0) return 'No matching messages.';
  const lines = rows.map((r) => {
    const botTag = r.is_bot_message ? ' (bot)' : '';
    const meTag = r.is_from_me ? ' (me)' : '';
    return [
      `<m id="${r.id}" ts="${r.timestamp}" sender="${r.sender}" name="${r.sender_name}"${botTag}${meTag}>`,
      r.content,
      r.meta ? `  meta: ${r.meta}` : '',
      '</m>',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return lines.join('\n');
}

function annotateError(
  code: 'CROSS_GROUP_REJECTED' | 'NOT_FOUND' | 'UPSTREAM_ERROR',
  message: string,
  meta: { retryable?: boolean } = {},
): AnnotateResponse {
  return {
    isError: true,
    _meta: { error_code: code, ...meta },
    content: [{ type: 'text', text: `${code}: ${message}` }],
  };
}

// ---------------------------------------------------------------------------
// lookup_messages — pure processor + file-driven wrapper
// ---------------------------------------------------------------------------

/**
 * Pure payload-driven `lookup_messages` processor. No filesystem side effects.
 * Used by the watcher dispatch path (payload already parsed from a
 * `.processing` file).
 *
 * `requestingGroupJids` is the authoritative JID list for the requesting
 * group, resolved by the watcher from `registeredGroups`. When the caller
 * doesn't pass one (test path), we fall back to `payload.groupJids`.
 */
export function processLookupMessages(
  payload: LookupMessagesPayload,
  requestingGroupJids?: string[],
): LookupResponse {
  const groupJids =
    requestingGroupJids && requestingGroupJids.length > 0
      ? requestingGroupJids
      : (payload.groupJids ?? []);

  // The container-side default is `limit:50`, cap 200. `db.lookupMessages`
  // also clamps to [1, 200] defensively, but pre-cap here so the cap is
  // visible/documented at the IPC boundary too.
  const rawLimit =
    typeof payload.limit === 'number' && Number.isFinite(payload.limit)
      ? payload.limit
      : 50;
  const limit = Math.min(Math.max(rawLimit, 1), 200);

  // Accept either snake_case `include_bot` (container client) or camelCase
  // `includeBot` (tests).
  const includeBot = payload.include_bot ?? payload.includeBot ?? false;

  const rows = lookupMessages({
    groupJids,
    tgMessageId: payload.tg_message_id,
    senderId: payload.sender_id,
    since: payload.since,
    until: payload.until,
    query: payload.query,
    includeBot,
    limit,
  });

  return {
    _meta: {},
    content: [{ type: 'text', text: formatLookupRows(rows) }],
  };
}

/**
 * File-driven entry point. Reads `<ipcRoot>/<group>/lookup-requests/<reqId>.json`,
 * calls `processLookupMessages`, writes the response atomically, unlinks the
 * request. Used by tests; the watcher uses `processLookupMessages` directly.
 */
export async function handleLookupMessagesRequest(
  ipcRoot: string,
  group: string,
  reqId: string,
  requestingGroupJids?: string[],
): Promise<LookupResponse> {
  const reqPath = path.join(ipcRoot, group, 'lookup-requests', `${reqId}.json`);
  const raw = fs.readFileSync(reqPath, 'utf-8');
  const payload = JSON.parse(raw) as LookupMessagesPayload;

  const response = processLookupMessages(payload, requestingGroupJids);

  writeLookupResponseAtomic(ipcRoot, group, reqId, response);
  try {
    fs.unlinkSync(reqPath);
  } catch {
    /* best effort — sweep may have already taken it */
  }
  return response;
}

// ---------------------------------------------------------------------------
// annotate_contact — pure processor + file-driven wrapper
// ---------------------------------------------------------------------------

/**
 * Pure payload-driven `annotate_contact` processor. Enforces the
 * CROSS_GROUP_REJECTED scope guard, calls `db.annotateContact`, and triggers
 * the debounced contacts.json snapshot via `onContactUpsert(ipcRoot, scope)`.
 *
 * Scope guard:
 *   - Resolve identifier → { scope, ident }.
 *   - If no contact matches → NOT_FOUND.
 *   - If `scope !== group && group !== 'main'` → CROSS_GROUP_REJECTED.
 *     (Main is the UNION reflection — annotations issued from `main`
 *     legitimately resolve to a backing scope. Non-main scopes may only
 *     annotate contacts they own.)
 */
export function processAnnotateContact(
  ipcRoot: string,
  payload: AnnotateContactPayload,
  group: string,
): AnnotateResponse {
  const identifier = resolveIdentifier(payload);
  if (!identifier.ident && !identifier.username && identifier.tg_id == null) {
    return annotateError(
      'NOT_FOUND',
      'annotate_contact: no identifier provided',
    );
  }

  const scopeRow = getContactScopeByIdentity(identifier);
  if (!scopeRow) {
    return annotateError('NOT_FOUND', 'contact does not exist in any scope');
  }

  // Security invariant: the resolved contact must belong to the requesting
  // group, OR the requesting group must be `main` (the UNION view, which is
  // allowed to annotate any underlying scope). Annotating a different group's
  // contact from a non-main scope is the cross-group attempt we must block.
  if (scopeRow.scope !== group && group !== 'main') {
    return annotateError(
      'CROSS_GROUP_REJECTED',
      `contact belongs to scope '${scopeRow.scope}', not requesting group '${group}'`,
    );
  }

  // Proceed with annotation. Pass the resolved `ident` (not the original
  // identifier) so we're definitionally writing to the row we just authorized
  // — defense against a race where another process changes the identifier
  // mapping between resolveScope and annotate.
  try {
    annotateContact(
      { ident: scopeRow.ident },
      { notes: payload.notes, tags: payload.tags },
    );
  } catch (err) {
    logger.error(
      { err, group },
      'annotateContact threw — surfacing UPSTREAM_ERROR',
    );
    return annotateError(
      'UPSTREAM_ERROR',
      `annotate failed: ${(err as Error).message}`,
      { retryable: true },
    );
  }

  // Trigger debounced snapshot for the SCOPE that actually owns the row
  // (which may differ from `group` when main annotates a backing scope).
  onContactUpsert(ipcRoot, scopeRow.scope);

  return {
    _meta: {},
    content: [
      {
        type: 'text',
        text: `Contact ${scopeRow.ident} annotated.`,
      },
    ],
  };
}

/**
 * File-driven entry point. Reads `<ipcRoot>/<group>/contact-write-requests/<reqId>.json`,
 * calls `processAnnotateContact`, writes the response atomically, unlinks the
 * request. Used by tests; the watcher uses `processAnnotateContact` directly.
 */
export async function handleAnnotateContactRequest(
  ipcRoot: string,
  group: string,
  reqId: string,
): Promise<AnnotateResponse> {
  const reqPath = path.join(
    ipcRoot,
    group,
    'contact-write-requests',
    `${reqId}.json`,
  );
  const raw = fs.readFileSync(reqPath, 'utf-8');
  const payload = JSON.parse(raw) as AnnotateContactPayload;

  const response = processAnnotateContact(ipcRoot, payload, group);

  writeContactWriteResponseAtomic(ipcRoot, group, reqId, response);
  try {
    fs.unlinkSync(reqPath);
  } catch {
    /* best effort */
  }
  return response;
}
