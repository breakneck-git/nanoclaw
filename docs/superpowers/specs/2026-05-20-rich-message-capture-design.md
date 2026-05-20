# Rich Message Capture + Persistent People Memory + On-Demand Vision

Design spec for letting the NanoClaw agent operate on the full data of every Telegram message it receives — including forward origin, mentioned/forwarded people, reply targets, and media — with a passive long-term contacts memory and on-demand media access.

> **Revision history**
> - **v3 (2026-05-20, after round 2 critical review)** — addresses ~25 verified defects against v2. Three v2 changes were CRITICAL: (a) message-loop filter `content != ''` silently dropped media-only messages, (b) the proposed `_nanoclaw_error_code` field was stripped by MCP SDK's Zod `$strip`, (c) `writeIpcFile`'s hardcoded filename collided with v2's `reqId` scheme. v3 fixes each plus the high/medium tail (sender_chat detection rule, `edited_channel_post` hook, `promoteContactIdent` merge, `errors/` sweep removal, pdftotext corruption detection, HEIC fallback, outbound storage chokepoint, debounce mechanism, mixed-history envelope shape, etc.).
> - v2 (2026-05-20) — committed `f9036ad`. Addressed 41 v1 defects. Round 2 review found ~25 new defects (3 critical).
> - v1 (2026-05-20) — committed `ea6a614`. Two showstoppers (escapeXml mangle, TRIGGER_PATTERN anchor).

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
- The existing message-loop filter `WHERE content != '' AND content IS NOT NULL` in `getNewMessages`/`getMessagesSince` is relaxed to **`WHERE (content != '' AND content IS NOT NULL) OR meta IS NOT NULL`** so a photo-with-no-caption is still delivered to the agent (the meta block carries the photo's file_id and structure).
- `formatMessages` (the function that wraps each row into `<message>...</message>` for the agent prompt) emits the metadata block alongside the text **without `escapeXml`-ing it** — we control the block's content, the user text is still escaped. The `<text>` tag is emitted only when content is non-empty (consistent with all other optional tags).
- Auto-vision is removed. Photos are no longer base64-inlined into the prompt. Media (any type) is represented in the structured block by its Telegram `file_id`; the agent calls `view_media` only when the user asks.
- A new SQLite table `contacts` holds a deterministic, per-group log of everyone the bot has seen — forward authors (user / hidden user / chat / channel), vCard contacts, direct senders, mentioned identifiers (`text_mention` entities are upserted from the inline `User` object; bare `@username` entities are best-effort resolved via `getChat`, which the Bot API only documents as working for channels and public supergroups).
- The agent gets four new MCP tools: `lookup_contacts`, `annotate_contact`, `view_media`, `lookup_messages`. Each carries a precise `description` so the model knows when to invoke it. Structured error data uses the documented `_meta` extension point of MCP content blocks (top-level extra fields are stripped by the SDK's Zod `$strip`).
- All Telegram update kinds that can deliver new content are wired: `message`, `edited_message`, `channel_post`, `edited_channel_post`. Edits write `meta.edited=<ts>` and update `timestamp = max(message.date, edit_date)` so the message-loop's `WHERE timestamp > cursor` re-picks the edit.
- File and IPC isolation remain group-scoped; the container has no direct DB or Telegram access — both reach through the existing per-group IPC namespace. The `contacts.json` snapshot mounted into the container is the same data the DB holds for that group's scope, by design — the boundary is the per-group mount.
- Outbound bot text flows through a single chokepoint `routeOutbound(channels, jid, text, opts)` in `src/router.ts` which now (a) calls `channel.sendMessage` (b) on success calls `storeOutboundMessage(jid, text, channelMessageId)`. Direct `channel.sendMessage` calls outside `routeOutbound` are forbidden going forward (linted out by code review; existing call sites are migrated to `routeOutbound`).

## Structured message block

Format: a single `<m>` element. It lives in a new column `messages.meta TEXT`. At delivery time `formatMessages` emits:

```
<message sender="..." time="...">
<m id="123" date="2026-05-20T10:00:00Z" ...>  ← from messages.meta, NOT escaped
  ...
</m>
<text>escaped user text</text>                  ← from messages.content, escaped; OMITTED if empty
</message>
```

When `messages.meta` is NULL (pre-migration rows): emit the legacy shape — `<message sender="..." time="...">${escapeXml(content)}</message>` — so the agent sees the pre-v3 format verbatim. The agent's system context explains both shapes once.

```
<m id="123" date="2026-05-20T10:00:00Z" media_group_id="42" edited="2026-05-20T10:01:00Z">
  <from id="222222222" un="vasya" name="Вася" is_bot="0" premium="1" lang="ru"/>
  <!-- OR, when sender_chat is set (anonymous admin / linked-channel auto-forward), <from> is SKIPPED entirely
       and <sender_chat> is emitted instead. Detection rule below. -->
  <sender_chat id="-1001..." kind="channel" un="durov" title="Durov"/>
  <fwd kind="channel" chat_id="-1001..." un="durov" title="Durov"
       sig="Pavel" orig_date="2026-05-01T..." orig_msg_id="123"
       link="https://t.me/durov/123"/>
  <reply external="0" mid="120" from_id="999" un="petya" name="Петя" is_bot="0"
         snippet="первые ≤500 символов цитируемого">
    <media type="photo" file_id="AgAC..." file_unique_id="..." mime="image/jpeg" w="1280" h="960"/>
  </reply>
  <!-- For Bot API external_reply (cross-chat / cross-topic): same <reply external="1"> shape, origin
       attributes mirror <fwd>, and ALL payload tags supported at top level (media, contact, location,
       venue, poll, story) may appear as children. -->
  <reply_to_story chat_id="..." story_id="..."/>
  <quote>фрагмент Bot API 7.0 ручной цитаты</quote>
  <media type="document" file_id="BQAC..." file_unique_id="..." mime="application/pdf"
         name="report.pdf" size="20480"/>
  <!-- Stickers carry both type discriminator and synthesized mime: -->
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
</m>
```

Tag reference. *All attributes optional unless marked **req**. All tags except `<m>` itself are optional and omitted when empty.*

| Tag | Source (Bot API field on `Message`) | Notes |
|---|---|---|
| `<m>` (req) | the message itself | `id`=message_id; `date`=ISO; `media_group_id` when present; `edited`=ISO of edit (when message is an edited_* update) |
| `<from>` | `from?: User` | **Skipped entirely when `message.sender_chat` is set** (Bot API populates a synthetic GroupAnonymousBot/Channel_Bot `from` in those cases — including its real-looking fields. v3 always prefers `sender_chat` when both exist. Detection rule: `if (message.sender_chat) emit sender_chat else if (message.from) emit from`.). `is_bot` always emitted. `un` is username without `@`. |
| `<sender_chat>` | `sender_chat?: Chat` | Emitted INSTEAD of `<from>` when present. `kind` ∈ {private, group, supergroup, channel}. |
| `<fwd>` | `forward_origin` (Bot API 7.0+) | `kind` ∈ {user, hidden_user, chat, channel}. **Unknown kinds** (future Bot API additions) emit `<fwd kind="unknown" raw="{json-escaped}"/>` so we never silently drop forward context. `link` is derivable **only** for `kind='channel'` (only `MessageOriginChannel` carries `message_id`); omitted for other kinds. Legacy `forward_from*` fields are NOT used (not present in grammy ≥3.x). |
| `<reply>` | `reply_to_message?: Message` OR `external_reply?: ExternalReplyInfo` | `external="0"` for in-chat reply, `external="1"` for `external_reply` (cross-chat / linked-channel discussion group). The external case carries origin attributes (same shape as `<fwd>`) **plus all top-level payload tags that can appear there**: `<media>`, `<contact>`, `<location>`, `<location ... venue=...>`, `<poll question=...>`, `<reply_to_story>`. Drops poll options (just the question), dice (just the value/emoji). |
| `<reply_to_story>` | `reply_to_story?: Story` | Story has only `chat`, `id`. No media — agent cannot `view_media` on it. |
| `<quote>` (text) | `quote?.text` (Bot API 7.0+) | Manual partial-text quotation. |
| `<media>` | `photo` / `video` / `voice` / `audio` / `document` / `sticker` / `animation` / `video_note` | `type`, `file_id` (req), `file_unique_id`, `mime`, `size`, type-specific (`w`,`h`,`duration`,`name`,`emoji`). For **stickers**, the Bot API has no `mime_type` — host **synthesizes**: `is_animated=true` → `application/x-tgsticker`; `is_video=true` → `video/webm`; else → `image/webp`. Sticker also carries `sticker_kind` ∈ {regular, mask, custom_emoji} (orthogonal to format). Photos always synthesize `image/jpeg` (Telegram convention; PhotoSize has no mime field). |
| `<media transcript=... transcript_status=...>` | voice/video_note | Voice transcription via Groq path is preserved. `transcript_status` mapping: `ok` (Groq returned non-empty text → stored in `transcript`); `failed` (Groq HTTP/network error); `missing_key` (`GROQ_API_KEY` absent); `skipped` (voice path disabled by config / file too large). When non-`ok`, `transcript` is omitted. |
| `<entities>` | `message.entities` | Children: `<url>`, `<mention>` (text-only @, lowercase, no `@`), `<textlink href>`text`</textlink>`, `<text_mention id un name is_bot/>`, `<custom_emoji id/>`, `<hashtag>`, `<cashtag>`, `<bot_command>`, `<phone>`, `<email>`. Formatting-only entities (`bold`, `italic`, `code`, `pre`, `spoiler`, `blockquote`) dropped. |
| `<contact>` | `message.contact?: Contact` | `phone`, `name`, `user_id`, `vcard_raw`. |
| `<location>` | `message.location` / `message.venue` | `lat`, `lon`, `title`, `address`. |

All block construction lives in one module so every channel handler is one-line: `const meta = buildMetaBlock(message);` and `onMessage` carries `meta` as a separate field on `NewMessage`.

### Handling all four message-update kinds

Bot API delivers four distinct updates:
- `message` (non-channel new) and `channel_post` (channel new) — INSERT new row.
- `edited_message` (non-channel edit) and `edited_channel_post` (channel edit) — INSERT OR REPLACE the existing `(id, chat_jid)` row; `meta.edited` is set, `timestamp = max(message.date, edit_date)` so the message-loop's `WHERE timestamp > cursor` re-picks the edited row. Contacts re-upserted in case the edit changed entities.

The host wires all four hooks. Skipping `edited_channel_post` would silently swallow channel edits (the Bot API type-narrows `edited_message` away from channel chats).

### Albums (`media_group_id`)

Telegram delivers a multi-photo album as **N separate Updates** sharing one `media_group_id`. Only the first usually carries the caption. The host writes each as its own `<m media_group_id="...">` row; the agent correlates via the shared id. No server-side reassembly in v1.

## Contacts memory

### Schema (SQLite, host-side)

```sql
CREATE TABLE IF NOT EXISTS contacts (
  ident       TEXT PRIMARY KEY,         -- "<scope>|id:<tgId>" | "<scope>|un:<lower>" | "<scope>|name:<lower>"
  scope       TEXT NOT NULL,            -- group_folder; isolation boundary
  tg_id       TEXT,
  username    TEXT,                     -- lowercased, no '@'
  kind        TEXT NOT NULL,            -- 'user' | 'hidden_user' | 'chat' | 'channel'
  is_bot      INTEGER NOT NULL DEFAULT 0,
  first_name  TEXT,
  last_name   TEXT,
  title       TEXT,                     -- for chat/channel
  phone       TEXT,                     -- from vCard
  link        TEXT,                     -- t.me link if derivable
  bio         TEXT,                     -- from getChat enrichment
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  seen_count  INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL,            -- 'sender' | 'forward' | 'reply' | 'vcard' | 'mention' | 'text_mention' | 'getChat'
  enriched    INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,                     -- agent-written, NEVER overwritten by host upsert
  tags        TEXT                      -- agent-written, NEVER overwritten by host upsert
);
CREATE INDEX IF NOT EXISTS contacts_scope_username ON contacts(scope, username);
CREATE INDEX IF NOT EXISTS contacts_scope_tg_id    ON contacts(scope, tg_id);
```

`is_bot` is required because Bot API's `User.is_bot` is required (`@grammyjs/types/manage.d.ts:43`) and the agent needs it to decide DM feasibility.

### Identity resolution and `promoteContactIdent` MERGE

Identity at upsert: prefer `tg_id` (`"<scope>|id:<tgId>"`); else lowered `username` (`"<scope>|un:<u>"`); else `lowered(first_name+last_name)` (`"<scope>|name:<n>"`).

When a row was first written under `un:` and a later inbound reveals `tg_id`, the host **promotes** in a single SQLite transaction. The promotion is a **column-wise MERGE**, not `INSERT OR REPLACE`, because the `id:` row may ALREADY exist (e.g. agent annotated it earlier):

```sql
BEGIN;
-- Pull existing id-row if any
-- Compute merged values:
--   first_name, last_name, title, phone, link, bio : COALESCE(id_row.X, un_row.X)
--   notes  : id_row.notes IF NOT NULL ELSE un_row.notes   (id-row wins; never NULL-overwrite)
--   tags   : append-unique(id_row.tags, un_row.tags)
--   first_seen : MIN(id_row.first_seen, un_row.first_seen)
--   last_seen  : MAX(id_row.last_seen,  un_row.last_seen)
--   seen_count : id_row.seen_count + un_row.seen_count
--   enriched   : MAX(id_row.enriched, un_row.enriched)
INSERT INTO contacts (ident, scope, tg_id, username, kind, ...) VALUES (...)
  ON CONFLICT(ident) DO UPDATE SET ... = merged_value ...;
DELETE FROM contacts WHERE ident = '<scope>|un:<u>';
COMMIT;
```

Column `notes` is NEVER NULL-overwritten on the id-row even by promotion. Column `tags` is append-unique. This preserves agent-written annotations across promotion.

### Upsert merge semantics (regular path)

The host upsert uses `ON CONFLICT(ident) DO UPDATE SET` with explicit per-column rules (matches the convention in `src/db.ts:194-211`):

| Column | Conflict rule |
|---|---|
| `first_name`, `last_name`, `title`, `phone`, `link`, `is_bot` | `COALESCE(excluded.X, contacts.X)` |
| `bio` | `COALESCE(excluded.bio, contacts.bio)` — getChat-supplied, sticky |
| `kind`, `source` | overwrite (most recent observation wins) |
| `enriched` | `MAX(contacts.enriched, excluded.enriched)` |
| `first_seen` | preserved (`contacts.first_seen`) |
| `last_seen` | overwrite (`excluded.last_seen`) |
| `seen_count` | `contacts.seen_count + 1` |
| `notes`, `tags` | **NEVER touched by host** — only `annotate_contact` writes |

### Scope and main-group cross-scope view

Per-group isolation by default: `contacts.scope = group_folder`. The agent in group X queries only X's contacts.

The **main group** sees a UNION across all groups, following the existing precedent at `src/container-runner.ts:884` (`writeGroupsSnapshot` emits all groups when `isMain`). The snapshot writer emits `contacts.json` filtered to the consuming group's scope when not main, OR the union for main.

### Host upsert rules (when and what)

Order on every inbound (BEFORE `storeMessage`, to keep upsert observable to the agent on the same turn):

| Trigger | Source value | Notes |
|---|---|---|
| `message.from` | `sender` | When `from` is present AND `sender_chat` is NOT present (otherwise from is the synthetic GroupAnonymousBot/Channel_Bot — skip) |
| `message.sender_chat` | `sender` | Replaces the from-upsert when present. Upserted with `kind='channel'` or `'chat'`. |
| `forward_origin` (any kind) or, in `external_reply`, its origin | `forward` | `hidden_user` keys on lowered name |
| `reply_to_message.from` | `reply` | When reply target carries a `from` |
| `external_reply` origin author | `reply` | When external_reply present, its origin carries the author |
| `message.contact` (vCard) | `vcard` | populates `phone`; if `user_id` present, key on it |
| `entities[type='text_mention'].user` | `text_mention` | Entity carries full `User` object — upsert immediately, no network call. `is_bot` propagated. |
| `entities[type='mention']` (bare `@username`) | (queued for enrichment) | See below |

**`@username` enrichment** is fire-and-forget after delivery, with explicit scope:

- Bot API contract (`@grammyjs/types/methods.d.ts:1180-1182`): `getChat({chat_id})` accepts `@channelusername` form ONLY for channels and public supergroups. Private user `@username` returns `Bad Request: chat not found` ≈always. v3 does **not** promise enrichment for user mentions.
- A baseline row is upserted on first sight (`source='mention'`, `enriched=0`) so `lookup_contacts` at least knows the username exists.
- One getChat attempt per (scope, username), then cached: success → 24h skip; failure → 7d skip.
- Rate limit: in-process token bucket of 1 getChat/sec. Overflow queued, not dropped.

## On-demand media (`view_media`)

Container has no Telegram token or network to Telegram (credential proxy only forwards to Anthropic). Host performs every download. Mechanism: request/response over file IPC.

### Flow

1. Agent reads a `file_id` from the structured block of the current message, its `<reply>` block, or a historical message via `lookup_messages`.
2. Agent calls `view_media({ file_id, mode?: 'auto'|'image'|'text', pages?: 'N-M' })`.
3. The tool writes the request file with a deterministic, caller-supplied filename via the extended `writeIpcFile(dir, data, filenameOverride?)`. **`writeIpcFile` is updated in v3** to accept an optional filename override; without the override it preserves its existing `${Date.now()}-${rand}.json` behavior (back-compat). The override is `${reqId}.json` where `reqId = "${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}"`.
4. The tool polls `data/ipc/<group>/media-responses/<reqId>.json` with **`pollResponseFile(reqId, 120000, 100)`** — 120s ceiling, 100ms cadence (chosen as the existing host watcher's `IPC_POLL_INTERVAL=1000` is the binding lower bound, so faster polling buys nothing on the server side but keeps client latency tight). Optionally upgraded to `fs.watch` when available.
5. Host watcher (extended `src/ipc.ts`): authorizes by the per-group IPC namespace (the request file is in this group's dir → it belongs to this group); pre-checks `message.document.file_size` against the **20MB Bot API cap** — if exceeded, writes a structured error response immediately (no `getFile` attempt). Else: calls Telegram `getFile(file_id)` → downloads → routes by mime → writes response → deletes the request file.
6. Tool reads the response, returns it as an MCP content block.

### Retry, timeout, response sweep

- Telegram `getFile` and the actual file download retry on 429/503/5xx with exponential backoff: **initial attempt + 3 retries = 4 total attempts**, backoffs 1s, 2s, 4s, 8s (`Math.min(1000*2^attempt, 8000)`, mirroring `src/credential-proxy.ts:28+`). Total max ≈15s. On 4xx other than 429 → no retry.
- If 120s elapses, tool returns `TIMEOUT`. Host watcher independently sweeps `media-requests/` on startup and every 5 minutes: any request file older than 180s gets a `TIMEOUT` response written then the request is unlinked.
- `media-responses/` files older than 180s are unlinked unconditionally (sweep at startup + every 5 min).
- **`errors/` directory is NOT swept.** It is the existing quarantine destination for unrecoverable IPC files (parse failures, exhausted retries) — its purpose is operator review and a TTL defeats that. v3 only sweeps the new request/response namespaces.

### Mime routing (`mode='auto'` default)

| Mime / type | Handling | MCP content returned |
|---|---|---|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` (incl. image documents, static stickers via synthesized mime) | download → `processImage()` (existing helper at `src/image.ts`) — always re-encodes to JPEG quality 85 at ≤1024px long edge | `{ type:'image', data, mimeType:'image/jpeg' }` |
| `image/heic`, `image/heif`, `image/tiff` (and any other image mime sharp doesn't decode) | sharp's prebuilt binary on macOS does not support HEIC (libheif not bundled). Host attempts `processImage`; on throw, returns `UNSUPPORTED_TYPE` with a hint to convert | `isError` |
| `application/x-tgsticker` (animated TGS), `video/webm` (video sticker), `video/mp4` (video), `video/quicktime` | not downloaded | text descriptor + `_meta.unsupported_kind` |
| `application/pdf` (default `mode:'auto'` or explicit `mode:'text'`) | `pdftotext -layout -enc UTF-8 -nopgbrk - -` (stdin/stdout). After exit: if stderr contains `Syntax Error`/`May not be a PDF file`, return `EXTRACTOR_OUTPUT_INVALID`. If stdout empty, same. Else truncate to ≤500KB with `…[truncated]` marker. | `{ type:'text', text }` |
| `application/pdf` (explicit `mode:'image'`, with `pages:'N-M'`, default `'1-1'`, hard cap 10 pages) | write PDF buffer to a `mkdtemp` directory; `pdftoppm -jpeg -r 150 -f N -l M <tmpfile> <prefix>` then read each `<prefix>-K.jpg`; rmdir at end (always, including error paths via `try/finally`) | array of `{ type:'image', data, mimeType:'image/jpeg' }` |
| `text/*`, `application/json`, `application/yaml` | UTF-8 decode, trim to ≤200KB | `{ type:'text', text }` |
| voice (any mime), audio (non-image) | not downloaded by view_media; transcript lives in `<m><media transcript=...>` if Groq path succeeded | `{ type:'text', text:'voice: see message transcript' }` |
| other (office, archives, unknown) | not downloaded | `{ type:'text', text:'тип X не отображается; <descriptor>' }` |

`pdftotext` / `pdftoppm` come from `poppler-utils` (macOS: `brew install poppler`). When absent, host returns `EXTRACTOR_MISSING`.

### Error contract

All `view_media` and `lookup_messages` errors return as MCP tool errors using the documented `_meta` extension point (top-level extra fields are dropped by the MCP SDK's Zod `$strip`):

```json
{ "isError": true,
  "content": [{
    "type": "text",
    "text": "<error_code>: <human message>",
    "_meta": {
      "error_code": "<code>",
      "retryable": true|false,
      "retry_after_ms": 60000   // optional, for transient errors with hint
    }
  }]
}
```

| Code | When | `retryable` |
|---|---|---|
| `TIMEOUT` | 120s polling exhausted | true |
| `UPSTREAM_ERROR` | `getFile` non-retryable error after host's own retries | true |
| `FILE_TOO_LARGE` | `file_size > 20MB` (pre-flight) | false |
| `FILE_EXPIRED` | Telegram `getFile` returns "file is too old" | false |
| `EXTRACTOR_MISSING` | `pdftotext`/`pdftoppm` not on PATH | false |
| `EXTRACTOR_OUTPUT_INVALID` | pdftotext returned `Syntax Error`/empty for what should be a PDF | false |
| `UNSUPPORTED_TYPE` | mime not in any image/text branch, OR `processImage` failed (e.g. HEIC) | false |
| `PAGES_OUT_OF_RANGE` | `pages` exceeds 10-page cap or invalid range | false |
| `AUTH_REJECTED` | request was in another group's IPC namespace (won't happen normally) | false |

The `text` field also redundantly prefixes the code so even a `_meta`-blind parser gets the signal. The agent SDK surfaces tool errors visibly to the model.

### Reply / forward "посмотри" workflows

- User replies to a media message with "посмотри X" → new message's `<m><reply><media file_id=.../></reply></m>` → agent calls `view_media(file_id)`. Works for both `reply_to_message` (in-chat) and `external_reply` (cross-chat).
- User forwards a media message and adds their own text including "посмотри" → the forward IS the current message; its `<m>` has top-level `<media file_id=.../>` AND the text the user added is in `<text>`. Agent → `view_media(file_id)`.
- Historical media → agent finds the `file_id` via `lookup_messages` → `view_media(file_id)`. Telegram file_ids are stable for the originating bot.

## Conversation access (`lookup_messages`)

The existing message loop feeds the recent batch (FIFO, capped per `getMessagesSince`). For older history, reply-chain walking, or targeted lookups, the agent uses a new tool.

```
lookup_messages({
  tg_message_id?,     // jump to a specific message id
  sender_id?,         // filter by author tg id
  since?, until?,     // ISO range
  query?,             // substring, case-insensitive LIKE on text (NOT on meta)
  include_bot?,       // default false — bot's own replies excluded
  limit?              // default 50; server clamps to [1, 200]
}) -> formatted text (same style as formatMessages) including each row's meta + text
```

Hard caps enforced server-side: `limit` clamped to `[1, 200]`; response body ≤500KB; on truncation, append `<truncated count="N"/>` to the result. When ALL filters empty (`{}`), defaults to last 50 messages in the group's chats.

### Outbound storage (single chokepoint)

`include_bot=true` requires that the bot's outbound replies be in `messages`. In v3:

1. `Channel.sendMessage(jid, text, opts?)` returns `Promise<{ messageId?: string } | void>` (signature widened). Telegram implementation captures grammy's `api.sendMessage` return value (full `Message` object) and extracts `message_id.toString()`. Gmail captures the RFC-2822 Message-ID from the `users.messages.send` response (used as the outbound id).
2. **All outbound flows through `routeOutbound` in `src/router.ts`** (single chokepoint). Direct `channel.sendMessage(...)` calls outside `routeOutbound` are migrated to `routeOutbound`. The remaining call sites that wrap `routeOutbound` (scheduler lambda, IPC outbound lambda, streaming-output callback, remote-control replies — index.ts:304, 647/667/676/682, 769, 777) all benefit automatically.
3. `routeOutbound` on success calls `storeOutboundMessage(jid, text, channelMessageId)` which inserts into `messages` with `is_from_me=1, is_bot_message=1`, `id=channelMessageId`, and goes through the same `INSERT OR IGNORE INTO chats` pre-check that fixes the FK pragma issue.

If a channel's sendMessage doesn't return a messageId (e.g. some future channel returns void), `storeOutboundMessage` synthesizes `id="out-${Date.now()}-${rand}"` AND sets a `meta` block `<m kind="outbound-synthetic"/>` so the agent can tell. `lookup_messages({tg_message_id})` filters synthetic ids out unless the caller explicitly opts in (rare).

Reply chain walking is just repeated calls: `<reply mid="X">` → `lookup_messages({tg_message_id: X})` → its `<reply mid="Y">` → another call.

## MCP tool descriptions

Each new tool ships a verbose `description` (mirrors `schedule_task` style):

**`view_media`**:
> Fetch a Telegram media file by `file_id` and return it to the conversation. Use this when the user asks to look at / view / show / посмотри / покажи a photo, image, sticker, document, or PDF that you have a `file_id` for (from the current message's `<media>`, its `<reply><media>`, or a historical row from `lookup_messages`). `mode` defaults to `auto`: images come back as images, PDFs as extracted text, text files as text. Use `mode:'image'` with `pages:'1-3'` for visual PDF rendering (max 10 pages). On failure returns an MCP tool error with `_meta.error_code` (TIMEOUT, FILE_TOO_LARGE, FILE_EXPIRED, EXTRACTOR_MISSING, EXTRACTOR_OUTPUT_INVALID, UNSUPPORTED_TYPE, PAGES_OUT_OF_RANGE, UPSTREAM_ERROR) and `_meta.retryable`. Relay the code to the user instead of guessing.

**`lookup_messages`**:
> Search this group's stored message history. Use this when the user references something older than what's visible in the current context, when walking a reply chain (`<reply mid="X">`), or when you need to find a specific message by id/sender/date. Filters: `tg_message_id`, `sender_id`, `since`/`until`, `query` (text substring). Default returns last 50; max 200. Does NOT call out to Telegram — purely local DB.

**`lookup_contacts`**:
> Search this group's known people/contacts. Use this when the user references "Петя" / "тот чувак из канала Х" / "@username" / a phone number and you need contact details (id, username, bio, notes, tags, is_bot). Pass `query` for free-text, `username` for exact (lowercase, no `@`), `tg_id` for exact. Returns at most `limit` rows (default 50). Note: bare `@username` mentions resolve only for public channels/supergroups; for private users the row may exist with `enriched=0` (just the username), not full bio.

**`annotate_contact`**:
> Attach a note or tag to a known contact so you remember the relationship later. Use this when the user tells you something durable about a person ("Петя — мой партнёр", "она занимается дизайном"). Identify the contact by ONE of `ident`, `username`, `tg_id`. `notes` REPLACES previous notes; `tags` APPENDS new comma-separated tags. The host never touches these fields outside this tool.

## Files touched

Host (`src/`):
- **NEW** `src/channels/telegram-meta.ts` — `buildMetaBlock(message): string`. Handles `from` skip when `sender_chat` present, all 4 forward kinds + unknown fallback, `reply_to_message` AND `external_reply` (with full payload) AND `reply_to_story`, `quote`, all `<media>` types with synthesized mime + sticker_kind, full `<entities>` enumeration, `<contact>`, `<location>`. Pure function, unit-testable.
- **NEW** `src/channels/telegram-enrich.ts` — bounded-rate `getChat` resolver; in-memory dedupe (24h success / 7d failure).
- **MOD** `src/channels/telegram.ts` — wire ALL FOUR update kinds: `bot.on('message:*')`, `bot.on('edited_message:*')`, `bot.on('channel_post:*')`, `bot.on('edited_channel_post:*')`. Each handler builds meta via `telegram-meta`, passes it as `NewMessage.meta`. Remove the auto-vision `processImage` call in `message:photo` and the `ImageAttachment[]` propagation.
- **MOD** `src/db.ts` — add `meta TEXT` column to `messages` (idempotent `ALTER TABLE ... ADD COLUMN` with try/catch); relax the `getNewMessages`/`getMessagesSince` filter to `(content != '' AND content IS NOT NULL) OR meta IS NOT NULL`; storeMessage carries `meta`; new `storeOutboundMessage(jid, text, channelMessageId)`; `contacts` schema + `upsertContact` (with COALESCE merge rules) + `promoteContactIdent` (column-wise MERGE in transaction) + `getContactsForGroup({scope, includeUnion?})` + `annotateContact` + `lookupMessages` (group-scoped, clamped, with `truncated` marker).
- **MOD** `src/ipc.ts` — extend with request handlers for `media-requests/` and `lookup-requests/`, response writers for matching `-responses/` dirs, **TTL sweep ONLY for the new namespaces** (180s, startup + 5min). The existing `errors/` directory is left alone (operator-review semantics preserved). Per-group `contacts.json` snapshot writer with **trailing-edge debounce, 500ms, per-scope timer**: each upsert (`upsert`/`annotate`/`promote`) calls `scheduleSnapshot(scope)` which `clearTimeout`+`setTimeout` keyed on scope; on fire writes current scope's snapshot. On SIGTERM, `flushAllSnapshots()` synchronously fires every pending timer before exit.
- **MOD** `src/container-runner.ts` — ensure new IPC sub-dirs exist when materializing per-group IPC; the `pendingImages` Map and `hasImages` branch in `src/index.ts` are removed in this same change set, along with the unused `pushWithImages` consumer in the agent-runner.
- **MOD** `src/router.ts` — `formatMessages` reads `messages.meta` alongside `content`. When meta present: emit `<message ...>${meta}\n${content?'<text>'+escapeXml(content)+'</text>':''}</message>`. When meta NULL: emit legacy `<message ...>${escapeXml(content)}</message>`. **`routeOutbound` becomes the outbound chokepoint**: calls `channel.sendMessage(...)`, awaits the returned `{messageId?}`, on success calls `storeOutboundMessage`. Throws propagate.
- **MOD** `src/types.ts` — `Channel.sendMessage` signature returns `Promise<{ messageId?: string } | void>`. `NewMessage.meta?: string`.
- **MOD** `src/index.ts` — every direct `channel.sendMessage(...)` migrated to `routeOutbound(channels, jid, text, opts)`. `pendingImages`+`hasImages` deleted.
- **MOD** `src/channels/gmail.ts` — `sendMessage` returns `{ messageId: rfc2822id }` from the gmail send response.

Container (`container/agent-runner/src/`):
- **MOD** `ipc-mcp-stdio.ts` — register 4 tools with the descriptions above. `writeIpcFile` extended to accept an optional `filenameOverride: string` parameter (when given, writes to `dir/<filenameOverride>` instead of generating a default). Shared helper `pollResponseFile(reqId, timeoutMs=120000, intervalMs=100)` for `view_media`/`lookup_messages`. Each call holds its own reqId. On timeout, returns `isError: true` with `_meta.error_code='TIMEOUT'`, `_meta.retryable=true`.

Tests:
- **NEW** `src/channels/telegram-meta.test.ts` — pure-function tests: forward (user/hidden/chat/channel + unknown kind fallback), reply (in-chat + external_reply with media+contact+location+poll+story + reply_to_story), quote, all media types (sticker mime synthesis static webp / animated tgs / video webm + sticker_kind regular/mask/custom_emoji), entities (all 10 emitted kinds incl. text_mention.is_bot), vCard, location, edited_message AND edited_channel_post markers, sender_chat detection (suppresses `<from>`), anonymous-admin / linked-channel auto-forward path.
- **MOD** `src/db.test.ts` — `upsertContact` insert→update with COALESCE preservation; `promoteContactIdent` column-wise MERGE when id-row pre-exists with notes/tags (verify notes preserved, tags appended); group-scope isolation; main-group union read; relaxed message-loop filter delivers photo-no-caption.
- **NEW** `src/ipc-mediarequest.test.ts` — happy path (stub Telegram getFile, write request, expect response file with correct reqId); timeout path (no response → tool gets TIMEOUT with `_meta.retryable=true`); oversized-file pre-flight (FILE_TOO_LARGE without calling getFile); pdftotext corruption (EXTRACTOR_OUTPUT_INVALID); startup sweep (orphan request gets TIMEOUT response written and request unlinked); `_meta.error_code` survives MCP serialization (round-trip through the SDK).

## Known limitations / risks

- **Edited messages lose history** — the previous version of a message is overwritten in `messages`. The user has the original in their Telegram client; the agent does not. Recovery would require diff storage; not in v1.
- **`getChat` resolves only public channels/supergroups** — per Bot API contract. User mentions of private accounts appear in contacts with `enriched=0`; the agent should not promise to "look someone up" by bare `@username` alone.
- **`pdftotext` / `pdftoppm` not installed** → `view_media` returns `EXTRACTOR_MISSING`. Document `brew install poppler` for macOS.
- **HEIC / HEIF / TIFF input** is not supported by the bundled `sharp` binary (libheif is not part of sharp's default prebuild). `view_media` returns `UNSUPPORTED_TYPE`. macOS users sharing iPhone photos as a Document hit this; sharing as a Photo upload via the Telegram client converts to JPEG and is unaffected.
- **Telegram DM limitation**: bots cannot DM an arbitrary user — the user must have `/start`ed the bot. "Write to that person" therefore means: bot composes a draft / supplies a t.me link / invokes an external tool, unless the recipient has already interacted with the bot.
- **Animated/video stickers and videos are not viewable** — `view_media` returns a descriptor, not pixels.
- **20MB file cap** — Telegram Bot API limit, not ours; pre-flight returns `FILE_TOO_LARGE`.
- **`processImage` resizes to 1024px long edge** — the existing helper's default. Anthropic vision accepts up to 1568px; v3 deliberately keeps the existing helper to avoid touching multiple call sites. Visible quality is fine; a future micro-fix could raise the cap.
- **PII storage**: third-party identifiers (names, usernames, phones, bios) per explicit user consent. The host-side DB is the primary store; the per-group `contacts.json` snapshot is mounted into the same group's container by design — group isolation is enforced at the mount boundary.
- **Token cost**: meta block adds ~150–400 chars per message (heavier rows for forwards-with-entities-with-vcard). 200-msg context ≈ 40–80KB extra. Tool descriptions add ~450 tokens to `tools/list` (≈doubles current tool description payload — still well within reasonable system-prompt budget).
- **Mixed history transition**: rows written before v3 have NULL `meta`; `formatMessages` falls back to emitting the legacy shape `<message>${escapeXml(content)}</message>` (no `<m>` envelope). The agent sees two formats during the transition window. A one-shot backfill is out of scope; the legacy prefix is human-readable so the agent copes.
- **First-turn freshness for `@mention` enrichment**: snapshot is debounced ≥500ms AND `getChat` is async post-delivery. If the user types "@some_channel что про него знаешь" and the agent calls `lookup_contacts` within the same turn, enrichment may not have completed. The agent should handle a missing/`enriched=0` row gracefully (the tool description warns about this).
- **Media + caption trigger in non-text handlers** (pre-existing): bot-mention rewriter only in `message:text`. Media with `@andy_ai_bot посмотри` caption in a non-main group doesn't trigger. v3 doesn't fix this (out of scope); flagged for a separate change.
- **Synthetic outbound ids for non-Telegram channels** — if a future channel's `sendMessage` returns void, outbound rows get `id="out-<ts>-<rand>"` with a `<m kind='outbound-synthetic'/>` meta. `lookup_messages({tg_message_id})` filters these out by default.
- **MessageOrigin evolution** — Bot API has historically added forward-origin variants (v7.0 introduced the union itself). v3 emits `<fwd kind='unknown' raw='{...}'/>` for any future variant, so forward context isn't silently dropped on Telegram upgrades.

## Out of scope (v1)

- Cross-group contact merging.
- Office document formats (.docx / .xlsx) extraction.
- Video / GIF frame extraction; OCR on stickers.
- Full-text search index (FTS5) on `messages` — v1 uses LIKE.
- Multi-channel media (Gmail attachments, Slack files).
- Diff-history for edited messages.

## Verification

- Unit: `npx vitest run src/channels/telegram-meta.test.ts src/db.test.ts src/ipc-mediarequest.test.ts` — all branches green.
- Integration (manual):
  1. Forward a channel post → `contacts` row with `kind='channel'`, derivable `link`, `enriched` later set to 1 via `getChat`.
  2. Reply to a media post asking "посмотри" (both in-chat AND cross-chat in a linked-channel discussion group, hitting `external_reply`).
  3. Mention `@some_public_channel` → after a few seconds, `contacts` row has `enriched=1` and `bio`.
  4. Mention `@some_private_user` → row created with `enriched=0`, no bio; no spurious retry storm.
  5. Album of 3 photos with one caption → 3 `<m media_group_id="...">` rows, agent correlates.
  6. **Anonymous admin post in supergroup** → `<sender_chat>` instead of `<from>` in meta; contacts row keyed on sender_chat id (NOT the synthetic GroupAnonymousBot).
  7. **Photo with no caption** → row appears in `getNewMessages` (filter relaxation); agent sees `<m><media type=photo file_id=.../></m>` with no `<text>`.
  8. **Corrupt PDF** sent as document → `view_media` returns `EXTRACTOR_OUTPUT_INVALID` (not silently empty).
  9. **HEIC document** → `view_media` returns `UNSUPPORTED_TYPE` with conversion hint.
  10. **Bot replies to user** → row appears in `messages` with real Telegram `message_id`; `lookup_messages({tg_message_id: <id>})` finds it.
  11. **Edit a channel post** in a chat where bot is in the channel → row gets `meta.edited=<ts>` AND new timestamp; message-loop re-delivers; contacts re-upsert.
  12. **`_meta.error_code` round-trip** — induce a `FILE_TOO_LARGE` and verify the agent's tool result has `_meta.error_code === 'FILE_TOO_LARGE'` (not stripped by MCP).
- Regression: existing message loop, scheduler, threadId routing, FIFO drain, sender allowlist, trigger detection, escapeXml on user text — all unchanged. Existing test suite stays green.

## Pre-implementation lessons (from v1 and v2 review)

Recorded so the next reviewer can verify they're addressed:
- v1 stored meta inside `messages.content` → escaped by `formatMessages` → unparseable XML. v2 separated `meta` and `text`.
- v1 placed `<m>` block at the start of `content` → `TRIGGER_PATTERN = ^@Andy\b` no longer matched. v2 kept content as raw text.
- v1 promised `getChat` enrichment for all `@mentions` → fails by Bot API contract for private users. v2 narrowed the promise.
- v1 missed `external_reply`, `reply_to_story`, `sender_chat`. v2 covered all three (sender_chat detection rule was still incomplete; v3 fixes that).
- v1 collapsed all forward kinds into one `<fwd>` schema with a `link` attribute that was never derivable for `kind='chat'`. v2 only emits `link` for `kind='channel'`.
- v1 left COALESCE-merge semantics implicit → notes/tags risked being clobbered. v2 spelled them out (but promotion still clobbered the id-row; v3 fixes with column-wise MERGE).
- v1 wrote contacts.json snapshot on every upsert with no debounce. v2 specified ≥500ms (mechanism unspecified; v3 specifies trailing-edge per-scope with SIGTERM flush).
- v1 hand-waved "TTL sweep similar to errors/" — but `errors/` has no actual sweep. v2 specified a 180s sweep (including `errors/`, which v3 removes — `errors/` is operator-review quarantine, not transient).
- v1 set `view_media` timeout at 30s → below typical 20MB Telegram download. v2 raised to 120s and added size pre-flight.
- v1 left `include_bot` parameter on `lookup_messages` dead. v2 added a storage hook (vague call-site enumeration; v3 pins a single chokepoint at `routeOutbound`).
- v1 left tool descriptions undefined. v2 shipped them.
- v1 listed `legacy forward_from*` as a fallback, but grammy ≥3.x dropped those fields. v2 removed the dead reference.
- **v2 critical defect 1**: photo-no-caption had `content=""`, which the message-loop filter excludes. v3 relaxes the filter to `OR meta IS NOT NULL`.
- **v2 critical defect 2**: `_nanoclaw_error_code` as a top-level field on `TextContent` is stripped by MCP SDK's Zod `$strip`. v3 uses the documented `_meta` extension point and redundantly prefixes the code in `text`.
- **v2 critical defect 3**: existing `writeIpcFile` hardcodes its own filename and ignores caller intent, so v2's `<reqId>.json` polling could never match the file on disk. v3 extends `writeIpcFile` with an optional `filenameOverride` parameter.
- **v2 high defect**: `promoteContactIdent` via `INSERT OR REPLACE` clobbers a pre-existing id-row's notes/tags. v3 does an explicit column-wise MERGE in the same transaction, preserving notes (id-row wins on non-null) and append-uniqueing tags.
- **v2 high defect**: `errors/` directory sweep destroyed operator-review quarantine. v3 only sweeps the new request/response namespaces.
- **v2 high defect**: `pdftotext` exits 0 even on corrupt PDF, returning empty stdout. v3 checks stderr for `Syntax Error`/`May not be a PDF file` AND treats empty-stdout-on-PDF as `EXTRACTOR_OUTPUT_INVALID`.
- **v2 high defect**: `sender_chat` and `from` coexist (Bot API places a synthetic GroupAnonymousBot user in `from` when `sender_chat` is set). v3 detection rule: if `sender_chat` is present, skip `<from>` and the from-upsert entirely.
- **v2 high defect**: `edited_message` doesn't fire for channel posts (Bot API splits into `edited_channel_post`). v3 wires all four update kinds.
- **v2 high defect**: `storeOutboundMessage` had no concrete id strategy. v3 widens `Channel.sendMessage` to return `{messageId?}`, captures the real Telegram message_id from grammy's send response, and routes all outbound through `routeOutbound` as a single chokepoint.
- **v2 medium**: HEIC unsupported by sharp's default build. v3 explicit `UNSUPPORTED_TYPE` branch.
- **v2 medium**: `external_reply` carries contact/location/poll/story/etc. — v2's `<reply external="1">` only mirrored origin+media. v3 enumerates the full set.
- **v2 medium**: `text_mention` dropped `is_bot`. v3 emits it and adds the column to `contacts`.
- **v2 medium**: poll cadence for `pollResponseFile` unspecified. v3 pins 100ms (host watcher is 1s, so 100ms is fast enough to not add latency, slow enough to not burn CPU).
- **v2 medium**: debounce mechanism value-only. v3 specifies trailing-edge per-scope timers with SIGTERM flush.
- **v2 medium**: `Sticker.type ∈ {regular, mask, custom_emoji}` is independent of `is_animated/is_video`. v3 emits `sticker_kind` attribute alongside the mime.
- **v2 medium**: `MessageOrigin` switch had no fallback. v3 emits `<fwd kind="unknown" raw="..."/>`.
- **v2 low**: retry budget "up to 3 attempts" ambiguous. v3 pins "initial + 3 retries = 4 total".
- **v2 low**: voice `transcript_status` state machine underspecified. v3 maps each value to its trigger.
- **v2 low**: tool-description token budget not addressed. v3 acknowledges in known limitations.
