# Rich Message Capture + Persistent People Memory Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-20-rich-message-capture-design.md` at commit `92ef68a` (v11, 1401 lines). All spec line references below are re-derived against this commit (v1 plan had systematically stale refs after v10/v11 spec additions shifted content by 50-300 lines).

**Goal:** Let the NanoClaw agent operate on the full data of every Telegram message — including forward origin, mentioned/forwarded people, reply targets, media `file_id` — with a passive long-term contacts memory and on-demand media access via a new `view_media` MCP tool.

**Architecture:** Per-inbound, host parses grammy `Context` into a structured `<m>` XML block stored in `messages.meta`. Photos no longer base64-inline (auto-vision deleted); media is accessed by `file_id` via `view_media` over IPC. New `contacts` SQLite table with identity-merge MERGE semantics. Outbound bot text flows through a single `routeOutbound` chokepoint (7 call sites migrated). Four new MCP tools registered. Tests on both host and container vitest scopes.

**Tech Stack:** TypeScript (strict), Node.js 22+, better-sqlite3, grammy ≥1.39.3, @modelcontextprotocol/sdk (container), Anthropic Agent SDK (container), poppler-utils (`pdftotext`/`pdftoppm`/`pdfinfo`), sharp (image processing), vitest.

**Working directory:** `/Users/breakneck/nanoclaw/` — the MAIN repo (NOT a worktree). Every task's `cd` and git commands target this path. If executing from a worktree session, switch to the main repo first. The working tree has uncommitted bug-fix changes from prior sessions; Task 0 handles them deterministically.

**Branch strategy:** Create feature branch `feature/rich-message-capture` off `main` AFTER committing pre-existing working-tree changes as a baseline commit. This keeps line refs stable across all 23 tasks.

**PR strategy:** Three stacked PRs (NOT one giant PR). Each PR is independently mergeable:
- **PR 1 — DB foundations** (Tasks 1-7): adds contacts table, lookup_messages, storeOutboundMessage. Pure additive; no behavior change.
- **PR 2 — Channels + outbound chokepoint** (Tasks 8-15): structured meta block, telegram-enrich, routeOutbound migration, auto-vision deletion. Behavior change.
- **PR 3 — IPC + MCP tools + CI** (Tasks 16-23): host watcher, MCP tools, test scaffold, CI lint, end-to-end verification.

---

## Spec line-ref index (use these — v1 plan refs were stale)

| Symbol/section | Spec line range (v11) |
|---|---|
| `escapeXmlAttr` / `escapeXmlText` helpers | 117-131 |
| Tag reference table | 190-208 |
| Worked example XML | 152-189 |
| `Handling 4 update kinds` | 210-216 |
| `Albums` (media_group_id) | 218-220 |
| Contacts schema `CREATE TABLE` | 227-244 |
| `ContactRow` type definition | 251-275 |
| `mergeContactRows` body | 285-326 |
| `promoteContactIdent` body | 328-358 |
| Upsert merge rules table | 364-377 |
| `Scope and main-group cross-scope` | 379-381 |
| `Host upsert rules` section | 383-475 |
| `processContactsFromContext` body | 390-475 |
| `view_media` flow steps 1-5 | 482-500 |
| Retry/timeout/sweep | 496-551 |
| Mime routing decision table | 553-564 |
| Error contract table | 566-599 |
| Reply/forward "посмотри" workflows | 601-603 |
| `lookup_messages` section | 605-665 |
| `lookup_messages` full SQL | 621-639 |
| `buildQueryParam` escape helper | 643-648 |
| Case-insensitive search rationale | 653-664 |
| §1 Channel widening | 674-682 |
| §2 `sendTelegramMessage` body | 684-720 |
| §3 `TelegramChannel.sendMessage` multi-chunk | 722-739 |
| §4 Gmail `sendMessage` | 741-761 |
| §5 `routeOutbound` chokepoint | 763-793 |
| §6 `storeOutboundMessage` body | 795-851 |
| §7 Migration 7 sites | 853-884 |
| §8 CI grep script | 886-955 |
| MCP tool descriptions | 956-964 |
| Files-touched section | 966-1180 |
| `wireDatabaseFeatures` example code | 1031-1074 |
| `contacts.json` snapshot writer details | 1115-1121 |
| `telegram-enrich.ts` full shape | 970-1020 |
| Container vitest scaffold + file-too-large test | 1024-1040 + 1170-1196 |
| Known limitations / risks | 1207-1237 |
| Out of scope v1 | 1239-1255 |
| 18 verification items | 1257-1319 |

---

## Phase 0 — Pre-flight

### Task 0: Baseline commit + feature branch

**Files:**
- None new; git-only operations
- May modify: any tracked files via baseline commit

- [ ] **Step 1: Verify working directory**

```bash
cd /Users/breakneck/nanoclaw && pwd
git rev-parse HEAD                         # Expected: 92ef68a (spec v11) or descendant
git status --short | wc -l                 # Expect 30+ entries (working tree has bug-fix work + untracked files)
git status --short
```

- [ ] **Step 2: Commit pre-existing working-tree as baseline** — DETERMINISTIC (no user coordination needed). Per CLAUDE.md these are prior bug-fix sessions; they share files this plan modifies, so stashing would lose the baseline that the spec's working-tree refs depend on. Strategy: commit verbatim as `chore: pre-feature baseline (existing bug-fix work)`.

```bash
git add -A
git commit -m "chore: pre-feature baseline (existing bug-fix work)"
git log --oneline -3
```

- [ ] **Step 3: Create feature branch**

```bash
git checkout -b feature/rich-message-capture
git log --oneline -3
```

- [ ] **Step 4: Sanity-check dependencies**

```bash
grep -E '"grammy"|"better-sqlite3"|"vitest"|"@modelcontextprotocol/sdk"|"googleapis"|"sharp"' package.json container/agent-runner/package.json
```

Expected: grammy ≥1.39, better-sqlite3, vitest, googleapis, sharp at host. `@modelcontextprotocol/sdk` at container only.

- [ ] **Step 5: Confirm spec is reachable**

```bash
wc -l docs/superpowers/specs/2026-05-20-rich-message-capture-design.md   # Expect 1401
sed -n '227,244p' docs/superpowers/specs/2026-05-20-rich-message-capture-design.md   # Expect contacts CREATE TABLE
sed -n '688,720p' docs/superpowers/specs/2026-05-20-rich-message-capture-design.md   # Expect sendTelegramMessage body
```

---

## Phase 1 — DB foundations (Tasks 1-7) → PR 1 candidate

### Task 1: ContactRow type + contacts schema + indexes

**Files:**
- Modify: `src/db.ts` (add `ContactRow` interface, add schema CREATE inside `createSchema`, add 2 indexes)
- Test: `src/db.test.ts`

**Spec refs:** schema CREATE at lines **227-244**; `ContactRow` type at lines **251-275**.

- [ ] **Step 1: Write the failing test** — append to `src/db.test.ts`:

```ts
import { _initTestDatabase, db } from './db.js';

describe('contacts table', () => {
  beforeEach(() => _initTestDatabase());

  it('inserts and reads a contacts row with all columns', () => {
    db.prepare(`
      INSERT INTO contacts (
        ident, scope, tg_id, username, kind, is_bot,
        first_name, last_name, title, phone, link, bio,
        first_seen, last_seen, seen_count, source, enriched, notes, tags
      ) VALUES (
        'g_main|id:42', 'g_main', '42', 'vasya', 'user', 0,
        'Вася', 'Иванов', NULL, NULL, NULL, NULL,
        '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'sender', 0, NULL, NULL
      )
    `).run();
    const row = db.prepare(`SELECT * FROM contacts WHERE ident = ?`).get('g_main|id:42') as { ident: string; tg_id: string; username: string };
    expect(row.ident).toBe('g_main|id:42');
    expect(row.tg_id).toBe('42');
    expect(row.username).toBe('vasya');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/db.test.ts -t "contacts table"`. Expected: `no such table: contacts`.

- [ ] **Step 3: Add the schema CREATE + indexes** — inside `createSchema(db)` in `src/db.ts`, append:

```sql
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
```

Then add the `ContactRow` interface (copy from spec lines **251-275** verbatim) to the type-exports section.

- [ ] **Step 4: Run test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): add contacts table schema + ContactRow type"
```

---

### Task 2: wireDatabaseFeatures helper + addMetaColumnIfMissing + lower_unicode UDF

**Files:**
- Modify: `src/db.ts`
- Test: `src/db.test.ts`

**Spec refs:** code example at lines **1031-1074** (full `wireDatabaseFeatures` + dual init paths).

- [ ] **Step 1: Write failing tests**

```ts
it('_initTestDatabase is idempotent across consecutive calls', () => {
  _initTestDatabase();
  _initTestDatabase();
  // If addMetaColumnIfMissing fails on the second call, this throws "duplicate column: meta"
  const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  expect(cols.some(c => c.name === 'meta')).toBe(true);
});

it('lower_unicode UDF lowercases Cyrillic', () => {
  _initTestDatabase();
  const result = db.prepare(`SELECT lower_unicode('Привет') AS r`).get() as { r: string };
  expect(result.r).toBe('привет');
});
```

- [ ] **Step 2: Run, expect FAIL** — `lower_unicode` undefined and/or `meta` column missing on second init.

- [ ] **Step 3: Implement** per spec lines 1031-1074 verbatim:
  - Add `function wireDatabaseFeatures(database)` that calls `database.pragma('foreign_keys = ON')` (preserve existing) and `database.function('lower_unicode', { deterministic: true }, ...)`.
  - Add `function addMetaColumnIfMissing(database)` using `PRAGMA table_info(messages)` check before `ALTER TABLE messages ADD COLUMN meta TEXT`.
  - Update `initDatabase`: `db = new Database(dbPath); wireDatabaseFeatures(db); createSchema(db); addMetaColumnIfMissing(db); migrateJsonState();`.
  - Update `_initTestDatabase`: `db = new Database(':memory:'); wireDatabaseFeatures(db); createSchema(db); addMetaColumnIfMissing(db);`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): wireDatabaseFeatures + addMetaColumnIfMissing + lower_unicode UDF"
```

---

### Task 3: mergeContactRows + promoteContactIdent

**Files:**
- Modify: `src/db.ts`
- Test: `src/db.test.ts`

**Spec refs:** `mergeContactRows` at lines **285-326**; `promoteContactIdent` at lines **328-358**.

