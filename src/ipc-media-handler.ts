/**
 * Host-side `view_media` IPC handler (Task 18).
 *
 * Owns the path from agent-issued `view_media` IPC payload to the atomic
 * response file the in-container watcher polls for. See
 * `docs/superpowers/specs/2026-05-20-rich-message-capture-design.md` lines
 * 482-599 for the full spec.
 *
 * Public entry point: `handleViewMediaRequest(payload, requestingGroupJids, bot)`.
 *
 * Response shape conforms to MCP `CallToolResult`:
 *   { isError?, _meta: { error_code?, retryable?, retry_after_ms? }, content: [...] }
 * On error, the model-facing canonical signal is the `text` prefix
 * `"<CODE>: <human-readable message>"` per spec lines 568-584.
 *
 * Error codes implemented (10):
 *   - CROSS_GROUP_REJECTED  (security-critical two-query authorization)
 *   - FILE_TOO_LARGE        (20MB pre-check from meta.size)
 *   - FILE_EXPIRED          (getFile "file is too old")
 *   - UPSTREAM_ERROR        (non-retryable 4xx after retry budget)
 *   - UNSUPPORTED_TYPE      (HEIC/TIFF, processImage failure, other mime)
 *   - EXTRACTOR_MISSING     (pdftotext/pdftoppm/pdfinfo not on PATH)
 *   - EXTRACTOR_OUTPUT_INVALID (Syntax Error / corruption / nonzero exit)
 *   - NO_TEXT_LAYER         (exit 0 + empty stdout + empty stderr)
 *   - PAGES_OUT_OF_RANGE    (invalid pages format or start > totalPages)
 *   - TIMEOUT               (emitted by sweep, not by this handler — see ipc.ts runSweepOnce)
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Bot } from 'grammy';
import { GrammyError } from 'grammy';
import sharp from 'sharp';

import { db } from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FILE_TOO_LARGE_LIMIT = 20 * 1024 * 1024; // 20MB
const PDF_TEXT_TRUNCATE = 500 * 1024; // 500KB
const TEXT_DECODE_LIMIT = 200 * 1024; // 200KB
const PDF_PAGES_CAP = 10;
const RETRY_BACKOFFS_MS = [1000, 2000, 4000, 8000];
const RETRY_AFTER_CAP_MS = 10_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ViewMediaPayload {
  reqId: string;
  file_id: string;
  tg_message_id: string;
  mode?: 'auto' | 'image' | 'text';
  pages?: string;
  chatJid: string;
  groupFolder: string;
}

export interface ViewMediaContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ViewMediaResponse {
  isError?: boolean;
  _meta: {
    error_code?: string;
    retryable?: boolean;
    retry_after_ms?: number;
  };
  content: ViewMediaContent[];
}

type ErrorCode =
  | 'CROSS_GROUP_REJECTED'
  | 'FILE_TOO_LARGE'
  | 'FILE_EXPIRED'
  | 'UPSTREAM_ERROR'
  | 'UNSUPPORTED_TYPE'
  | 'EXTRACTOR_MISSING'
  | 'EXTRACTOR_OUTPUT_INVALID'
  | 'NO_TEXT_LAYER'
  | 'PAGES_OUT_OF_RANGE';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function errorResponse(
  code: ErrorCode,
  message: string,
  meta: { retryable?: boolean; retry_after_ms?: number } = {},
): ViewMediaResponse {
  return {
    isError: true,
    _meta: { error_code: code, ...meta },
    content: [{ type: 'text', text: `${code}: ${message}` }],
  };
}

function successResponse(content: ViewMediaContent[]): ViewMediaResponse {
  return { _meta: {}, content };
}

// ---------------------------------------------------------------------------
// CROSS_GROUP_REJECTED two-query algorithm (spec error-contract row line 597).
// ---------------------------------------------------------------------------

/**
 * Authorize the request: is `tg_message_id` owned by the requesting group,
 * or does it exist in a different group, or doesn't exist at all (external
 * reply pass-through)?
 *
 * Returns:
 *   - 'allow'  → continue processing
 *   - 'reject' → return CROSS_GROUP_REJECTED to caller
 */
