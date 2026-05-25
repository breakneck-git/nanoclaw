import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Read a per-group env file at `data/env/<folder>.env` and return ALL
 * key/value pairs found. Returns `{}` if the file does not exist.
 *
 * Used by the per-group credentials MVP: when a non-main group has been
 * given its own NOTION_API_KEY / GOOGLE_MAPS_API_KEY via `save_credential`,
 * those overrides live in this file (mode 0600) and take precedence over the
 * global `.env` / `process.env` values inside that group's container.
 *
 * Format mirrors `readEnvFile`: `KEY=VALUE` per line, `#` comments and
 * blank lines ignored, optional matching quotes stripped. Unlike
 * `readEnvFile` this does NOT filter to a wanted-keys set — the caller
 * picks which keys to honor per service. NEVER logs values.
 */
export function readPerGroupEnvFile(folder: string): Record<string, string> {
  const envPath = path.join(DATA_DIR, 'env', `${folder}.env`);
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // ENOENT is the common case (no per-group overrides yet). Don't even
    // debug-log it — the per-group flow is opt-in via save_credential.
    return {};
  }

  // Warn (once-per-call) if the file is world- or group-readable. We
  // intentionally don't auto-chmod here — the user may have set 0600 via
  // some other tool and we'd rather flag than silently mutate permissions.
  try {
    const mode = fs.statSync(envPath).mode & 0o777;
    if (mode & 0o077) {
      logger.warn(
        { folder, mode: mode.toString(8) },
        'Per-group env file has loose permissions (should be 0600)',
      );
    }
  } catch {
    /* stat failure is non-fatal */
  }

  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