- [ ] **Step 1: Write failing tests** — IMPORT ONLY `promoteContactIdent` (NOT `upsertContact` — that's Task 4 and unused by these tests):

```ts
import { promoteContactIdent } from './db.js';

describe('promoteContactIdent', () => {
  beforeEach(() => _initTestDatabase());

  it('tg_id non-NULL after promotion when un-row had NULL tg_id (round-7 invariant)', () => {
    db.prepare(`INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched)
                VALUES ('g|un:vasya', 'g', NULL, 'vasya', 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'mention', 0)`).run();
    promoteContactIdent('g', 'vasya', '42');
    const row = db.prepare(`SELECT tg_id FROM contacts WHERE ident = ?`).get('g|id:42') as { tg_id: string };
    expect(row.tg_id).toBe('42');
    expect(db.prepare(`SELECT 1 FROM contacts WHERE ident = ?`).get('g|un:vasya')).toBeUndefined();
  });

  it('preserves id-row notes when both rows have non-null notes (notes-loss known limitation)', () => {
    db.prepare(`INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched, notes)
                VALUES ('g|id:42', 'g', '42', NULL, 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'sender', 0, 'id-notes')`).run();
    db.prepare(`INSERT INTO contacts (ident, scope, tg_id, username, kind, is_bot, first_seen, last_seen, seen_count, source, enriched, notes)
                VALUES ('g|un:vasya', 'g', NULL, 'vasya', 'user', 0, '2026-05-20T10:00:00Z', '2026-05-20T10:00:00Z', 1, 'mention', 0, 'un-notes')`).run();
    promoteContactIdent('g', 'vasya', '42');
    const row = db.prepare(`SELECT notes FROM contacts WHERE ident = ?`).get('g|id:42') as { notes: string };
    expect(row.notes).toBe('id-notes');
  });

  it('does NOT crash at module load (no-op early return when un-row absent)', () => {
    expect(() => promoteContactIdent('g', 'nobody', '999')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `promoteContactIdent` undefined.

- [ ] **Step 3: Implement** — copy `mergeContactRows` (spec lines **285-326**) and `promoteContactIdent` (spec lines **328-358**) into `src/db.ts`. CRITICAL: `promoteContactIdent` uses lazy `db.transaction(() => {...})()` pattern (see spec line ~330 comment about the module-load crash anti-pattern).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): mergeContactRows + promoteContactIdent with lazy txn wrap"
```

---

### Task 4: upsertContact + ContactPatch + getContactsForGroup + annotateContact

**Files:**
- Modify: `src/db.ts`
- Test: `src/db.test.ts`

**Spec refs:** ContactPatch + upsertContact signature comment at lines **979-985**; upsert merge rules table at **364-377**; cross-scope view rule at **379-381**.

- [ ] **Step 1: Write failing test**

```ts
import { upsertContact, getContactsForGroup, annotateContact } from './db.js';

describe('upsertContact', () => {
  beforeEach(() => _initTestDatabase());

  it('INSERTs on first call', () => {
    upsertContact('g', { kind: 'user', first_name: 'Вася' }, { identity: { tg_id: '42', username: 'vasya' }, source: 'sender' });
    const row = db.prepare(`SELECT * FROM contacts WHERE ident = ?`).get('g|id:42') as { first_name: string; username: string };
    expect(row.first_name).toBe('Вася');
    expect(row.username).toBe('vasya');
  });

  it('UPDATEs with COALESCE rules on second call (does not overwrite non-null with null)', () => {
    upsertContact('g', { kind: 'user', first_name: 'Вася', last_name: 'Иванов' }, { identity: { tg_id: '42' }, source: 'sender' });
    upsertContact('g', { kind: 'user' }, { identity: { tg_id: '42' }, source: 'sender' });
    const row = db.prepare(`SELECT first_name, last_name, seen_count FROM contacts WHERE ident = ?`).get('g|id:42') as { first_name: string; last_name: string; seen_count: number };
    expect(row.first_name).toBe('Вася');
    expect(row.last_name).toBe('Иванов');
    expect(row.seen_count).toBe(2);
  });

  it('main scope sees UNION via getContactsForGroup({scope: "main", includeUnion: true})', () => {
    upsertContact('g_dev', { kind: 'user', first_name: 'Петя' }, { identity: { tg_id: '99' }, source: 'sender' });
    const rows = getContactsForGroup({ scope: 'main', includeUnion: true });
    expect(rows.find(r => r.tg_id === '99')).toBeDefined();
  });

  it('annotateContact REPLACES notes and APPENDS-UNIQUE tags', () => {
    upsertContact('g', { kind: 'user' }, { identity: { tg_id: '42' }, source: 'sender' });
    annotateContact({ tg_id: '42' }, { notes: 'first', tags: 'a,b' });
    annotateContact({ tg_id: '42' }, { notes: 'second', tags: 'b,c' });
    const row = db.prepare(`SELECT notes, tags FROM contacts WHERE ident = ?`).get('g|id:42') as { notes: string; tags: string };
    expect(row.notes).toBe('second');
    expect(row.tags.split(',').sort()).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**:
  - Define `ContactPatch` type per spec lines **979-985**: `type ContactPatch = Partial<Pick<ContactRow, 'first_name' | 'last_name' | 'title' | 'phone' | 'link' | 'bio' | 'is_bot' | 'kind'>>;`.
  - `upsertContact(scope: string, patch: ContactPatch, opts: { identity: { tg_id?: string; username?: string; name?: string }; source: string; enriched?: 0 | 1 }): void` — identity resolution: prefer `tg_id` else `lowered(username)` else `lowered(name)`. Build `INSERT INTO contacts (...) VALUES (...) ON CONFLICT(ident) DO UPDATE SET ...` using the per-column rules from spec lines **364-377**.
  - `getContactsForGroup({scope: string; includeUnion?: boolean})` — when `scope==='main'` and `includeUnion`, return all rows; else filter by scope.
  - `annotateContact(identifier: {ident?: string; username?: string; tg_id?: string}, {notes?, tags?})` — resolve identifier to ident; `notes` REPLACES; `tags` parses CSV, unions, re-CSVs.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): upsertContact + ContactPatch + getContactsForGroup + annotateContact"
```

---

### Task 5: lookupMessages SQL + buildQueryParam

**Files:**
- Modify: `src/db.ts`
- Test: `src/db.test.ts`

**Spec refs:** full SQL at lines **621-639**; `buildQueryParam` at **643-648**; bind list rationale at **653-665**.

- [ ] **Step 1: Write failing tests**

```ts
import { lookupMessages, storeMessage } from './db.js';

describe('lookupMessages', () => {
  beforeEach(() => _initTestDatabase());

  it('Cyrillic case-insensitive search via lower_unicode', () => {
    storeMessage({ id: '1', chat_jid: 'tg:1', sender: 'u', sender_name: 'U', content: 'Петя пришёл', timestamp: '2026-05-20T10:00:00Z', is_from_me: false, is_bot_message: false });
    const rows = lookupMessages({ groupJids: ['tg:1'], query: 'петя', includeBot: false, limit: 50 });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('Петя пришёл');
  });

  it('LIKE wildcard % is escaped (literal match)', () => {
    storeMessage({ id: '1', chat_jid: 'tg:1', sender: 'u', sender_name: 'U', content: 'тратил 50% налога', timestamp: '2026-05-20T10:00:00Z', is_from_me: false, is_bot_message: false });
    storeMessage({ id: '2', chat_jid: 'tg:1', sender: 'u', sender_name: 'U', content: 'тратил 5000 рублей', timestamp: '2026-05-20T10:01:00Z', is_from_me: false, is_bot_message: false });
    const rows = lookupMessages({ groupJids: ['tg:1'], query: '50%', includeBot: false, limit: 50 });
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('1');
  });

  it('include_bot=true UNIONs bot rows with user rows', () => {
    storeMessage({ id: 'u1', chat_jid: 'tg:1', sender: 'u', sender_name: 'U', content: 'hi', timestamp: '2026-05-20T10:00:00Z', is_from_me: false, is_bot_message: false });
    storeMessage({ id: 'b1', chat_jid: 'tg:1', sender: 'bot', sender_name: 'Andy', content: 'hello', timestamp: '2026-05-20T10:01:00Z', is_from_me: true, is_bot_message: true });
    const without = lookupMessages({ groupJids: ['tg:1'], includeBot: false, limit: 50 });
    const withBot = lookupMessages({ groupJids: ['tg:1'], includeBot: true, limit: 50 });
    expect(without.length).toBe(1);
    expect(withBot.length).toBe(2);
  });

  it('empty filters return last N rows clamped to limit', () => {
    for (let i = 0; i < 250; i++) {
      storeMessage({ id: `m${i}`, chat_jid: 'tg:1', sender: 'u', sender_name: 'U', content: `msg${i}`, timestamp: `2026-05-20T10:${String(i).padStart(2,'0')}:00Z`, is_from_me: false, is_bot_message: false });
    }
    const rows = lookupMessages({ groupJids: ['tg:1'], includeBot: false, limit: 500 });
    expect(rows.length).toBe(200);  // server clamp [1,200]
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** per spec lines **621-639** (SQL) and **643-648** (`buildQueryParam`):
  - `buildQueryParam(q?: string): string | null` — escapes `\`, `%`, `_` with backslash; returns `%${escaped}%` or null.
  - `lookupMessages({groupJids, tgMessageId?, senderId?, since?, until?, query?, includeBot, limit})` — builds the SQL per spec 621-639. Bind order EXACTLY: `[...groupJids, (includeBot ? 1 : 0), tgMessageId ?? null, tgMessageId ?? null, senderId ?? null, senderId ?? null, since ?? null, since ?? null, until ?? null, until ?? null, buildQueryParam(query), buildQueryParam(query), Math.min(Math.max(limit, 1), 200)]`. Boolean coercion is critical — better-sqlite3 rejects JS booleans.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): lookupMessages with Cyrillic-safe LIKE escape (N+12 binds)"
```

---

### Task 6: src/types.ts — Channel widening + botSenderId + NewMessage.meta (build-safe subset)

**Files:**
- Modify: `src/types.ts`

**Spec refs:** Channel widening at **674-682**; `Channel.botSenderId?` + `NewMessage.meta` declarations inside Files-touched MOD bullet (~lines **1000-1010** in the `src/types.ts` MOD list).

**IMPORTANT (round-1 fix):** This task does NOT remove `NewMessage.images?` — that removal is deferred to Task 15 (auto-vision cascade) so the build stays GREEN at every commit boundary. The widening + new fields here are purely additive.

- [ ] **Step 1: Make additive changes** in `src/types.ts`:
  - Change `Channel.sendMessage(...)` return type from `Promise<void>` to `Promise<{ messageId?: string } | void>` (union — backwards compatible with existing `Promise<void>` implementations).
  - Add `botSenderId?(): string | undefined;` to the `Channel` interface.
  - Add `meta?: string;` to `NewMessage` (additive — does not remove `images?`).