function checkAuthorization(
  tgMessageId: string,
  requestingGroupJids: string[],
): 'allow' | 'reject' {
  if (requestingGroupJids.length === 0) {
    // No registered JIDs for this group folder → can't prove ownership; defer
    // to the cross-group check. If the row exists anywhere, reject (defense
    // in depth); if not, allow (external_reply pass-through).
    const anywhere = db
      .prepare('SELECT 1 FROM messages WHERE id = ? LIMIT 1')
      .get(tgMessageId);
    return anywhere ? 'reject' : 'allow';
  }

  // Step 1: owner check — does the row exist in any of the requesting
  // group's JIDs? If yes, ALLOW.
  const placeholders = requestingGroupJids.map(() => '?').join(',');
  const ownRow = db
    .prepare(
      `SELECT 1 FROM messages WHERE id = ? AND chat_jid IN (${placeholders}) LIMIT 1`,
    )
    .get(tgMessageId, ...requestingGroupJids);
  if (ownRow) return 'allow';

  // Step 2: cross-group check — does the row exist elsewhere? If yes, REJECT
  // (some other group's message); if no, ALLOW (external_reply pass-through —
  // file_id came from a host-emitted meta block already authorized by the
  // mount boundary).
  const anywhere = db
    .prepare('SELECT 1 FROM messages WHERE id = ? LIMIT 1')
    .get(tgMessageId);
  return anywhere ? 'reject' : 'allow';
}

// ---------------------------------------------------------------------------
// Meta-block parsing for the 20MB pre-check.
// ---------------------------------------------------------------------------

/**
 * Pull the `size` attribute out of the `<media file_id="X" size="N"/>` tag in
 * the message's `meta` column. Simple regex — we don't require a full XML
 * parser. Returns `null` when the row, the meta, or the size attribute is
 * absent (pre-check skipped; final size check happens after download).
 */
