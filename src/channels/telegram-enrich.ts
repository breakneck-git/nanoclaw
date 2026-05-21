/**
 * Telegram contact enrichment — bounded-rate getChat resolver.
 *
 * Per inbound mention/username sighting, callers invoke {@link queueEnrich}.
 * The function dedupes against an in-memory cache (24h success TTL, 7d
 * failure TTL) and against a pending queue. Cache hits on a successful
 * record short-circuit the API and apply the cached patch to the requesting
 * scope's contact row (cross-scope reuse — round-10 fix).
 *
 * The worker started by {@link startEnrichWorker} drains the queue at
 * RATE_PER_SEC (token bucket size 1, refill 1/s) and calls
 * `bot.api.getChat('@username')`, persisting results via
 * {@link upsertContact}.
 *
 * State is in-memory only: cold start re-resolves everything; pending
 * queue entries on restart are lost. Single-process assumption (one Bot
 * instance per host).
 */

import { GrammyError, type Bot } from 'grammy';
import type Database from 'better-sqlite3';
import { upsertContact, type ContactPatch } from '../db.js';
import { logger } from '../logger.js';

// ── Internal state (module-level, scoped per process) ──────────────────────
type EnrichRecord = {
  kind: 'success' | 'failure';
  ts: number;
  data?: ContactPatch;
};

const enrichCache = new Map<string, EnrichRecord>(); // key: lowercased username
const enrichQueue: Array<{ scope: string; username: string }> = [];
const inFlight = new Set<string>(); // key: `${scope}|${username}`

