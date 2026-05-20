# Rich Message Capture + Persistent People Memory + On-Demand Vision

Design spec for letting the NanoClaw agent operate on the full data of every Telegram message it receives — including forward origin, mentioned/forwarded people, reply targets, and media — with a passive long-term contacts memory and on-demand media access.

> **Revision history**
> - **v5 (2026-05-20, after round 4 critical review)** — addresses ~23 v4 defects. Headline fixes: full SELECT projection shown verbatim (not just prose); CI script body inlined in spec; `storeOutboundMessage` isolation (DB error no longer corrupts message-loop cursor); explicit `String(message_id)` for grammy + `?? undefined` for Gmail null; `LIKE … ESCAPE` clause + user-query sanitization; verification #14 rewritten as Anthropic-API-intercept (not SDK wire); verification #7 spelled out as explicit `expect`; `include_bot` semantics pinned; `mergeContactRows` notes rule disambiguated; `lookup_messages` full SQL shown; contact IPC dir renamed for sweep-glob consistency.
> - v4 (2026-05-20, commit `1110ef7`) — addressed 24 v3 defects. Round 4 found 23 more (most polish; one real correctness bug class — LIKE wildcards).
> - v3 (2026-05-20, commit `b923090`) — addressed 25 v2 defects.
> - v2 (2026-05-20, commit `f9036ad`) — addressed 41 v1 defects.
> - v1 (2026-05-20, commit `ea6a614`) — two showstoppers.

## Context

Today the Telegram channel collapses each incoming message into a short human-readable string prefix (`[Forwarded from X]`, `[Reply to Y: "..."]`) plus the message text. Most actionable fields are dropped: sender username and id, forward-origin id/username/link, reply target's media file_id, message entities (urls/mentions), Bot API 7.0 quotes, vCard contacts, locations. Forward author is a name string only — the agent can't actually contact them later.

Media handling is the opposite problem: every `message:photo` is downloaded and base64-injected into the prompt automatically, whether the user wanted vision or not. Other media types (image documents, stickers, video, PDFs) only land as `[Document: ...]` placeholders.

The user wants the bot to:
1. Operate on as much message data as possible.
2. Remember forward authors (and other people seen) durably — across restarts and context compaction — so requests like "напиши тому-то / запишись туда-то" have something to act on.
3. Use a side-tool to actually act, or DM directly when Telegram allows.
4. Process replies and forwards-with-instructions ("посмотри"), and process documents (PDF text extraction), but only put media into vision when explicitly asked — not by default.
5. Have access to the full chat history and to walk reply chains.

## Behavior changes (summary)

