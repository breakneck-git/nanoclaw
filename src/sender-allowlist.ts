import fs from 'fs';

import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

const DEFAULT_CONFIG: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: true,
};

// Last successfully-parsed config per file path. If the on-disk file goes
// invalid (typo, partial write), keep using the previous good values
// instead of silently widening trust to DEFAULT_CONFIG ({ allow: '*' }).
const lastKnownGood = new Map<string, SenderAllowlistConfig>();

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  // Fail-CLOSED on broken config: if we ever loaded a valid restrictive
  // allowlist for this path, keep enforcing it after a typo / partial
  // write. Falling back to DEFAULT_CONFIG (`allow: '*'`) silently widens
  // trust to every sender — the exact opposite of what an allowlist is for.
  const fallback = (reason: string, err?: unknown): SenderAllowlistConfig => {
    const lkg = lastKnownGood.get(filePath);
    if (lkg) {
      logger.error(
        { path: filePath, reason, err },
        'sender-allowlist: keeping last-known-good config (refusing to fall back to permissive default)',
      );
      return lkg;
    }
    logger.warn(
      { path: filePath, reason, err },
      'sender-allowlist: using DEFAULT_CONFIG (no prior good config cached)',
    );
    return DEFAULT_CONFIG;
  };

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_CONFIG;
    return fallback('cannot read config', err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fallback('invalid JSON', err);
  }

  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    return fallback('invalid or missing default entry');
  }

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  const cfg: SenderAllowlistConfig = {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };
  lastKnownGood.set(filePath, cfg);
  return cfg;
}

/** @internal — tests only. */
export function _resetSenderAllowlistCache(): void {
  lastKnownGood.clear();
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}
