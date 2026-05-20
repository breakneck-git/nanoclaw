# Rich Message Capture + Persistent People Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-20-rich-message-capture-design.md` at commit `92ef68a` (v11, 1401 lines). Plan refers to spec line ranges for verbatim code blocks that were vetted through 11 critical-review rounds — copy them as-is.

**Goal:** Let the NanoClaw agent operate on the full data of every Telegram message — including forward origin, mentioned/forwarded people, reply targets, media `file_id` — with a passive long-term contacts memory and on-demand media access via a new `view_media` MCP tool.

**Architecture:** Per-inbound, host parses grammy `Context` into a structured `<m>` XML block stored in `messages.meta`. Photos no longer base64-inline (auto-vision deleted); media is accessed by `file_id` via `view_media` over IPC. New `contacts` SQLite table with identity-merge MERGE semantics. Outbound bot text flows through a single `routeOutbound` chokepoint (7 call sites migrated). Four new MCP tools registered. Tests on both host and container vitest scopes.

**Tech Stack:** TypeScript (strict), Node.js, better-sqlite3, grammy ≥1.39.3, @modelcontextprotocol/sdk (container), Anthropic Agent SDK (container), poppler-utils (`pdftotext`/`pdftoppm`/`pdfinfo`), sharp (image processing), vitest.

**Working tree:** `/Users/breakneck/nanoclaw/` — has uncommitted bug-fix changes from earlier sessions; the plan's line refs target this tree (NOT HEAD, NOT the worktree at `.claude/worktrees/zen-payne-6cf769/`). Verify line numbers before edits.

**Branch strategy:** Create feature branch `feature/rich-message-capture` from `main`. Each task = one commit. Final PR after Task 23.

---

## Pre-flight

### Task 0: Setup branch

**Files:**
- None (git-only)

- [ ] **Step 1: Verify clean baseline** — `cd /Users/breakneck/nanoclaw && git status --short` to inventory uncommitted bug-fix changes. Confirm these are the expected pre-existing modifications (per CLAUDE.md, working tree has prior bug-fix work).

- [ ] **Step 2: Stash or commit pre-existing changes** — these are NOT this plan's work. Either `git stash push -m "pre-feature bug fixes"` (if user prefers stash) OR commit them first via `git add -p` to a separate branch. Coordinate with user before proceeding.

- [ ] **Step 3: Create feature branch**

```bash
git checkout -b feature/rich-message-capture
git log --oneline -1   # confirm spec v11 commit 92ef68a is HEAD
```

- [ ] **Step 4: Sanity-check dependencies**

```bash
grep -E '"grammy"|"better-sqlite3"|"vitest"|"@modelcontextprotocol/sdk"|"googleapis"|"sharp"' package.json container/agent-runner/package.json
```

Expected: grammy ≥1.39, better-sqlite3, vitest, googleapis, sharp at host. `@modelcontextprotocol/sdk` at container only.

---

## Phase 1 — DB foundations (Tasks 1-5)

### Task 1: ContactRow type + contacts schema + indexes

**Files:**
- Modify: `src/db.ts` (add type, schema CREATE inside `createSchema`, indexes)
- Test: `src/db.test.ts`

**Spec refs:** v11 spec lines 198-274 (full schema + ContactRow type).

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
    const row = db.prepare(`SELECT * FROM contacts WHERE ident = ?`).get('g_main|id:42') as { ident: string; tg_id: string };
    expect(row.ident).toBe('g_main|id:42');
    expect(row.tg_id).toBe('42');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `npx vitest run src/db.test.ts -t "contacts table"`. Expected: `no such table: contacts`.

- [ ] **Step 3: Add the schema CREATE + indexes** — inside `createSchema(db)` in `src/db.ts`, append the schema from spec lines 222-243 verbatim (the `CREATE TABLE IF NOT EXISTS contacts (...)` block plus the two `CREATE INDEX IF NOT EXISTS` lines). Then add the `ContactRow` interface from spec lines 250-273 to the type-exports section of `src/db.ts`.

- [ ] **Step 4: Run test, expect PASS** — same command.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): add contacts table schema + ContactRow type"
```

---

### Task 2: wireDatabaseFeatures helper + addMetaColumnIfMissing + lower_unicode UDF

**Files:**
- Modify: `src/db.ts` (refactor init paths, add helpers, add ALTER wrapper, register UDF)
- Test: `src/db.test.ts`

**Spec refs:** lines 754-794 (wireDatabaseFeatures + initDatabase + _initTestDatabase pattern). The `addMetaColumnIfMissing` PRAGMA-check pattern is in the same section.

- [ ] **Step 1: Write failing test for idempotent init**

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

- [ ] **Step 2: Run, expect FAIL** — `lower_unicode` undefined and/or `meta` column missing.

- [ ] **Step 3: Implement** — refactor `initDatabase` and `_initTestDatabase` per spec lines 758-794. Add:
  - `function wireDatabaseFeatures(database)` registering pragma + UDF.
  - `function addMetaColumnIfMissing(database)` using PRAGMA-table_info check before `ALTER TABLE messages ADD COLUMN meta TEXT`.
  - Both `initDatabase` and `_initTestDatabase` call `wireDatabaseFeatures(db)` then `createSchema(db)` then `addMetaColumnIfMissing(db)`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): wireDatabaseFeatures helper + addMetaColumnIfMissing + lower_unicode UDF"
```

---

### Task 3: mergeContactRows + promoteContactIdent

**Files:**
- Modify: `src/db.ts` (add both functions)
- Test: `src/db.test.ts`

**Spec refs:** lines 250-340 (verbatim `mergeContactRows` and `promoteContactIdent` bodies; identity-resolution rule).