- Every inbound Telegram message attaches a single machine-readable XML block (`<m>...</m>`) to its delivery — **stored in a new `messages.meta` column, NOT interleaved into `content`**. The legacy `[Forwarded from ...]` / `[Reply to ...]` string prefixes are removed. `content` keeps only the user's raw text.
- The existing message-loop filter `WHERE content != '' AND content IS NOT NULL` in `getNewMessages`/`getMessagesSince` is relaxed; the **full new WHERE clause AND the full SELECT projection** are shown verbatim in the SQL section below.
- `formatMessages` emits the metadata block **without `escapeXml`-ing it** (we control the block's content) alongside the user text in a `<text>` child (escaped, optional). The `<text>` tag is emitted only when content is non-empty.
- Auto-vision is removed. Photos are no longer base64-inlined into the prompt. Media (any type) is represented in the structured block by its Telegram `file_id`; the agent calls `view_media` only when the user asks.
- A new SQLite table `contacts` holds a deterministic, per-group log of everyone the bot has seen.
- The agent gets four new MCP tools: `lookup_contacts`, `annotate_contact`, `view_media`, `lookup_messages`. Errors return as MCP tool errors with structured diagnostic data on **top-level `CallToolResult._meta`** (verified by tracing Anthropic agent SDK's `cli.js` — only top-level `D._meta` is read; `content[N]._meta` is silently dropped). The `text` field of the result content carries `<error_code>: <human message>` as the canonical model-facing signal.
- Standard non-business Telegram update kinds wired: `message`, `edited_message`, `channel_post`, `edited_channel_post`. Business updates (`business_message`, `edited_business_message`) out of scope.
- File and IPC isolation remain group-scoped.
- Outbound bot text flows through a single chokepoint `routeOutbound` in `src/router.ts`. Every direct `channel.sendMessage` call site is rewritten (7 sites enumerated). A CI script enforces the chokepoint.

## Structured message block

Format: a single `<m>` element in the new `messages.meta` column. `formatMessages` emits:

```
<message sender="..." time="...">
<m id="123" date="2026-05-20T10:00:00Z" ...>  ← from messages.meta, NOT escaped
  ...
</m>
<text>escaped user text</text>                  ← from messages.content, escaped; OMITTED when empty
</message>
```

When `messages.meta` is NULL (pre-migration rows): emit legacy `<message sender="..." time="...">${escapeXml(content)}</message>` — no `<text>` envelope, no `<m>`.

```
<m id="123" date="2026-05-20T10:00:00Z" media_group_id="42" edited="2026-05-20T10:01:00Z">
  <from id="222222222" un="vasya" name="Вася" is_bot="0" premium="1" lang="ru"/>
  <sender_chat id="-1001..." kind="channel" un="durov" title="Durov"/>
  <fwd kind="channel" chat_id="-1001..." un="durov" title="Durov"
       sig="Pavel" orig_date="2026-05-01T..." orig_msg_id="123"
       link="https://t.me/durov/123"/>
  <reply external="0" mid="120" from_id="999" un="petya" name="Петя" is_bot="0"
         snippet="первые ≤500 символов">
    <media type="photo" file_id="AgAC..." mime="image/jpeg" w="1280" h="960"/>
  </reply>
  <reply_to_story chat_id="..." story_id="..."/>
  <quote>фрагмент цитаты</quote>
  <media type="document" file_id="BQAC..." mime="application/pdf" name="report.pdf" size="20480"/>
  <media type="sticker" sticker_kind="regular" file_id="..." mime="image/webp" w="512" h="512" emoji="🐬"/>
  <entities>
    <url>https://example.com</url>
    <mention>target_user</mention>
    <textlink href="https://y.com">текст</textlink>
    <text_mention id="111" un="ivan" name="Иван" is_bot="0"/>
    <custom_emoji id="5368324170671202286"/>
    <hashtag>news</hashtag><cashtag>BTC</cashtag>
    <bot_command>/start@andy_ai_bot</bot_command>
    <phone>+79991234567</phone><email>x@y.com</email>
  </entities>
  <contact phone="+79991234567" name="Иван" user_id="888" vcard_raw="BEGIN:VCARD..."/>
  <location lat="55.75" lon="37.61" title="Кафе" address="ул. Ленина 1"/>
  <poll question="Где встретимся?" type="regular"/>
  <story chat_id="..." story_id="..."/>
</m>
```

Tag reference (all attributes optional unless **req**, all tags except `<m>` omitted when empty):

| Tag | Source (Bot API field on `Message`) | Notes |
|---|---|---|
| `<m>` (req) | the message itself | `id`=message_id; `date`=ISO; `media_group_id` when present; `edited`=ISO of edit (only for `edited_*` updates) |
| `<from>` | `from?: User` | **Skipped when `sender_chat` is set** (Bot API places synthetic GroupAnonymousBot/Channel_Bot in `from`). Detection: `if (message.sender_chat) emit_sender_chat() else if (message.from) emit_from()`. `is_bot` always emitted. |
| `<sender_chat>` | `sender_chat?: Chat` | Replaces `<from>`. |
| `<fwd>` | `forward_origin` (7.0+) | `kind` ∈ {user, hidden_user, chat, channel}. Unknown kinds emit `<fwd kind="unknown" raw="${escapeXml(JSON.stringify(origin))}"/>`. `link` derivable only for `kind='channel'`. |
| `<reply>` | `reply_to_message` OR `external_reply` | `external="0|1"`. External case carries origin attributes + ALL payload tags (`<media>`, `<contact>`, `<location>`, `<poll>`, `<story>`, `<reply_to_story>`). |
| `<reply_to_story>` | `reply_to_story?: Story` | Top-level. |
| `<quote>` (text) | `quote?.text` (7.0+) | |
| `<media>` | `photo`/`video`/`voice`/`audio`/`document`/`sticker`/`animation`/`video_note` | `type`, `file_id` (req), `file_unique_id`, `mime`, `size`, type-specific. Sticker `mime` synthesized: `is_animated` → `application/x-tgsticker`; `is_video` → `video/webm`; else → `image/webp`. `sticker_kind` ∈ {regular, mask, custom_emoji} (orthogonal to format). Photos synthesize `image/jpeg`. |
| `<media transcript=... transcript_status=...>` | voice/video_note | `transcript_status`: `ok` / `failed` / `missing_key` / `skipped`. |
| `<entities>` | `message.entities` | Children: `<url>`, `<mention>`, `<textlink href>text</textlink>`, `<text_mention id un name is_bot/>`, `<custom_emoji id/>`, `<hashtag>`, `<cashtag>`, `<bot_command>`, `<phone>`, `<email>`. Formatting entities dropped. |
| `<contact>` | `message.contact?: Contact` | `phone`, `name`, `user_id`, `vcard_raw`. |
| `<location>` | `message.location` / `message.venue` | `lat`, `lon`, `title`, `address`. |
| `<poll>` | `message.poll?: Poll` | `question`, `type`. Options dropped. |
| `<story>` | `message.story?: Story` | `chat_id`, `story_id`. |

### Handling all four message-update kinds

Bot API delivers four distinct update kinds:
- `message` / `channel_post` — INSERT new row.
- `edited_message` / `edited_channel_post` — INSERT OR REPLACE existing `(id, chat_jid)` row; `meta.edited=<ts>`; `timestamp = max(message.date, edit_date)` so `WHERE timestamp > cursor` re-delivers.

`business_message` / `edited_business_message` (Bot API 7.x Business connections) are **out of scope for v1**.

### Albums (`media_group_id`)

Telegram delivers a multi-photo album as N separate Updates sharing one `media_group_id`. Only the first usually carries the caption. The host writes each as its own `<m media_group_id="...">` row; agent correlates via the shared id.

## Contacts memory

### Schema (SQLite, host-side)

```sql
CREATE TABLE IF NOT EXISTS contacts (
  ident       TEXT PRIMARY KEY,         -- "<scope>|id:<tgId>" | "<scope>|un:<lower>" | "<scope>|name:<lower>"
  scope       TEXT NOT NULL,
  tg_id       TEXT,
  username    TEXT,                     -- lowercased, no '@'
  kind        TEXT NOT NULL,            -- 'user' | 'hidden_user' | 'chat' | 'channel'
  is_bot      INTEGER NOT NULL DEFAULT 0,
  first_name  TEXT, last_name TEXT,
  title       TEXT,
  phone       TEXT,
  link        TEXT,
  bio         TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  seen_count  INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL,            -- 'sender'|'forward'|'reply'|'vcard'|'mention'|'text_mention'|'getChat'
  enriched    INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  tags        TEXT
);
CREATE INDEX IF NOT EXISTS contacts_scope_username ON contacts(scope, username);
CREATE INDEX IF NOT EXISTS contacts_scope_tg_id    ON contacts(scope, tg_id);
```

### Identity resolution and `promoteContactIdent` MERGE

Identity at upsert: prefer `tg_id`; else lowered `username`; else `lowered(first_name+last_name)`.

When a row was first written under `un:` and a later inbound reveals `tg_id`, promote with explicit JS read-merge-write inside a `db.transaction(...)` block:

```ts
function mergeContactRows(idRow: ContactRow | undefined, unRow: ContactRow): ContactRow {
  // id-row authoritative going forward; preserve all agent-authored data;
  // both NULL → NULL; one NULL → take the other; both non-NULL → id-row wins
  // for notes (idempotent for the common case where promotion happens before
  // any annotation on either row), tags → union of comma-separated values.
  const coalesce = <T>(a: T | null | undefined, b: T | null | undefined) =>
    a == null ? b : a;
  const unionTags = (a: string | null, b: string | null) => {
    const set = new Set([...(a || '').split(','), ...(b || '').split(',')].filter(Boolean));
    return set.size ? [...set].join(',') : null;
  };
  return {
    ident:       idRow?.ident ?? unRow.ident,  // caller overwrites with new id-ident
    scope:       unRow.scope,
    tg_id:       coalesce(idRow?.tg_id, unRow.tg_id),
    username:    coalesce(idRow?.username, unRow.username),
    kind:        idRow?.kind ?? unRow.kind,
    is_bot:      idRow?.is_bot ?? unRow.is_bot,
    first_name:  coalesce(idRow?.first_name, unRow.first_name),
    last_name:   coalesce(idRow?.last_name, unRow.last_name),
    title:       coalesce(idRow?.title, unRow.title),
    phone:       coalesce(idRow?.phone, unRow.phone),
    link:        coalesce(idRow?.link, unRow.link),
    bio:         coalesce(idRow?.bio, unRow.bio),
    first_seen:  idRow && idRow.first_seen < unRow.first_seen ? idRow.first_seen : unRow.first_seen,
    last_seen:   idRow && idRow.last_seen  > unRow.last_seen  ? idRow.last_seen  : unRow.last_seen,
    seen_count:  (idRow?.seen_count ?? 0) + unRow.seen_count,
    source:      'forward', // promotion source
    enriched:    Math.max(idRow?.enriched ?? 0, unRow.enriched),
    notes:       coalesce(idRow?.notes, unRow.notes),  // id-row wins when both non-null
    tags:        unionTags(idRow?.tags ?? null, unRow.tags),
  };
}

const promoteContactIdent = db.transaction((scope: string, un: string, tgId: string) => {
  const idIdent = `${scope}|id:${tgId}`;
  const unIdent = `${scope}|un:${un.toLowerCase()}`;
  const idRow = db.prepare('SELECT * FROM contacts WHERE ident = ?').get(idIdent) as ContactRow | undefined;
  const unRow = db.prepare('SELECT * FROM contacts WHERE ident = ?').get(unIdent) as ContactRow | undefined;
  if (!unRow) return;
  const merged = { ...mergeContactRows(idRow, unRow), ident: idIdent };
  db.prepare(/* INSERT OR REPLACE INTO contacts ... VALUES (... bound from merged ...) */).run(/* fields */);
  db.prepare('DELETE FROM contacts WHERE ident = ?').run(unIdent);
});
```

**Notes rule, unambiguous**: `coalesce(idRow.notes, unRow.notes)` — if both are non-null, the id-row's notes win (the id-row is the authoritative future identity; the un-row was an early-observation placeholder). This is a known **data-loss edge** when the agent wrote distinct notes on both rows before promotion; documented in known limitations.

**Tags rule**: union (deduplicated comma-separated values from both rows are preserved).

### Upsert merge semantics (regular path, non-promotion)

`INSERT ... ON CONFLICT(ident) DO UPDATE SET` with explicit per-column rules:

| Column | Conflict rule |
|---|---|
| `first_name`, `last_name`, `title`, `phone`, `link`, `is_bot` | `COALESCE(excluded.X, contacts.X)` |
| `bio` | `COALESCE(excluded.bio, contacts.bio)` — sticky |
| `kind`, `source` | overwrite |
| `enriched` | `MAX(contacts.enriched, excluded.enriched)` |
| `first_seen` | preserved |
| `last_seen` | overwrite |
| `seen_count` | `contacts.seen_count + 1` |
| `notes`, `tags` | **NEVER touched by host** |

### Scope and main-group cross-scope view

Per-group isolation; main group sees UNION (mirrors `src/container-runner.ts:884`'s `isMain` precedent).

### Host upsert rules

Order on every inbound (BEFORE `storeMessage`):

| Trigger | Source |
|---|---|
| `message.from` (when `sender_chat` NOT set) | `sender` |
| `message.sender_chat` | `sender` |
| `forward_origin` or `external_reply` origin | `forward` |
| `reply_to_message.from` or `external_reply` origin author | `reply` |
| `message.contact` | `vcard` |
| `entities[type='text_mention'].user` | `text_mention` |
| `entities[type='mention']` (bare `@username`) | queued for `getChat` enrichment |

`@username` enrichment: best-effort via `getChat`. Bot API only documents this for channels/public supergroups; private users return `Bad Request`. Cache 24h success / 7d failure; token-bucket 1/sec.

## On-demand media (`view_media`)

Container has no Telegram token. Host performs every download via request/response over file IPC.

### Flow

1. Agent reads `file_id` from `<m>`.
2. Agent calls `view_media({ file_id, mode?: 'auto'|'image'|'text', pages?: 'N-M' })`.
3. Tool generates `reqId = "${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}"`, calls `writeIpcFile(MEDIA_REQ_DIR, data, \`${reqId}.json\`)` (v5 keeps the `filenameOverride` parameter from v3), polls `data/ipc/<group>/media-responses/<reqId>.json` via `pollResponseFile(reqId, 120000, 100)`.
4. Host watcher authorizes (request lives in this group's IPC namespace), pre-checks `file_size > 20MB` (`FILE_TOO_LARGE`), `getFile` + download → routes by mime → writes response → unlinks request.
5. Tool reads response.

### Retry, timeout, sweep

- `getFile` + download retry on 429/503/5xx with exponential backoff: **initial + 3 retries = 4 total attempts**, backoffs 1s, 2s, 4s, 8s.
- 120s elapsed → `TIMEOUT`. Host watcher sweeps `media-requests/` on startup and every 5 min: any request file older than 180s gets a `TIMEOUT` response written, then the request is unlinked.
- `media-responses/` files older than 180s unlinked unconditionally.
- **`errors/` is NEVER swept** (operator-review quarantine).
- IPC sweep glob is `*-requests/` and `*-responses/` ONLY (matches the new namespaces below; the existing `errors/` doesn't match either pattern).

### Mime routing (`mode='auto'` default)

| Mime / type | Handling | MCP content |
|---|---|---|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` (incl. static stickers) | `processImage()` (resizes ≤1024px, JPEG q85) | `{type:'image', data, mimeType:'image/jpeg'}` |
| `image/heic`, `image/heif`, `image/tiff` | sharp's prebuilt binary doesn't support HEIC. On throw → `UNSUPPORTED_TYPE` | tool error |
| `application/x-tgsticker`, `video/webm`, `video/mp4`, `video/quicktime` | not downloaded | text descriptor |
| `application/pdf` (`auto`/`text`) | `pdftotext -layout -enc UTF-8 -nopgbrk - -`. **Detection rule**: stdout empty AND stderr matches `/Syntax Error|May not be a PDF file/` → `EXTRACTOR_OUTPUT_INVALID` (AND, not OR — partially-recoverable PDFs with stderr noise but non-empty stdout still return the recovered text). Truncate stdout ≤500KB with `…[truncated]` | `{type:'text', text}` |
| `application/pdf` (`image`, `pages:'N-M'`, default `'1-1'`, cap 10) | `mkdtemp`, write PDF, `pdftoppm -jpeg -r 150 -f N -l M`, read each `<prefix>-K.jpg`, `rm -rf` in `try/finally` | array of `{type:'image', data, mimeType:'image/jpeg'}` |
| `text/*`, JSON/YAML | UTF-8 decode, ≤200KB | `{type:'text', text}` |
| voice/audio (non-image) | transcript in `<m><media transcript=...>` from inbound path | `{type:'text', text:'voice: see message transcript'}` |
| other | not downloaded | `{type:'text', text:'тип X не отображается; <descriptor>'}` |

### Error contract

All errors return as MCP tool errors. Diagnostic data on **top-level `CallToolResult._meta`** (verified by tracing Anthropic agent SDK's `cli.js`: only top-level `D._meta` is read; `content[N]._meta` is silently dropped). The model-facing canonical signal is the `text` prefix:

```json
{ "isError": true,
  "_meta": {
    "error_code": "<CODE>",
    "retryable": true|false,
    "retry_after_ms": <number>
  },
  "content": [{
    "type": "text",
    "text": "<CODE>: <human-readable message>"
  }]
}
```

The model only reads `content[0].text`, so the `<CODE>: ...` prefix is the contract for agent reasoning. `_meta` exists for SDK-side telemetry, tests, and hooks. Tool descriptions tell the agent to parse the text prefix.

| Code | When | `retryable` | `retry_after_ms` |
|---|---|---|---|
| `TIMEOUT` | 120s polling exhausted | true | undefined |
| `UPSTREAM_ERROR` | `getFile` non-retryable error after host retries | true | optional (echoes upstream `Retry-After` on 429) |
| `FILE_TOO_LARGE` | `file_size > 20MB` (pre-flight) | false | — |
| `FILE_EXPIRED` | `getFile` returns "file is too old" | false | — |
| `EXTRACTOR_MISSING` | `pdftotext`/`pdftoppm` not on PATH | false | — |
| `EXTRACTOR_OUTPUT_INVALID` | stdout empty AND stderr indicates corruption | false | — |
| `UNSUPPORTED_TYPE` | mime not in any image/text branch, OR `processImage` failed | false | — |
| `PAGES_OUT_OF_RANGE` | `pages` invalid or exceeds 10 | false | — |
| `AUTH_REJECTED` | request from another group's IPC namespace | false | — |

`retry_after_ms` is **informational only** — the SDK does not honor it automatically; the agent (which only sees the text prefix) cannot consume it directly.

### Reply / forward "посмотри" workflows

Reply to media (in-chat OR `external_reply`) → `<reply><media file_id=.../></reply>` → `view_media(file_id)`. Forward media + own text → top-level `<media>` + `<text>`. Historical media → `lookup_messages` returns `meta` → find `file_id` → `view_media`.

## Conversation access (`lookup_messages`)

### Tool surface

```
lookup_messages({
  tg_message_id?,   sender_id?,
  since?, until?,
  query?,           // substring; case-insensitive on text via lower_unicode; LIKE-escaped before binding
  include_bot?,     // default false. true = ALSO include bot rows (UNION semantics; not "ONLY bot")
  limit?            // default 50; server clamps to [1, 200]
}) -> formatted text including each row's meta + text
```

**`include_bot` semantics (pinned)**: `include_bot=false` (default) → exclude rows where `is_bot_message = 1`. `include_bot=true` → return all rows regardless of `is_bot_message`. NOT "filter inversion" (i.e. `true` ≠ "only bot rows"). Tool description spells this out.

### Full SQL (verbatim)

```sql
SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, meta
FROM messages
WHERE chat_jid IN (<group_jids placeholders>)
  AND (? OR is_bot_message = 0)            -- ? = include_bot 1/0
  AND (? IS NULL OR id = ?)                 -- tg_message_id
  AND (? IS NULL OR sender = ?)             -- sender_id
  AND (? IS NULL OR timestamp >= ?)         -- since
  AND (? IS NULL OR timestamp <= ?)         -- until
  AND (? IS NULL OR lower_unicode(content) LIKE lower_unicode(?) ESCAPE '\')
ORDER BY timestamp DESC
LIMIT ?;
```

Bound params (in order): group_jids…, include_bot (0/1), `tg_message_id`×2, `sender_id`×2, `since`×2, `until`×2, `query`-or-null, **escaped-and-wildcarded query**, clamped limit.

**Query escape and wildcarding (host side, before bind)**:
```ts
function buildQueryParam(q: string | undefined): string | null {
  if (q == null || q === '') return null;
  // Escape SQL LIKE metacharacters with backslash; bind with ESCAPE '\'
  const escaped = q.replace(/[\\%_]/g, '\\$&');
  return `%${escaped}%`;
}
```

A user query of `тратил 50%` becomes literal `%тратил 50\%%` (the trailing `%` survives as wildcard, the inner `%` is escaped — substring matches `тратил 50%` literally as required).

### Case-insensitive search

SQLite's default `LIKE` is ASCII-only-case-insensitive. NanoClaw's primary user writes in Russian.

`db.function` registers a JS callback **before any `db.prepare`** that references it:

```ts
db.pragma('foreign_keys = ON');
db.function('lower_unicode', { deterministic: true }, (s: string | null) =>
  s == null ? null : s.toLowerCase()
);
// ... only AFTER this point may anything `db.prepare` reference `lower_unicode`.
```

`String.prototype.toLowerCase()` is **Unicode-aware** (per ECMA-262 §22.1.3.28, applies `Lowercase_Mapping` from UnicodeData.txt). It correctly lowercases Cyrillic, Greek, accented Latin. It is NOT full Unicode case-folding (`ẞ` → `ß`, not `ss`; Turkish `İ` → `i̇`). For the user's Russian + ASCII use case this is correct; for German/Turkish edge cases it's not. Documented in known limitations.

### Hard caps

`limit` clamped `[1, 200]` server-side. Response body ≤500KB; on truncation append `<truncated count="N"/>`. Empty filters return last 50.

### Outbound storage chokepoint

`include_bot=true` requires bot replies in `messages`. v5 routes ALL outbound through one chokepoint:

#### 1. `Channel.sendMessage` signature widening

In `src/types.ts`:
```ts
sendMessage(jid: string, text: string, opts?: SendMessageOptions):
  Promise<{ messageId?: string } | void>;
```

Backward-compatible. New implementations should return `{messageId?}`. The `| void` retains compatibility with channels that don't capture an id.

#### 2. `sendTelegramMessage` wrapper — exact signature and return rule

`src/channels/telegram.ts`:
```ts
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<{ messageId: string }> {
  let result: Message.TextMessage;
  try {
    result = await api.sendMessage(chatId, text, { ...options, parse_mode: 'Markdown' });
  } catch (err) {
    // Markdown failed (or Telegram rejected). Fall back to plain text.
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    result = await api.sendMessage(chatId, text, options);
    // The plain-text result is the only delivered-and-visible message in this case.
  }
  return { messageId: String(result.message_id) };  // grammy returns number; coerce to string
}
```

Notes on the type coercion: `grammy.api.sendMessage` returns `Message.TextMessage` with `message_id: number` (`@grammyjs/types/message.d.ts:10`). `Channel.sendMessage` returns `messageId: string`. v5 coerces with `String()`. `messages.id TEXT` then receives a numeric string consistently.

#### 3. `TelegramChannel.sendMessage` — multi-chunk capture

```ts
async sendMessage(jid: string, text: string, opts?: SendMessageOptions) {
  // ... existing setup ...
  const chunks = splitForTelegram(text, MAX_LENGTH);
  let firstId: string | undefined;
  let lastErr: unknown;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const r = await sendTelegramMessage(this.bot.api, numericId, chunks[i], options);
      if (i === 0) firstId = r.messageId;
    } catch (err) {
      lastErr = err;
      // Re-throw to outer; caller has the FIRST chunk's id (if captured) via the closure.
      // The throw aborts further chunks; partial-delivery known limitation applies.
      throw err;
    }
  }
  return { messageId: firstId };
}
```

#### 4. Gmail `sendMessage` — handles `id?: string | null`

```ts
async sendMessage(jid: string, text: string, _opts?: SendMessageOptions) {
  // ... existing build of `requestBody` ...
  const res = await this.gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage, threadId },
  });
  // googleapis Schema$Message.id: string | null | undefined
  const id = res.data?.id ?? undefined;  // null → undefined → synthetic-id branch downstream
  return { messageId: id };
}
```

Gmail's `id` is the internal opaque id (NOT RFC-2822 Message-ID — that would require an extra `users.messages.get({format:'metadata', metadataHeaders:['Message-ID']})` round-trip, out of scope for v1).

#### 5. `routeOutbound` (the chokepoint) — isolation of send vs store

`src/router.ts`:
```ts
export async function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  opts?: SendMessageOptions,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  // SEND first — any throw here means the user didn't receive the message; propagate
  // so the caller's streamingSendFailed/cursor-rollback machinery does the right thing.
  const result = await channel.sendMessage(jid, text, opts);
  // STORE in an isolated try — the user already saw the message; a DB error here must
  // NOT propagate, otherwise the caller will roll back the cursor and re-deliver the
  // same agent output on the next poll (user sees duplicates).
  try {
    const messageId =
      result && typeof result === 'object' && 'messageId' in result
        ? (result.messageId ?? undefined)
        : undefined;
    storeOutboundMessage(jid, text, messageId);
  } catch (err) {
    logger.error({ jid, err }, 'storeOutboundMessage failed (message was delivered)');
  }
}
```

The two failure modes are intentionally separated. Caller's existing `try { await routeOutbound(...) } catch { streamingSendFailed = true }` (`src/index.ts:308-313`) only triggers when SEND fails. DB failures are logged-only.

#### 6. `storeOutboundMessage` body

`src/db.ts`:
```ts
export function storeOutboundMessage(jid: string, text: string, channelMessageId?: string): void {
  const id = channelMessageId
    ?? `out-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;  // 16 hex chars
  const timestamp = new Date().toISOString();
  // Same FK pre-check as storeMessage
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time, channel, is_group)
     VALUES (?, NULL, ?, NULL, 0)`,
  ).run(jid, timestamp);
  db.prepare(
    `INSERT OR REPLACE INTO messages
     (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, jid, '', ASSISTANT_NAME, text, timestamp,
        1 /*is_from_me*/, 1 /*is_bot_message*/,
        channelMessageId ? null : `<m kind="outbound-synthetic"/>`);
}
```

#### 7. Migration: seven direct `channel.sendMessage` call sites rewritten

Every existing site is replaced with `routeOutbound(channels, jid, text, opts)`:
- `src/index.ts:304` (streaming output callback in `runAgent`)
- `src/index.ts:647`, `667`, `676`, `682` (remote-control branches in `handleRemoteControl`)
- `src/index.ts:761-771` (the `deps.sendMessage` lambda passed to `startSchedulerLoop`)
- `src/index.ts:773-778` (the `deps.sendMessage` lambda passed to `startIpcWatcher`)

#### 8. CI grep enforcement — actual script

`scripts/check-outbound-chokepoint.sh`:
```bash
#!/usr/bin/env bash
# Fail if any source file outside the allowlist calls channel.sendMessage(...).
# Allowlist: the channel implementations themselves (they DEFINE sendMessage)
# and src/router.ts (the chokepoint that legitimately calls it).
set -euo pipefail

PATTERN='channel\.sendMessage\('
ALLOWLIST=(
  'src/router.ts'
  'src/channels/telegram.ts'
  'src/channels/gmail.ts'
  'src/channels/whatsapp.ts'   # if/when added
  'src/channels/slack.ts'      # if/when added
  'src/channels/discord.ts'    # if/when added
)

# Search only .ts source files; skip compiled .js artifacts under agent-runner.
matches=$(git grep -nE "$PATTERN" \
  -- 'src/**/*.ts' 'container/agent-runner/src/**/*.ts' \
  ':!**/*.test.ts' || true)

# Filter out allowlisted paths
violations=$(echo "$matches" | awk -F: -v allow="$(IFS=\|; echo "${ALLOWLIST[*]}")" '
  $1 !~ allow { print $0 }
')

if [[ -n "$violations" ]]; then
  echo "ERROR: direct channel.sendMessage(...) calls outside the chokepoint:" >&2
  echo "$violations" >&2
  echo "Migrate to routeOutbound(channels, jid, text, opts)." >&2
  exit 1
fi
exit 0
```

Wired into `npm test` via `package.json`'s `scripts.test` (concatenate the existing test runner with `&& bash scripts/check-outbound-chokepoint.sh`).

## MCP tool descriptions

**`view_media`** — Fetch a Telegram media file by `file_id`. Use when the user asks to look at / view / show / посмотри / покажи a photo, image, sticker, document, or PDF you have a `file_id` for. `mode` default `auto`: images → image content, PDFs → extracted text. `mode:'image'` with `pages:'1-3'` for visual PDF rendering (max 10 pages). On failure the response text starts with the error code followed by `:` — e.g. `TIMEOUT: ...`, `FILE_TOO_LARGE: ...`, `FILE_EXPIRED: ...`, `EXTRACTOR_MISSING: ...`, `EXTRACTOR_OUTPUT_INVALID: ...`, `UNSUPPORTED_TYPE: ...`, `PAGES_OUT_OF_RANGE: ...`, `UPSTREAM_ERROR: ...`. Parse the prefix from the first line and relay the code to the user.

**`lookup_messages`** — Search this group's stored message history. Use when the user references something older than the recent context, when walking a reply chain (`<reply mid="X">`), or to find a specific message. Filters: `tg_message_id`, `sender_id`, `since`/`until`, `query` (case-insensitive substring on text — incl. Cyrillic; `%` and `_` in the query are escaped and matched literally). `include_bot` default `false`; pass `true` to UNION the bot's own past replies into the result (not "only bot"). Default returns last 50; max 200.

**`lookup_contacts`** — Search this group's known people/contacts. Use when the user references a person by name / nickname / `@username` / phone. `query` for free-text; `username` exact (lowercase, no `@`); `tg_id` exact. Returns up to `limit` rows (default 50). Reads a snapshot file refreshed within ~500ms of last upsert — enrichment from `@mention` resolution may not be reflected on the same turn; if a row is missing or `enriched=0`, say so honestly.

**`annotate_contact`** — Attach a note or tag. Identify by ONE of `ident`, `username`, `tg_id`. `notes` REPLACES previous notes (use for the canonical summary); `tags` APPENDS unique comma-separated tags.

## Files touched

Host (`src/`):
- **NEW** `src/channels/telegram-meta.ts` — `buildMetaBlock(message): string`.
- **NEW** `src/channels/telegram-enrich.ts` — bounded-rate `getChat` resolver.
- **MOD** `src/channels/telegram.ts`:
  - Wire FOUR update kinds: `bot.on('message:*')`, `bot.on('edited_message:*')`, `bot.on('channel_post:*')`, `bot.on('edited_channel_post:*')`.
  - Each handler builds meta via `telegram-meta` and passes via `NewMessage.meta`.
  - Remove auto-vision in `message:photo` (no `processImage`, no `images` field on `NewMessage`).
  - **Rewrite `sendTelegramMessage`** as shown in §2 above — returns `Promise<{ messageId: string }>`.
  - **Rewrite `TelegramChannel.sendMessage`** as shown in §3 above — captures the first chunk's id.
- **MOD** `src/db.ts`:
  - `ALTER TABLE messages ADD COLUMN meta TEXT` (idempotent).
  - **Register `db.function('lower_unicode', ...)` immediately after `new Database(dbPath)` and BEFORE any `db.prepare` that references it** (existing `createSchema` doesn't use it, but future prepared statements do — `lookup_messages` SQL needs the function registered first).
  - **Extend SELECT projection in `getNewMessages` and `getMessagesSince`** to include `meta`. Verbatim new SELECT lists:
    ```sql
    -- getNewMessages
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, meta
    FROM messages
    WHERE timestamp > ?
      AND chat_jid IN (<jids placeholders>)
      AND is_bot_message = 0
      AND content NOT LIKE ?
      AND ((content != '' AND content IS NOT NULL) OR meta IS NOT NULL)
    ORDER BY timestamp ASC
    LIMIT ?;
    ```
    ```sql
    -- getMessagesSince
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, meta
    FROM messages
    WHERE timestamp > ?
      AND chat_jid = ?
      AND is_bot_message = 0
      AND content NOT LIKE ?
      AND ((content != '' AND content IS NOT NULL) OR meta IS NOT NULL)
    ORDER BY timestamp ASC
    LIMIT ?;
    ```
  - Updated `NewMessage` type carries `meta?: string`.
  - `storeMessage` carries `meta`; **`storeOutboundMessage`** as shown in §6 above.
  - `contacts` schema + `upsertContact` (COALESCE merge) + `promoteContactIdent` (read-merge-write with `mergeContactRows` as shown above) + `getContactsForGroup({scope, includeUnion?})` + `annotateContact` + `lookupMessages` (group-scoped, clamped, `lower_unicode` LIKE with `ESCAPE '\'`, full SQL above).
- **MOD** `src/ipc.ts`:
  - New request/response namespaces: `media-requests/` ↔ `media-responses/`, `lookup-requests/` ↔ `lookup-responses/`, `contact-write-requests/` ↔ `contact-write-responses/` (renamed from `contact-writes/` so it matches the `*-requests/` / `*-responses/` sweep glob).
  - `lookup_contacts` does NOT use IPC; it reads the mounted `contacts.json` directly.
  - TTL sweep at 180s, startup + every 5 min, for `*-requests/` and `*-responses/` ONLY (glob matches all three new namespaces). `errors/` left alone.
  - `contacts.json` snapshot writer: **trailing-edge debounce, 500ms, per-scope timer**. On SIGTERM, `flushAllSnapshots()` synchronously fires all pending timers.
- **MOD** `src/container-runner.ts` — ensure new IPC sub-dirs exist. Delete `pendingImages` Map and `hasImages` branch in `src/index.ts` in the same change set.
- **MOD** `src/router.ts`:
  - `formatMessages` reads both `content` and `meta`. When `meta` present: `<message ...>${meta}\n${content ? '<text>' + escapeXml(content) + '</text>' : ''}</message>`. When `meta` NULL: legacy `<message ...>${escapeXml(content)}</message>`.
  - **`routeOutbound`** as shown in §5 above — isolation of send vs store.
- **MOD** `src/types.ts` — `Channel.sendMessage` returns `Promise<{ messageId?: string } | void>`; `NewMessage.meta?: string`.
- **MOD** `src/index.ts`:
  - All seven direct `channel.sendMessage(...)` migrated to `routeOutbound(channels, jid, text, opts)` (lines 304, 647, 667, 676, 682, and the two lambda bodies at 761-771 and 773-778).
  - Delete `pendingImages` Map and `hasImages` branch.
- **MOD** `src/channels/gmail.ts` — `sendMessage` as shown in §4 above; handles `id | null | undefined`.

Container (`container/agent-runner/src/`):
- **MOD** `ipc-mcp-stdio.ts`:
  - Register 4 new tools with the descriptions above.
  - `writeIpcFile(dir, data, filenameOverride?: string)` — when provided, writes to `dir/${filenameOverride}` via temp+rename. Preserves existing default-filename behavior when absent.
  - Shared helper `pollResponseFile(reqId, timeoutMs=120000, intervalMs=100): Promise<unknown>`.
  - `lookup_contacts` reads `/workspace/ipc/contacts.json` via `fs.readFileSync` and filters in memory.

CI/QA:
- **NEW** `scripts/check-outbound-chokepoint.sh` — body shown in §8 above. Wired into `npm test`.

Tests:
- **NEW** `src/channels/telegram-meta.test.ts` — forward (user/hidden/chat/channel + unknown), reply (in-chat + external_reply with full payload + reply_to_story), quote, all media types, entities, vCard, location, poll, story, edited_* markers, sender_chat detection.
- **NEW** `src/channels/telegram.test.ts` — `sendTelegramMessage` returns `{messageId}` (mock grammy to return distinct numeric ids per call; assert `String()` coercion); Markdown→plain fallback returns the SECOND id (the delivered one); `TelegramChannel.sendMessage` with multi-chunk input returns FIRST chunk's id; partial failure (chunk 2 throws) propagates the throw, chunk 1's id is captured but never reaches `storeOutboundMessage` (known limitation).
- **NEW** `src/channels/gmail.test.ts` — `sendMessage` with mocked `users.messages.send` returning `{data:{id:'GMAIL_INTERNAL'}}` returns `{messageId:'GMAIL_INTERNAL'}`; with `{data:{id:null}}` returns `{messageId: undefined}` (falls to synthetic id path downstream); never reads `payload.headers` (no extra round-trip).
- **MOD** `src/db.test.ts`:
  - After `storeMessage(...meta: '<m>foo</m>')` then `getNewMessages(...)` then `getMessagesSince(...)`: assert `expect(rows[0].meta).toBe('<m>foo</m>')` — explicit verification that `meta` survives the SELECT projection.
  - Photo-no-caption admitted via filter relaxation (verify both `meta != null` AND `content = ''` row passes).
  - `upsertContact` insert→update with COALESCE; `promoteContactIdent` MERGE when id-row pre-exists with notes/tags (assert: id_row's notes preserved when both non-null; tags union); group-scope isolation; main-group union.
  - `lookup_messages` LIKE wildcard escape: query `тратил 50%` matches a row with literal `тратил 50%` and does NOT match `тратил 5000`.
  - Cyrillic case insensitivity: `Петя` ↔ `петя` via `lower_unicode`.
- **NEW** `src/ipc-mediarequest.test.ts` — happy path; timeout (TIMEOUT with `_meta.retryable=true` at the wire level AND text prefix `TIMEOUT:`); oversized-file pre-flight (FILE_TOO_LARGE without `getFile`); pdftotext AND-rule (stderr noise + non-empty stdout → return text; stderr noise + empty stdout → EXTRACTOR_OUTPUT_INVALID); startup sweep; `writeIpcFile` filename-override round-trip; HEIC → UNSUPPORTED_TYPE; **routeOutbound DB-failure isolation** (mock `storeOutboundMessage` to throw; assert `routeOutbound` does NOT throw and the calling fixture's `streamingSendFailed` remains false).
- **NEW** `scripts/check-outbound-chokepoint.test.sh` — fixture: introduce a temporary file under `src/` with a forbidden `channel.sendMessage(` call; assert the check script returns 1. Remove the file; assert returns 0. Run as part of the suite.

## Known limitations / risks

- **Edited messages lose history** — previous version overwritten. Edit-to-empty (deleting caption) is indistinguishable from "never had caption".
- **`getChat` resolves only public channels/supergroups** — per Bot API contract. User mentions of private accounts get `enriched=0`.
- **`pdftotext` / `pdftoppm` not installed** → `EXTRACTOR_MISSING`. Document `brew install poppler`.
- **HEIC / HEIF / TIFF input** — not supported by sharp's prebuilt binary.
- **Telegram DM limitation**: bots cannot DM arbitrary users without prior `/start`.
- **Animated/video stickers and videos** — descriptor only.
- **20MB file cap** — Telegram Bot API limit.
- **`processImage` 1024px ceiling** — Anthropic accepts 1568px; v5 keeps existing helper.
- **PII storage** — third-party identifiers per explicit user consent; group-isolated.
- **Token cost** — meta block ~150-400 chars/message.
- **Mixed history transition** — pre-v5 rows have NULL `meta`; legacy shape served verbatim.
- **First-turn freshness for `@mention` enrichment** — debounce + async; tool description warns.
- **Media + caption trigger in non-text handlers** (pre-existing) — `@andy_ai_bot посмотри` as a photo caption in a non-main group doesn't trigger.
- **Photo-with-no-caption in non-main groups** — relaxed SQL filter admits the row, but `src/index.ts:507`'s `TRIGGER_PATTERN.test(content.trim())` against empty content drops it. **Main group**: delivered. **Non-main group**: not delivered (semantic change to fix would be too broad).
- **Multi-chunk outbound** — when a reply spans multiple Telegram messages, only the **first chunk's** `messageId` is stored. `lookup_messages({tg_message_id: <second-chunk-id>})` won't find it.
- **Partial multi-chunk failure** — if chunk 1 succeeds and chunk 2 throws, the throw propagates and `storeOutboundMessage` is never called → chunk 1's row is not written to `messages` even though the user saw it. The Markdown-fallback double-send case (line 426 in v4) is a related variant.
- **Gmail outbound id is internal** — not RFC-2822 Message-ID. Capturing the RFC-2822 ID would require an extra `users.messages.get({format:'metadata'})` round-trip, out of scope for v1.
- **`business_message`/`edited_business_message`** — not wired in v1.
- **`lookup_messages` query on text-only** — photo-no-caption rows have `content=''` and are unsearchable by `query`; agent must use `tg_message_id` / temporal filters.
- **`promoteContactIdent` data-loss edge** — when both `id:` and `un:` rows have non-null `notes` written by the agent before promotion fires, the id-row's notes win and the un-row's notes are lost. Tags are unioned. To preserve both, the agent must annotate AFTER promotion (i.e. after the bot has both seen the tg_id directly and any previous mention). Out of scope to merge note strings programmatically.
- **`String.prototype.toLowerCase` is Unicode-aware, not full case-folding** — handles Cyrillic / Greek / accented Latin (the user's actual languages). Does not perform Turkish `İ`→`i̇` or German `ẞ`→`ss` folds.
- **Snapshot mounted into container** — `contacts.json` lives in the group's IPC mount by design. Group isolation enforced at the mount boundary.
- **`_meta` is host-side only** — Anthropic agent SDK doesn't propagate MCP content-block `_meta` to the model. v5 places error metadata on `CallToolResult._meta` (top-level, in the SDK's event stream) but the model only reads the `text` prefix. The `_meta` exists for tests, hooks, and host-side telemetry.
- **`retry_after_ms` is informational only** — SDK doesn't honor it automatically; the agent (text-prefix-only view) can't consume it directly.

## Out of scope (v1)

- Cross-group contact merging.
- Office document formats extraction.
- Video / GIF frame extraction; OCR on stickers.
- Full-text search index (FTS5) on `messages`.
- Multi-channel media (Gmail attachments, Slack files).
- Diff-history for edited messages.
- `business_message` Telegram Business connections.
- Extra `users.messages.get` to capture Gmail RFC-2822 Message-ID.
- Per-chunk message_id tracking for multi-chunk Telegram outbound.
- Programmatic note-string merge during `promoteContactIdent`.
- Turkish/German full case-folding (not used by current users).

## Verification

- Unit: `npx vitest run` (includes all new/modified test files) — all green.
- Integration (manual):
  1. Forward a channel post → `contacts` row with `kind='channel'`, derivable `link`, later `enriched=1`.
  2. Reply to media asking "посмотри" (both in-chat AND `external_reply`).
  3. `@some_public_channel` mention → `enriched=1` and `bio`.
  4. `@some_private_user` → `enriched=0`, no retry storm.
  5. Album of 3 photos → 3 `<m media_group_id="...">` rows.
  6. Anonymous admin post → `<sender_chat>`, contacts row keyed on sender_chat id.
  7. **Photo with no caption in MAIN group** → row appears in `getNewMessages` AND `meta` field on returned `NewMessage` object is non-null. Asserted directly in `src/db.test.ts`: `expect(rows[0].meta).toBe('<m>...</m>')`.
  8. **Photo with no caption in non-main group** → row stored, NOT delivered (known limitation).
  9. Corrupt PDF → `EXTRACTOR_OUTPUT_INVALID`; partially-recoverable PDFs still return text.
  10. HEIC document → `UNSUPPORTED_TYPE`.
  11. Bot reply → `messages` row with real Telegram `message_id` (numeric-string coerced via `String()`); `lookup_messages({tg_message_id})` finds it.
  12. Edit a channel post → `meta.edited` set; row re-delivered.
  13. **`_meta` wire-level round-trip**: induce `FILE_TOO_LARGE`; `CallToolResultSchema.parse(rawWireFrame)._meta?.error_code === 'FILE_TOO_LARGE'`.
  14. **Model-facing text prefix (the actual model contract)**: induce `FILE_TOO_LARGE`. Use the Anthropic SDK's request interceptor (`client.messages.create` is called; mock or proxy the underlying `fetch` to capture the request body) to assert: the `tool_result` content block sent to the Anthropic API has `content[0].text` starting with `FILE_TOO_LARGE:` AND no `_meta` field is forwarded inside the tool_result content. This proves the model sees the prefix, not `_meta`.
  15. **Cyrillic `lookup_messages`**: store `Петя`; query `'петя'` returns the row.
  16. **LIKE wildcard escape**: store two rows, content `'тратил 50% налога'` and `'тратил 5000 налога'`. Query `'50%'` returns ONLY the first row (the `%` is escaped, matched literally).
  17. **CI grep enforcement**: running `scripts/check-outbound-chokepoint.sh` on the post-migration tree returns 0. Reverting any one of the 7 enumerated migrations makes it return 1.
  18. **`routeOutbound` DB-failure isolation**: mock `storeOutboundMessage` to throw `SQLITE_BUSY`. Call `routeOutbound(channels, jid, 'hello')`. Assert: it does NOT throw; the channel's `sendMessage` was called (user got the message); an `error` log entry was made.
- Regression: existing message loop, scheduler, threadId routing, FIFO drain, sender allowlist, trigger detection, `escapeXml` on user text — all unchanged.

## Pre-implementation lessons (cumulative)

Defects resolved across four review rounds, each verifiable against the current spec.

**v1 lessons (resolved in v2)** — meta block escaped, `^@Andy` regex broken by prefix, `getChat` over-promised, `external_reply`/`reply_to_story`/`sender_chat` missed, `<fwd link>` invalid for `kind='chat'`, COALESCE implicit, snapshot writer no debounce, fake `errors/` TTL claim, 30s timeout below 20MB download, `include_bot` dead, tool descriptions absent, legacy `forward_from*` gone in grammy ≥3.x.

**v2 lessons (resolved in v3)** — photo-no-caption dropped by filter, `_nanoclaw_error_code` stripped by Zod $strip, `writeIpcFile` filename collision, `storeOutboundMessage` no id, `promoteContactIdent` clobbered notes, `errors/` sweep, pdftotext exit-0, `sender_chat`+synthetic `from`, `edited_channel_post`, HEIC, `external_reply` payload, `text_mention.is_bot`, poll cadence, debounce mechanism, Sticker.type orthogonal, MessageOrigin fallback, retry budget, voice transcript_status, tool-description budget.

**v3 lessons (resolved in v4)** — SELECT projection missing meta (CRITICAL triple-confirmed → resolved by directing the SELECT extension), `_meta` on content-block invisible to model (CRITICAL → moved to top-level `CallToolResult._meta`), `sendTelegramMessage` wrapper unchanged → rewrite listed, multi-chunk message_id picking → first chunk's, Gmail RFC-2822 factually wrong → internal id (extra round-trip out of scope), 7 lambdas not migrated → all enumerated, `routeOutbound` "linted by review" → CI grep, photo-no-caption non-main → known limitation, SQLite LIKE Cyrillic → custom `lower_unicode`, `lookup_contacts`/`annotate_contact` path split → snapshot read / IPC write, `<poll>`/`<story>` top-level rows added, `_meta.unsupported_kind` dropped, `retry_after_ms` host-side only, `view_media` description re-pointed at text prefix, verification #12 split into wire+model, `promoteContactIdent` explicit JS read-merge-write, pdftotext AND-rule, `<fwd raw>` `escapeXml(JSON.stringify(...))`, synthetic id with `crypto.randomBytes`, "ALL FOUR" softened, full WHERE clause shown verbatim, Markdown fallback documented, edit-to-empty as known limit, `lookup_messages` photo-no-caption unsearchable as known limit.

**v4 lessons (resolved in v5)**:
- **Verification #14 was redundant with #13** (both wire-level) → v5 rewrites #14 as Anthropic-API-intercept asserting the actual `tool_result` content block contains the text prefix and NOT `_meta`.
- **Verification #7 didn't actually prove SELECT** → v5 spells out `expect(rows[0].meta).toBe(...)` in `db.test.ts`.
- **CI grep contradiction** between line 34 and line 337 → v5 has ONE canonical command (`git grep -nE`) and the full script body inlined; allowlist exact paths shown; test files explicitly excluded.
- **CI grep script body underspecified** → v5 inlines the full bash with exact pattern, exclusion list (`:!**/*.test.ts`), exit-code contract.
- **SELECT projection still not verbatim** → v5 shows the literal new SELECT for both `getNewMessages` and `getMessagesSince`, with all 8 columns.
- **`mergeContactRows` notes rule ambiguous** → v5 pins `coalesce(idRow.notes, unRow.notes)` (id-row wins when both non-null), tags = union; the data-loss edge for "both non-null" is in known limitations.
- **`storeOutboundMessage` throw corrupted `streamingSendFailed`** → v5's `routeOutbound` has an isolated `try/catch` around `storeOutboundMessage` that logs but does not propagate. Verification step #18 covers this.
- **grammy `message_id: number` vs spec `messageId: string` type mismatch** → v5 explicit `String(result.message_id)` in `sendTelegramMessage`.
- **Gmail `id?: string | null` not handled** → v5 explicit `res.data?.id ?? undefined` in `gmail.sendMessage`; null falls through to synthetic-id branch.
- **LIKE wildcard injection** (user query `50%`) → v5 host-side escape `query.replace(/[\\%_]/g, '\\$&')` + `ESCAPE '\'` in SQL. Verification #16.
- **`include_bot` semantics undefined** → v5 pins "default false = exclude is_bot_message=1; true = UNION; never 'only-bot'". Reflected in tool description.
- **`lookup_messages` full SQL absent** → v5 shows the verbatim SELECT including all filters.
- **No multi-chunk test** → v5 adds `src/channels/telegram.test.ts` with grammy mocks for chunked + Markdown fallback.
- **No Gmail outbound test** → v5 adds `src/channels/gmail.test.ts`.
- **CI grep not tested against actual tree** → v5 verification step #17 + `scripts/check-outbound-chokepoint.test.sh` fixture.
- **`contact-writes/` doesn't match the sweep glob** → renamed to `contact-write-requests/` ↔ `contact-write-responses/`.
- **Line ref 511 vs 507** → corrected.
- **`db.function` registration ordering not pinned** → v5 specifies: register immediately after `new Database(dbPath)`, before any `db.prepare` referencing it.
- **First-chunk capture mechanism not shown** → v5 inlines the loop with `if (i === 0) firstId = r.messageId`.
- **Multi-chunk first-id capture mechanism shown** → see `TelegramChannel.sendMessage` body above.
- **"Full Unicode case-folding" overpromised** → v5 says "Unicode-aware case lowering (per ECMA-262 `Lowercase_Mapping`)"; full case-folding (`ẞ`→`ss`) explicitly NOT performed.
- **Synthetic id collision** → already addressed in v4 (`crypto.randomBytes(8)` = 16 hex chars).
- **Markdown→plain double-send semantics** → v5's `sendTelegramMessage` body documents: the catch-on-Markdown path re-sends with plain, returns the SECOND id (which IS the delivered message because Markdown-throw + plain-success both happen on the same chunk; the first attempt was rejected by Telegram so no duplicate). If Markdown succeeded and a later transport error fired (rare), the catch fires only because the await rejected; the duplicate-message edge is documented as known limitation.