- [ ] **Step 2: Verify build is GREEN**

```bash
npx tsc --noEmit
```

Expected: zero errors. If errors appear, abort — additive changes should not break consumers.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): widen Channel.sendMessage + add botSenderId + NewMessage.meta (additive)"
```

---

### Task 7: storeMessage carries meta + storeOutboundMessage + getNewMessages/getMessagesSince projection

**Files:**
- Modify: `src/db.ts`
- Test: `src/db.test.ts`

**Spec refs:** `storeOutboundMessage` body at lines **795-851**; updated SELECT projection inside `getNewMessages`/`getMessagesSince` MOD bullet (`src/db.ts` MOD bullet, ~lines **1080-1093** in Files-touched).

- [ ] **Step 1: Write failing tests** (covers verification #7 + round-10 storeOutboundMessage 4 cases):

```ts
import { storeMessage, storeOutboundMessage, getNewMessages, getMessagesSince } from './db.js';

describe('messages.meta projection', () => {
  beforeEach(() => _initTestDatabase());

  it('storeMessage with meta + getNewMessages preserves meta column', () => {
    storeMessage({ id: '1', chat_jid: 'tg:1', sender: 'u1', sender_name: 'U', content: 'hi', timestamp: '2026-05-20T10:00:00Z', is_from_me: false, is_bot_message: false, meta: '<m id="1"/>' });
    const { messages: rows } = getNewMessages(['tg:1'], '2026-05-20T09:00:00Z', 'Andy', 50);
    expect(rows[0].meta).toBe('<m id="1"/>');
  });

  it('photo-no-caption admitted via relaxed WHERE (content="" AND meta != NULL)', () => {
    storeMessage({ id: '2', chat_jid: 'tg:1', sender: 'u1', sender_name: 'U', content: '', timestamp: '2026-05-20T10:00:00Z', is_from_me: false, is_bot_message: false, meta: '<m id="2"><media file_id="X"/></m>' });
    const { messages: rows } = getNewMessages(['tg:1'], '2026-05-20T09:00:00Z', 'Andy', 50);
    expect(rows.find(r => r.id === '2')).toBeDefined();
  });

  it('getMessagesSince also includes meta column', () => {
    storeMessage({ id: '3', chat_jid: 'tg:1', sender: 'u', sender_name: 'U', content: 'x', timestamp: '2026-05-20T10:00:00Z', is_from_me: false, is_bot_message: false, meta: '<m id="3"/>' });
    const rows = getMessagesSince('tg:1', '2026-05-20T09:00:00Z', 'Andy', 50);
    expect(rows[0].meta).toBe('<m id="3"/>');
  });
});