function lookupCachedFileSize(
  tgMessageId: string,
  fileId: string,
): number | null {
  const row = db
    .prepare('SELECT meta FROM messages WHERE id = ? LIMIT 1')
    .get(tgMessageId) as { meta: string | null } | undefined;
  if (!row?.meta) return null;
  // Use the file_id as anchor so we don't accidentally pick a sibling
  // `<reply><media>` size. Match `<media ... file_id="X" ... size="N"...>`
  // OR `<media ... size="N" ... file_id="X"...>` (attribute order varies).
  const fidEsc = fileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<media[^>]*file_id="${fidEsc}"[^>]*size="(\\d+)"`),
    new RegExp(`<media[^>]*size="(\\d+)"[^>]*file_id="${fidEsc}"`),
  ];
  for (const re of patterns) {
    const m = re.exec(row.meta);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// getFile + downloadFile with retry budget.
// ---------------------------------------------------------------------------

interface DownloadOk {
  ok: true;
  buffer: Buffer;
  mimeType: string | null;
  fileSize: number;
}

interface DownloadErr {
  ok: false;
  response: ViewMediaResponse;
}

type DownloadResult = DownloadOk | DownloadErr;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run getFile + downloadFile with up to 5 attempts (initial + 4 retries).
 * Backoff schedule: 1s, 2s, 4s, 8s between attempts.
 *
 * Honors `Retry-After` from grammy GrammyError 429 (clamped to RETRY_AFTER_CAP_MS).
 *
 * Returns either a populated buffer + metadata, OR a ViewMediaResponse error
 * the caller forwards verbatim (FILE_EXPIRED / UPSTREAM_ERROR).
 */
async function fetchTelegramFile(
  bot: Bot,
  fileId: string,
): Promise<DownloadResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // getFile returns metadata incl. file_path. grammy's File object also
      // exposes a `.download()` helper that fetches the bytes; we use that
      // when present, otherwise fall back to constructing the URL manually.
      const file = await bot.api.getFile(fileId);
      const buffer = await downloadFileBytes(bot, file);
      return {
        ok: true,
        buffer,
        mimeType: null, // grammy File doesn't expose mime; caller infers from meta/sharp
        fileSize: file.file_size ?? buffer.byteLength,
      };
    } catch (err) {
      lastErr = err;
      // FILE_EXPIRED — non-retryable.
      const desc =
        err instanceof GrammyError
          ? err.description.toLowerCase()
          : err instanceof Error
            ? err.message.toLowerCase()
            : '';
      if (desc.includes('file is too old')) {
        return {
          ok: false,
          response: errorResponse(
            'FILE_EXPIRED',
            'Telegram file is too old to retrieve',
          ),
        };
      }

      // 4xx non-retryable (except 429).
      if (err instanceof GrammyError) {
        const code = err.error_code;
        if (code === 429) {
          // Rate-limited: respect Retry-After if present.
          const retryAfterSec = err.parameters?.retry_after;
          const retryAfterMs =
            retryAfterSec != null
              ? Math.min(retryAfterSec * 1000, RETRY_AFTER_CAP_MS)
              : RETRY_BACKOFFS_MS[
                  Math.min(attempt, RETRY_BACKOFFS_MS.length - 1)
                ];
          if (attempt < 4) {
            await sleep(retryAfterMs);
            continue;
          }
          // Exhausted retries on 429 — surface upstream Retry-After in meta.
          return {
            ok: false,
            response: errorResponse(
              'UPSTREAM_ERROR',
              `Telegram rate limit (429): ${err.description}`,
              {
                retryable: true,
                retry_after_ms: retryAfterMs,
              },
            ),
          };
        }
        if (code >= 400 && code < 500) {
          // Non-rate-limit 4xx → no retry.
          return {
            ok: false,
            response: errorResponse(
              'UPSTREAM_ERROR',
              `Telegram API error ${code}: ${err.description}`,
              { retryable: true },
            ),
          };
        }
        // 5xx → retry below.
      }

      // 5xx, network, or unknown error → retry per backoff.
      if (attempt < 4) {
        await sleep(RETRY_BACKOFFS_MS[attempt]);
        continue;
      }
    }
  }
  // All retries exhausted.
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  return {
    ok: false,
    response: errorResponse(
      'UPSTREAM_ERROR',
      `getFile failed after 5 attempts: ${msg}`,
      { retryable: true },
    ),
  };
}

/**
 * Download the bytes for a grammy File. Uses the `file_path` to construct the
 * direct-download URL; relies on global `fetch` (Node 18+).
 *
 * Exported separately so tests can patch the HTTP layer if needed without
 * having to mock the entire getFile/download path.
 */
async function downloadFileBytes(
  bot: Bot,
  file: { file_path?: string; file_id: string },
): Promise<Buffer> {
  if (!file.file_path) {
    throw new Error('getFile returned no file_path');
  }
  // `bot.token` is the trusted bot token (private field exposed by grammy on
  // the Bot class). When unavailable (mock Bot in tests), use the constructed
  // URL path-only form which the test mock can intercept.
  // We cast via unknown because grammy's Bot type doesn't publicly expose `token`.
  const token = (bot as unknown as { token: string }).token;
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download HTTP ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ---------------------------------------------------------------------------
// Image processing (sharp). Re-inlined verbatim from the deleted src/image.ts.
// Returns null on failure → caller emits UNSUPPORTED_TYPE.
// ---------------------------------------------------------------------------

async function processImage(
  buffer: Buffer,
): Promise<{ type: 'image'; data: string; mimeType: 'image/jpeg' } | null> {
  try {
    const processed = await sharp(buffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    return {
      type: 'image',
      data: processed.toString('base64'),
      mimeType: 'image/jpeg',
    };
  } catch (err) {
    logger.warn({ err }, 'processImage failed');
    return null;
  }
}

// ---------------------------------------------------------------------------
// PDF extraction — pdftotext / pdfinfo / pdftoppm wrappers.
// ---------------------------------------------------------------------------

interface PdftotextResult {
  status: number;
  stdout: string;
  stderr: string;
  binaryFound: boolean;
}

function runPdftotext(buffer: Buffer): PdftotextResult {
  try {
    const r = spawnSync(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', '-nopgbrk', '-', '-'],
      { input: buffer, encoding: 'buffer' },
    );
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: -1, stdout: '', stderr: '', binaryFound: false };
    }
    return {
      status: r.status ?? -1,
      stdout: r.stdout ? r.stdout.toString('utf-8') : '',
      stderr: r.stderr ? r.stderr.toString('utf-8') : '',
      binaryFound: true,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: -1, stdout: '', stderr: '', binaryFound: false };
    }
    throw err;
  }
}

const CORRUPTION_RE = /Syntax Error|May not be a PDF file/i;

function classifyPdftotext(r: PdftotextResult): ViewMediaResponse | null {
  // Decision table v8 (spec line 560):
  //   1. stdout empty AND stderr matches corruption regex → EXTRACTOR_OUTPUT_INVALID
  //   2. exit === 0 AND stdout empty AND stderr empty → NO_TEXT_LAYER
  //   3. exit !== 0 AND stdout empty AND stderr does NOT match regex → EXTRACTOR_OUTPUT_INVALID
  //   4. stdout non-empty → return stdout text (handled by caller, returns null here)
  const stdoutEmpty = r.stdout.length === 0;
  const stderrCorruption = CORRUPTION_RE.test(r.stderr);

  if (stdoutEmpty && stderrCorruption) {
    return errorResponse(
      'EXTRACTOR_OUTPUT_INVALID',
      'pdftotext reported file corruption',
    );
  }
  if (r.status === 0 && stdoutEmpty && r.stderr.length === 0) {
    return errorResponse(
      'NO_TEXT_LAYER',
      "PDF has no extractable text — retry with mode:'image' and a small pages range to render the scan",
    );
  }
  if (r.status !== 0 && stdoutEmpty && !stderrCorruption) {
    return errorResponse(
      'EXTRACTOR_OUTPUT_INVALID',
      `pdftotext exited ${r.status} with no output`,
    );
  }
  return null; // happy path: non-empty stdout, caller emits text content
}

function makePdfTextContent(r: PdftotextResult): ViewMediaContent[] {
  let text = r.stdout;
  if (text.length > PDF_TEXT_TRUNCATE) {
    text = text.slice(0, PDF_TEXT_TRUNCATE) + '\n…[truncated]';
  }
  if (r.status !== 0) {
    text += `\n[pdftotext exit ${r.status}; partial recovery]`;
  }
  return [{ type: 'text', text }];
}

/**
 * Parse a "N-M" page-range string per spec line 561. Returns the validated
 * [start, end] pair, or a PAGES_OUT_OF_RANGE error response.
 */
function parsePagesRange(
  pages: string | undefined,
): { start: number; end: number } | ViewMediaResponse {
  const raw = pages ?? '1-1';
  const m = /^(\d+)-(\d+)$/.exec(raw);
  if (!m) {
    return errorResponse(
      'PAGES_OUT_OF_RANGE',
      `invalid pages format: ${JSON.stringify(raw)}; expected "N-M"`,
    );
  }
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 1 ||
    end < start
  ) {
    return errorResponse('PAGES_OUT_OF_RANGE', `pages out of range: ${raw}`);
  }
  if (end - start + 1 > PDF_PAGES_CAP) {
    return errorResponse(
      'PAGES_OUT_OF_RANGE',
      `requested range exceeds ${PDF_PAGES_CAP}-page cap`,
    );
  }
  return { start, end };
}

function probePdfPageCount(
  buffer: Buffer,
): { totalPages: number } | ViewMediaResponse {
  try {
    const r = spawnSync('pdfinfo', ['-'], {
      input: buffer,
      encoding: 'buffer',
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return errorResponse(
        'EXTRACTOR_MISSING',
        'pdfinfo not found on PATH (install poppler-utils)',
      );
    }
    const stdout = r.stdout ? r.stdout.toString('utf-8') : '';
    const m = /^Pages:\s+(\d+)/m.exec(stdout);
    if (!m) {
      return errorResponse(
        'EXTRACTOR_OUTPUT_INVALID',
        'pdfinfo: could not determine page count',
      );
    }
    return { totalPages: parseInt(m[1], 10) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return errorResponse(
        'EXTRACTOR_MISSING',
        'pdfinfo not found on PATH (install poppler-utils)',
      );
    }
    return errorResponse(
      'EXTRACTOR_OUTPUT_INVALID',
      `pdfinfo failed: ${(err as Error).message}`,
    );
  }
}

async function renderPdfPages(
  buffer: Buffer,
  start: number,
  end: number,
): Promise<ViewMediaResponse> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-pdf-'));
  try {
    const pdfPath = path.join(tmp, 'input.pdf');
    fs.writeFileSync(pdfPath, buffer);
    const prefix = path.join(tmp, 'page');
    const r = spawnSync(
      'pdftoppm',
      [
        '-jpeg',
        '-r',
        '150',
        '-f',
        String(start),
        '-l',
        String(end),
        pdfPath,
        prefix,
      ],
      { encoding: 'buffer' },
    );
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return errorResponse(
        'EXTRACTOR_MISSING',
        'pdftoppm not found on PATH (install poppler-utils)',
      );
    }
    if (r.status !== 0) {
      const stderr = r.stderr ? r.stderr.toString('utf-8') : '';
      return errorResponse(
        'EXTRACTOR_OUTPUT_INVALID',
        `pdftoppm exited ${r.status}: ${stderr.slice(0, 200)}`,
      );
    }
    const contents: ViewMediaContent[] = [];
    for (let p = start; p <= end; p++) {
      // pdftoppm zero-pads page numbers per its `-W` default; but with our
      // explicit -f/-l the suffix uses the natural decimal width. Probe a
      // small set of plausible suffixes.
      const candidates = [
        `${prefix}-${p}.jpg`,
        `${prefix}-${String(p).padStart(2, '0')}.jpg`,
        `${prefix}-${String(p).padStart(3, '0')}.jpg`,
      ];
      const found = candidates.find((c) => fs.existsSync(c));
      if (!found) {
        return errorResponse(
          'EXTRACTOR_OUTPUT_INVALID',
          `pdftoppm did not produce expected file for page ${p}`,
        );
      }
      const buf = fs.readFileSync(found);
      contents.push({
        type: 'image',
        data: buf.toString('base64'),
        mimeType: 'image/jpeg',
      });
    }
    return successResponse(contents);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Mime routing.
// ---------------------------------------------------------------------------

/**
 * Pull the `mime` attribute for the given file_id out of the message meta
 * block — used to route routing when getFile doesn't carry it. Returns
 * `null` when not found so the caller can fall back to sharp-based sniffing.
 */
function lookupCachedMime(tgMessageId: string, fileId: string): string | null {
  const row = db
    .prepare('SELECT meta FROM messages WHERE id = ? LIMIT 1')
    .get(tgMessageId) as { meta: string | null } | undefined;
  if (!row?.meta) return null;
  const fidEsc = fileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<media[^>]*file_id="${fidEsc}"[^>]*mime="([^"]+)"`),
    new RegExp(`<media[^>]*mime="([^"]+)"[^>]*file_id="${fidEsc}"`),
  ];
  for (const re of patterns) {
    const m = re.exec(row.meta);
    if (m) return m[1];
  }
  return null;
}

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);
const UNSUPPORTED_IMAGE_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/tiff',
]);
const VIDEO_MIMES = new Set([
  'application/x-tgsticker',
  'video/webm',
  'video/mp4',
  'video/quicktime',
]);
const VOICE_MIMES = new Set([
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/x-m4a',
  'audio/wav',
]);