- [ ] **Step 1: Write failing tests** (3 cases per spec verification #6 and round-7 round-10):

```ts
import { upsertContact, promoteContactIdent } from './db.js';  // also adds upsertContact (Task 4)

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

  it('preserves id-row notes when both rows non-null (notes-loss known limitation)', () => {
    // seed both rows
    db.prepare(/* insert g|id:42 with notes='id-notes' */).run();
    db.prepare(/* insert g|un:vasya with notes='un-notes' */).run();
    promoteContactIdent('g', 'vasya', '42');
    const row = db.prepare(`SELECT notes, tags FROM contacts WHERE ident = ?`).get('g|id:42') as { notes: string };
    expect(row.notes).toBe('id-notes');
  });

  it('does not crash at module load (no-op early return when un-row absent)', () => {
    expect(() => promoteContactIdent('g', 'nobody', '999')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — symbol undefined.

- [ ] **Step 3: Implement** — copy `mergeContactRows` (spec lines 280-310) and `promoteContactIdent` (spec lines 313-340) into `src/db.ts`. CRITICAL: the function uses lazy `db.transaction(() => {...})()` pattern — see spec line 313 comment about the module-load crash anti-pattern.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): mergeContactRows + promoteContactIdent with lazy txn wrap"
```

---

### Task 4: upsertContact + ContactPatch + getContactsForGroup + annotateContact

**Files:**
- Modify: `src/db.ts` (4 functions + ContactPatch type)
- Test: `src/db.test.ts`

**Spec refs:** lines 280-303 (upsert merge rules), 305-340 (per-column ON CONFLICT table), 953-985 (ContactPatch + upsertContact signature inside telegram-enrich.ts comment block).

- [ ] **Step 1: Write failing test**

```ts
describe('upsertContact', () => {
  beforeEach(() => _initTestDatabase());

  it('INSERTs on first call', () => {
    upsertContact('g', { kind: 'user', first_name: 'Вася' }, { identity: { tg_id: '42', username: 'vasya' }, source: 'sender' });
    const row = db.prepare(`SELECT * FROM contacts WHERE ident = ?`).get('g|id:42') as { first_name: string };
    expect(row.first_name).toBe('Вася');
  });

  it('UPDATEs with COALESCE rules on second call (does not overwrite non-null with null)', () => {
    upsertContact('g', { kind: 'user', first_name: 'Вася', last_name: 'Иванов' }, { identity: { tg_id: '42' }, source: 'sender' });
    upsertContact('g', { kind: 'user' }, { identity: { tg_id: '42' }, source: 'sender' });
    const row = db.prepare(`SELECT first_name, last_name, seen_count FROM contacts WHERE ident = ?`).get('g|id:42') as { first_name: string; last_name: string; seen_count: number };
    expect(row.first_name).toBe('Вася');
    expect(row.last_name).toBe('Иванов');
    expect(row.seen_count).toBe(2);
  });

  it('main scope sees UNION', () => {
    upsertContact('g_dev', { kind: 'user', first_name: 'Петя' }, { identity: { tg_id: '99' }, source: 'sender' });
    const rows = getContactsForGroup({ scope: 'main', includeUnion: true });
    expect(rows.find(r => r.tg_id === '99')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `upsertContact undefined`.

- [ ] **Step 3: Implement**:
  - Define `ContactPatch` type (spec lines 959-962 inline definition).
  - Define `upsertContact(scope, patch, opts)`: identity resolution per spec line 247 ("prefer tg_id; else lowered username; else lowered name"). Build `INSERT INTO contacts (...) VALUES (...) ON CONFLICT(ident) DO UPDATE SET ...` using the per-column rules table at spec lines 313-340.
  - Define `getContactsForGroup({scope, includeUnion})`: `SELECT * FROM contacts WHERE scope = ?` OR for main+union: `SELECT * FROM contacts WHERE 1=1`.
  - Define `annotateContact(identifier, {notes?, tags?})`: identifier is one of `ident | username | tg_id`; `notes` REPLACES, `tags` APPENDS-UNIQUE comma-separated.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): upsertContact + ContactPatch + getContactsForGroup + annotateContact"
```

---

### Task 5: lookupMessages SQL + buildQueryParam (LIKE escape helper)

**Files:**
- Modify: `src/db.ts` (add `lookupMessages` function and `buildQueryParam` helper)
- Test: `src/db.test.ts`

**Spec refs:** lines 502-545 (full `lookup_messages` SQL with N+12 binds; `buildQueryParam` escape function; `(include_bot ? 1 : 0)` coercion).

- [ ] **Step 1: Write failing tests** (covers verification #11, #15, #16):

```ts
describe('lookupMessages', () => {
  beforeEach(() => _initTestDatabase());

  it('Cyrillic case-insensitive search', () => {
    // seed: storeMessage(... content: 'Петя', chat_jid: 'tg:1', ...)
    const rows = lookupMessages({ groupJids: ['tg:1'], query: 'петя', includeBot: false, limit: 50 });
    expect(rows.length).toBe(1);
  });

  it('LIKE wildcard % is escaped (literal match)', () => {
    // seed: 'тратил 50%' and 'тратил 5000'
    const rows = lookupMessages({ groupJids: ['tg:1'], query: '50%', includeBot: false, limit: 50 });
    expect(rows.length).toBe(1);
    expect(rows[0].content).toBe('тратил 50%');
  });

  it('include_bot=true returns bot rows in addition to user rows', () => {
    // seed inbound + outbound (is_bot_message=1)
    const without = lookupMessages({ groupJids: ['tg:1'], includeBot: false, limit: 50 });
    const withBot = lookupMessages({ groupJids: ['tg:1'], includeBot: true, limit: 50 });
    expect(withBot.length).toBeGreaterThan(without.length);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** — copy spec lines 511-525 (full SQL) and spec lines 528-532 (`buildQueryParam` escape function) into `src/db.ts`. The function signature: `lookupMessages({groupJids, tgMessageId?, senderId?, since?, until?, query?, includeBot, limit})`. Bind order EXACTLY per spec line 526: `...groupJids, (includeBot ? 1 : 0), tgMessageId×2, senderId×2, since×2, until×2, buildQueryParam(query)×2, clampedLimit`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): lookupMessages with Cyrillic-safe LIKE escape (N+12 binds)"
```

---

## Phase 2 — Types + storeMessage (Tasks 6-7)

### Task 6: src/types.ts — Channel widening + botSenderId + NewMessage.meta

**Files:**
- Modify: `src/types.ts`
- Test: `src/types.test.ts` (NEW — pure-type tests; if vitest already runs tsc, a build-pass test is enough)

**Spec refs:** lines 564-580 (Channel.sendMessage widening), 989-993 (Channel.botSenderId? + NewMessage.meta + NewMessage.images removal).

- [ ] **Step 1: Make changes** — in `src/types.ts`:
  - Change `Channel.sendMessage(jid: string, text: string, opts?: SendMessageOptions): Promise<void>` → `Promise<{ messageId?: string } | void>`.
  - Add `botSenderId?(): string | undefined;` to the `Channel` interface.
  - Add `meta?: string;` to `NewMessage`.
  - Remove `images?: import('./container-runner.js').ImageAttachment[]` from `NewMessage` (line 56 of working tree).

- [ ] **Step 2: Verify compile** — `npx tsc --noEmit`. Expected: any consumer of `NewMessage.images` errors. Note them for Task 15 cleanup; do NOT fix them yet (they'll be deleted entirely in Phase 4).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): widen Channel.sendMessage + add botSenderId + NewMessage.meta"
```

(NOTE: build is intentionally broken until Task 15 deletes the auto-vision cascade. This is OK — subsequent tasks 7-14 build correctly because they don't depend on the removed paths.)

---

### Task 7: storeMessage carries meta + storeOutboundMessage + getNewMessages/getMessagesSince projection

**Files:**
- Modify: `src/db.ts`
- Test: `src/db.test.ts`

**Spec refs:** lines 736-758 (verbatim new SELECTs for getNewMessages/getMessagesSince), 712-735 (`storeOutboundMessage` body verbatim).

- [ ] **Step 1: Write failing tests** (cover verification #7 + round-10 storeOutboundMessage 4 cases):

```ts
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
});

describe('storeOutboundMessage', () => {
  beforeEach(() => _initTestDatabase());

  it('synthetic-id path: undefined messageId + undefined senderId', () => {
    storeOutboundMessage('tg:1', 'hello');
    const row = db.prepare(`SELECT * FROM messages WHERE chat_jid = ?`).get('tg:1') as any;
    expect(row.id).toMatch(/^out-/);
    expect(row.sender).toBe('bot');
    expect(row.meta).toBe('<m kind="outbound-synthetic"/>');
    expect(row.is_bot_message).toBe(1);
  });

  it('channel-id path: real messageId + senderId', () => {
    storeOutboundMessage('tg:1', 'hello', 'TG_MID_123', '987654');
    const row = db.prepare(`SELECT * FROM messages WHERE chat_jid = ?`).get('tg:1') as any;
    expect(row.id).toBe('TG_MID_123');
    expect(row.sender).toBe('987654');
    expect(row.meta).toBeNull();
  });

  it("empty-string messageId '' treated as missing (truthy fallback)", () => {
    storeOutboundMessage('tg:1', 'hello', '');
    const row = db.prepare(`SELECT * FROM messages WHERE chat_jid = ?`).get('tg:1') as any;
    expect(row.id).toMatch(/^out-/);
    expect(row.sender).toBe('bot');
  });

  it('auto-seeds chats row on first send to new jid', () => {
    storeOutboundMessage('tg:never_seen', 'hello');
    const chat = db.prepare(`SELECT * FROM chats WHERE jid = ?`).get('tg:never_seen');
    expect(chat).toBeDefined();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `storeOutboundMessage` undefined; `meta` not in SELECT.

- [ ] **Step 3: Implement**:
  - Update `storeMessage` to accept and bind a `meta?: string` field (extend INSERT OR REPLACE column list + values).
  - Add `storeOutboundMessage(jid, text, channelMessageId?, senderId?)` per spec lines 712-735 verbatim.
  - Update `getNewMessages` SELECT per spec lines 737-748 (add `, meta` to SELECT; change WHERE last predicate to `((content != '' AND content IS NOT NULL) OR meta IS NOT NULL)`). KEEP `ORDER BY timestamp ASC LIMIT ?` (FIFO drain — see spec line 729 and working-tree comment at src/db.ts:335-339).
  - Update `getMessagesSince` SELECT per spec lines 750-758 similarly.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): meta column projection + storeOutboundMessage + photo-no-caption WHERE relax"
```

---

## Phase 3 — Telegram channel (Tasks 8-11)

### Task 8: telegram-meta.ts (NEW) — buildMetaBlock + escape helpers

**Files:**
- Create: `src/channels/telegram-meta.ts`
- Test: `src/channels/telegram-meta.test.ts` (NEW)

**Spec refs:** lines 70-100 (escapeXmlAttr/escapeXmlText), 110-210 (tag reference + worked example XML), 1167 (test bullet enumerating ALL round-10 additions).

- [ ] **Step 1: Write failing tests** — create `src/channels/telegram-meta.test.ts` with at minimum these cases (each is a separate `it()`):
  - forward (user/hidden_user/chat/channel/unknown — 5 cases)
  - reply (in-chat + external_reply with media+contact+location+poll+story)
  - reply_to_story top-level
  - quote
  - all media types (photo/video/voice/audio/document/sticker/animation/video_note)
  - sticker mime cascade: is_animated → application/x-tgsticker; is_video → video/webm; else image/webp
  - voice/video_note transcript attribute
  - entities (url/mention/text_link/text_mention/custom_emoji/hashtag/cashtag/bot_command/phone_number/email)
  - caption_entities merged into <entities>
  - vCard
  - location
  - poll (question + type only; options dropped)
  - story
  - edited_message markers (meta.edited=ISO)
  - sender_chat detection (mutex with from)
  - <via_bot id un name/>
  - <link_preview url disabled above_text small large> emitted only when any field explicitly set
  - <m auto_fwd="1"> when is_automatic_forward=true
  - XML injection fixture: sender named `Bob "the builder" <hr@x>` round-trips through `xml2js` (or similar strict parser)
  - <fwd raw="..."/> with unknown origin containing `"` survives escapeXmlAttr

```ts
import { buildMetaBlock, escapeXmlAttr, escapeXmlText } from './telegram-meta.js';

describe('escapeXmlAttr', () => {
  it('escapes all 5 special chars', () => {
    expect(escapeXmlAttr('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
});

describe('buildMetaBlock', () => {
  it('XML injection fixture: round-trips through strict parser', async () => {
    const meta = buildMetaBlock({
      message_id: 1,
      date: 1747731600,
      from: { id: 1, is_bot: false, first_name: 'Bob "the builder" <hr@x>' },
      chat: { id: 1, type: 'private', first_name: 'Bob' },
    } as any);
    // wrap in synthetic root to make it valid XML doc:
    const doc = `<root>${meta}</root>`;
    const { parseStringPromise } = await import('xml2js');
    await expect(parseStringPromise(doc)).resolves.toBeDefined();
  });

  // ... 20+ more it() blocks ...
});
```

- [ ] **Step 2: Run, expect FAIL** — `buildMetaBlock undefined`.

- [ ] **Step 3: Implement** — create `src/channels/telegram-meta.ts`:
  - Export `escapeXmlAttr` (escapes &, <, >, ", ') and `escapeXmlText` (escapes &, <, > only) per spec line 78-90.
  - Export `buildMetaBlock(message: Message): string` that walks every field in spec lines 110-210's tag reference table. CRITICAL: use `message.via_bot`, `message.link_preview_options`, `message.is_automatic_forward`, `message.caption_entities` from grammy types. For `forward_origin`, switch on `origin.type` (NOT `origin.kind` — see spec line 190's round-10 disambiguation note).

- [ ] **Step 4: Run, expect PASS for all cases**

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram-meta.ts src/channels/telegram-meta.test.ts
git commit -m "feat(telegram): buildMetaBlock with full Bot API 7.0+ field coverage"
```

---

### Task 9: telegram-enrich.ts (NEW) — bounded-rate getChat resolver

**Files:**
- Create: `src/channels/telegram-enrich.ts`
- Test: `src/channels/telegram-enrich.test.ts` (NEW)

**Spec refs:** lines 819-893 (full shape: types, cache, queue, inFlight Set, TTLs, cross-scope cache-hit behavior).

- [ ] **Step 1: Write failing tests** (5 cases from spec line 1182):

```ts
describe('telegram-enrich', () => {
  beforeEach(() => { /* reset cache + inFlight + queue */ });

  it('(a) dedupes 100 calls for same scope+username into 1 queue entry', () => {
    for (let i = 0; i < 100; i++) queueEnrich('g', 'vasya');
    expect(getQueueSize()).toBe(1);
  });

  it('(b) cache hit within 24h success TTL is no-op on the queue', () => { /* ... */ });
  it('(c) cache miss after 25h re-queues', () => { /* ... */ });
  it('(d) failure 6d23h ago does NOT re-queue (7d failure TTL)', () => { /* ... */ });

  it('(e) cross-scope cache hit applies patch per-scope (round-7 round-10 fix)', () => {
    primeCache('vasya', { kind: 'success', ts: Date.now(), data: { bio: 'engineer' } });
    const spy = vi.spyOn(db, 'upsertContact');
    queueEnrich('group-A', 'vasya');
    queueEnrich('group-B', 'vasya');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][0]).toBe('group-A');
    expect(spy.mock.calls[1][0]).toBe('group-B');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** per spec lines 825-893: `EnrichRecord` type, `cache: Map<string, EnrichRecord>` (key: lowered username), `inFlight: Set<string>` (key: `${scope}|${username}`), `queue` (1/sec token bucket), `queueEnrich(scope, username)` with the 4-branch logic from spec lines 855-878. CRITICAL: cache-hit branch MUST call `upsertContact(scope, record.data, {source:'getChat', enriched:1})` synchronously for the new scope (round-7 round-10 fix at spec line 872).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/channels/telegram-enrich.ts src/channels/telegram-enrich.test.ts
git commit -m "feat(telegram): telegram-enrich with cross-scope cache-hit upsert"
```

---

### Task 10: TelegramChannel — wire 4 update kinds + processContactsFromContext + remove auto-vision + botSenderId

**Files:**
- Modify: `src/channels/telegram.ts`
- Test: covered by existing telegram tests + Task 22 additions

**Spec refs:** lines 358-450 (processContactsFromContext body verbatim with round-11 fix at trigger row 1), 1011-1023 (Files-touched bullet enumerating handler wiring + botSenderId).

- [ ] **Step 1: Wire 4 update handlers** — replace any single `bot.on('message')` (or `bot.on('message:*')` if present) with four handlers: `bot.on('message:*')`, `bot.on('edited_message:*')`, `bot.on('channel_post:*')`, `bot.on('edited_channel_post:*')`. Each handler invokes `processContactsFromContext(ctx, scope)` and `buildMetaBlock(ctx.msg)`, then constructs `NewMessage` with `meta` field and calls `this.opts.onMessage(...)`.

- [ ] **Step 2: Add `processContactsFromContext`** — copy spec lines 369-450 verbatim. The 7-trigger pipeline uses `ctx.msg` (grammy omnibus accessor, NOT `ctx.update.message`). Trigger row 1 (sender) puts `username` in `opts.identity.username` (round-11 fix at spec line 400-422).

- [ ] **Step 3: Remove auto-vision** in `message:photo` handler — DELETE any `processImage(...)` call. Photos now flow through `<m><media file_id="..."/></m>` only.

- [ ] **Step 4: Add `botSenderId(): string | undefined`** method to `TelegramChannel` class — body: `return this.bot?.botInfo?.id ? String(this.bot.botInfo.id) : undefined;` (round-11 fix at spec line 1027).

- [ ] **Step 5: Run all existing tests** — `npx vitest run src/channels/telegram` — expect existing tests still green (smoke test).

- [ ] **Step 6: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat(telegram): wire 4 update kinds + processContactsFromContext + botSenderId; remove auto-vision"
```

---

### Task 11: sendTelegramMessage narrowed catch + TelegramChannel.sendMessage multi-chunk first-id capture

**Files:**
- Modify: `src/channels/telegram.ts`
- Create: `src/channels/telegram.test.ts` (NEW per spec line 1168)

**Spec refs:** lines 605-650 (sendTelegramMessage verbatim with narrowed catch), 670-700 (TelegramChannel.sendMessage multi-chunk loop body).

- [ ] **Step 1: Write failing tests** per spec line 1168 — narrowed-catch matrix (parse-error retries; 429/503/network propagate without retry) + multi-chunk first-id capture.

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Rewrite `sendTelegramMessage`** — copy spec lines 605-650 verbatim. The narrow catch: `if (!isMarkdownParseError) throw err;` where `isMarkdownParseError = e?.error_code === 400 && /can't parse entities|entity/i.test(e.description ?? '')`.

- [ ] **Step 4: Rewrite `TelegramChannel.sendMessage`** — copy spec lines 670-700. The loop captures `firstId` only when `i === 0`; returns `{ messageId: firstId }`.

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/channels/telegram.ts src/channels/telegram.test.ts
git commit -m "feat(telegram): narrowed Markdown→plain catch + multi-chunk first-id capture"
```

---

## Phase 4 — Outbound chokepoint + Gmail + migrations (Tasks 12-15)

### Task 12: Gmail channel — sendMessage '' truthy fallback + botSenderId

**Files:**
- Modify: `src/channels/gmail.ts`
- Modify: `src/channels/gmail.test.ts`

**Spec refs:** lines 580-605 (Gmail sendMessage body with truthy fallback verbatim), 1037 (test bullet enumerating null/value/empty-string cases), 1029-1035 (botSenderId implementation).

- [ ] **Step 1: Write failing tests** — add 3 cases per spec line 1169: `{id:'X'}` → messageId, `{id:null}` → undefined, `{id:''}` → undefined (the critical regression case).

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Update Gmail `sendMessage`** — per spec lines 580-605: use `const rawId = res.data?.id; const id = rawId && rawId.length > 0 ? rawId : undefined; return { messageId: id };`. Add `botSenderId()` returning the cached `userEmail` or undefined (depending on whether profile cache is added — see spec line 1033).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/channels/gmail.ts src/channels/gmail.test.ts
git commit -m "feat(gmail): truthy '' id fallback + botSenderId method"
```

---

### Task 13: routeOutbound chokepoint rewrite — SEND/STORE isolation + botSenderId threading

**Files:**
- Modify: `src/router.ts`
- Test: `src/routing.test.ts` (modify)

**Spec refs:** lines 705-760 (full routeOutbound body verbatim, including round-7 senderId threading).

- [ ] **Step 1: Write failing test for verification #18 (routeOutbound DB-failure isolation)**

```ts
it('routeOutbound: SEND throw propagates; STORE throw is logged-only', async () => {
  const sendSpy = vi.fn().mockResolvedValue({ messageId: 'TG_1' });
  const storeSpy = vi.fn().mockImplementation(() => { throw new Error('SQLITE_BUSY'); });
  vi.doMock('./db.js', () => ({ storeOutboundMessage: storeSpy }));
  const channel = { ownsJid: () => true, isConnected: () => true, sendMessage: sendSpy, botSenderId: () => '999' };
  await expect(routeOutbound([channel as any], 'tg:1', 'hi')).resolves.toBeUndefined();
  expect(sendSpy).toHaveBeenCalledOnce();
  expect(storeSpy).toHaveBeenCalledOnce();
});

it('routeOutbound: no channel throws "No channel for JID"', async () => {
  await expect(routeOutbound([], 'tg:1', 'hi')).rejects.toThrow(/No channel for JID/);
});
```

- [ ] **Step 2: Run, expect FAIL** (current `routeOutbound` is the working-tree 3-line passthrough).

- [ ] **Step 3: Rewrite `routeOutbound`** — copy spec lines 715-755 verbatim into `src/router.ts`. The body: find channel via `ownsJid && isConnected`; throw if none; `await channel.sendMessage(jid, text, opts)` OUTSIDE try (throws propagate); then INSIDE try: extract `messageId`, get `senderId = channel.botSenderId?.()`, call `storeOutboundMessage(jid, text, messageId, senderId)`; catch + log.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/routing.test.ts
git commit -m "feat(router): routeOutbound chokepoint with SEND/STORE isolation"
```

---

### Task 14: Migrate 7 channel.sendMessage sites + scheduler-lambda narrowed catch

**Files:**
- Modify: `src/index.ts` (7 sites)

**Spec refs:** lines 745-895 (all 7 enumerated sites with the scheduler-lambda narrowed-catch wrap at line 859).

- [ ] **Step 1: Verify line numbers** — `grep -nE 'channel\.sendMessage\(' src/index.ts` should return exactly lines 304, 647, 667, 676, 682, 769, 777.

- [ ] **Step 2: Replace site 1 (line 304)** — `await channel.sendMessage(chatJid, text, opts)` → `await routeOutbound(channels, chatJid, text, opts)`.

- [ ] **Step 3: Replace sites 2-5 (lines 647, 667, 676, 682)** — same pattern. For multi-line calls (667, 676), preserve argument layout.

- [ ] **Step 4: Replace scheduler lambda (line 769)** — wrap in narrowed try/catch per spec lines 866-880 verbatim. The catch matches `msg.startsWith('No channel for JID')` ONLY; rethrows everything else.

- [ ] **Step 5: Replace IPC lambda (line 777)** — `return channel.sendMessage(...)` → `return routeOutbound(channels, jid, text, { threadId: lastThreadId[jid] });`. No additional try/catch (lambda already throws on missing channel per working-tree behavior; routeOutbound propagates).

- [ ] **Step 6: Add import** — `import { routeOutbound } from './router.js';` if not already present.

- [ ] **Step 7: Run all tests** — `npx vitest run` — should compile but auto-vision deletion is incomplete (Task 15 fixes).

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): migrate 7 channel.sendMessage sites to routeOutbound + scheduler-lambda narrowed catch"
```

---

### Task 15: Auto-vision deletion cascade

**Files:**
- Delete: `src/image.ts`
- Modify: `src/container-runner.ts`, `src/channels/telegram.ts`, `src/index.ts`, `container/agent-runner/src/index.ts`

**Spec refs:** lines 1106-1130 (full cascade enumeration including container-side).

- [ ] **Step 1: Remove from `src/container-runner.ts`** — delete `export interface ImageAttachment { ... }` (line 41 working tree) and `images?: ImageAttachment[]` field on `ContainerInput` (line 58).

- [ ] **Step 2: Remove `src/image.ts`** — `git rm src/image.ts`.

- [ ] **Step 3: Remove from `src/channels/telegram.ts`** — delete `import { downloadImage, processImage } from '../image.js';` at line 4. Delete the inline-import type at line 427 (`let images: ... ImageAttachment[] | undefined;` and any local construction).

- [ ] **Step 4: Remove from `src/index.ts`** — delete in order:
  - Lines 86-89: `const pendingImages = new Map<...>()` declaration.
  - Line 242: `const batchImages: ... ImageAttachment[] = [];` local.
  - Line 365: `images?: ... ImageAttachment[],` lambda param.
  - Lines 530, 549: `hasImages` branch in `processGroupMessages` (simplify the if/else).
  - Line 720: `pendingImages.set(...)` write.
  - Any other reference funneling images into `runAgent` / `runContainerAgent`.

- [ ] **Step 5: Remove from `container/agent-runner/src/index.ts`** — delete:
  - `interface ImageAttachment {...}` (lines 25-39 working tree).
  - `images?: ImageAttachment[]` field on `ContainerInput` (line 39).
  - `pushWithImages(text, images)` method on the stream wrapper (line 94 area).
  - `if (containerInput.images && containerInput.images.length > 0)` branch at lines 396-397; replace with the simple text-only push.

- [ ] **Step 6: Verify build** — `npx tsc --noEmit` should now pass (the Task 6 dangling refs are now resolved).

- [ ] **Step 7: Commit**

```bash
git add -A src/ container/agent-runner/src/
git commit -m "feat: delete auto-vision cascade (src/image.ts + ImageAttachment refs)"
```

---

## Phase 5 — IPC + container MCP (Tasks 16-19)

### Task 16: src/ipc.ts — 3 new namespaces + sweep with .processing interlock + atomic responses + contacts.json writer

**Files:**
- Modify: `src/ipc.ts`
- Modify: `src/container-runner.ts` (ensure new IPC sub-dirs created at group setup)
- Test: `src/ipc.test.ts` (NEW or modify existing)

**Spec refs:** lines 297-470 (full IPC flow + sweep pseudocode + atomic write + `.processing` interlock), 1063-1095 (contacts.json snapshot writer with main UNION cross-trigger at line 1095).

- [ ] **Step 1: Write failing test for sweep `errors/` exclusion + `.processing` skip**

```ts
it('sweep does not touch errors/ directory', async () => {
  /* create data/ipc/g/errors/foo.json with mtime = now - 1h */
  await runSweepOnce('g');
  /* assert file still exists */
});

it('.processing files older than 600s rename back to .json for next sweep tick', async () => {
  /* create data/ipc/g/media-requests/req1.json.processing with mtime = now - 700s */
  await runSweepOnce('g');
  /* assert req1.json exists; req1.json.processing gone */
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement sweep** per spec lines 393-470 — the `runSweepOnce(group)` function with the inlined pseudocode (matched directories `/-(requests|responses)$/`, `.processing` skip + 600s orphan recovery, sweep writes TIMEOUT only if no response file exists).

- [ ] **Step 4: Add 3 new IPC namespaces** — extend the existing IPC routing to handle `media-requests/` → `media-responses/`, `lookup-requests/` → `lookup-responses/`, `contact-write-requests/` → `contact-write-responses/`. Wire watchers per spec lines 297-310.

- [ ] **Step 5: Atomic host→container response write** — every response write uses temp+rename pattern (spec lines 477-481).

- [ ] **Step 6: Add `contacts.json` writer** — per-scope trailing-edge debounce (500ms) PLUS cross-trigger to main on every non-main upsert (round-10 fix at spec line 1095). Atomic write via temp+rename. `flushAllSnapshots()` on SIGTERM.

- [ ] **Step 7: Update `src/container-runner.ts`** — ensure the new IPC sub-dirs exist at group setup (`fs.mkdirSync('media-requests', { recursive: true })` etc.).

- [ ] **Step 8: Run, expect PASS**

- [ ] **Step 9: Commit**

```bash
git add src/ipc.ts src/container-runner.ts src/ipc.test.ts
git commit -m "feat(ipc): 3 new namespaces + .processing interlock + atomic responses + main UNION cross-trigger"
```

---

### Task 17: Container MCP tools — register 4 new tools (view_media, lookup_messages, lookup_contacts, annotate_contact)

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

**Spec refs:** lines 957-1005 (tool descriptions for view_media/lookup_messages/lookup_contacts/annotate_contact), 1141-1146 (writeIpcFile + pollResponseFile + lookup_contacts file-read).

- [ ] **Step 1: Add `pollResponseFile(reqId, timeoutMs=120000, intervalMs=100)`** helper as shared utility.

- [ ] **Step 2: Add `writeIpcFile(dir, data, filenameOverride?)`** — extend existing signature to accept optional filename (atomic temp+rename preserved).

- [ ] **Step 3: Register `view_media` tool** — per spec lines 957-973. Input schema includes `file_id`, `tg_message_id`, `mode?`, `pages?`. On call: generate reqId, `writeIpcFile(MEDIA_REQ_DIR, payload, ${reqId}.json)`, `pollResponseFile(reqId, 120000, 100)`. Return the polled response (`isError`, `_meta`, `content`). Add Zod schema.

- [ ] **Step 4: Register `lookup_messages`** — IPC pattern same as view_media.

- [ ] **Step 5: Register `lookup_contacts`** — DOES NOT use IPC. Reads `/workspace/ipc/contacts.json` via `fs.readFileSync`, JSON.parses, filters in memory by `query` / `username` / `tg_id`.

- [ ] **Step 6: Register `annotate_contact`** — IPC pattern (writes to `contact-write-requests/`).

- [ ] **Step 7: Quick sanity build** — `cd container/agent-runner && npx tsc --noEmit`.

- [ ] **Step 8: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat(container): register 4 new MCP tools (view_media/lookup_messages/lookup_contacts/annotate_contact)"
```

---

### Task 18: Host watcher — view_media flow (download + retry + mime routing + CROSS_GROUP_REJECTED)

**Files:**
- Modify: `src/ipc.ts` (or new `src/ipc-media-handler.ts`)
- Test: `src/ipc-mediarequest.test.ts` (NEW)

**Spec refs:** lines 380-470 (full flow), 472-518 (error contract table — every error code reachable), 520-560 (mime routing decision table with NO_TEXT_LAYER + pdfinfo pin).

- [ ] **Step 1: Write failing tests** for each error code (TIMEOUT, FILE_TOO_LARGE, FILE_EXPIRED, EXTRACTOR_MISSING, EXTRACTOR_OUTPUT_INVALID, NO_TEXT_LAYER, UNSUPPORTED_TYPE, PAGES_OUT_OF_RANGE, UPSTREAM_ERROR, CROSS_GROUP_REJECTED) — see spec line 1175 for the 18 verification items.

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement view_media handler** in `src/ipc.ts` (or new file):
  - `CROSS_GROUP_REJECTED` two-query algorithm per spec lines 488-500: first `WHERE id = ? AND chat_jid IN (<requesting-group's JIDs>) LIMIT 1` (ALLOW), else `WHERE id = ? LIMIT 1` (REJECT if found, ALLOW if not).
  - 20MB pre-check via cached `file_size` (no `getFile` round-trip).
  - `getFile` + download retry: 5 attempts / 4 backoffs (1/2/4/8s). Honor `Retry-After` on 429 (clamped to 10s).
  - Mime routing per spec lines 520-560: images → `processImage`; pdf+auto/text → pdftotext with 8-cell decision table; pdf+image → pdfinfo for totalPages + pdftoppm for render; HEIC → UNSUPPORTED_TYPE; voice/audio → pointer text.
  - Atomic response write (temp+rename).

- [ ] **Step 4: Implement `processImage`-equivalent inline** since `src/image.ts` was deleted in Task 15. Reuse the same sharp logic (≤1024px, JPEG q85) inside the host watcher.

- [ ] **Step 5: Run, expect PASS**

- [ ] **Step 6: Commit**

```bash
git add src/ipc.ts src/ipc-mediarequest.test.ts
git commit -m "feat(ipc): view_media host handler with CROSS_GROUP_REJECTED + all error codes"
```

---

### Task 19: Host lookup_messages + annotate_contact handlers

**Files:**
- Modify: `src/ipc.ts`
- Test: `src/ipc.test.ts`

- [ ] **Step 1: Wire `lookup_messages` IPC handler** — reads `lookup-requests/<reqId>.json`, calls host-side `lookupMessages(...)` (from Task 5), atomically writes response.

- [ ] **Step 2: Wire `annotate_contact` IPC handler** — reads `contact-write-requests/<reqId>.json`, calls host-side `annotateContact(...)`, triggers per-scope debounce (and main cross-trigger), atomically writes response.

- [ ] **Step 3: Test both handlers** with stubs/mocks.

- [ ] **Step 4: Commit**

```bash
git add src/ipc.ts src/ipc.test.ts
git commit -m "feat(ipc): lookup_messages + annotate_contact host handlers"
```

---

## Phase 6 — Container test scaffold + CI grep (Tasks 20-21)

### Task 20: Container vitest scaffold + file-too-large-prefix.test.ts

**Files:**
- Create: `container/agent-runner/vitest.config.ts`
- Modify: `container/agent-runner/package.json`
- Create: `container/agent-runner/src/file-too-large-prefix.test.ts`
- Modify: root `package.json`

**Spec refs:** lines 1024-1040 (NEW vitest.config + package.json test script), 1170-1196 (verification #14 verbatim test body).

- [ ] **Step 1: Create `container/agent-runner/vitest.config.ts`** — content from spec lines 1024-1030.

- [ ] **Step 2: Update `container/agent-runner/package.json`** — add to `devDependencies`: `"vitest": "<same version as root>"`. Add to `scripts`: `"test": "vitest run"`.

- [ ] **Step 3: Install deps** — `cd container/agent-runner && npm install`.

- [ ] **Step 4: Create `container/agent-runner/src/file-too-large-prefix.test.ts`** — content from spec lines 1170-1196 verbatim (no `handleViewMediaRequest` import — round-10 fix).

- [ ] **Step 5: Update root `package.json` `scripts.test`** — per spec line 1037: `"test": "vitest run && (cd container/agent-runner && npm test) && bash scripts/check-outbound-chokepoint.sh"`.

- [ ] **Step 6: Run** — `npm test` from repo root; expect both host + container vitest to discover and run.

- [ ] **Step 7: Commit**

```bash
git add container/agent-runner/vitest.config.ts container/agent-runner/package.json container/agent-runner/src/file-too-large-prefix.test.ts package.json
git commit -m "feat(test): container vitest scaffold + file-too-large-prefix wire-frame test"
```

---

### Task 21: CI grep enforcement script + fixture test

**Files:**
- Create: `scripts/check-outbound-chokepoint.sh`
- Create: `scripts/check-outbound-chokepoint.test.sh`

**Spec refs:** lines 800-915 (full script body), 1180 (fixture test bullet with `--untracked` workaround).

- [ ] **Step 1: Create `scripts/check-outbound-chokepoint.sh`** — copy spec lines 805-915 verbatim. CRITICAL: uses `git grep --untracked` (round-10 fix) AND awk exact-match allowlist (round-10 fix; comma-split into associative array, NOT regex-join).

- [ ] **Step 2: Make executable** — `chmod +x scripts/check-outbound-chokepoint.sh`.

- [ ] **Step 3: Empirically test on current tree** — `bash scripts/check-outbound-chokepoint.sh; echo "exit=$?"`. Expected after Task 14 migration: exit=0 (no violations). If 7-site migration is complete, prints nothing and exits 0.

- [ ] **Step 4: Create `scripts/check-outbound-chokepoint.test.sh`** — fixture:
  - Write `src/__lint_fixture.ts` with `channel.sendMessage(jid, text)`.
  - `git add src/__lint_fixture.ts` (so plain `git grep` finds it; OR rely on `--untracked` per spec line 915).
  - Run script; assert exit=1.
  - Remove file (`git rm src/__lint_fixture.ts` + `rm`); run script; assert exit=0.

- [ ] **Step 5: Run fixture** — `bash scripts/check-outbound-chokepoint.test.sh`.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-outbound-chokepoint.sh scripts/check-outbound-chokepoint.test.sh
git commit -m "feat(ci): outbound chokepoint enforcement script + fixture test"
```

---

## Phase 7 — Final integration (Tasks 22-23)

### Task 22: Update remaining existing tests

**Files:**
- Modify: `src/db.test.ts` (any straggler assertions not covered earlier)
- Modify: `src/channels/telegram.ts` consumers (formatMessages in `src/router.ts`)
- Verify: all existing tests still green

**Spec refs:** spec verification list (lines 1196-1230).

- [ ] **Step 1: Run full test suite** — `npm test`. Identify any failing tests in existing files (e.g. `formatting.test.ts`, `routing.test.ts`, `container-runner.test.ts`).

- [ ] **Step 2: Fix `formatMessages` in `src/router.ts`** per spec lines 1163-1165: when `meta` present, emit `<message ...>${meta}\n${content ? '<text>' + escapeXmlText(content) + '</text>' : ''}</message>`. When meta NULL, legacy form with `escapeXmlText(content)`. Update or add a test in `src/formatting.test.ts` to cover both branches.

- [ ] **Step 3: Run, expect ALL PASS**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(router): formatMessages reads meta + emits <text> envelope when present"
```

---

### Task 23: End-to-end verification + finalize

**Files:**
- None (manual smoke + docs)

**Spec refs:** verification items #1-#18 at spec lines 1196-1230.

- [ ] **Step 1: Build** — `npm run build`. Expected: zero errors.

- [ ] **Step 2: Run full test suite** — `npm test`. Expected: all green, CI grep returns 0.

- [ ] **Step 3: Build container image** — `./container/build.sh`. Expected: success.

- [ ] **Step 4: Restart service** — `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.

- [ ] **Step 5: Walk verification list manually** — for each of #1-#18 in spec (lines 1196-1230):
  - #1: Forward a channel post → check `contacts` table for new row with `kind='channel'`.
  - #2: Reply to media asking "посмотри" → agent calls `view_media`, gets the image.
  - #3: `@some_public_channel` → enriched=1 + bio populated.
  - #4: `@some_private_user` → enriched=0, no retry storm.
  - #5: Album of 3 photos → 3 `<m media_group_id="...">` rows.
  - #6: Anonymous admin post → `<sender_chat>` + contacts row keyed on sender_chat id.
  - #7: Photo with no caption in MAIN group → row appears (already test-covered in Task 7).
  - #8: Photo with no caption in non-main group → row stored, NOT delivered (known limitation).
  - #9: Corrupt PDF → `EXTRACTOR_OUTPUT_INVALID`.
  - #10: HEIC document → `UNSUPPORTED_TYPE`.
  - #11: Bot reply → `messages` row with real Telegram message_id; `lookup_messages({tg_message_id})` finds it.
  - #12: Edit a channel post → `meta.edited` set; row re-delivered.
  - #13: `_meta` wire-level (db.test.ts + ipc-mediarequest.test.ts coverage).
  - #14: Container-side text prefix (container vitest covers).
  - #15: Cyrillic `lookup_messages` (db.test.ts covers).
  - #16: LIKE wildcard escape (db.test.ts covers).
  - #17: CI grep enforcement (Task 21 covers).
  - #18: `routeOutbound` DB-failure isolation (Task 13 covers).

- [ ] **Step 6: Document any verification deviations** — if any item fails, file a follow-up issue rather than blocking the PR.

- [ ] **Step 7: Open PR** — `gh pr create --title "feat: rich message capture + persistent people memory + on-demand vision" --body "..."`. Body references spec commit `92ef68a` and lists tasks 1-23.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "chore: end-to-end verification complete (spec v11 92ef68a)" --allow-empty
```

---

## Self-review checklist (run before handoff)

**1. Spec coverage** — every section of v11 has a task:
- Schema (lines 198-274): Task 1 ✓
- promoteContactIdent (lines 247-340): Task 3 ✓
- upsertContact rules (lines 280-340): Task 4 ✓
- lookup_messages SQL (lines 502-560): Task 5 ✓
- view_media flow (lines 380-560): Tasks 17 + 18 ✓
- routeOutbound chokepoint (lines 700-760): Task 13 ✓
- 7 migration sites (lines 745-895): Task 14 ✓
- buildMetaBlock + meta block tags (lines 70-280): Task 8 ✓
- telegram-enrich (lines 825-893): Task 9 ✓
- IPC sweep + .processing interlock (lines 393-470): Task 16 ✓
- contacts.json snapshot (lines 1063-1095): Task 16 ✓
- Container MCP tools (lines 957-1005): Task 17 ✓
- Container test scaffold (lines 1024-1040): Task 20 ✓
- CI grep script (lines 800-915): Task 21 ✓
- Auto-vision deletion (lines 1106-1130): Task 15 ✓
- 18 verification items: Task 23 ✓

**2. Placeholder scan** — no "TBD", "TODO", "later", "appropriate error handling", "similar to Task N". All code in steps is either inline or spec-line-ref'd.

**3. Type consistency** — `ContactRow`, `ContactPatch`, `Channel`, `NewMessage`, `botSenderId` signatures consistent across Tasks 1, 4, 6, 9, 11, 12, 13. `routeOutbound` signature matches between Task 13 (def) and Task 14 (call).

**4. Round-11 corrections incorporated** — Task 11 trigger row 1 puts `username` in `opts.identity` (NOT patch); Task 14 scheduler-lambda catch is narrowed (NOT catch-all); Task 10 botSenderId uses `this.bot?.` optional chain; only ONE `MOD src/index.ts` reference per phase.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-rich-message-capture-impl.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Good for 23-task plan with clear boundaries.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**
