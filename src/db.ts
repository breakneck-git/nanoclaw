import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

export let db: Database.Database;

function wireDatabaseFeatures(database: Database.Database): void {
  database.pragma('foreign_keys = ON');
  database.function('lower_unicode', { deterministic: true }, (s: unknown) =>
    s === null ? null : (s as string).toLowerCase(),
  );
}

function addMetaColumnIfMissing(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(messages)').all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === 'meta')) {
    database.exec('ALTER TABLE messages ADD COLUMN meta TEXT');
  }
}

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS contacts (
      ident       TEXT PRIMARY KEY,
      scope       TEXT NOT NULL,
      tg_id       TEXT,
      username    TEXT,
      kind        TEXT NOT NULL,
      is_bot      INTEGER NOT NULL DEFAULT 0,
      first_name  TEXT, last_name TEXT,
      title       TEXT,
      phone       TEXT,
      link        TEXT,
      bio         TEXT,
      first_seen  TEXT NOT NULL,
      last_seen   TEXT NOT NULL,
      seen_count  INTEGER NOT NULL DEFAULT 1,
      source      TEXT NOT NULL,
      enriched    INTEGER NOT NULL DEFAULT 0,
      notes       TEXT,
      tags        TEXT
    );
    CREATE INDEX IF NOT EXISTS contacts_scope_username ON contacts(scope, username);
    CREATE INDEX IF NOT EXISTS contacts_scope_tg_id    ON contacts(scope, tg_id);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  // wireDatabaseFeatures turns on foreign_keys (better-sqlite3 defaults to
  // OFF, which would leave the declared FK on task_run_logs(task_id) as just
  // decoration; deleteTask's manual child-cascade depends on it and is wrapped
  // in a transaction below for atomicity) and registers the lower_unicode UDF
  // for Cyrillic-safe case-insensitive search.
  wireDatabaseFeatures(db);
  createSchema(db);
  addMetaColumnIfMissing(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  wireDatabaseFeatures(db);
  createSchema(db);
  addMetaColumnIfMissing(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export interface ContactRow {
  ident: string;
  scope: string;
  tg_id: string | null;
  username: string | null;
  kind: 'user' | 'hidden_user' | 'chat' | 'channel';
  is_bot: number; // 0|1
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  phone: string | null;
  link: string | null;
  bio: string | null;
  first_seen: string; // ISO 8601
  last_seen: string; // ISO 8601
  seen_count: number;
  source:
    | 'sender'
    | 'forward'
    | 'reply'
    | 'vcard'
    | 'mention'
    | 'text_mention'
    | 'getChat';
  enriched: number; // 0|1
  notes: string | null; // agent-owned, never touched by host upsert
  tags: string | null; // comma-separated; agent-owned
}

/**
 * Subset of ContactRow that callers may set via upsertContact. Identity columns
 * (`ident`, `scope`, `tg_id`, `username`, `source`, `enriched`, timestamps,
 * `seen_count`, `notes`, `tags`) are NOT in patch — they flow via opts.identity
 * / opts directly, or are agent-owned (notes/tags) and reach the row only via
 * annotateContact.
 */
export type ContactPatch = Partial<
  Pick<
    ContactRow,
    | 'first_name'
    | 'last_name'
    | 'title'
    | 'phone'
    | 'link'
    | 'bio'
    | 'is_bot'
    | 'kind'
  >
>;

function mergeContactRows(
  idRow: ContactRow | undefined,
  unRow: ContactRow,
): ContactRow {
  // id-row authoritative going forward; preserve all agent-authored data;
  // one NULL → take the other; both non-NULL → id-row wins for notes
  // (idempotent for the common case where promotion happens before any
  // annotation on either row), tags → union of comma-separated values.
  //
  // NOTE: `tg_id` is intentionally NOT computed here because the merged row's
  // identity is the *new* tg_id (the caller knows it; pre-existing rows may
  // both have null tg_id since the un-row was created without it). The caller
  // overrides `tg_id: tgId` after merging. See promoteContactIdent below.
  const coalesce = <T>(a: T | null | undefined, b: T | null | undefined) =>
    a == null ? b : a;
  const unionTags = (a: string | null, b: string | null) => {
    const set = new Set(
      [...(a || '').split(','), ...(b || '').split(',')].filter(Boolean),
    );
    return set.size ? [...set].join(',') : null;
  };
  return {
    ident: unRow.ident, // placeholder; caller overrides
    scope: unRow.scope,
    tg_id: coalesce(idRow?.tg_id, unRow.tg_id) ?? null, // placeholder; caller overrides
    username: coalesce(idRow?.username, unRow.username) ?? null,
    kind: idRow?.kind ?? unRow.kind,
    is_bot: idRow?.is_bot ?? unRow.is_bot,
    first_name: coalesce(idRow?.first_name, unRow.first_name) ?? null,
    last_name: coalesce(idRow?.last_name, unRow.last_name) ?? null,
    title: coalesce(idRow?.title, unRow.title) ?? null,
    phone: coalesce(idRow?.phone, unRow.phone) ?? null,
    link: coalesce(idRow?.link, unRow.link) ?? null,
    bio: coalesce(idRow?.bio, unRow.bio) ?? null,
    first_seen:
      idRow && idRow.first_seen < unRow.first_seen
        ? idRow.first_seen
        : unRow.first_seen,
    last_seen:
      idRow && idRow.last_seen > unRow.last_seen
        ? idRow.last_seen
        : unRow.last_seen,
    seen_count: (idRow?.seen_count ?? 0) + unRow.seen_count,
    source: 'forward', // promotion source
    enriched: Math.max(idRow?.enriched ?? 0, unRow.enriched),
    notes: coalesce(idRow?.notes, unRow.notes) ?? null, // id-row wins when both non-null
    tags: unionTags(idRow?.tags ?? null, unRow.tags),
  };
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  // Ensure the FK parent row exists. Gmail can deliver a message keyed to a
  // mainJid that has never sent or received a direct message through its own
  // channel — pre-foreign_keys=ON this silently inserted an orphan; now it
  // throws SQLITE_CONSTRAINT_FOREIGNKEY and loses the message. INSERT OR
  // IGNORE is a no-op if the row already exists.
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, NULL, ?, NULL, 0)`,
  ).run(msg.chat_jid, msg.timestamp);
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // FIFO drain: take the OLDEST `limit` unseen messages so a backlog larger
  // than the limit doesn't lose its tail. `lastTimestamp` advances to the
  // newest of returned (= the oldest unseen + limit-1) so the next poll
  // picks up the remainder. Previously this used `ORDER BY DESC LIMIT 200`
  // and advanced past the cap, silently dropping the oldest unseen rows.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp ASC
    LIMIT ?
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // FIFO drain (see getNewMessages): oldest unseen first, no inner DESC sort.
  // Limit prevents memory blow-up; if more remain, the cursor advance happens
  // upstream and the next call picks up where this batch ended.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp ASC
    LIMIT ?
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

const deleteTaskTxn = (id: string) => {
  // Cascade is manual because schema declares the FK without ON DELETE
  // CASCADE. Wrap in a transaction so a crash between the two DELETEs can't
  // leave orphan log rows or (with foreign_keys=ON) a half-deleted parent.
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
};

export function deleteTask(id: string): void {
  db.transaction(deleteTaskTxn)(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

/**
 * Atomically log a task run and advance the task's next_run cursor. Without
 * this, a crash (or thrown computeNextRun) between the two writes leaves
 * `task_run_logs` updated but `scheduled_tasks.next_run` <= now, causing the
 * scheduler to re-run the task on its next poll → duplicate executions.
 *
 * `db.transaction` is instantiated lazily — db is undefined until
 * `initDatabase()` runs, so we can't bind the transaction at module load.
 */
export function recordTaskRun(
  log: TaskRunLog,
  nextRun: string | null,
  lastResult: string,
): void {
  db.transaction(() => {
    logTaskRun(log);
    updateTaskAfterRun(log.task_id, nextRun, lastResult);
  })();
}

// CRITICAL: `db.transaction(...)` must NOT be bound at module load — `db` is
// undefined until `initDatabase()` runs. This mirrors `recordTaskRun` which has
// an explicit docstring warning about this exact anti-pattern. The transaction
// is constructed lazily on each call.
export function promoteContactIdent(
  scope: string,
  un: string,
  tgId: string,
): void {
  db.transaction(() => {
    const idIdent = `${scope}|id:${tgId}`;
    const unIdent = `${scope}|un:${un.toLowerCase()}`;
    const idRow = db
      .prepare('SELECT * FROM contacts WHERE ident = ?')
      .get(idIdent) as ContactRow | undefined;
    const unRow = db
      .prepare('SELECT * FROM contacts WHERE ident = ?')
      .get(unIdent) as ContactRow | undefined;
    if (!unRow) return;
    // Override ident + tg_id so the upsert always lands the new schema-valid identity.
    const merged: ContactRow = {
      ...mergeContactRows(idRow, unRow),
      ident: idIdent,
      tg_id: tgId,
    };
    db.prepare(
      `
      INSERT OR REPLACE INTO contacts
        (ident, scope, tg_id, username, kind, is_bot,
         first_name, last_name, title, phone, link, bio,
         first_seen, last_seen, seen_count, source, enriched, notes, tags)
      VALUES
        (@ident, @scope, @tg_id, @username, @kind, @is_bot,
         @first_name, @last_name, @title, @phone, @link, @bio,
         @first_seen, @last_seen, @seen_count, @source, @enriched, @notes, @tags)
    `,
    ).run(merged);
    db.prepare('DELETE FROM contacts WHERE ident = ?').run(unIdent);
  })();
}

/**
 * Insert or update a contact row keyed by `ident`.
 *
 * Identity resolution order: tg_id → username → name (else throw).
 *
 * Per-column conflict rules:
 *   - first_name/last_name/title/phone/link/is_bot/bio/tg_id/username:
 *       COALESCE(excluded.X, contacts.X) — sticky non-null, never blanks out
 *   - kind/source/last_seen: overwrite (excluded.X)
 *   - enriched: MAX(contacts.enriched, excluded.enriched)
 *   - first_seen: preserved (no update)
 *   - seen_count: contacts.seen_count + 1
 *   - notes/tags: NEVER touched here — agent-owned, only annotateContact writes
 */
export function upsertContact(
  scope: string,
  patch: ContactPatch,
  opts: {
    identity: { tg_id?: string; username?: string; name?: string };
    source:
      | 'sender'
      | 'forward'
      | 'reply'
      | 'vcard'
      | 'mention'
      | 'text_mention'
      | 'getChat';
    enriched?: 0 | 1;
  },
): void {
  let ident: string;
  let usernameLower: string | null = null;
  if (opts.identity.tg_id != null) {
    ident = `${scope}|id:${opts.identity.tg_id}`;
    usernameLower = opts.identity.username
      ? opts.identity.username.toLowerCase()
      : null;
  } else if (opts.identity.username != null) {
    usernameLower = opts.identity.username.toLowerCase();
    ident = `${scope}|un:${usernameLower}`;
  } else if (opts.identity.name != null) {
    ident = `${scope}|name:${opts.identity.name.toLowerCase()}`;
  } else {
    throw new Error('upsertContact: no identity provided');
  }

  const now = new Date().toISOString();
  const binds = {
    ident,
    scope,
    tg_id: opts.identity.tg_id ?? null,
    username: usernameLower,
    kind: patch.kind ?? 'user',
    is_bot: patch.is_bot ?? 0,
    first_name: patch.first_name ?? null,
    last_name: patch.last_name ?? null,
    title: patch.title ?? null,
    phone: patch.phone ?? null,
    link: patch.link ?? null,
    bio: patch.bio ?? null,
    first_seen: now,
    last_seen: now,
    source: opts.source,
    enriched: opts.enriched ?? 0,
  };

  // ON CONFLICT(ident) DO UPDATE: per-column rules in the spec. notes/tags are
  // deliberately omitted from UPDATE SET — they belong to the agent, not host.
  db.prepare(
    `
    INSERT INTO contacts
      (ident, scope, tg_id, username, kind, is_bot,
       first_name, last_name, title, phone, link, bio,
       first_seen, last_seen, seen_count, source, enriched)
    VALUES
      (@ident, @scope, @tg_id, @username, @kind, @is_bot,
       @first_name, @last_name, @title, @phone, @link, @bio,
       @first_seen, @last_seen, 1, @source, @enriched)
    ON CONFLICT(ident) DO UPDATE SET
      tg_id      = COALESCE(excluded.tg_id, contacts.tg_id),
      username   = COALESCE(excluded.username, contacts.username),
      kind       = excluded.kind,
      is_bot     = COALESCE(excluded.is_bot, contacts.is_bot),
      first_name = COALESCE(excluded.first_name, contacts.first_name),
      last_name  = COALESCE(excluded.last_name, contacts.last_name),
      title      = COALESCE(excluded.title, contacts.title),
      phone      = COALESCE(excluded.phone, contacts.phone),
      link       = COALESCE(excluded.link, contacts.link),
      bio        = COALESCE(excluded.bio, contacts.bio),
      last_seen  = excluded.last_seen,
      seen_count = contacts.seen_count + 1,
      source     = excluded.source,
      enriched   = MAX(contacts.enriched, excluded.enriched)
    `,
  ).run(binds);
}

/**
 * Return contact rows for a scope, newest activity first.
 *
 * When `scope === 'main' && includeUnion`, returns ALL rows across every scope
 * (main has visibility across the workspace). Otherwise filters by scope.
 */
export function getContactsForGroup(opts: {
  scope: string;
  includeUnion?: boolean;
}): ContactRow[] {
  if (opts.scope === 'main' && opts.includeUnion) {
    return db
      .prepare(`SELECT * FROM contacts ORDER BY last_seen DESC`)
      .all() as ContactRow[];
  }
  return db
    .prepare(`SELECT * FROM contacts WHERE scope = ? ORDER BY last_seen DESC`)
    .all(opts.scope) as ContactRow[];
}

/**
 * Agent-only writer for the two agent-owned columns. notes REPLACE; tags
 * APPEND-UNIQUE (union with existing comma-separated values, deduped).
 *
 * Identifier resolution: ident → tg_id → username (scope-agnostic; the agent
 * may only know the tg_id). Throws if no identifier or no matching row.
 */
export function annotateContact(
  identifier: { ident?: string; username?: string; tg_id?: string },
  patch: { notes?: string; tags?: string },
): void {
  let ident: string | undefined;
  if (identifier.ident) {
    ident = identifier.ident;
  } else if (identifier.tg_id != null) {
    const row = db
      .prepare('SELECT ident FROM contacts WHERE tg_id = ? LIMIT 1')
      .get(identifier.tg_id) as { ident: string } | undefined;
    ident = row?.ident;
  } else if (identifier.username != null) {
    const row = db
      .prepare('SELECT ident FROM contacts WHERE username = ? LIMIT 1')
      .get(identifier.username.toLowerCase()) as { ident: string } | undefined;
    ident = row?.ident;
  } else {
    throw new Error('annotateContact: no identifier');
  }

  if (!ident) throw new Error('annotateContact: contact not found');

  if (patch.notes !== undefined) {
    db.prepare('UPDATE contacts SET notes = ? WHERE ident = ?').run(
      patch.notes,
      ident,
    );
  }

  if (patch.tags !== undefined) {
    const existing = db
      .prepare('SELECT tags FROM contacts WHERE ident = ?')
      .get(ident) as { tags: string | null } | undefined;
    const set = new Set(
      [
        ...(existing?.tags ?? '').split(','),
        ...patch.tags.split(','),
      ].filter(Boolean),
    );
    const merged = set.size ? [...set].join(',') : null;
    db.prepare('UPDATE contacts SET tags = ? WHERE ident = ?').run(
      merged,
      ident,
    );
  }
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