describe('storeOutboundMessage', () => {
  beforeEach(() => _initTestDatabase());

  it('synthetic-id path: undefined messageId + undefined senderId', () => {
    storeOutboundMessage('tg:1', 'hello');
    const row = db.prepare(`SELECT * FROM messages WHERE chat_jid = ?`).get('tg:1') as { id: string; sender: string; meta: string | null; is_bot_message: number };
    expect(row.id).toMatch(/^out-/);
    expect(row.sender).toBe('bot');
    expect(row.meta).toBe('<m kind="outbound-synthetic"/>');
    expect(row.is_bot_message).toBe(1);
  });

  it('channel-id path: real messageId + senderId', () => {
    storeOutboundMessage('tg:1', 'hello', 'TG_MID_123', '987654');
    const row = db.prepare(`SELECT * FROM messages WHERE chat_jid = ?`).get('tg:1') as { id: string; sender: string; meta: string | null };
    expect(row.id).toBe('TG_MID_123');
    expect(row.sender).toBe('987654');
    expect(row.meta).toBeNull();
  });

  it("empty-string messageId '' treated as missing (truthy fallback)", () => {
    storeOutboundMessage('tg:1', 'hello', '');
    const row = db.prepare(`SELECT * FROM messages WHERE chat_jid = ?`).get('tg:1') as { id: string; sender: string };
    expect(row.id).toMatch(/^out-/);
    expect(row.sender).toBe('bot');
  });

  it('auto-seeds chats row on first send to new jid via INSERT OR IGNORE', () => {
    storeOutboundMessage('tg:never_seen', 'hello');
    const chat = db.prepare(`SELECT * FROM chats WHERE jid = ?`).get('tg:never_seen');
    expect(chat).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `storeOutboundMessage` undefined; `meta` not in SELECT.

- [ ] **Step 3: Implement**:
  - Update `storeMessage` to accept and bind `meta?: string` (extend INSERT OR REPLACE column list).
  - Add `storeOutboundMessage(jid, text, channelMessageId?, senderId?)` per spec lines **795-851** verbatim.
  - Update `getNewMessages` SELECT: add `, meta` to projection; change WHERE last predicate from `AND content != '' AND content IS NOT NULL` to `AND ((content != '' AND content IS NOT NULL) OR meta IS NOT NULL)`. KEEP `ORDER BY timestamp ASC LIMIT ?` (FIFO drain — see working-tree `src/db.ts:335-339` comment).
  - Update `getMessagesSince` SELECT similarly.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): meta column projection + storeOutboundMessage + photo-no-caption WHERE relax"
```

**End of Phase 1 → PR 1 candidate (Tasks 1-7).** Open PR 1 against `main` for review before continuing.

---

## Phase 2 — Telegram channel (Tasks 8-11) → part of PR 2

### Task 8a: telegram-meta.ts — escape helpers + buildMetaBlock skeleton + basic tags

**Files:**
- Create: `src/channels/telegram-meta.ts`
- Create: `src/channels/telegram-meta.test.ts`
- Create: `src/channels/__fixtures__/telegram-meta/` (directory of input.json + expected.xml fixture pairs)

**Spec refs:** escape helpers at lines **117-131**; tag reference at **190-208**; worked-example XML at **152-189**.

**Round-1 fix:** Original Task 8 had `// ... 20+ more it() blocks ...` placeholder. v2 splits into Task 8a (skeleton + basic tags + injection fixture, **inlined**) and Task 8b (complex tags + Bot API 7.0+ features). Concrete fixtures replace prose enumeration.

- [ ] **Step 1: Write failing tests** for escape helpers + basic tags + the XML-injection fixture (these are real tests, not placeholders):

```ts
import { buildMetaBlock, escapeXmlAttr, escapeXmlText } from './telegram-meta.js';
import { parseStringPromise } from 'xml2js';

describe('escapeXmlAttr', () => {
  it('escapes all 5 special chars', () => {
    expect(escapeXmlAttr('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
  it('returns string for non-string inputs', () => {
    expect(escapeXmlAttr(42)).toBe('42');
    expect(escapeXmlAttr(undefined)).toBe('');
    expect(escapeXmlAttr(null)).toBe('');
  });
});

describe('escapeXmlText', () => {
  it('escapes only & < >', () => {
    expect(escapeXmlText('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d"e\'f');
  });
});

describe('buildMetaBlock — minimal message', () => {
  it('emits <m id date> for a plain text message', async () => {
    const msg = { message_id: 42, date: 1747731600, chat: { id: 1, type: 'private' as const, first_name: 'X' }, from: { id: 1, is_bot: false, first_name: 'X' }, text: 'hi' };
    const xml = `<root>${buildMetaBlock(msg as any)}</root>`;
    const parsed = await parseStringPromise(xml);
    expect(parsed.root.m[0].$.id).toBe('42');
    expect(parsed.root.m[0].$.date).toMatch(/^2025-/);
  });
});

describe('buildMetaBlock — XML injection fixture (mandated at spec line 105)', () => {
  it('round-trips through strict XML parser when sender name contains " < > & \'', async () => {
    const msg = {
      message_id: 1,
      date: 1747731600,
      chat: { id: 1, type: 'private' as const, first_name: 'Bob' },
      from: { id: 1, is_bot: false, first_name: 'Bob "the builder" <hr@x>' },
    };
    const xml = `<root>${buildMetaBlock(msg as any)}</root>`;
    await expect(parseStringPromise(xml)).resolves.toBeDefined();
  });
});

describe('buildMetaBlock — <from> vs <sender_chat> mutex', () => {
  it('emits <sender_chat> NOT <from> when sender_chat is set', () => {
    const msg = { message_id: 1, date: 1747731600, chat: { id: -100, type: 'supergroup' as const, title: 'G' }, sender_chat: { id: -100, type: 'channel' as const, title: 'Durov', username: 'durov' }, from: { id: 1, is_bot: true, first_name: 'GroupAnonymousBot' } };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<sender_chat');
    expect(meta).not.toContain('<from');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `buildMetaBlock` undefined.

- [ ] **Step 3: Implement**:
  - `escapeXmlAttr(v: unknown): string` — escapes `&<>"'`.
  - `escapeXmlText(v: unknown): string` — escapes `&<>` only.
  - `buildMetaBlock(message: Message): string` — minimal skeleton handling `<m id date media_group_id edited>`, `<from>` ↔ `<sender_chat>` mutex, ISO timestamp conversion (`new Date(message.date * 1000).toISOString()`).
  - Return value is the raw `<m>...</m>` string (no enclosing root).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram-meta.ts src/channels/telegram-meta.test.ts src/channels/__fixtures__/
git commit -m "feat(telegram): telegram-meta.ts skeleton with escape helpers + injection fixture"
```

---

### Task 8b: buildMetaBlock — full Bot API 7.0+ tag coverage

**Files:**
- Modify: `src/channels/telegram-meta.ts`
- Modify: `src/channels/telegram-meta.test.ts` (add tests for all remaining tags)

**Spec refs:** tag reference table at **190-208** — every row enumerated.

- [ ] **Step 1: Add concrete tests** (one `it()` per tag — NOT a placeholder enumeration):

```ts
describe('buildMetaBlock — forward_origin', () => {
  it('user kind: emits <fwd kind="user" id un name is_bot/>', () => {
    const msg = { message_id: 1, date: 1747731600, chat: {id:1,type:'private' as const, first_name:'X'}, forward_origin: { type: 'user' as const, date: 1747731600, sender_user: { id: 99, is_bot: false, first_name: 'V', username: 'v' } } };
    const meta = buildMetaBlock(msg as any);
    expect(meta).toContain('<fwd kind="user"');
    expect(meta).toContain('id="99"');
  });

  it('hidden_user kind: emits sender_user_name', () => { /* ... */ });
  it('chat kind: emits sig from author_signature', () => { /* ... */ });
  it('channel kind: emits link derivable from chat.username + message_id', () => { /* ... */ });
  it('unknown kind: emits raw=escapeXmlAttr(JSON.stringify(origin))', () => { /* ... */ });
});

describe('buildMetaBlock — <reply>', () => {
  it('in-chat reply: external="0", inlines media file_id', () => { /* ... */ });
  it('external_reply: external="1", inlines origin attributes + all payload tags (media, contact, location, poll, story, reply_to_story)', () => { /* ... */ });
});

describe('buildMetaBlock — <quote>', () => {
  it('emits <quote>fragment</quote> from quote.text', () => { /* ... */ });
});

describe('buildMetaBlock — <media> for all 8 types', () => {
  it.each(['photo', 'video', 'voice', 'audio', 'document', 'sticker', 'animation', 'video_note'])('emits <media type="%s" file_id> for %s', (type) => { /* ... */ });
});

describe('buildMetaBlock — sticker mime cascade', () => {
  it('is_animated=true → application/x-tgsticker', () => { /* ... */ });
  it('is_video=true → video/webm', () => { /* ... */ });
  it('else → image/webp', () => { /* ... */ });
});

describe('buildMetaBlock — voice/video_note transcript', () => {
  it('emits transcript + transcript_status attributes', () => { /* ... */ });
});

describe('buildMetaBlock — <entities>', () => {
  it.each(['url', 'mention', 'text_link', 'text_mention', 'custom_emoji', 'hashtag', 'cashtag', 'bot_command', 'phone_number', 'email'])('emits <%s> for entity type %s', (type) => { /* ... */ });

  it('merges caption_entities into <entities>', () => { /* ... */ });
  it('drops formatting entities (bold/italic/code/pre/blockquote/spoiler/strikethrough/underline)', () => { /* ... */ });
});

describe('buildMetaBlock — <contact>', () => {
  it('emits phone name user_id vcard_raw', () => { /* ... */ });
});

describe('buildMetaBlock — <location>', () => {
  it('emits lat lon title address (from message.location or message.venue)', () => { /* ... */ });
});

describe('buildMetaBlock — <poll>', () => {
  it('emits question type, drops options', () => { /* ... */ });
});

describe('buildMetaBlock — <story> + <reply_to_story>', () => {
  it('emits <story chat_id story_id> from message.story', () => { /* ... */ });
  it('emits top-level <reply_to_story> from message.reply_to_story', () => { /* ... */ });
});

describe('buildMetaBlock — <via_bot>', () => {
  it('emits <via_bot id un name/> when via_bot is set', () => { /* ... */ });
});

describe('buildMetaBlock — <link_preview>', () => {
  it('emits url/disabled/above_text/small/large when ANY field explicitly set', () => { /* ... */ });
  it('emits NOTHING when link_preview_options is undefined', () => { /* ... */ });
});

describe('buildMetaBlock — <m auto_fwd="1">', () => {
  it('emits attribute when is_automatic_forward=true', () => { /* ... */ });
  it('does NOT emit attribute when is_automatic_forward unset', () => { /* ... */ });
});

describe('buildMetaBlock — edited_* updates', () => {
  it('emits edited="<ISO>" attribute on <m> when edit_date present', () => { /* ... */ });
});

describe('buildMetaBlock — media_group_id', () => {
  it('emits <m media_group_id="..."> for album messages', () => { /* ... */ });
});
```

Fill EACH `/* ... */` body — no `it.skip`, no placeholder. The bodies are mechanical: construct a grammy `Message` object with the right shape, call `buildMetaBlock`, assert substring or parse with xml2js. If 20+ test bodies is too much for one task, split further into 8b-1 (forward/reply/quote/entities), 8b-2 (media/sticker/transcript), 8b-3 (contact/location/poll/story/via_bot/link_preview/auto_fwd/edited/media_group_id).

- [ ] **Step 2: Run, expect FAIL** for new cases.

- [ ] **Step 3: Implement** the remaining tag handlers in `buildMetaBlock`. For `forward_origin`, **switch on `origin.type`** (NOT `origin.kind` — see spec line 195 round-10 disambiguation).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram-meta.ts src/channels/telegram-meta.test.ts
git commit -m "feat(telegram): buildMetaBlock full Bot API 7.0+ tag coverage"
```

---

### Task 9: telegram-enrich.ts (NEW) — bounded-rate getChat resolver

**Files:**
- Create: `src/channels/telegram-enrich.ts`
- Create: `src/channels/telegram-enrich.test.ts`

**Spec refs:** full shape at lines **970-1020**.

**Round-1 fix:** test helpers `_test_primeCache`, `_test_getQueueSize`, `_test_resetState` are explicitly added as underscore-prefixed exports (test-only API). Without these exports the tests at Step 1 fail to import.

- [ ] **Step 1: Write failing tests** (using `_test_*` helpers):

```ts
import { queueEnrich, _test_primeCache, _test_getQueueSize, _test_resetState } from './telegram-enrich.js';
import * as db from './db.js';
import { vi } from 'vitest';

vi.mock('./db.js', () => ({
  upsertContact: vi.fn(),
}));

describe('telegram-enrich', () => {
  beforeEach(() => { _test_resetState(); vi.mocked(db.upsertContact).mockClear(); });

  it('(a) dedupes 100 calls for same scope+username into 1 queue entry', () => {
    for (let i = 0; i < 100; i++) queueEnrich('g', 'vasya');
    expect(_test_getQueueSize()).toBe(1);
  });

  it('(b) cache hit within 24h success TTL is no-op on the queue', () => {
    _test_primeCache('vasya', { kind: 'success', ts: Date.now() - 23 * 3600_000, data: { bio: 'engineer' } });
    queueEnrich('g', 'vasya');
    expect(_test_getQueueSize()).toBe(0);
  });

  it('(c) cache miss after 25h re-queues', () => {
    _test_primeCache('vasya', { kind: 'success', ts: Date.now() - 25 * 3600_000, data: {} });
    queueEnrich('g', 'vasya');
    expect(_test_getQueueSize()).toBe(1);
  });

  it('(d) failure 6d23h ago does NOT re-queue (7d failure TTL)', () => {
    _test_primeCache('vasya', { kind: 'failure', ts: Date.now() - (6 * 24 + 23) * 3600_000 });
    queueEnrich('g', 'vasya');
    expect(_test_getQueueSize()).toBe(0);
  });

  it('(e) cross-scope cache hit applies upsertContact per-scope (round-10 fix)', () => {
    _test_primeCache('vasya', { kind: 'success', ts: Date.now(), data: { bio: 'engineer', kind: 'user' } });
    queueEnrich('group-A', 'vasya');
    queueEnrich('group-B', 'vasya');
    expect(db.upsertContact).toHaveBeenCalledTimes(2);
    expect(vi.mocked(db.upsertContact).mock.calls[0][0]).toBe('group-A');
    expect(vi.mocked(db.upsertContact).mock.calls[1][0]).toBe('group-B');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — module doesn't exist.

- [ ] **Step 3: Implement** per spec lines **970-1020**:
  - Module-level `cache: Map<string, EnrichRecord>` keyed by lowered username, `queue: Array<{scope, username}>`, `inFlight: Set<string>` keyed by `${scope}|${username}`.
  - Export `queueEnrich(scope, username)` with the 4-branch logic from spec.
  - Export `startEnrichWorker(bot, db)` (the 1/sec token-bucket consumer).
  - Export test-only helpers: `_test_primeCache(username, record)`, `_test_getQueueSize()`, `_test_resetState()`.
  - On cache-hit-success, synchronously call `upsertContact(scope, record.data, { source: 'getChat', enriched: 1 })` BEFORE returning (NOT a no-op — round-10 fix).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram-enrich.ts src/channels/telegram-enrich.test.ts
git commit -m "feat(telegram): telegram-enrich with cross-scope cache-hit upsert + test-only exports"
```

---

### Task 10: TelegramChannel — 4 handler wiring + processContactsFromContext (all 7 triggers) + botSenderId

**Files:**
- Modify: `src/channels/telegram.ts`
- Modify or create: `src/channels/telegram.test.ts`

**Spec refs:** `processContactsFromContext` body at lines **390-475** (worked example for trigger 1 inline; trigger rows 2-6 are **comment stubs in spec** that this task MUST flesh out per the trigger table); botSenderId at MOD bullet ~line **1013**.

**CRITICAL round-1 fix #1:** Spec lines 446-460 are COMMENT STUBS for trigger rows 2-6. Implementer MUST follow the row-1 worked example pattern for each remaining row (see Step 3 for explicit code).

**CRITICAL round-1 fix #2:** Auto-vision removal (deleting the `processImage` call) is MOVED OUT of this task — it lives in Task 15 (auto-vision cascade). This task focuses purely on additive wiring + helper extraction.

**Round-1 fix #3:** Add a Step 0 with a failing test BEFORE implementation (the v1 plan's "smoke test" was not TDD).

- [ ] **Step 1: Write failing tests** for `processContactsFromContext` (the pure function) and `botSenderId`:

```ts
import { _testProcessContactsFromContext, _testBotSenderId } from './telegram.js';  // Or import the class and call methods
import * as db from '../db.js';
import * as enrich from './telegram-enrich.js';
import { vi } from 'vitest';

vi.mock('../db.js', () => ({ upsertContact: vi.fn(), promoteContactIdent: vi.fn() }));
vi.mock('./telegram-enrich.js', () => ({ queueEnrich: vi.fn() }));

describe('processContactsFromContext — all 7 triggers', () => {
  beforeEach(() => { vi.mocked(db.upsertContact).mockClear(); vi.mocked(db.promoteContactIdent).mockClear(); vi.mocked(enrich.queueEnrich).mockClear(); });

  it('trigger 1: msg.from (with username) → promoteContactIdent + upsertContact source=sender', () => {
    const ctx = { msg: { from: { id: 42, is_bot: false, first_name: 'V', username: 'vasya' }, chat: { id: 1, type: 'private' } } } as any;
    _testProcessContactsFromContext(ctx, 'g');
    expect(db.promoteContactIdent).toHaveBeenCalledWith('g', 'vasya', '42');
    expect(db.upsertContact).toHaveBeenCalledWith('g', expect.objectContaining({ kind: 'user', first_name: 'V', is_bot: 0 }), expect.objectContaining({ identity: expect.objectContaining({ tg_id: '42', username: 'vasya' }), source: 'sender' }));
  });

  it('trigger 1: msg.sender_chat → upsertContact source=sender (username in identity, not patch)', () => { /* ... */ });
  it('trigger 2: forward_origin type=user → upsertContact source=forward', () => { /* ... */ });
  it('trigger 2: forward_origin type=hidden_user → no row created (only sender_user_name)', () => { /* ... */ });
  it('trigger 2: forward_origin type=chat (anonymous admin) → upsertContact with sig from author_signature', () => { /* ... */ });
  it('trigger 2: forward_origin type=channel → upsertContact source=forward + link derivable', () => { /* ... */ });
  it('trigger 3: reply_to_message.from → upsertContact source=reply', () => { /* ... */ });
  it('trigger 4: msg.contact → upsertContact source=vcard with phone+vcard_raw', () => { /* ... */ });
  it('trigger 5: entity type=text_mention → upsertContact source=text_mention for each entity', () => { /* ... */ });
  it('trigger 6: entity type=mention (bare @username) → queueEnrich for each entity', () => { /* ... */ });
});

describe('botSenderId', () => {
  it('returns String(bot.botInfo.id) when populated', () => { /* expect _testBotSenderId({bot:{botInfo:{id:12345}}}).toBe('12345') */ });
  it('returns undefined when bot is null', () => { /* ... */ });
  it('returns undefined when botInfo missing', () => { /* ... */ });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `processContactsFromContext` with ALL 7 triggers inlined** — DO NOT copy spec verbatim for rows 2-6 (those are comment stubs). Use this concrete code:

```ts
import type { Context } from 'grammy';
import { upsertContact, promoteContactIdent } from '../db.js';
import { queueEnrich } from './telegram-enrich.js';

export function _testProcessContactsFromContext(ctx: Context, scope: string): void {
  return processContactsFromContext(ctx, scope);  // test-only re-export
}

function processContactsFromContext(ctx: Context, scope: string): void {
  const msg = ctx.msg;
  if (!msg) return;

  // Trigger 1: sender (sender_chat mutex with from)
  if (msg.sender_chat) {
    const sc = msg.sender_chat;
    upsertContact(scope, {
      kind: sc.type === 'channel' ? 'channel' : 'chat',
      title: 'title' in sc ? sc.title : null,
      is_bot: 0,
    }, {
      identity: {
        tg_id: String(sc.id),
        username: 'username' in sc ? sc.username ?? undefined : undefined,
      },
      source: 'sender',
    });
  } else if (msg.from) {
    if (msg.from.username) promoteContactIdent(scope, msg.from.username, String(msg.from.id));
    upsertContact(scope, {
      kind: 'user',
      first_name: msg.from.first_name ?? null,
      last_name: msg.from.last_name ?? null,
      is_bot: msg.from.is_bot ? 1 : 0,
    }, {
      identity: { tg_id: String(msg.from.id), username: msg.from.username ?? undefined },
      source: 'sender',
    });
  }

  // Trigger 2: forward_origin
  if (msg.forward_origin) {
    const o = msg.forward_origin;
    if (o.type === 'user') {
      const u = o.sender_user;
      if (u.username) promoteContactIdent(scope, u.username, String(u.id));
      upsertContact(scope, { kind: 'user', first_name: u.first_name ?? null, last_name: u.last_name ?? null, is_bot: u.is_bot ? 1 : 0 }, { identity: { tg_id: String(u.id), username: u.username ?? undefined }, source: 'forward' });
    } else if (o.type === 'chat') {
      const c = o.sender_chat;
      upsertContact(scope, { kind: c.type === 'channel' ? 'channel' : 'chat', title: 'title' in c ? c.title : null, is_bot: 0 }, { identity: { tg_id: String(c.id), username: 'username' in c ? c.username ?? undefined : undefined }, source: 'forward' });
    } else if (o.type === 'channel') {
      const c = o.chat;
      const link = c.username ? `https://t.me/${c.username}/${o.message_id}` : null;
      upsertContact(scope, { kind: 'channel', title: c.title, link, is_bot: 0 }, { identity: { tg_id: String(c.id), username: c.username ?? undefined }, source: 'forward' });
    }
    // hidden_user: no identity to create a row (only sender_user_name string) — skip
  }

  // Trigger 3: reply_to_message.from
  if (msg.reply_to_message?.from) {
    const u = msg.reply_to_message.from;
    if (u.username) promoteContactIdent(scope, u.username, String(u.id));
    upsertContact(scope, { kind: 'user', first_name: u.first_name ?? null, last_name: u.last_name ?? null, is_bot: u.is_bot ? 1 : 0 }, { identity: { tg_id: String(u.id), username: u.username ?? undefined }, source: 'reply' });
  }

  // Trigger 4: msg.contact (vCard)
  if (msg.contact) {
    const c = msg.contact;
    upsertContact(scope, { kind: 'user', first_name: c.first_name ?? null, last_name: c.last_name ?? null, phone: c.phone_number ?? null, is_bot: 0 }, { identity: c.user_id ? { tg_id: String(c.user_id) } : { name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() }, source: 'vcard' });
  }

  // Trigger 5: text_mention entities
  for (const e of (msg.entities ?? []).concat(msg.caption_entities ?? [])) {
    if (e.type === 'text_mention') {
      const u = e.user;
      if (u.username) promoteContactIdent(scope, u.username, String(u.id));
      upsertContact(scope, { kind: 'user', first_name: u.first_name ?? null, last_name: u.last_name ?? null, is_bot: u.is_bot ? 1 : 0 }, { identity: { tg_id: String(u.id), username: u.username ?? undefined }, source: 'text_mention' });
    }
  }

  // Trigger 6: bare @mention entities → queueEnrich
  const text = msg.text ?? msg.caption ?? '';
  for (const e of (msg.entities ?? []).concat(msg.caption_entities ?? [])) {
    if (e.type === 'mention') {
      const username = text.slice(e.offset + 1, e.offset + e.length);  // strip leading '@'
      if (username) queueEnrich(scope, username);
    }
  }
}
```

- [ ] **Step 4: Wire 4 update handlers** — modify `src/channels/telegram.ts` so each `bot.on('message:*')`, `bot.on('edited_message:*')`, `bot.on('channel_post:*')`, `bot.on('edited_channel_post:*')` handler calls `processContactsFromContext(ctx, scope)` and `buildMetaBlock(ctx.msg)`, then constructs `NewMessage` with `meta` field and calls `this.opts.onMessage(...)`. The working tree currently has 9+ `bot.on` handlers — consolidate them OR add `processContactsFromContext` to each (whichever is simpler given the existing structure). Do NOT delete the `processImage` call yet — Task 15 handles that.

- [ ] **Step 5: Add `botSenderId()` method** to `TelegramChannel`:

```ts
botSenderId(): string | undefined {
  return this.bot?.botInfo?.id ? String(this.bot.botInfo.id) : undefined;
}

// Test-only export at module level:
export function _testBotSenderId(self: { bot: { botInfo?: { id: number } } | null }): string | undefined {
  return self.bot?.botInfo?.id ? String(self.bot.botInfo.id) : undefined;
}
```

- [ ] **Step 6: Run, expect PASS** for new tests + all existing tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat(telegram): 4 update kinds + processContactsFromContext (all 7 triggers) + botSenderId"
```

---

### Task 11: sendTelegramMessage narrowed catch + TelegramChannel.sendMessage multi-chunk first-id

**Files:**
- Modify: `src/channels/telegram.ts`
- Modify: `src/channels/telegram.test.ts`

**Spec refs:** `sendTelegramMessage` at lines **684-720**; `TelegramChannel.sendMessage` multi-chunk at **722-739**.

- [ ] **Step 1: Add failing tests**

```ts
describe('sendTelegramMessage narrowed catch', () => {
  it('Markdown 400 parse-error retries plain', async () => {
    const api = { sendMessage: vi.fn().mockRejectedValueOnce({ error_code: 400, description: "Bad Request: can't parse entities: ..." }).mockResolvedValueOnce({ message_id: 7 }) };
    const r = await sendTelegramMessage(api as any, 1, 'text');
    expect(r.messageId).toBe('7');
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('429 rate-limit propagates WITHOUT retry', async () => {
    const api = { sendMessage: vi.fn().mockRejectedValue({ error_code: 429, description: 'Too Many Requests' }) };
    await expect(sendTelegramMessage(api as any, 1, 'text')).rejects.toMatchObject({ error_code: 429 });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('503 service unavailable propagates WITHOUT retry', async () => { /* ... */ });

  it('plain network error (no error_code) propagates WITHOUT retry', async () => { /* ... */ });

  it("400 'chat not found' (non-parse) propagates WITHOUT retry", async () => { /* ... */ });
});

describe('TelegramChannel.sendMessage multi-chunk', () => {
  it('single chunk: returns that chunk\'s messageId', async () => { /* ... */ });
  it('multi-chunk: returns FIRST chunk messageId, sends all chunks', async () => { /* ... */ });
  it('partial failure (chunk 2 throws): throw propagates, chunk 1 messageId not returned (known limitation)', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Replace `sendTelegramMessage`** — copy spec lines **684-720** verbatim (the narrow catch block).

- [ ] **Step 4: Replace `TelegramChannel.sendMessage`** — copy spec lines **722-739** verbatim (multi-chunk first-id capture).

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat(telegram): narrowed Markdown→plain catch + multi-chunk first-id capture"
```

---

## Phase 3 — Outbound chokepoint + Gmail + migration (Tasks 12-15) → part of PR 2

### Task 12: Gmail — truthy id fallback + botSenderId

**Files:**
- Modify: `src/channels/gmail.ts`
- Modify: `src/channels/gmail.test.ts`

**Spec refs:** Gmail `sendMessage` at lines **741-761** verbatim; `botSenderId` for Gmail at Files-touched MOD bullet (in 966-1180).

- [ ] **Step 1: Write failing tests**

```ts
describe('GmailChannel.sendMessage id fallback', () => {
  it('valid id: returns messageId', async () => { /* mock users.messages.send → {data: {id: 'X'}}, expect {messageId: 'X'} */ });
  it('null id: returns undefined', async () => { /* {data: {id: null}} → {messageId: undefined} */ });
  it("empty-string id '' (round-10 regression case): returns undefined via truthy check", async () => { /* {data: {id: ''}} → {messageId: undefined} */ });
});

describe('GmailChannel.botSenderId', () => {
  it('returns configured userEmail when set', () => { /* ... */ });
  it('returns undefined when not connected', () => { /* ... */ });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Replace Gmail `sendMessage`** — copy spec lines **741-761** verbatim. Add `botSenderId()` method returning the cached `userEmail` or undefined.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/channels/gmail.ts src/channels/gmail.test.ts
git commit -m "feat(gmail): truthy '' id fallback + botSenderId"
```

---

### Task 13: routeOutbound chokepoint rewrite — SEND/STORE isolation + botSenderId threading

**Files:**
- Modify: `src/router.ts`
- Modify: `src/routing.test.ts`

**Spec refs:** §5 routeOutbound body at lines **763-793**; senderId threading detail in §6 narrative at lines **838-848**.

**Round-1 fix:** v1 plan cited lines 715-755 — wrong (that range is Gmail). Correct refs above.

**Round-1 fix #2:** v1 plan used `vi.doMock` inside `it()` which does NOT intercept static ESM imports. v2 uses TOP-LEVEL `vi.mock`.

- [ ] **Step 1: Write failing tests** with TOP-LEVEL `vi.mock`:

```ts
import { routeOutbound } from './router.js';
import * as db from './db.js';
import { vi } from 'vitest';

vi.mock('./db.js', () => ({
  storeOutboundMessage: vi.fn(),
}));

describe('routeOutbound SEND/STORE isolation', () => {
  beforeEach(() => { vi.mocked(db.storeOutboundMessage).mockReset(); });

  it('SEND throw propagates', async () => {
    const channel = { ownsJid: () => true, isConnected: () => true, sendMessage: vi.fn().mockRejectedValue(new Error('telegram down')), botSenderId: () => '1' };
    await expect(routeOutbound([channel as any], 'tg:1', 'hi')).rejects.toThrow(/telegram down/);
    expect(db.storeOutboundMessage).not.toHaveBeenCalled();
  });

  it('STORE throw is logged-only (DB-failure isolation, verification #18)', async () => {
    vi.mocked(db.storeOutboundMessage).mockImplementation(() => { throw new Error('SQLITE_BUSY'); });
    const channel = { ownsJid: () => true, isConnected: () => true, sendMessage: vi.fn().mockResolvedValue({ messageId: 'TG_1' }), botSenderId: () => '1' };
    await expect(routeOutbound([channel as any], 'tg:1', 'hi')).resolves.toBeUndefined();
    expect(channel.sendMessage).toHaveBeenCalledOnce();
    expect(db.storeOutboundMessage).toHaveBeenCalledOnce();
  });

  it('No channel for JID throws (matches "No channel for JID" prefix exactly)', async () => {
    await expect(routeOutbound([], 'tg:nobody', 'hi')).rejects.toThrow(/^No channel for JID/);
  });

  it('threads botSenderId into storeOutboundMessage', async () => {
    const channel = { ownsJid: () => true, isConnected: () => true, sendMessage: vi.fn().mockResolvedValue({ messageId: 'TG_1' }), botSenderId: () => '999888' };
    await routeOutbound([channel as any], 'tg:1', 'hi');
    expect(db.storeOutboundMessage).toHaveBeenCalledWith('tg:1', 'hi', 'TG_1', '999888');
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — current `routeOutbound` is the working-tree 3-line passthrough.

- [ ] **Step 3: Rewrite `routeOutbound`** in `src/router.ts` — copy spec lines **763-793** verbatim, then add the senderId thread per spec lines **838-848**:

```ts
export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  opts?: SendMessageOptions,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  // SEND outside try — throws propagate.
  const result = await channel.sendMessage(jid, text, opts);
  // STORE inside try — DB errors logged only.
  try {
    const messageId = result && typeof result === 'object' && 'messageId' in result
      ? (result.messageId ?? undefined)
      : undefined;
    const senderId = channel.botSenderId?.();
    storeOutboundMessage(jid, text, messageId, senderId);
  } catch (err) {
    logger.error({ jid, err }, 'storeOutboundMessage failed (message was delivered)');
  }
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/routing.test.ts
git commit -m "feat(router): routeOutbound chokepoint with SEND/STORE isolation + senderId threading"
```

---

### Task 14: Migrate 7 channel.sendMessage sites + scheduler narrowed catch

**Files:**
- Modify: `src/index.ts`

**Spec refs:** 7 migration sites + scheduler-lambda narrowed catch at lines **853-884**.

**Round-1 fix:** v1 had hard-coded line numbers (304, 647, ...). v2 uses **context-relative refs** with empirical pre-flight verification.

- [ ] **Step 1: Empirically verify call count**

```bash
cd /Users/breakneck/nanoclaw
grep -nE 'channel\.sendMessage\(' src/index.ts
```

Expected: 7 lines. If different count, HALT and reconcile against spec lines **853-884** before proceeding. Line numbers may have shifted from earlier work — refer to sites by surrounding function/closure context (`runAgent` streaming callback, `handleRemoteControl` remote-control branches, `startSchedulerLoop` lambda, `startIpcWatcher` lambda).

- [ ] **Step 2: Replace each `channel.sendMessage(...)` call** with `routeOutbound(channels, jid, text, opts)`:
  - The streaming output callback inside `runAgent` (1 site).
  - The remote-control branches in `handleRemoteControl` (4 sites — some multi-line).
  - The scheduler lambda inside `startSchedulerLoop` (1 site).
  - The IPC lambda inside `startIpcWatcher` (1 site).

- [ ] **Step 3: Apply narrowed catch in scheduler lambda ONLY** (NOT the IPC lambda — that already throws):

```ts
// Scheduler lambda (current working-tree behavior: warn-and-skip on missing channel):
sendMessage: async (jid, rawText) => {
  const text = formatOutbound(rawText);
  if (!text) return;
  try {
    await routeOutbound(channels, jid, text, { threadId: lastThreadId[jid] });
  } catch (err) {
    // Round-11 narrow catch: only swallow "No channel for JID". Rethrow other
    // errors so the outer task-scheduler catch records the task as failed.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('No channel for JID')) {
      logger.warn({ jid }, 'Scheduled task: no channel owns JID, skipping');
      return;
    }
    throw err;
  }
},
```

The IPC lambda becomes simply `return routeOutbound(channels, jid, text, { threadId: lastThreadId[jid] });` (no extra try/catch).

- [ ] **Step 4: Add import** — `import { routeOutbound } from './router.js';` at top of `src/index.ts` if not already present.

- [ ] **Step 5: Verify build** — `npx tsc --noEmit`. Expected: any remaining `pendingImages`/`hasImages`/`images` references still resolve (Task 15 cleans them). If `NewMessage.images` is still in `src/types.ts` (per Task 6), the build is GREEN.

- [ ] **Step 6: Run existing tests** — `npx vitest run`. Expected: all green (no new test in this task; coverage comes from Tasks 13 + 21).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): migrate 7 channel.sendMessage sites to routeOutbound + scheduler narrowed catch"
```

---

### Task 15: Auto-vision deletion cascade (incl. `NewMessage.images` removal)

**Files:**
- Delete: `src/image.ts`
- Modify: `src/container-runner.ts`, `src/channels/telegram.ts`, `src/index.ts`, `src/types.ts` (`NewMessage.images` removal — moved here from Task 6), `container/agent-runner/src/index.ts`

**Spec refs:** full cascade enumeration in Files-touched section (~lines **1106-1130**).

**Round-1 fixes:**
- Use `rm` (plain shell), NOT `git rm` — file is untracked.
- Absorb `NewMessage.images?` removal from Task 6.
- Absorb auto-vision `processImage()` call deletion from Task 10.
- This is now the SINGLE atomic commit that drops all auto-vision code.

- [ ] **Step 1: Pre-flight grep**

```bash
cd /Users/breakneck/nanoclaw
grep -rnE 'ImageAttachment|processImage|pendingImages|hasImages|pushWithImages|batchImages' src/ container/agent-runner/src/ 2>/dev/null
```

Save the output. Expect ~30+ matches. Every match must be deleted or refactored.

- [ ] **Step 2: Remove `ImageAttachment` interface + `ContainerInput.images?`** from `src/container-runner.ts` (delete the interface declaration and the field).

- [ ] **Step 3: Delete `src/image.ts`** — use plain shell `rm` (file is untracked, so `git rm` fails):

```bash
rm src/image.ts
```

The deletion will be picked up by `git add -A` later.

- [ ] **Step 4: Remove from `src/channels/telegram.ts`**:
  - Delete `import { downloadImage, processImage } from '../image.js';` at line 4 (or wherever it is).
  - Delete the inline-import type and local `images` variable at line ~427.
  - Delete any `processImage(...)` call inside the `message:photo` handler — photos now flow through `<m><media file_id=...>` only.
  - Remove `images` from the `onMessage({...})` call payload.

- [ ] **Step 5: Remove from `src/index.ts`** — every reference saved in Step 1's grep output:
  - `const pendingImages = new Map<...>()` declaration.
  - `import('./container-runner.js').ImageAttachment[]` type refs.
  - `const batchImages: ... ImageAttachment[] = []` local.
  - `images?: ... ImageAttachment[]` lambda params.
  - `hasImages` branch in `processGroupMessages` (simplify).
  - `pendingImages.set(...)` writes.
  - Any call funneling images into `runAgent`/`runContainerAgent`.

- [ ] **Step 6: Remove `NewMessage.images?: ImageAttachment[]`** from `src/types.ts` (moved here from Task 6 to keep build green until this atomic deletion).

- [ ] **Step 7: Remove from `container/agent-runner/src/index.ts`**:
  - `interface ImageAttachment {...}` declaration (lines ~25-39).
  - `images?: ImageAttachment[]` field on `ContainerInput`.
  - `pushWithImages(text, images)` method on stream wrapper.
  - `if (containerInput.images && containerInput.images.length > 0)` branch at ~lines 396-397; replace with the simple text-only push.

- [ ] **Step 8: Verify build is GREEN**

```bash
npx tsc --noEmit
```

Expected: zero errors. Re-grep to confirm all references gone:

```bash
grep -rnE 'ImageAttachment|processImage|pendingImages|hasImages|pushWithImages|batchImages' src/ container/agent-runner/src/ 2>/dev/null
```

Expected: zero matches.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: delete auto-vision cascade (src/image.ts + ImageAttachment everywhere)"
```

**End of Phase 3 → PR 2 candidate (Tasks 8-15).** Open PR 2 against `main` for review.

---

## Phase 4 — IPC + container MCP (Tasks 16-19) → part of PR 3

### Task 16a: IPC sweep with .processing interlock + errors/ exclusion

**Files:**
- Modify: `src/ipc.ts`
- Modify: `src/container-runner.ts` (ensure new IPC sub-dirs exist at group setup)
- Modify or create: `src/ipc.test.ts`

**Spec refs:** sweep pseudocode at lines **496-551** (full inlined implementation).

**Round-1 fix:** v1 Task 16 packed 5 concerns. v2 splits into 16a (sweep), 16b (namespaces + atomic responses), 16c (contacts.json writer).

- [ ] **Step 1: Write failing tests**

```ts
import fs from 'fs';
import path from 'path';
import { runSweepOnce } from './ipc.js';

describe('IPC sweep', () => {
  it('does NOT touch errors/ directory', () => {
    /* setup data/ipc/g/errors/foo.json with mtime = now - 1h */
    runSweepOnce('g');
    /* assert errors/foo.json still exists */
  });

  it('.processing files older than 600s rename back to .json', () => {
    /* setup media-requests/req1.json.processing mtime = now - 700s */
    runSweepOnce('g');
    /* expect req1.json exists, req1.json.processing gone */
  });

  it('writes TIMEOUT response only when no response file exists (interlock)', () => {
    /* setup media-requests/req2.json mtime = now - 200s */
    runSweepOnce('g');
    /* expect media-responses/req2.json exists with _meta.error_code='TIMEOUT' */
  });

  it('responses older than 180s unlinked', () => {
    /* setup media-responses/old.json mtime = now - 200s */
    runSweepOnce('g');
    /* expect old.json gone */
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `runSweepOnce` undefined.

- [ ] **Step 3: Implement `runSweepOnce(group)`** in `src/ipc.ts` per spec lines **496-551** verbatim. The loop iterates dirs matching `/-(requests|responses)$/`, skips `.processing` files, applies the 600s orphan-recovery rule.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts src/container-runner.ts
git commit -m "feat(ipc): sweep with .processing interlock + errors/ exclusion"
```

---

### Task 16b: 3 new IPC namespaces + atomic host→container response writes

**Files:**
- Modify: `src/ipc.ts`
- Modify: `src/container-runner.ts`
- Modify: `src/ipc.test.ts`

**Spec refs:** namespace list + atomic write rule in Files-touched (~lines **1108-1115**).

- [ ] **Step 1: Add 3 new namespaces** — extend IPC routing to handle `media-requests/` ↔ `media-responses/`, `lookup-requests/` ↔ `lookup-responses/`, `contact-write-requests/` ↔ `contact-write-responses/`.

- [ ] **Step 2: Mandate atomic temp+rename for all host→container response writes**:

```ts
const tmp = `${responsePath}.tmp.${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(response));
fs.renameSync(tmp, responsePath);
```

Apply at every response-write site (success path + error path + sweep TIMEOUT-write — the last already atomic per spec).

- [ ] **Step 3: Update `src/container-runner.ts`** — create the 3 new IPC sub-dirs at group setup via `fs.mkdirSync(..., { recursive: true })`.

- [ ] **Step 4: Add test**

```ts
it('response write is atomic — concurrent read never sees partial JSON', () => { /* setup race; spin a reader loop while writing 5MB response */ });
```

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/container-runner.ts src/ipc.test.ts
git commit -m "feat(ipc): 3 new namespaces (media/lookup/contact-write) with atomic responses"
```

---

### Task 16c: contacts.json snapshot writer (debounced + cross-trigger main UNION)

**Files:**
- Modify: `src/ipc.ts`
- Modify: `src/ipc.test.ts`

**Spec refs:** snapshot writer details at lines **1115-1121**.

- [ ] **Step 1: Write failing tests**

```ts
it('per-scope trailing-edge debounce (500ms)', async () => { /* call upsertContact rapid-fire; assert exactly 1 snapshot write after 600ms */ });

it('non-main upsert ALSO triggers main timer (round-10 fix)', async () => { /* upsertContact(scope='g_dev', ...); after 600ms, assert main's contacts.json contains the new row */ });

it('SIGTERM flushAllSnapshots fires pending timers synchronously', () => { /* simulate SIGTERM, assert all snapshots written */ });

it('atomic write — temp+rename', () => { /* spy on fs.renameSync to confirm temp path used */ });
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** `writeContactsSnapshot(scope)` + per-scope `setTimeout` debounce (500ms trailing edge) + cross-trigger to main scope on every non-main upsert + `flushAllSnapshots()` on SIGTERM. Atomic temp+rename writes.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(ipc): contacts.json snapshot writer with debounce + main UNION cross-trigger"
```

---

### Task 17: Container MCP tools — register 4 new tools

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Spec refs:** tool descriptions at lines **956-964**; `writeIpcFile` + `pollResponseFile` + `lookup_contacts` file-read in Files-touched (~lines **1141-1146**).

- [ ] **Step 1: Add `pollResponseFile(reqId, timeoutMs=120000, intervalMs=100)`** helper as shared utility.

- [ ] **Step 2: Extend `writeIpcFile(dir, data, filenameOverride?)`** — optional filename, atomic temp+rename preserved.

- [ ] **Step 3: Register `view_media`** — input schema (Zod): `{file_id: string, tg_message_id: string, mode?: 'auto'|'image'|'text', pages?: string}`. On call: generate reqId, `writeIpcFile(MEDIA_REQ_DIR, payload, ${reqId}.json)`, `pollResponseFile(reqId, 120000, 100)`. Return polled response (`isError`, `_meta`, `content`).

- [ ] **Step 4: Register `lookup_messages`** — same IPC pattern.

- [ ] **Step 5: Register `lookup_contacts`** — DOES NOT use IPC. Reads `/workspace/ipc/contacts.json` via `fs.readFileSync`, JSON.parses, filters in memory by `query` / `username` / `tg_id`.

- [ ] **Step 6: Register `annotate_contact`** — IPC pattern (writes to `contact-write-requests/`).

- [ ] **Step 7: Verify container build** — `cd container/agent-runner && npx tsc --noEmit`.

- [ ] **Step 8: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(container): register 4 new MCP tools (view_media/lookup_messages/lookup_contacts/annotate_contact)"
```

---

### Task 18: Host watcher — view_media flow (CROSS_GROUP_REJECTED + retry + mime routing + atomic responses)

**Files:**
- Modify: `src/ipc.ts` (or new `src/ipc-media-handler.ts`)
- Create: `src/ipc-mediarequest.test.ts`

**Spec refs:** flow steps at lines **482-500**; retry/timeout at **496-551**; mime routing decision table at **553-564**; error contract at **566-599**; CROSS_GROUP_REJECTED two-query algorithm at error-contract row (~lines **574-576**).

**Round-1 fix:** v1 listed 10 error codes with zero inlined tests. v2 inlines 3 concrete tests (CROSS_GROUP_REJECTED, pdftotext NO_TEXT_LAYER, FILE_TOO_LARGE pre-check). The remaining 7 codes follow the same mock pattern — each gets one `it()` body sketched.

- [ ] **Step 1: Write failing tests** (concrete, inlined):

```ts
import { handleViewMediaRequest } from './ipc.js';  // or wherever exported
import { vi } from 'vitest';

vi.mock('grammy', async () => {
  const actual = await vi.importActual<typeof import('grammy')>('grammy');
  return { ...actual, /* mock Bot.api.getFile + downloadFile */ };
});

describe('view_media error codes', () => {
  beforeEach(() => _initTestDatabase());

  it('FILE_TOO_LARGE: file_size > 20MB pre-check (no getFile)', async () => {
    storeMessage({ id: '1', chat_jid: 'tg:1', sender: 'u', sender_name: 'U', content: '', timestamp: '2026-05-20T10:00:00Z', is_from_me: false, is_bot_message: false, meta: '<m id="1"><media file_id="X" size="22000000"/></m>' });
    const result = await handleViewMediaRequest({ file_id: 'X', tg_message_id: '1' }, ['tg:1']);
    expect(result.isError).toBe(true);
    expect(result._meta.error_code).toBe('FILE_TOO_LARGE');
    expect(result.content[0].text).toMatch(/^FILE_TOO_LARGE:/);
  });

  it('CROSS_GROUP_REJECTED: file_id belongs to another group', async () => {
    storeMessage({ id: '1', chat_jid: 'tg:OTHER', sender: 'u', sender_name: 'U', content: 'x', timestamp: '2026-05-20T10:00:00Z', is_from_me: false, is_bot_message: false, meta: '<m id="1"><media file_id="X"/></m>' });
    const result = await handleViewMediaRequest({ file_id: 'X', tg_message_id: '1' }, ['tg:REQUESTING']);
    expect(result.isError).toBe(true);
    expect(result._meta.error_code).toBe('CROSS_GROUP_REJECTED');
  });

  it('NO_TEXT_LAYER: pdftotext exit 0 + empty stdout + empty stderr', async () => {
    /* mock spawnSync('pdftotext', ...) → { status: 0, stdout: '', stderr: '' } */
    /* setup a scanned PDF mock */
    const result = await handleViewMediaRequest({ file_id: 'pdf-X', tg_message_id: '1' }, ['tg:1']);
    expect(result._meta.error_code).toBe('NO_TEXT_LAYER');
  });

  // Sketch (Step 1 fills these out — each is ~5-10 lines):
  it('TIMEOUT: getFile pending past 120s', async () => { /* ... */ });
  it('FILE_EXPIRED: getFile rejects with "file is too old"', async () => { /* ... */ });
  it('EXTRACTOR_MISSING: pdftotext not on PATH', async () => { /* ... */ });
  it('EXTRACTOR_OUTPUT_INVALID: stdout empty AND stderr matches /Syntax Error/', async () => { /* ... */ });
  it('UNSUPPORTED_TYPE: HEIC image', async () => { /* ... */ });
  it('PAGES_OUT_OF_RANGE: invalid pages syntax', async () => { /* ... */ });
  it('PAGES_OUT_OF_RANGE: start > totalPages', async () => { /* ... */ });
  it('UPSTREAM_ERROR: getFile non-retryable after 5 attempts', async () => { /* ... */ });
});

describe('view_media happy path', () => {
  it('returns image content for JPEG', async () => { /* ... */ });
  it('returns text content for PDF (auto/text mode)', async () => { /* ... */ });
  it('returns array of image contents for PDF mode=image pages=1-3', async () => { /* ... */ });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement `handleViewMediaRequest`**:
  - **CROSS_GROUP_REJECTED two-query algorithm** (spec error-contract row at ~574-576):
    1. `SELECT 1 FROM messages WHERE id = ? AND chat_jid IN (<requesting-group's JIDs>) LIMIT 1`. Found → ALLOW.
    2. Else `SELECT 1 FROM messages WHERE id = ? LIMIT 1`. Found → REJECT; not found → ALLOW (external_reply pass-through).
  - **20MB pre-check** via cached `file_size` parsed from `messages.meta` (no `getFile` round-trip).
  - **Retry budget** per spec lines 496-551: initial + 4 retries = 5 attempts, backoffs 1s/2s/4s/8s. Honor `Retry-After` clamped to 10s.
  - **Mime routing decision table** per spec lines 553-564.
  - **Inline `processImage` logic** (sharp resize ≤1024px, JPEG q85) — Task 15 deleted `src/image.ts`, so embed the sharp call here directly.
  - **Atomic temp+rename** for response write.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/ipc.ts src/ipc-mediarequest.test.ts
git commit -m "feat(ipc): view_media host handler with CROSS_GROUP_REJECTED + 10 error codes + retry"
```

---

### Task 19: Host lookup_messages + annotate_contact handlers

**Files:**
- Modify: `src/ipc.ts`
- Modify: `src/ipc.test.ts`

- [ ] **Step 1: Wire `lookup_messages` IPC handler** — reads `lookup-requests/<reqId>.json`, calls `lookupMessages(...)` (Task 5), atomically writes response.

- [ ] **Step 2: Wire `annotate_contact` IPC handler** — reads `contact-write-requests/<reqId>.json`, calls `annotateContact(...)` (Task 4), triggers per-scope debounce + main cross-trigger (Task 16c), atomically writes response.

- [ ] **Step 3: Add tests** for both handlers with mocks.

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(ipc): lookup_messages + annotate_contact host handlers"
```

---

## Phase 5 — Container test scaffold + CI grep (Tasks 20-21)

### Task 20: Container vitest scaffold + file-too-large-prefix.test.ts (NO scripts.test change yet)

**Files:**
- Create: `container/agent-runner/vitest.config.ts`
- Modify: `container/agent-runner/package.json`
- Create: `container/agent-runner/src/file-too-large-prefix.test.ts`

**Spec refs:** vitest config + package.json at lines **1024-1040**; test body at lines **1170-1196**.

**Round-1 fix:** v1 Task 20 also modified root `package.json` `scripts.test` referencing the CI script created in Task 21 — broke `npm test` at Task 20's commit. v2 moves root `scripts.test` modification into Task 21 (atomic with script creation).

- [ ] **Step 1: Create `container/agent-runner/vitest.config.ts`**:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
```

- [ ] **Step 2: Update `container/agent-runner/package.json`** — add `"vitest": "<same version as root>"` to `devDependencies` and `"test": "vitest run"` to `scripts`.

- [ ] **Step 3: Install deps** — `cd container/agent-runner && npm install`.

- [ ] **Step 4: Create test file** — copy spec lines **1170-1196** verbatim (no `handleViewMediaRequest` import — round-10 fix already in spec).

- [ ] **Step 5: Run container vitest standalone**

```bash
cd container/agent-runner && npm test
```

Expected: 1 test passes.

- [ ] **Step 6: Commit**

```bash
git add container/agent-runner/vitest.config.ts container/agent-runner/package.json container/agent-runner/src/file-too-large-prefix.test.ts container/agent-runner/package-lock.json
git commit -m "feat(test): container vitest scaffold + file-too-large-prefix wire-frame test"
```

---

### Task 21: CI grep enforcement script + fixture test + root scripts.test wiring

**Files:**
- Create: `scripts/check-outbound-chokepoint.sh`
- Create: `scripts/check-outbound-chokepoint.test.sh`
- Modify: root `package.json` (scripts.test — moved here from Task 20)

**Spec refs:** full script body at lines **886-955**; fixture bullet inside Files-touched (test bullet near ~line **1205**).

**Round-1 fix:** v1 Task 21 used `git add src/__lint_fixture.ts` PLUS the script's `git grep --untracked`. v2 uses only `--untracked` (single approach, per spec line ~912).

- [ ] **Step 1: Create `scripts/check-outbound-chokepoint.sh`** — copy spec lines **886-955** verbatim. CRITICAL: uses `git grep --untracked` (round-10 fix) AND awk exact-match allowlist via comma-split associative array (NOT regex `|`-join).

- [ ] **Step 2: Make executable** — `chmod +x scripts/check-outbound-chokepoint.sh`.

- [ ] **Step 3: Empirically run on current tree** — `bash scripts/check-outbound-chokepoint.sh; echo "exit=$?"`. Expected after Task 14 migration: exit=0 (no violations).

- [ ] **Step 4: Create `scripts/check-outbound-chokepoint.test.sh`** — fixture that uses `--untracked`:

```bash
#!/usr/bin/env bash
set -euo pipefail
echo 'channel.sendMessage(jid, text)' > src/__lint_fixture.ts
if bash scripts/check-outbound-chokepoint.sh; then
  echo "FAIL: script should have detected fixture violation"; rm src/__lint_fixture.ts; exit 1
fi
rm src/__lint_fixture.ts
if ! bash scripts/check-outbound-chokepoint.sh; then
  echo "FAIL: script should pass on clean tree"; exit 1
fi
echo "OK"
```

- [ ] **Step 5: Run fixture** — `chmod +x scripts/check-outbound-chokepoint.test.sh && bash scripts/check-outbound-chokepoint.test.sh`.

- [ ] **Step 6: Modify root `package.json`** `scripts.test`:

```json
"test": "vitest run && (cd container/agent-runner && npm test) && bash scripts/check-outbound-chokepoint.sh"
```

- [ ] **Step 7: Run** — `npm test` from repo root.

- [ ] **Step 8: Commit**

```bash
git add scripts/check-outbound-chokepoint.sh scripts/check-outbound-chokepoint.test.sh package.json
git commit -m "feat(ci): outbound chokepoint enforcement + fixture test + npm test wiring"
```

---

## Phase 6 — Integration (Tasks 22-23) → completes PR 3

### Task 22: formatMessages updated to read meta

**Files:**
- Modify: `src/router.ts`
- Modify: `src/formatting.test.ts`

**Spec refs:** `formatMessages` directive in `src/router.ts` MOD bullet (~lines **1141-1146** in Files-touched).

- [ ] **Step 1: Write failing test**

```ts
it('formatMessages emits <message><m>...</m><text>...</text></message> when meta present', () => { /* ... */ });
it('formatMessages emits legacy <message>escaped text</message> when meta NULL', () => { /* ... */ });
it('formatMessages omits <text> envelope when content is empty', () => { /* ... */ });
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Update `formatMessages`** in `src/router.ts`:

```ts
function formatMessages(rows: NewMessage[]): string {
  return rows.map(r => {
    if (r.meta) {
      const textPart = r.content ? `<text>${escapeXmlText(r.content)}</text>` : '';
      return `<message sender="${escapeXmlAttr(r.sender_name)}" time="${r.timestamp}">${r.meta}\n${textPart}</message>`;
    }
    return `<message sender="${escapeXmlAttr(r.sender_name)}" time="${r.timestamp}">${escapeXmlText(r.content)}</message>`;
  }).join('\n');
}
```

(Import `escapeXmlAttr`/`escapeXmlText` from `./channels/telegram-meta.js`.)

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/formatting.test.ts
git commit -m "feat(router): formatMessages reads meta + emits <text> envelope when content non-empty"
```

---

### Task 23: End-to-end verification + open final PR

**Files:**
- None (manual smoke + git ops)

**Spec refs:** 18 verification items at lines **1257-1319**.

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: zero errors.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all green (host vitest + container vitest + CI grep exit 0).

- [ ] **Step 3: Build container image**

```bash
./container/build.sh
```

Expected: success.

- [ ] **Step 4: Restart service**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 5: Walk verification items #1-#18** from spec lines **1257-1319** manually. For each, note pass/fail in a temp scratch file. If any item fails, file a follow-up issue rather than blocking the PR.

- [ ] **Step 6: Open PR 3**

```bash
gh pr create --base main --title "feat: rich message capture + persistent people memory (PR 3 — IPC/MCP/CI)" --body "Implements Tasks 16-23 of /docs/superpowers/plans/2026-05-20-rich-message-capture-impl.md. Spec: commit 92ef68a (v11)."
```

- [ ] **Step 7: Final commit (empty if needed for chronology)**

```bash
git commit --allow-empty -m "chore: end-to-end verification complete (spec v11 92ef68a)"
```

---

## Self-review checklist

**1. Spec coverage** — every section of v11 maps to a task:
- Structured meta block (lines 109-220): Tasks 8a/8b ✓
- Contacts schema + identity (lines 222-381): Tasks 1, 3, 4 ✓
- Host upsert rules (lines 383-475) — INCLUDING all 7 trigger rows: Task 10 step 3 ✓ (concrete code inlined for rows 2-6)
- view_media flow + retry + mime + errors (lines 478-599): Tasks 17, 18 ✓
- lookup_messages (lines 605-665): Tasks 5, 17, 19 ✓
- Outbound chokepoint (lines 670-895): Tasks 11, 12, 13, 14 ✓
- CI grep (lines 886-955): Task 21 ✓
- MCP descriptions (lines 956-964): Task 17 ✓
- Files-touched (lines 966-1180): all mapped, including atomic auto-vision cascade in Task 15 ✓
- Known limitations: respected via verbatim spec-block copies ✓
- Out of scope: untouched ✓
- 18 verification items (lines 1257-1319): Task 23 ✓

**2. Placeholder scan** — no `// ... N more it() blocks ...`, no "TBD", no "similar to Task N". Every code-step has concrete code or explicit spec line range with a correct ref.

**3. Type consistency** — `ContactRow`, `ContactPatch`, `Channel.botSenderId`, `NewMessage.meta`, `routeOutbound`, `processContactsFromContext` consistent across all tasks.

**4. Round-1 plan-review corrections incorporated**:
- ✓ Task 0 deterministic (commits baseline; no user coordination)
- ✓ Task 3 import drops dead `upsertContact`
- ✓ Task 6 keeps build green (defers `NewMessage.images` removal to Task 15)
- ✓ Task 8 split into 8a + 8b with concrete fixtures (no placeholder enumerations)
- ✓ Task 9 exports `_test_*` helpers
- ✓ Task 10 inlines all 7 trigger rows (rows 2-6 NOT spec comment stubs)
- ✓ Task 10 has Step 0 with failing tests; auto-vision removal moved to Task 15
- ✓ Task 13 uses top-level `vi.mock` (not `vi.doMock`) + correct spec ref 763-793
- ✓ Task 14 uses context-relative refs + empirical pre-flight grep
- ✓ Task 15 uses `rm` (plain shell), absorbs auto-vision cascade from Tasks 6/10
- ✓ Task 16 split into 16a/16b/16c
- ✓ Task 18 inlines 3 concrete tests + sketches 7 more (no zero-test bullet)
- ✓ Task 20 doesn't modify root scripts.test (moved to Task 21)
- ✓ Task 21 uses `--untracked` only (no double-approach)
- ✓ All spec line refs re-derived against v11 (per the index table at top of this plan)
- ✓ Working dir pinned to `/Users/breakneck/nanoclaw/` for every task
- ✓ Three stacked PRs (Phase 1 / Phases 2-3 / Phases 4-6)

---

## Execution Handoff

**Plan v2 complete and saved to `docs/superpowers/plans/2026-05-20-rich-message-capture-impl.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good for 25-task plan with clear boundaries.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