// ── Constants ──────────────────────────────────────────────────────────────
const RATE_PER_SEC = 1;
const TTL_SUCCESS_MS = 24 * 3600 * 1000;
const TTL_FAILURE_MS = 7 * 24 * 3600 * 1000;
const WORKER_TICK_MS = 1000;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Idempotent: caller invokes per inbound mention.
 *
 * Behaviour:
 *  - Cache fresh + success → synchronously apply patch via {@link upsertContact}
 *    for the requesting scope (cross-scope reuse).
 *  - Cache fresh + failure → no-op (Bot API rejected the username; same
 *    outcome for any scope, don't retry).
 *  - Already queued or in-flight → no-op (dedupe).
 *  - Otherwise → push into queue for the worker to drain.
 */
export function queueEnrich(scope: string, username: string): void {
  const un = username.toLowerCase();
  const key = `${scope}|${un}`;
  const cached = enrichCache.get(un);
  const now = Date.now();

  // (a) Cache fresh + success → apply patch to THIS scope (cross-scope reuse).
  if (cached && cached.kind === 'success' && now - cached.ts < TTL_SUCCESS_MS) {
    if (cached.data) {
      upsertContact(scope, cached.data, {
        identity: { username: un },
        source: 'getChat',
        enriched: 1,
      });
    }
    return;
  }

  // (b) Cache fresh + failure → no-op (don't retry; bot API rejected).
  if (cached && cached.kind === 'failure' && now - cached.ts < TTL_FAILURE_MS) {
    return;
  }

  // (c) Already queued or in-flight → dedupe.
  if (inFlight.has(key)) return;
  if (enrichQueue.some((e) => e.scope === scope && e.username === un)) return;

  // (d) Push into queue.
  enrichQueue.push({ scope, username: un });
}

/**
 * Map grammy's `Chat.type` (Bot API enum) → `ContactRow.kind` (db enum).
 *
 *   Bot API:  'private' | 'group' | 'supergroup' | 'channel'
 *   db row:   'user' | 'hidden_user' | 'chat' | 'channel'
 *
 * 'hidden_user' is not reachable via getChat (that's a Bot API ghost — see
 * forwards from privacy-protected senders).
 */
function chatTypeToKind(type: string): 'user' | 'chat' | 'channel' | undefined {
  switch (type) {
    case 'private':
      return 'user';
    case 'group':
    case 'supergroup':
      return 'chat';
    case 'channel':
      return 'channel';
    default:
      return undefined;
  }
}

/**
 * Long-running worker that drains {@link enrichQueue} at RATE_PER_SEC,
 * invokes `bot.api.getChat('@${username}')`, caches the result, and on
 * success calls {@link upsertContact} for the originally-requesting scope.
 *
 * Returns a handle with `stop()` to clear the interval (for graceful
 * shutdown).
 *
 * The `_db` parameter is currently unused — `upsertContact` operates on
 * the module-level Database singleton in `db.ts`. Keeping the parameter
 * preserves the spec's signature (`startEnrichWorker(bot, db)`) and allows
 * the worker to switch to a per-call connection without breaking callers.
 */
export function startEnrichWorker(
  bot: Bot,
  _db: Database.Database,
): { stop: () => void } {
  const timer = setInterval(async () => {
    for (let i = 0; i < RATE_PER_SEC && enrichQueue.length > 0; i++) {
      const entry = enrichQueue.shift()!;
      const key = `${entry.scope}|${entry.username}`;
      inFlight.add(key);
      try {
        // Re-check cache before hitting the API. A sibling queueEnrich for a
        // different scope may have populated the cache after this entry was
        // enqueued (round-2 worker fix — Defect 2).
        const cached = enrichCache.get(entry.username);
        const now = Date.now();
        if (
          cached &&
          cached.kind === 'success' &&
          now - cached.ts < TTL_SUCCESS_MS
        ) {
          if (cached.data) {
            upsertContact(entry.scope, cached.data, {
              identity: { username: entry.username },
              source: 'getChat',
              enriched: 1,
            });
          }
          continue;
        }
        if (
          cached &&
          cached.kind === 'failure' &&
          now - cached.ts < TTL_FAILURE_MS
        ) {
          continue;
        }

        const chat = await bot.api.getChat('@' + entry.username);
        const patch: ContactPatch = {};
        if ('first_name' in chat && chat.first_name) {
          patch.first_name = chat.first_name;
        }
        if ('last_name' in chat && chat.last_name) {
          patch.last_name = chat.last_name;
        }
        if ('title' in chat && chat.title) {
          patch.title = chat.title;
        }
        if ('bio' in chat && chat.bio) {
          patch.bio = chat.bio;
        }
        if ('type' in chat && typeof chat.type === 'string') {
          const mapped = chatTypeToKind(chat.type);
          if (mapped) patch.kind = mapped;
        }

        // Upsert first, then cache — if upsert throws, cache must not claim
        // success for a row that doesn't exist (Defect 3).
        upsertContact(entry.scope, patch, {
          identity: { username: entry.username },
          source: 'getChat',
          enriched: 1,
        });
        enrichCache.set(entry.username, {
          kind: 'success',
          ts: Date.now(),
          data: patch,
        });
      } catch (err) {
        // Discriminate transient vs permanent failures (Defect 1).
        // Only Bot-API 400 means "username/chat truly doesn't exist" — that
        // outcome is stable, safe to cache for the full failure TTL.
        // Everything else (401 auth, 429 flood, 5xx, network/HttpError) is
        // transient — leave the cache untouched so the next mention retries.
        if (err instanceof GrammyError && err.error_code === 400) {
          enrichCache.set(entry.username, {
            kind: 'failure',
            ts: Date.now(),
          });
          logger.debug(
            {
              username: entry.username,
              code: err.error_code,
              desc: err.description,
            },
            'getChat rejected (chat not found), caching failure',
          );
        } else {
          logger.warn(
            { username: entry.username, err: String(err) },
            'getChat failed (transient); not caching',
          );
        }
      } finally {
        inFlight.delete(key);
      }
    }
  }, WORKER_TICK_MS);
  return { stop: () => clearInterval(timer) };
}

// ── Test-only exports (underscore-prefixed by convention) ──────────────────
// The module's state is intentionally process-scoped (one Bot per host),
// which makes test isolation awkward. These helpers exist for the unit
// suite at `telegram-enrich.test.ts` to seed and clear state cleanly.
// Not part of the public API — do not import outside tests.

export function _test_primeCache(username: string, record: EnrichRecord): void {
  enrichCache.set(username.toLowerCase(), record);
}

export function _test_getQueueSize(): number {
  return enrichQueue.length;
}

export function _test_getCacheRecord(username: string): EnrichRecord | undefined {
  return enrichCache.get(username.toLowerCase());
}

export function _test_resetState(): void {
  enrichCache.clear();
  enrichQueue.length = 0;
  inFlight.clear();
}
