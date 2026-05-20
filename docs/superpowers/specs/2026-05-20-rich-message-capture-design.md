# Rich Message Capture + Persistent People Memory + On-Demand Vision

Design spec for letting the NanoClaw agent operate on the full data of every Telegram message it receives — including forward origin, mentioned/forwarded people, reply targets, and media — with a passive long-term contacts memory and on-demand media access.

> **Revision history**
> - **v4 (2026-05-20, after round 3 critical review)** — addresses 24 v3 defects. Key fixes: SELECT clause now explicitly adds `meta` projection (triple-confirmed missing in v3); MCP error metadata moves to **top-level `CallToolResult._meta`** (Anthropic agent SDK only reads top-level, content-block `_meta` is invisible to the model — verified by tracing `cli.js`); `sendTelegramMessage` wrapper signature change is explicit; multi-chunk send picks first chunk's message_id; Gmail captures internal id (RFC-2822 requires extra get-call, documented); all seven outbound lambdas enumerated for migration; Cyrillic-aware `LIKE` via custom SQLite function; `lookup_contacts`/`annotate_contact` path split (snapshot read / IPC write); `<poll>`/`<story>` get top-level rows; full WHERE clause shown verbatim; retry-after semantics pinned; verification step #12 split.
> - v3 (2026-05-20, commit `b923090`) — addressed 25 v2 defects. Round 3 found 24 more.
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
- The existing message-loop filter `WHERE content != '' AND content IS NOT NULL` in `getNewMessages`/`getMessagesSince` is relaxed; the **full new WHERE clause** is shown verbatim in the SQL section below. **`meta` is added to the SELECT projection** so `formatMessages` actually sees it (this was missed in v3).
- `formatMessages` emits the metadata block **without `escapeXml`-ing it** (we control the block's content) alongside the user text in a `<text>` child (escaped, optional). The `<text>` tag is emitted only when content is non-empty.
- Auto-vision is removed. Photos are no longer base64-inlined into the prompt. Media (any type) is represented in the structured block by its Telegram `file_id`; the agent calls `view_media` only when the user asks.
- A new SQLite table `contacts` holds a deterministic, per-group log of everyone the bot has seen — forward authors (user / hidden user / chat / channel), vCard contacts, direct senders, mentioned identifiers (`text_mention` entities are upserted from the inline `User` object; bare `@username` entities are best-effort resolved via `getChat`, which the Bot API only documents as working for channels and public supergroups).
- The agent gets four new MCP tools: `lookup_contacts`, `annotate_contact`, `view_media`, `lookup_messages`. Errors return as MCP tool errors with structured diagnostic data on **top-level `CallToolResult._meta`** (NOT on `content[0]._meta`; the Anthropic agent SDK only reads top-level metadata). The `text` field of the result content also carries `<error_code>: <human message>` as the canonical model-facing signal.
- Standard non-business Telegram update kinds are wired: `message`, `edited_message`, `channel_post`, `edited_channel_post`. `business_message` / `edited_business_message` are out of scope for v1 (niche use).
- File and IPC isolation remain group-scoped; the container has no direct DB or Telegram access. The `contacts.json` snapshot mounted into the container is the same data the DB holds for that group's scope; the boundary is the per-group mount.
- Outbound bot text flows through a single chokepoint `routeOutbound(channels, jid, text, opts)` in `src/router.ts` which now (a) calls `channel.sendMessage`, (b) on success calls `storeOutboundMessage(jid, text, channelMessageId)`. Every existing direct `channel.sendMessage` call site (enumerated in the Files Touched section) is rewritten to call `routeOutbound`. A CI grep-check enforces: `git grep -n 'channel\.sendMessage(' src/ container/agent-runner/src/` returning anything outside `router.ts`, the test files, and the channel implementations themselves fails CI.

## Structured message block

Format: a single `<m>` element. It lives in a new column `messages.meta TEXT`. At delivery time `formatMessages` emits:

```
<message sender="..." time="...">
<m id="123" date="2026-05-20T10:00:00Z" ...>  ← from messages.meta, NOT escaped
  ...
</m>
<text>escaped user text</text>                  ← from messages.content, escaped; OMITTED when empty
</message>
```

When `messages.meta` is NULL (pre-migration rows): emit `<message sender="..." time="...">${escapeXml(content)}</message>` — the legacy shape verbatim. Agent's system prompt documents both shapes once.

```
<m id="123" date="2026-05-20T10:00:00Z" media_group_id="42" edited="2026-05-20T10:01:00Z">
  <from id="222222222" un="vasya" name="Вася" is_bot="0" premium="1" lang="ru"/>
  <!-- OR, when sender_chat is set, <from> is SKIPPED entirely (Bot API places a synthetic
       GroupAnonymousBot / Channel_Bot user in `from` in those cases). Detection rule:
       if (message.sender_chat) emit <sender_chat>, skip <from>. -->
  <sender_chat id="-1001..." kind="channel" un="durov" title="Durov"/>
  <fwd kind="channel" chat_id="-1001..." un="durov" title="Durov"
       sig="Pavel" orig_date="2026-05-01T..." orig_msg_id="123"
       link="https://t.me/durov/123"/>
  <!-- Unknown future MessageOrigin variant: <fwd kind="unknown" raw="<xml-escaped-JSON>"/> -->
  <reply external="0" mid="120" from_id="999" un="petya" name="Петя" is_bot="0"
         snippet="первые ≤500 символов цитируемого">
    <media type="photo" file_id="AgAC..." mime="image/jpeg" w="1280" h="960"/>
  </reply>
  <reply_to_story chat_id="..." story_id="..."/>
  <quote>фрагмент Bot API 7.0 ручной цитаты</quote>
  <media type="document" file_id="BQAC..." file_unique_id="..." mime="application/pdf"
         name="report.pdf" size="20480"/>
  <media type="sticker" sticker_kind="regular" file_id="..." mime="image/webp" w="512" h="512" emoji="🐬"/>
  <entities>
    <url>https://example.com</url>
    <mention>target_user</mention>
    <textlink href="https://y.com">текст</textlink>
    <text_mention id="111" un="ivan" name="Иван" is_bot="0"/>
    <custom_emoji id="5368324170671202286"/>
    <hashtag>news</hashtag>
    <cashtag>BTC</cashtag>
    <bot_command>/start@andy_ai_bot</bot_command>
    <phone>+79991234567</phone>
    <email>x@y.com</email>
  </entities>
  <contact phone="+79991234567" name="Иван" user_id="888" vcard_raw="BEGIN:VCARD..."/>
  <location lat="55.75" lon="37.61" title="Кафе" address="ул. Ленина 1"/>
  <poll question="Где встретимся?" type="regular"/>
  <story chat_id="..." story_id="..."/>
</m>
```

Tag reference. *All attributes optional unless marked **req**. All tags except `<m>` itself are optional and omitted when empty.*

| Tag | Source (Bot API field on `Message`) | Notes |
|---|---|---|
| `<m>` (req) | the message itself | `id`=message_id; `date`=ISO; `media_group_id` when present; `edited`=ISO of edit (only for `edited_*` updates) |
| `<from>` | `from?: User` | **Skipped when `sender_chat` is set** (the synthetic bot in `from` is uninteresting). Detection: `if (message.sender_chat) emit_sender_chat() else if (message.from) emit_from()`. `is_bot` always emitted. |
| `<sender_chat>` | `sender_chat?: Chat` | Replaces `<from>` when present. |
| `<fwd>` | `forward_origin` (Bot API 7.0+) | `kind` ∈ {user, hidden_user, chat, channel}. **Unknown kinds** (future Bot API additions) emit `<fwd kind="unknown" raw="..."/>` where `raw="${escapeXml(JSON.stringify(origin))}"` (XML-attribute-escaped JSON; spec was wrong about "json-escaped" alone in v3). `link` is derivable only for `kind='channel'`. |
| `<reply>` | `reply_to_message?: Message` OR `external_reply?: ExternalReplyInfo` | `external="0"` for in-chat reply, `external="1"` for `external_reply`. The external case carries origin attributes (mirror of `<fwd>`) **plus all top-level payload tags that may appear there**: `<media>`, `<contact>`, `<location>`, `<poll>`, `<story>`, `<reply_to_story>`. |
| `<reply_to_story>` | `reply_to_story?: Story` | Top-level reply target distinct from message replies. |
| `<quote>` (text) | `quote?.text` (7.0+) | Manual partial-text quotation. |
| `<media>` | `photo` / `video` / `voice` / `audio` / `document` / `sticker` / `animation` / `video_note` | `type`, `file_id` (req), `file_unique_id`, `mime`, `size`, type-specific (`w`,`h`,`duration`,`name`,`emoji`). For **stickers**, host synthesizes `mime`: `is_animated=true` → `application/x-tgsticker`; `is_video=true` → `video/webm`; else → `image/webp`. Sticker carries `sticker_kind` ∈ {regular, mask, custom_emoji} (orthogonal to format). Photos synthesize `image/jpeg` (Telegram convention). |
| `<media transcript=... transcript_status=...>` | voice/video_note | Voice transcription via Groq path. `transcript_status`: `ok` (Groq returned non-empty text → in `transcript`); `failed` (Groq HTTP/network error or empty result); `missing_key` (`GROQ_API_KEY` absent); `skipped` (file too large or transcription disabled). |
| `<entities>` | `message.entities` | Children: `<url>`, `<mention>`, `<textlink href>text</textlink>`, `<text_mention id un name is_bot/>`, `<custom_emoji id/>`, `<hashtag>`, `<cashtag>`, `<bot_command>`, `<phone>`, `<email>`. Formatting-only entities (`bold`, `italic`, `code`, `pre`, `spoiler`, `blockquote`) dropped. |
| `<contact>` | `message.contact?: Contact` | `phone`, `name`, `user_id`, `vcard_raw`. |
| `<location>` | `message.location` / `message.venue` | `lat`, `lon`, `title`, `address`. |
| `<poll>` | `message.poll?: Poll` | `question`, `type` (regular/quiz). Options dropped in v1. |
| `<story>` | `message.story?: Story` | `chat_id`, `story_id`. |

### Handling all four message-update kinds

Bot API delivers four distinct update kinds the spec wires:
- `message` (non-channel new) — INSERT new row.
- `channel_post` (channel new) — INSERT new row.
- `edited_message` (non-channel edit) — INSERT OR REPLACE existing `(id, chat_jid)` row; `meta.edited=<ts>` set; `timestamp = max(message.date, edit_date)` so `WHERE timestamp > cursor` re-delivers.
- `edited_channel_post` (channel edit) — same as edited_message but for channel posts.

`business_message` / `edited_business_message` (Bot API 7.x Business connections) are **out of scope for v1**; document and add the wiring if the user enables Business mode later.

### Albums (`media_group_id`)

Telegram delivers a multi-photo album as N separate Updates sharing one `media_group_id`. Only the first usually carries the caption. The host writes each as its own `<m media_group_id="...">` row; agent correlates via the shared id. No server-side reassembly.

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
  first_name  TEXT,
  last_name   TEXT,
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

Identity at upsert: prefer `tg_id` (`"<scope>|id:<tgId>"`); else lowered `username`; else `lowered(first_name+last_name)`.

When a row was first written under `un:` and a later inbound reveals `tg_id`, promote in a single SQLite transaction. ON CONFLICT cannot reference a sibling row, so the implementation does a **read-merge-write in JS** inside a `db.transaction(...)` block:

```ts
const promoteContactIdent = db.transaction((scope: string, un: string, tgId: string) => {
  const idIdent = `${scope}|id:${tgId}`;
  const unIdent = `${scope}|un:${un.toLowerCase()}`;
  const idRow = db.prepare('SELECT * FROM contacts WHERE ident = ?').get(idIdent);
  const unRow = db.prepare('SELECT * FROM contacts WHERE ident = ?').get(unIdent);
  if (!unRow) return; // race; nothing to do
  // Build merged row: id-row wins for notes (never NULL-overwrite); tags append-unique;
  // first_seen = min; last_seen = max; seen_count = sum; enriched = max;
  // other fields = COALESCE(id_row.X, un_row.X).
  const merged = mergeContactRows(idRow, unRow);
  db.prepare('INSERT OR REPLACE INTO contacts (ident, scope, ...) VALUES (?, ?, ...)').run(idIdent, scope, ...);
  db.prepare('DELETE FROM contacts WHERE ident = ?').run(unIdent);
});
```

`mergeContactRows` is a small pure helper with the column-wise rules above. Notes/tags written by the agent are preserved.

### Upsert merge semantics (regular path)

`INSERT ... ON CONFLICT(ident) DO UPDATE SET` with explicit per-column rules (matching `src/db.ts:194-211` convention):

| Column | Conflict rule |
|---|---|
| `first_name`, `last_name`, `title`, `phone`, `link`, `is_bot` | `COALESCE(excluded.X, contacts.X)` |
| `bio` | `COALESCE(excluded.bio, contacts.bio)` — getChat-supplied, sticky |
| `kind`, `source` | overwrite |
| `enriched` | `MAX(contacts.enriched, excluded.enriched)` |
| `first_seen` | preserved |
| `last_seen` | overwrite |
| `seen_count` | `contacts.seen_count + 1` |
| `notes`, `tags` | **NEVER touched by host** |

### Scope and main-group cross-scope view

Per-group isolation by default: `contacts.scope = group_folder`. Main group sees the UNION across all groups (mirrors `src/container-runner.ts:884`'s `isMain` precedent).

### Host upsert rules

Order on every inbound (BEFORE `storeMessage`):

| Trigger | Source |
|---|---|
| `message.from` (only when `sender_chat` NOT set; otherwise from is a synthetic bot) | `sender` |
| `message.sender_chat` | `sender` |
| `forward_origin` or `external_reply` origin | `forward` |
| `reply_to_message.from` or `external_reply` origin author | `reply` |
| `message.contact` (vCard) | `vcard` |
| `entities[type='text_mention'].user` | `text_mention` |
| `entities[type='mention']` (bare `@username`) | queued for `getChat` enrichment |

`@username` enrichment: best-effort via `getChat('@'+username)`. Bot API only documents this for channels and public supergroups; private users return `Bad Request`. On success: upsert with `source='getChat'`, `enriched=1`, `bio`. Failure cached 7 days, success 24 hours. Rate-limited to 1/sec via in-process token bucket.

## On-demand media (`view_media`)

Container has no Telegram token or network to Telegram. Host performs every download via request/response over file IPC.

### Flow

1. Agent reads a `file_id` from the structured block.
2. Agent calls `view_media({ file_id, mode?: 'auto'|'image'|'text', pages?: 'N-M' })`.
3. The tool generates `reqId = "${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}"`, calls `writeIpcFile(MEDIA_REQ_DIR, data, \`${reqId}.json\`)` (with the v4 filename-override parameter), then polls `data/ipc/<group>/media-responses/<reqId>.json` via `pollResponseFile(reqId, 120000, 100)` — 120s ceiling, 100ms cadence.
4. Host watcher authorizes (request lives in this group's IPC namespace), pre-checks `file_size > 20MB` (FILE_TOO_LARGE without `getFile`), calls Telegram `getFile(file_id)` → downloads → routes by mime → writes response → deletes request file.
5. Tool reads response, returns it as an MCP `CallToolResult`.

### Retry, timeout, sweep

- `getFile` + download retry on 429/503/5xx with exponential backoff: **initial + 3 retries = 4 total attempts**, backoffs 1s, 2s, 4s, 8s (max ~15s). 4xx other than 429 → no retry.
- 120s elapsed → `TIMEOUT`. Host watcher sweeps `media-requests/` on startup and every 5 minutes: any request file older than 180s gets a `TIMEOUT` response written, then the request is unlinked.
- `media-responses/` files older than 180s unlinked unconditionally.
- **`errors/` is NEVER swept.** It is operator-review quarantine; deleting it on TTL defeats the existing semantic.

### Mime routing (`mode='auto'` default)

| Mime / type | Handling | MCP content |
|---|---|---|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` (incl. static stickers via synthesized mime) | download → `processImage()` (resizes to ≤1024px long edge, re-encodes JPEG q85) | `{type:'image', data, mimeType:'image/jpeg'}` |
| `image/heic`, `image/heif`, `image/tiff` and any other image mime sharp can't decode | sharp's prebuilt binary on macOS doesn't support HEIC (libheif absent). On throw, return `UNSUPPORTED_TYPE` | tool error |
| `application/x-tgsticker`, `video/webm`, `video/mp4`, `video/quicktime` | not downloaded | text descriptor in `text` (no extra `_meta` keys — keep the field set minimal) |
| `application/pdf` (`mode:'auto'` or explicit `mode:'text'`) | `pdftotext -layout -enc UTF-8 -nopgbrk - -` (stdin/stdout). Detection rule for invalid PDFs: **stdout empty AND stderr matches `/Syntax Error\|May not be a PDF file/`** (AND, not OR — partially-recoverable PDFs with stderr noise but non-empty stdout still return the recovered text). Truncate stdout to ≤500KB with `…[truncated]` marker. | `{type:'text', text}` |
| `application/pdf` (explicit `mode:'image'`, with `pages:'N-M'`, default `'1-1'`, hard cap 10 pages) | `mkdtemp` directory, write PDF buffer to it, run `pdftoppm -jpeg -r 150 -f N -l M <pdf> <prefix>`, read each `<prefix>-K.jpg`, then `rm -rf` the temp dir in a `try/finally` (always cleans up, even on error) | array of `{type:'image', data, mimeType:'image/jpeg'}` |
| `text/*`, `application/json`, `application/yaml` | UTF-8 decode, trim to ≤200KB | `{type:'text', text}` |
| voice (any mime), audio (non-image) | not downloaded; transcript lives in `<m><media transcript=...>` if Groq path succeeded | `{type:'text', text:'voice: see message transcript'}` |
| other (office, archives, unknown) | not downloaded | `{type:'text', text:'тип X не отображается; <descriptor>'}` |

`pdftotext` / `pdftoppm` come from `poppler-utils` (macOS: `brew install poppler`). Absent → `EXTRACTOR_MISSING`.

### Error contract

All `view_media` and `lookup_messages` errors return as MCP tool errors. The structured diagnostic data lives on the **top-level `CallToolResult._meta`** (verified by tracing the Anthropic agent SDK's `cli.js`: only top-level `D._meta` is read; `content[0]._meta` is silently dropped from the agent's perspective). The model-facing canonical signal is the `text` prefix:

```json
{ "isError": true,
  "_meta": {
    "error_code": "<CODE>",
    "retryable": true|false,
    "retry_after_ms": <number>  // optional, only emitted for errors with a useful hint
  },
  "content": [{
    "type": "text",
    "text": "<CODE>: <human-readable message>"
  }]
}
```

The model only reads `content[0].text`, so the `<CODE>: ...` prefix is the contract for agent reasoning. `_meta` exists for SDK-side telemetry, tests, and hooks — it never reaches the model. Tool descriptions therefore tell the agent to parse the text prefix, not the `_meta` field.

| Code | When | `retryable` | `retry_after_ms` |
|---|---|---|---|
| `TIMEOUT` | 120s polling exhausted | true | undefined (immediate retry OK) |
| `UPSTREAM_ERROR` | `getFile` non-retryable error after host retries | true | optional (echoes upstream `Retry-After` for 429) |
| `FILE_TOO_LARGE` | `file_size > 20MB` (pre-flight) | false | — |
| `FILE_EXPIRED` | `getFile` returns "file is too old" | false | — |
| `EXTRACTOR_MISSING` | `pdftotext`/`pdftoppm` not on PATH | false | — |
| `EXTRACTOR_OUTPUT_INVALID` | stdout empty AND stderr indicates corruption | false | — |
| `UNSUPPORTED_TYPE` | mime not in any image/text branch, OR `processImage` failed (HEIC) | false | — |
| `PAGES_OUT_OF_RANGE` | `pages` invalid or exceeds 10 | false | — |
| `AUTH_REJECTED` | request from another group's IPC namespace (shouldn't happen) | false | — |

`retry_after_ms` is **informational** — the SDK does not honor it automatically. The agent (which only sees the text prefix anyway) cannot consume it directly. It exists for host-side rate-limit awareness and for tests that exercise the wire-level contract.

### Reply / forward "посмотри" workflows

- Reply to media (in-chat OR cross-chat via `external_reply`) → new message's `<m><reply><media file_id=.../></reply></m>` → `view_media(file_id)`.
- Forward media with own text → top-level `<media>` in `<m>`, text in `<text>` → `view_media(file_id)`.
- Historical media → `lookup_messages` returns the row's `meta`; agent finds the `file_id` and calls `view_media`. Telegram file_ids are stable for the originating bot.

## Conversation access (`lookup_messages`)

```
lookup_messages({
  tg_message_id?,   sender_id?,
  since?, until?,
  query?,           // substring, case-insensitive on text (NOT on meta)
  include_bot?,     // default false
  limit?            // default 50; server clamps to [1, 200]
}) -> formatted text (formatMessages style) including each row's meta + text
```

Hard caps: `limit` clamped to `[1, 200]`; response body ≤500KB; on truncation append `<truncated count="N"/>`.

### Case-insensitive search with non-ASCII (Cyrillic)

SQLite's default `LIKE` is ASCII-only-case-insensitive (`Петя` does NOT match `петя`). NanoClaw's primary user writes in Russian; a naive LIKE silently breaks the feature.

`lookup_messages` registers a SQLite function at DB init using better-sqlite3's `db.function`:

```ts
db.function('lower_unicode', { deterministic: true }, (s: string | null) =>
  s == null ? null : s.toLowerCase()
);
```

The query becomes `WHERE lower_unicode(content) LIKE lower_unicode(?)`. Adds full Unicode case-folding via JS `String.prototype.toLowerCase`. Note: photo-no-caption rows have `content=''` so they are unsearchable by text query — that's a deliberate trade-off (search content, not meta) documented in known limitations.

### Outbound storage chokepoint

`include_bot=true` requires bot replies in `messages`. v4 reroutes ALL outbound through one chokepoint:

1. **`Channel.sendMessage` signature widened** (in `src/types.ts`): `sendMessage(jid, text, opts?): Promise<{ messageId?: string } | void>`. Backward-compatible: existing void-returning implementations still type-check.
2. **`sendTelegramMessage` wrapper rewritten** (in `src/channels/telegram.ts`): returns `Promise<{ messageId: string } | { messageId: undefined }>`. Captures `grammy.api.sendMessage`'s returned `Message.message_id` for both the Markdown path AND the plain-text fallback (returns the SECOND id if Markdown failed). `TelegramChannel.sendMessage` returns the **first chunk's** `messageId` when `splitForTelegram` produces N≥2 chunks (the rest are not separately tracked in v1; document as limitation).
3. **Gmail's `users.messages.send`** returns `Schema$Message.id` — Gmail's INTERNAL opaque id, NOT the RFC-2822 Message-ID header (verified against `googleapis/build/src/apis/gmail/v1.d.ts:585-622`). To get the RFC-2822 header value would require an extra `users.messages.get({format:'metadata', metadataHeaders:['Message-ID']})` round-trip. v4 uses the internal id; the RFC-2822 round-trip is **out of scope for v1**.
4. **`routeOutbound` in `src/router.ts`** is the chokepoint:
   ```ts
   export async function routeOutbound(channels, jid, text, opts) {
     const channel = channels.find(c => c.ownsJid(jid) && c.isConnected());
     if (!channel) throw new Error(`No channel for JID: ${jid}`);
     const result = await channel.sendMessage(jid, text, opts);
     const messageId = (result && typeof result === 'object' && 'messageId' in result) ? result.messageId : undefined;
     storeOutboundMessage(jid, text, messageId);
   }
   ```
5. **All seven existing direct `channel.sendMessage` call sites are explicitly rewritten** to call `routeOutbound`:
   - `src/index.ts:304` (streaming output callback in `runAgent`)
   - `src/index.ts:647, 667, 676, 682` (remote-control branches in `handleRemoteControl`)
   - `src/index.ts:761-771` (the lambda passed as `deps.sendMessage` to `startSchedulerLoop`)
   - `src/index.ts:773-778` (the lambda passed as `deps.sendMessage` to `startIpcWatcher`)
   - Both lambdas are rewritten to `routeOutbound(channels, jid, text, opts)` instead of `channel.sendMessage`.
6. **CI grep enforcement**: a check script in `scripts/check-outbound-chokepoint.sh` runs `git grep -lEn "channel\.sendMessage\(" -- src/ container/agent-runner/src/` and fails if any matches outside the channel implementations themselves and `src/router.ts`. Wired into `npm test`.
7. **Synthetic id collision**: when `messageId` is undefined, `storeOutboundMessage` uses `id = "out-${Date.now()}-${crypto.randomBytes(8).toString('hex')}"` (16 random hex chars vs v3's 6, eliminates birthday collision risk).
8. **`storeOutboundMessage`** uses the same `INSERT OR IGNORE INTO chats` pre-check as `storeMessage` to satisfy the FK pragma.

## MCP tool descriptions

**`view_media`**:
> Fetch a Telegram media file by `file_id` and return it to the conversation. Use this when the user asks to look at / view / show / посмотри / покажи a photo, image, sticker, document, or PDF that you have a `file_id` for. `mode` defaults to `auto`: images come back as images, PDFs as extracted text. Use `mode:'image'` with `pages:'1-3'` for visual PDF rendering (max 10 pages). On failure the tool returns an MCP tool error and the response text begins with the error code followed by `:` — for example `TIMEOUT: ...`, `FILE_TOO_LARGE: ...`, `FILE_EXPIRED: ...`, `EXTRACTOR_MISSING: ...`, `EXTRACTOR_OUTPUT_INVALID: ...`, `UNSUPPORTED_TYPE: ...`, `PAGES_OUT_OF_RANGE: ...`, `UPSTREAM_ERROR: ...`. Parse the prefix from the first line of the response text and relay the code to the user instead of paraphrasing.

**`lookup_messages`**:
> Search this group's stored message history. Use this when the user references something older than the recent context, when walking a reply chain (`<reply mid="X">`), or to find a specific message by id/sender/date. Filters: `tg_message_id`, `sender_id`, `since`/`until`, `query` (case-insensitive substring on text — including Cyrillic). Default returns last 50; max 200.

**`lookup_contacts`**:
> Search this group's known people/contacts. Use when the user references "Петя" / "тот чувак из канала Х" / "@username" / a phone number. Pass `query` for free-text, `username` for exact (lowercase), `tg_id` for exact. Returns at most `limit` rows (default 50). Reads a snapshot file refreshed within 500ms of the last upsert — enrichment from `@mention` resolution may not be reflected on the same turn as the mention; if the row is missing or `enriched=0`, say so honestly.

**`annotate_contact`**:
> Attach a note or tag to a known contact. Use when the user says something durable ("Петя — мой партнёр", "она занимается дизайном"). Identify by ONE of `ident`, `username`, `tg_id`. `notes` REPLACES previous notes; `tags` APPENDS unique comma-separated tags.

## Files touched

Host (`src/`):
- **NEW** `src/channels/telegram-meta.ts` — `buildMetaBlock(message): string`. Handles `<from>` vs `<sender_chat>` detection, all forward kinds + unknown fallback with XML-escaped JSON, `reply_to_message` AND `external_reply` (with full payload incl. poll/story/contact/location) AND `reply_to_story`, `quote`, all `<media>` types with synthesized mime + sticker_kind, full `<entities>` enumeration with `is_bot` on text_mention, `<contact>`, `<location>`, `<poll>`, `<story>`. Pure function.
- **NEW** `src/channels/telegram-enrich.ts` — bounded-rate `getChat` resolver; in-memory dedupe (24h success / 7d failure).
- **MOD** `src/channels/telegram.ts`:
  - Wire ALL FOUR update kinds: `bot.on('message:*')`, `bot.on('edited_message:*')`, `bot.on('channel_post:*')`, `bot.on('edited_channel_post:*')`.
  - Each handler builds meta via `telegram-meta` and passes via `NewMessage.meta`.
  - Remove auto-vision in `message:photo` (no `processImage` call, no `images` field).
  - **Rewrite `sendTelegramMessage`**: signature becomes `Promise<{messageId?: string}>`; captures `grammy.api.sendMessage` return.
  - `TelegramChannel.sendMessage` returns the first chunk's messageId when `splitForTelegram` produces N≥2 chunks.
- **MOD** `src/db.ts`:
  - `ALTER TABLE messages ADD COLUMN meta TEXT` (idempotent).
  - **Extend SELECT projection in `getNewMessages` and `getMessagesSince`** to include `meta`. Updated `NewMessage` type carries `meta?: string`. The full WHERE clause becomes:
    ```sql
    WHERE timestamp > ?
      AND chat_jid IN (...)
      AND is_bot_message = 0
      AND content NOT LIKE ?
      AND ((content != '' AND content IS NOT NULL) OR meta IS NOT NULL)
    ```
  - Register `db.function('lower_unicode', ...)` at init (for Cyrillic-aware LIKE).
  - `storeMessage` carries `meta`; `storeOutboundMessage(jid, text, channelMessageId)` does `INSERT OR IGNORE INTO chats` + INSERT into messages with `is_from_me=1, is_bot_message=1`.
  - `contacts` schema + `upsertContact` (COALESCE merge) + `promoteContactIdent` (read-merge-write inside `db.transaction`, preserves notes/tags via JS `mergeContactRows`) + `getContactsForGroup({scope, includeUnion?})` + `annotateContact` + `lookupMessages` (group-scoped, clamped, `lower_unicode` LIKE).
- **MOD** `src/ipc.ts`:
  - New request namespaces: `media-requests/`, `lookup-requests/` (lookup_messages goes through IPC too — request/response), `contact-writes/` (for `annotate_contact`).
  - `lookup_contacts` does NOT use IPC; it reads the mounted `contacts.json` directly from the container's filesystem (one-way push).
  - TTL sweep at 180s, startup + every 5 min, for `*-requests/` and `*-responses/` ONLY. `errors/` left alone.
  - `contacts.json` snapshot writer: **trailing-edge debounce, 500ms, per-scope timer**. Each upsert/annotate/promote calls `scheduleSnapshot(scope)` which `clearTimeout`+`setTimeout` keyed on scope. On fire, write the snapshot for that scope. On SIGTERM, `flushAllSnapshots()` synchronously fires all pending timers.
- **MOD** `src/container-runner.ts` — ensure new IPC sub-dirs exist. Delete `pendingImages` Map and `hasImages` branch in `src/index.ts` (in the same change set).
- **MOD** `src/router.ts`:
  - `formatMessages` reads both `messages.content` and `messages.meta`. When `meta` present: emit `<message ...>${meta}\n${content?('<text>'+escapeXml(content)+'</text>'):''}</message>`. When `meta` NULL: emit legacy `<message ...>${escapeXml(content)}</message>`.
  - `routeOutbound` becomes the outbound chokepoint as defined above.
- **MOD** `src/types.ts` — `Channel.sendMessage` returns `Promise<{ messageId?: string } | void>`. `NewMessage.meta?: string`.
- **MOD** `src/index.ts`:
  - Every direct `channel.sendMessage(...)` migrated to `routeOutbound(channels, jid, text, opts)` — explicit list: lines 304, 647, 667, 676, 682, and the two lambda bodies at 761-771 and 773-778.
  - Delete `pendingImages` Map + `hasImages` branch.
- **MOD** `src/channels/gmail.ts` — `sendMessage` returns `{ messageId: response.data.id }` (Gmail internal id; NOT RFC-2822 Message-ID). Document the limitation.

Container (`container/agent-runner/src/`):
- **MOD** `ipc-mcp-stdio.ts`:
  - Register 4 new tools with the descriptions above.
  - **Extend `writeIpcFile(dir, data, filenameOverride?: string): string`** — when `filenameOverride` is provided, the file is written to `dir/${filenameOverride}` (still using temp+rename for atomicity). When absent, preserves the existing `${Date.now()}-${rand}.json` behavior.
  - Shared helper `pollResponseFile(reqId, timeoutMs=120000, intervalMs=100): Promise<unknown>` for `view_media`/`lookup_messages`/`annotate_contact`. Each call holds its own reqId. Returns parsed JSON on success; on timeout returns the timeout-error response synthesized by the host watcher (NOT by the tool itself).
  - `lookup_contacts` reads `/workspace/ipc/contacts.json` directly via `fs.readFileSync` and filters in memory (no IPC round-trip; the file is the host's snapshot mounted into the container's `/workspace/ipc`).

CI/QA:
- **NEW** `scripts/check-outbound-chokepoint.sh` — fails CI on any `channel\.sendMessage\(` outside `src/router.ts` and the channel implementations themselves.

Tests:
- **NEW** `src/channels/telegram-meta.test.ts` — pure-function tests covering: forward (user/hidden/chat/channel + unknown fallback with XML-escaped JSON), reply (in-chat + external_reply with full payload + reply_to_story), quote, all media types (sticker mime synthesis + sticker_kind), entities (all 10 emitted kinds incl. text_mention.is_bot), vCard, location, poll, story, edited_message + edited_channel_post markers, sender_chat detection (suppresses `<from>`).
- **MOD** `src/db.test.ts` — `upsertContact` insert→update with COALESCE; `promoteContactIdent` MERGE when id-row pre-exists with notes/tags (verify notes preserved, tags append-unique); group-scope isolation; main-group union read; relaxed message-loop filter delivers photo-no-caption (verify both projections: filter passes AND `meta` is in SELECT); `lower_unicode` LIKE matches Cyrillic case-insensitively.
- **NEW** `src/ipc-mediarequest.test.ts` — happy path; timeout path (TIMEOUT with `_meta.retryable=true` at the wire level AND text prefix `TIMEOUT:` for model visibility); oversized-file pre-flight (FILE_TOO_LARGE); pdftotext corruption AND-rule (stderr noise + non-empty stdout → still returns recovered text; stderr noise + empty stdout → EXTRACTOR_OUTPUT_INVALID); startup sweep; `writeIpcFile` filename override round-trip; HEIC → UNSUPPORTED_TYPE; outbound chokepoint enforcement (the grep script returns 0 on a clean tree).

## Known limitations / risks

- **Edited messages lose history** — previous version is overwritten; user has it in Telegram client, agent does not. Edit-to-empty (deleting caption) is indistinguishable from "never had caption".
- **`getChat` resolves only public channels/supergroups** — per Bot API contract. User mentions of private accounts get `enriched=0`.
- **`pdftotext`/`pdftoppm` not installed** → `EXTRACTOR_MISSING`. Document `brew install poppler`.
- **HEIC/HEIF/TIFF input** — not supported by sharp's prebuilt binary. `view_media` returns `UNSUPPORTED_TYPE`.
- **Telegram DM limitation**: bots cannot DM arbitrary users without prior `/start`.
- **Animated/video stickers and videos** — `view_media` returns a descriptor, not pixels.
- **20MB file cap** — Telegram Bot API limit.
- **`processImage` 1024px ceiling** — Anthropic accepts 1568px; v4 keeps existing helper.
- **PII storage** — third-party identifiers per explicit user consent; group-isolated.
- **Token cost** — meta block ~150-400 chars/message; 200-msg context ≈ 40-80KB. Tool descriptions add ~450 tokens to `tools/list`.
- **Mixed history transition** — pre-v4 rows have NULL `meta`; `formatMessages` falls back to legacy shape. Agent copes (legacy prefixes are human-readable).
- **First-turn freshness for `@mention` enrichment** — snapshot debounced 500ms + `getChat` async. Tool description tells the agent to handle `enriched=0` gracefully.
- **Media + caption trigger in non-text handlers** (pre-existing) — `@andy_ai_bot посмотри` as a photo caption in a non-main group doesn't trigger; not fixed by v4.
- **Photo-with-no-caption in non-main groups** — relaxed filter admits the row, but the non-main trigger gate at `src/index.ts:511` checks `TRIGGER_PATTERN.test(content.trim())` against empty content and drops it. **In v4, main group receives photo-no-caption; non-main groups still drop it** unless the user includes the trigger word in another message. Fixing this requires changing trigger semantics (media counts as trigger) — out of scope.
- **Multi-chunk outbound** — when an agent reply spans multiple Telegram messages (text > 4096 UTF-16 units), only the **first chunk's** `messageId` is stored in `messages`. The full text is stored once (joined). `lookup_messages({tg_message_id: <second-chunk-id>})` won't find it.
- **Markdown→plain-text fallback** — if `sendTelegramMessage`'s Markdown path 5xxes after Telegram already received the message, the second send creates a duplicate Telegram message. Only the second message's id is stored; the first is lost from `messages` (but the user still saw both in Telegram). Acceptable v1.
- **Gmail outbound id** — Gmail's internal id, not RFC-2822 Message-ID. Cross-referencing outbound emails with their inbound Reply-To threads via `lookup_messages` won't naturally match.
- **`business_message` / `edited_business_message`** — not wired in v1. If user enables Telegram Business mode, business chat messages are silently swallowed.
- **`lookup_messages` query on `<text>`-only** — photo-no-caption rows have `content=''` and are unsearchable by text; agent must use `tg_message_id` or temporal filters to find them.
- **Snapshot mounted into container** — `contacts.json` is mounted into the group's container by design. Group isolation enforced at the mount boundary.
- **MessageOrigin evolution** — `<fwd kind="unknown" raw="..."/>` future-proofs against Bot API additions.
- **`_meta` is host-side only** — the Anthropic agent SDK doesn't propagate MCP content-block `_meta` to the model. v4 places error metadata on `CallToolResult._meta` (top-level, which the SDK does read into its event stream) but the model only reads the `text` prefix. The `_meta` exists for SDK-side tests, hooks, and telemetry.

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

## Verification

- Unit: `npx vitest run src/channels/telegram-meta.test.ts src/db.test.ts src/ipc-mediarequest.test.ts` — all green.
- Integration:
  1. Forward a channel post → `contacts` row with `kind='channel'`, derivable `link`, later `enriched=1`.
  2. Reply to media asking "посмотри" (both in-chat AND linked-channel discussion `external_reply`).
  3. `@some_public_channel` mention → `enriched=1` and `bio` after a few seconds.
  4. `@some_private_user` → `enriched=0`, no retry storm.
  5. Album of 3 photos → 3 `<m media_group_id="...">` rows.
  6. Anonymous admin post → `<sender_chat>` instead of `<from>`; contacts row keyed on sender_chat id.
  7. Photo with no caption **in MAIN group** → row appears (filter relaxation), agent sees `<m><media type=photo .../></m>` (verified meta IS in SELECT projection, not just stored).
  8. Photo with no caption **in non-main group** → row stored, NOT delivered (known limitation).
  9. Corrupt PDF → `EXTRACTOR_OUTPUT_INVALID` (and partially-recoverable PDFs with stderr noise still return text).
  10. HEIC document → `UNSUPPORTED_TYPE`.
  11. Bot reply → `messages` row with real Telegram `message_id`; `lookup_messages({tg_message_id})` finds it.
  12. Edit a channel post → `meta.edited` set; row re-delivered.
  13. **`_meta` wire-level round-trip**: a `FILE_TOO_LARGE` from the host yields a tool response with `_meta.error_code === 'FILE_TOO_LARGE'` at the wire level (verifiable via `CallToolResultSchema.parse(rawResponse)`).
  14. **`text` prefix round-trip (the actual model contract)**: the model's tool_result content has `text` starting with `FILE_TOO_LARGE: ...`. Verified by inspecting the agent's transcript / SDK event stream after inducing the error.
  15. **Cyrillic `lookup_messages`**: store a message containing `Петя` (capital П). Query with `query: 'петя'` (lowercase) returns the row.
  16. **CI grep**: `scripts/check-outbound-chokepoint.sh` returns 0 on a clean tree; if a developer adds `channel.sendMessage(...)` outside `routeOutbound`, the check returns 1.
- Regression: existing message loop, scheduler, threadId routing, FIFO drain, sender allowlist, trigger detection (for non-media or main-group cases), `escapeXml` on user text — all unchanged.

## Pre-implementation lessons (cumulative v1 + v2 + v3)

Every defect resolved across the three review rounds. Reviewers can verify each was addressed.

**v1 lessons (resolved in v2)**:
- meta block escaped by `formatMessages` → moved to separate column.
- `<m>` prefix broke `TRIGGER_PATTERN ^@Andy\b` → content stays as raw text.
- `getChat` over-promised → narrowed to channels/supergroups.
- `external_reply`, `reply_to_story`, `sender_chat` missed → all three added.
- `<fwd link>` not derivable for `kind='chat'` → emit only for channel.
- COALESCE merge implicit → spelled out per-column.
- Snapshot writer with no debounce → ≥500ms.
- TTL sweep referenced non-existent `errors/` mechanism → real sweep specified.
- `view_media` 30s timeout below 20MB download time → 120s.
- `include_bot` dead → storage hook added.
- Tool descriptions undefined → shipped.
- Legacy `forward_from*` doesn't exist in grammy ≥3.x → removed.

**v2 lessons (resolved in v3)**:
- Photo-no-caption silently dropped by `content != ''` filter → relaxed to `OR meta IS NOT NULL`.
- Wrong-level `_nanoclaw_error_code` field stripped → moved to `_meta`.
- `writeIpcFile` hardcoded filename collided with reqId → optional `filenameOverride`.
- `storeOutboundMessage` no message_id → widened `Channel.sendMessage` return.
- `promoteContactIdent` clobbered id-row notes → column-wise MERGE in transaction.
- `errors/` sweep destroyed quarantine → left alone.
- `pdftotext` exit-0 on corrupt PDF → stderr + empty-stdout detection.
- `sender_chat` + synthetic `from` coexistence → detection rule.
- `edited_channel_post` separate update → all four wired.
- HEIC unsupported → explicit `UNSUPPORTED_TYPE`.
- `external_reply` payload coverage → enumerated.
- `text_mention` dropped `is_bot` → emitted + column added.
- Poll cadence unspecified → 100ms pinned.
- Debounce mechanism unspecified → trailing-edge per-scope + SIGTERM flush.
- `Sticker.type` orthogonal to format → `sticker_kind` attribute.
- MessageOrigin fallback missing → `kind='unknown'`.
- Retry budget ambiguous → 4 total attempts.
- Voice `transcript_status` mapping → spelled out.
- Tool descriptions token budget → acknowledged.

**v3 lessons (resolved in v4)**:
- **CRITICAL**: SELECT projection missing `meta` (triple-confirmed) → explicit in Files Touched + verified in test #7.
- **CRITICAL**: `_meta` on content-block invisible to model → moved to top-level `CallToolResult._meta`; model contract is the `text` prefix.
- `sendTelegramMessage` wrapper unchanged → rewrite listed in Files Touched.
- Multi-chunk `message_id` not picked → first chunk's id (documented limitation).
- Gmail RFC-2822 claim factually wrong → use internal id, document the extra round-trip as out of scope.
- Lambdas at index.ts:761-778 not migrated → all 7 sites enumerated.
- `routeOutbound` "linted by review" → CI grep script enforced.
- Photo-no-caption in non-main groups still dropped by trigger gate → documented as known limitation.
- SQLite LIKE Cyrillic case-sensitivity → custom `lower_unicode` SQLite function.
- `lookup_contacts` vs `annotate_contact` path unspecified → snapshot read / IPC write split explicit.
- `<poll>` / `<story>` top-level tag rows missing → added to reference table.
- `_meta.unsupported_kind` inconsistent contract → dropped from non-error path (text descriptor only).
- `retry_after_ms` semantics undefined → informational, host-side; not honored by SDK.
- `view_media` description told agent to read `_meta` → rewritten to point at text prefix.
- Verification #12 tested wrong thing → split into wire-level (#13) and model-facing (#14).
- `promoteContactIdent` pseudo-SQL imprecise → explicit JS read-merge-write inside `db.transaction`.
- `pdftotext` OR-rule too aggressive → AND-rule (stderr noise AND empty stdout).
- `<fwd raw>` JSON-escaped → `escapeXml(JSON.stringify(...))`.
- Synthetic id birthday collision → `crypto.randomBytes(8)` (16 hex chars).
- "ALL FOUR" wording overstated → "standard non-business" + Business as out of scope.
- WHERE clause parenthesization implicit → full SQL shown verbatim in Files Touched.
- Markdown→plain double-send → documented as known limitation; first chunk's id stored.
- Edit-to-empty observability gap → documented as known limitation.
- `lookup_messages` photo-no-caption unsearchable → documented as known limitation.