async function routeByMime(
  mime: string,
  buffer: Buffer,
  payload: ViewMediaPayload,
): Promise<ViewMediaResponse> {
  const lower = mime.toLowerCase();

  // 1. Image — supported.
  if (IMAGE_MIMES.has(lower)) {
    const img = await processImage(buffer);
    if (!img) {
      return errorResponse(
        'UNSUPPORTED_TYPE',
        `image decode failed for mime ${mime}`,
      );
    }
    return successResponse([img]);
  }

  // 2. Image — explicitly unsupported (sharp's prebuilt binary).
  if (UNSUPPORTED_IMAGE_MIMES.has(lower)) {
    return errorResponse(
      'UNSUPPORTED_TYPE',
      `mime ${mime} not supported by sharp prebuilt`,
    );
  }

  // 3. Video / animated sticker — descriptor only.
  if (VIDEO_MIMES.has(lower)) {
    return successResponse([
      {
        type: 'text',
        text: `тип ${mime} не отображается; ${buffer.byteLength} bytes downloaded but not rendered`,
      },
    ]);
  }

  // 4. PDF — branch on mode.
  if (lower === 'application/pdf') {
    const mode = payload.mode ?? 'auto';
    if (mode === 'image') {
      const range = parsePagesRange(payload.pages);
      if ('isError' in range && range.isError)
        return range as ViewMediaResponse;
      const { start, end } = range as { start: number; end: number };
      const probe = probePdfPageCount(buffer);
      if ('isError' in probe && probe.isError)
        return probe as ViewMediaResponse;
      const { totalPages } = probe as { totalPages: number };
      if (start > totalPages) {
        return errorResponse(
          'PAGES_OUT_OF_RANGE',
          `start page ${start} exceeds total ${totalPages}`,
        );
      }
      const effectiveEnd = Math.min(end, totalPages);
      return renderPdfPages(buffer, start, effectiveEnd);
    }
    // mode = 'auto' | 'text' → text extraction.
    const r = runPdftotext(buffer);
    if (!r.binaryFound) {
      return errorResponse(
        'EXTRACTOR_MISSING',
        'pdftotext not found on PATH (install poppler-utils)',
      );
    }
    const classified = classifyPdftotext(r);
    if (classified) return classified;
    return successResponse(makePdfTextContent(r));
  }

  // 5. Text / JSON / YAML — UTF-8 decode capped at 200KB.
  if (
    lower.startsWith('text/') ||
    lower === 'application/json' ||
    lower === 'application/yaml' ||
    lower === 'application/x-yaml'
  ) {
    if (buffer.byteLength > TEXT_DECODE_LIMIT) {
      // Still decode but truncate.
      return successResponse([
        {
          type: 'text',
          text:
            buffer.slice(0, TEXT_DECODE_LIMIT).toString('utf-8') +
            '\n…[truncated]',
        },
      ]);
    }
    return successResponse([{ type: 'text', text: buffer.toString('utf-8') }]);
  }

  // 6. Voice / audio — transcript already lives in <m><media transcript=...>
  if (VOICE_MIMES.has(lower) || lower.startsWith('audio/')) {
    return successResponse([
      { type: 'text', text: 'voice: see message transcript' },
    ]);
  }

  // 7. Everything else.
  return errorResponse(
    'UNSUPPORTED_TYPE',
    `mime ${mime} not displayable; ${buffer.byteLength} bytes downloaded but not rendered`,
  );
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Handle a single `view_media` IPC request. Returns the MCP-shaped response
 * that the caller writes (atomically) into `<group>/media-responses/<reqId>.json`.
 *
 * Note: this function never throws on expected-error paths — it converts them
 * into structured `isError: true` responses. Programmer errors (DB failures,
 * etc.) will still propagate.
 */
export async function handleViewMediaRequest(
  payload: ViewMediaPayload,
  requestingGroupJids: string[],
  bot: Bot,
): Promise<ViewMediaResponse> {
  // 1. Authorization gate — security-critical.
  const auth = checkAuthorization(payload.tg_message_id, requestingGroupJids);
  if (auth === 'reject') {
    return errorResponse(
      'CROSS_GROUP_REJECTED',
      `tg_message_id=${payload.tg_message_id} not owned by this group`,
    );
  }

  // 2. Cheap 20MB pre-check from cached meta — saves a network round-trip
  //    when the channel layer already stored file_size in <media size="..."/>.
  const cachedSize = lookupCachedFileSize(
    payload.tg_message_id,
    payload.file_id,
  );
  if (cachedSize != null && cachedSize > FILE_TOO_LARGE_LIMIT) {
    return errorResponse(
      'FILE_TOO_LARGE',
      `file_size ${cachedSize} exceeds ${FILE_TOO_LARGE_LIMIT}-byte limit`,
    );
  }

  // 3. Fetch bytes (retry budget, FILE_EXPIRED / UPSTREAM_ERROR pass-through).
  const dl = await fetchTelegramFile(bot, payload.file_id);
  if (!dl.ok) return dl.response;

  // 4. Post-download size guard (in case meta didn't carry size).
  if (dl.fileSize > FILE_TOO_LARGE_LIMIT) {
    return errorResponse(
      'FILE_TOO_LARGE',
      `file_size ${dl.fileSize} exceeds ${FILE_TOO_LARGE_LIMIT}-byte limit`,
    );
  }

  // 5. Determine mime: cached meta first (Telegram inbound parsing already
  //    decided), then fall back to a sharp probe for the image branch.
  let mime = lookupCachedMime(payload.tg_message_id, payload.file_id);
  if (!mime) {
    // Sniff: try sharp metadata; if it works, treat as image; else give up
    // and return UNSUPPORTED_TYPE with descriptor.
    try {
      const meta = await sharp(dl.buffer).metadata();
      const format = meta.format; // 'jpeg' | 'png' | 'gif' | 'webp' | ...
      if (format === 'jpeg') mime = 'image/jpeg';
      else if (format === 'png') mime = 'image/png';
      else if (format === 'gif') mime = 'image/gif';
      else if (format === 'webp') mime = 'image/webp';
      else if (format === 'heif') mime = 'image/heif';
      else if (format === 'tiff') mime = 'image/tiff';
    } catch {
      /* not an image; fall through */
    }
  }
  if (!mime) {
    return errorResponse(
      'UNSUPPORTED_TYPE',
      `mime unknown; ${dl.buffer.byteLength} bytes downloaded but not classified`,
    );
  }

  // 6. Route.
  return routeByMime(mime, dl.buffer, payload);
}

// Re-exported for unit tests that want to validate routing directly.
export const _internal = {
  checkAuthorization,
  lookupCachedFileSize,
  lookupCachedMime,
  classifyPdftotext,
  parsePagesRange,
  CORRUPTION_RE,
  FILE_TOO_LARGE_LIMIT,
};
