# Rich Message Capture + Persistent People Memory + On-Demand Vision

Design spec for letting the NanoClaw agent operate on the full data of every Telegram message it receives — including forward origin, mentioned/forwarded people, reply targets, and media — with a passive long-term contacts memory and on-demand media access.

> **Revision history**
> - **v2 (2026-05-20, after critical review)** — addresses 40+ defects found by parallel auditors (bot-api, storage, ipc-mcp, media-vision, regression-fit, completeness). Key structural pivot: the structured metadata block lives in a **separate DB column**, not embedded in `messages.content`, to avoid `escapeXml` mangling and `TRIGGER_PATTERN ^` regression. Multiple smaller fixes (sender_chat, external_reply, COALESCE merge, mime synthesis, command flags, retry, error contract) folded into the relevant sections.
> - v1 (initial) — committed `ea6a614`. Showstoppers found during review; see "Pre-implementation lessons" at the end.

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

- Every inbound Telegram message attaches a single machine-readable XML block (`<m>...</m>`) to its delivery — **stored in a new `messages.meta` column, not interleaved into `content`**. The legacy `[Forwarded from ...]` / `[Reply to ...]` string prefixes are removed. `content` keeps only the user's raw text (so `TRIGGER_PATTERN` and existing text-based logic keep working unchanged).
- `formatMessages` (the function that wraps each row into `<message>...</message>` for the agent prompt) emits the metadata block alongside the text **without `escapeXml`-ing it** — we control the block's content, the user text is still escaped.
- Auto-vision is removed. Photos are no longer base64-inlined into the prompt. Media (any type) is represented in the structured block by its Telegram `file_id`; the agent calls `view_media` only when the user asks.
- A new SQLite table `contacts` holds a deterministic, per-group log of everyone the bot has seen — forward authors (user / hidden user / chat / channel), vCard contacts, direct senders, and mentioned identifiers (`text_mention` entities are upserted from the inline `User` object; bare `@username` entities are best-effort resolved via `getChat`, which the Bot API only documents as working for channels and public supergroups).
- The agent gets four new MCP tools: `lookup_contacts`, `annotate_contact`, `view_media`, `lookup_messages`. Each carries a precise `description` so the model knows when to invoke it.
- File and IPC isolation remain group-scoped; the container has no direct DB or Telegram access — both reach through the existing per-group IPC namespace. The `contacts.json` snapshot mounted into the container is the same data the DB holds for that group's scope, by design — there's no privacy gain in pretending otherwise; the actual boundary is the per-group mount.

## Structured message block

Format: a single `<m>` element. It lives in a new column `messages.meta TEXT`. At delivery time `formatMessages` emits:

```
<message sender="..." time="...">
<m id="123" date="2026-05-20T10:00:00Z" ...>  ← from messages.meta, NOT escaped
  ...
</m>
<text>escaped user text</text>                  ← from messages.content, escaped
</message>
```

XML matches existing project conventions (`<message>`, `<context>`, `<internal>`). All tags except `<m>` itself and `<text>` are optional and omitted when empty.

```
<m id="123" date="2026-05-20T10:00:00Z" media_group_id="42" edited="2026-05-20T10:01:00Z">
  <from id="222222222" un="vasya" name="Вася" premium="1" lang="ru"/>
  <!-- OR, when the post is from a chat/anonymous admin/auto-forward, instead of <from>: -->
  <sender_chat id="-1001..." kind="channel" un="durov" title="Durov"/>
  <fwd kind="channel" chat_id="-1001..." un="durov" title="Durov"
       sig="Pavel" orig_date="2026-05-01T..." orig_msg_id="123"
       link="https://t.me/durov/123"/>
  <reply mid="120" external="0" from_id="999" un="petya" name="Петя"
         snippet="первые ≤500 символов цитируемого">
    <media type="photo" file_id="AgAC..." file_unique_id="..." mime="image/jpeg" w="1280" h="960"/>
  </reply>
  <!-- For Bot API external_reply (cross-chat / cross-topic) the same <reply external="1"> shape is used,
       with origin attributes mirroring <fwd>. -->
  <reply_to_story chat_id="..." story_id="..."/>
  <quote>фрагмент Bot API 7.0 ручной цитаты</quote>
  <media type="document" file_id="BQAC..." file_unique_id="..." mime="application/pdf"
         name="report.pdf" size="20480"/>
  <entities>
    <url>https://example.com</url>
    <mention>target_user</mention>
    <textlink href="https://y.com">текст</textlink>
    <text_mention id="111" un="ivan" name="Иван"/>
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

Tag reference. *All attributes optional unless marked **req**.*

| Tag | Source (Bot API field on `Message`) | Notes |
|---|---|---|
| `<m>` (req) | the message itself | `id`=message_id; `date`=ISO; `media_group_id` when present (album correlation); `edited`=ISO of edited_message edit, omitted on first delivery |
| `<from>` | `from?: User` | Omitted when `from` is absent (channel posts, anonymous admins, linked-channel auto-forwards). `un` is username without `@`. |
| `<sender_chat>` | `sender_chat?: Chat` | Emitted INSTEAD of `<from>` when the message is on behalf of a chat (anonymous admin in supergroup, linked channel auto-forward). `kind` ∈ {private, group, supergroup, channel}. |
| `<fwd>` | `forward_origin` (Bot API 7.0+) | `kind` ∈ {user, hidden_user, chat, channel}. `link` is derivable **only** for `kind='channel'` (only `MessageOriginChannel` carries `message_id`). For `kind='chat'`, `link` is omitted. Legacy `forward_from*` fields are NOT used (not present in grammy ≥3.x types). |
| `<reply>` | `reply_to_message?: Message` OR `external_reply?: ExternalReplyInfo` | `external="0"` for in-chat reply, `external="1"` when sourced from `external_reply` (cross-chat / linked-channel discussion group). The external case carries `origin` attributes (same shape as `<fwd>`) plus media. |
| `<reply_to_story>` | `reply_to_story?: Story` | New top-level reply target distinct from message replies. |
| `<quote>` (text) | `quote?.text` (Bot API 7.0+) | The manual partial-text quotation Telegram added in 7.0. |
| `<media>` | `photo` / `video` / `voice` / `audio` / `document` / `sticker` / `animation` / `video_note` | `type`, `file_id` (req), `file_unique_id`, `mime`, `size`, type-specific (`w`,`h`,`duration`,`name`,`emoji`). For **stickers and photos**, the Bot API does NOT include a `mime_type` field; the host **synthesizes**: stickers→`is_animated=true` → `application/x-tgsticker`; `is_video=true` → `video/webm`; else → `image/webp`. Photos → always `image/jpeg` (Telegram convention). |
| `<media transcript=... transcript_status=...>` | voice/video_note | Voice transcription via Groq path is preserved. `transcript_status` ∈ {ok, failed, missing_key, skipped}. When `ok`, `transcript` holds the text; otherwise the attribute is absent and the user-visible text body in `<text>` falls back to a placeholder. |
| `<entities>` | `message.entities` | Children: `<url>`, `<mention>` (text-only @, lowercase, no `@`), `<textlink href>`text`</textlink>`, `<text_mention id un name/>`, `<custom_emoji id/>`, `<hashtag>`, `<cashtag>`, `<bot_command>`, `<phone>`, `<email>`. Formatting-only entities (`bold`, `italic`, `code`, `pre`, `spoiler`, `blockquote`) are dropped — agent gets the visible text anyway. |
| `<contact>` | `message.contact?: Contact` | `phone`, `name`, `user_id`, `vcard_raw` (full vCard string preserved for later parsing). |
| `<location>` | `message.location` / `message.venue` | `lat`, `lon`, `title`, `address`. |

All block construction lives in one module so every channel handler is one-line: `const meta = buildMetaBlock(message);` and `onMessage` carries `meta` as a separate field on `NewMessage`.

### Handling edited messages

When Telegram delivers `edited_message`, the host upserts the same `messages` row (PK is `(id, chat_jid)`) — `meta` is rewritten with `edited=<ts>`, contacts re-upserted (in case the edit added/removed entities). The agent receives the EDITED row on the next message-loop tick as if it were new; the previous version is no longer in DB. **Trade-off accepted:** the agent doesn't see the edit history. Rationale: the user can re-state if needed, and storing diff history multiplies storage cost. Listed in known limitations.

### Albums (`media_group_id`)

Telegram delivers a multi-photo album as **N separate Updates** sharing one `media_group_id`. Only the first usually carries the caption. The host writes each as its own `<m media_group_id="...">` row; the agent correlates them via the shared id. No server-side reassembly in v1.

## Contacts memory

### Schema (SQLite, host-side)

```sql
CREATE TABLE IF NOT EXISTS contacts (
  ident       TEXT PRIMARY KEY,         -- "<scope>|id:<tgId>" | "<scope>|un:<lower>" | "<scope>|name:<lower>"
  scope       TEXT NOT NULL,            -- group_folder; isolation boundary
  tg_id       TEXT,
  username    TEXT,                     -- lowercased, no '@'
  kind        TEXT NOT NULL,            -- 'user' | 'hidden_user' | 'chat' | 'channel'
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
CREATE INDEX IF NOT EXISTS contacts_scope_tg_id ON contacts(scope, tg_id);
```

Identity resolution at upsert: prefer `tg_id` (`"<scope>|id:<tgId>"`); else lowered `username` (`"<scope>|un:<u>"`); else `lowered(first_name+last_name)` (`"<scope>|name:<n>"`). When a row was first written under `un:` and a later inbound reveals `tg_id`, the host **promotes** the row in a single transaction: copy fields and `notes`/`tags` from the `un:` row into a new `id:` row via `INSERT OR REPLACE`, then delete the `un:` row. This eliminates the v1 duplicate-row hazard the original spec acknowledged.

### Upsert merge semantics

The host upsert uses `ON CONFLICT(ident) DO UPDATE SET` with explicit per-column rules (matches the convention in `src/db.ts:194-211`):

| Column | Conflict rule |
|---|---|
| `first_name`, `last_name`, `title`, `phone`, `link` | `COALESCE(excluded.X, contacts.X)` — keep existing non-null, fill in from new |
| `bio` | `COALESCE(excluded.bio, contacts.bio)` — getChat-supplied, sticky |
| `kind`, `source` | overwrite (most recent observation wins) |
| `enriched` | `MAX(contacts.enriched, excluded.enriched)` — once true, stays true |
| `first_seen` | preserved (`contacts.first_seen`) |
| `last_seen` | overwrite (`excluded.last_seen`) |
| `seen_count` | `contacts.seen_count + 1` |
| `notes`, `tags` | **NEVER touched by host** — only `annotate_contact` writes |

This guarantees notes/tags written by the agent are never clobbered by a subsequent inbound, and enriched bio survives sparse later observations.

### Scope and main-group cross-scope view

Per-group isolation by default: `contacts.scope = group_folder`. The agent in group X queries only X's contacts.

The **main group** sees a UNION across all groups, following the existing precedent at `src/container-runner.ts:884` (`writeGroupsSnapshot` emits all groups when `isMain`). Rationale: the user usually issues "напиши Пете" in their main chat, and Petya was learned in a sibling group. The snapshot writer emits `contacts.json` filtered to the consuming group's scope when not main, OR the union for main.

### Host upsert rules (when and what)

Order on every inbound message (BEFORE `storeMessage`, to keep upsert observable to the agent on the same turn):

| Trigger | Source value | Notes |
|---|---|---|
| `message.from` | `sender` | When `from` is present |
| `message.sender_chat` | `sender` | When the message is on behalf of a chat (anonymous admin / auto-forward); upserted with `kind='channel'` or `'chat'` |
| `forward_origin` (any kind) or, in `external_reply`, its origin | `forward` | `hidden_user` keys on lowered name (best effort) |
| `reply_to_message.from` | `reply` | Only when reply target carries a `from` |
| `external_reply` origin author | `reply` | When external_reply present, its `origin` carries the author |
| `message.contact` (vCard) | `vcard` | populates `phone`; if `user_id` present, key on it |
| `entities[type='text_mention'].user` | `text_mention` | The entity already carries a full `User` object — upsert immediately, no network call |
| `entities[type='mention']` (bare `@username`) | (queued for enrichment) | See below |

**`@username` (bare mention) enrichment** is fire-and-forget after delivery, with explicit scope:

- Only attempt `getChat('@'+username)` when the username plausibly resolves: per Bot API docs, this works for **channels and public supergroups**. For private users, getChat returns `Bad Request: chat not found` ≈always — so the spec **does not** claim enrichment for arbitrary user mentions.
- A baseline row is upserted on first sight (`source='mention'`, `enriched=0`) so the agent's `lookup_contacts` at least knows the username exists.
- The host queues one getChat per (scope, username) per 24h. On success → upsert `source='getChat'`, `enriched=1`, `bio`, and (if returned) `tg_id`/`title`/`first_name`. On 400/404 → leave row at `enriched=0` and skip future attempts for 7 days.
- Rate limiting: in-process token bucket of 1 getChat/sec (Telegram's documented soft cap). Overflow is queued, not dropped.

## On-demand media (`view_media`)

Container has no Telegram token or network to Telegram (credential proxy only forwards to Anthropic). The host performs every download. Mechanism: request/response over file IPC.

### Flow

1. Agent reads a `file_id` from the structured block of the current message, its `<reply>` block, or a historical message via `lookup_messages`.
2. Agent calls `view_media({ file_id, mode?: 'auto'|'image'|'text', pages?: 'N-M' })`.
3. The tool writes `data/ipc/<group>/media-requests/<reqId>.json` (filename returned by `writeIpcFile`) and **polls** `data/ipc/<group>/media-responses/<reqId>.json` with a **120s bounded timeout** (revised from v1's 30s; a 20MB document on a slow link can exceed 30s end-to-end).
4. Host watcher (extended `src/ipc.ts`): validates the request comes from the group's IPC namespace (existing per-group isolation = authorization), pre-checks `message.document.file_size` (already in the structured block) against the **20MB Bot API cap** — if exceeded, writes a structured error response immediately (no `getFile` attempt). Else: calls Telegram `getFile(file_id)` → downloads → routes by mime → writes response → deletes the request file.
5. Tool reads the response, returns it as an MCP content block.

### reqId generation and correlation

`reqId = "${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}"` — collision odds vanishingly small in the per-group window. Request filename equals reqId; the response filename must equal the request reqId (the host reads the request filename, writes the response under the same name). Concurrent calls in one agent turn each poll only their own `<reqId>.json` — no shared watcher state.

### Retry and timeout

- Telegram `getFile` and the actual file download retry on 429/503/5xx with exponential backoff up to 3 attempts (mirrors the existing `credential-proxy` policy at `src/credential-proxy.ts:28+`). On 4xx other than 429 → no retry.
- If 120s elapses before a response file appears, the tool returns a structured timeout error. The host's watcher independently sweeps `media-requests/` on startup AND every 5 minutes: any request file older than 180s gets a timeout-error response written, then the request is unlinked. This handles host restarts mid-flight, crashed containers, and runaway downloads.
- `media-responses/` files older than 180s are unlinked unconditionally (sweep at startup + every 5 min). Container is expected to read+unlink under normal flow; the sweep handles missed cases.

### Mime routing (`mode='auto'` default)

| Mime / type | Handling | MCP content returned |
|---|---|---|
| `image/*` (incl. image documents, static stickers via synthesized mime) | download → `processImage()` (existing helper at `src/image.ts`) — always re-encodes to JPEG quality 85 | `{ type:'image', data, mimeType:'image/jpeg' }` |
| `application/x-tgsticker` (animated TGS), `video/webm` (video sticker), `video/mp4` (video) | not downloaded | `{ type:'text', text:'тип X не отображается; <descriptor: kind, duration, size>' }` |
| `application/pdf` (default `mode:'auto'` or `mode:'text'`) | `pdftotext -layout -enc UTF-8 -nopgbrk - -` (stdin/stdout); truncate output to ≤500KB with `…[truncated]` marker | `{ type:'text', text }` |
| `application/pdf` (`mode:'image'`, with `pages:'N-M'`, **default `'1-1'`, hard cap 10 pages**) | `pdftoppm -jpeg -r 150 -f N -l M <tmpfile> <prefix>` then read each `<prefix>-K.jpg` (then unlink) | array of `{ type:'image', data, mimeType:'image/jpeg' }`, one per page; reject if N..M is open-ended or spans > 10 pages |
| `text/*`, JSON/YAML/Markdown | UTF-8 decode, trim to ≤200KB | `{ type:'text', text }` |
| voice (any), audio (non-image) | not downloaded by view_media; transcript already lives in `<m><media transcript=...>` | `{ type:'text', text:'voice: see message transcript' }` |
| other (office, archives, unknown) | no download | `{ type:'text', text:'тип X не отображается; <descriptor>' }` |

`pdftotext` / `pdftoppm` come from `poppler-utils` (macOS: `brew install poppler`). When the binary is absent, the host returns the structured error `EXTRACTOR_MISSING` — the rest of the system keeps working.

### Error contract

All `view_media` and `lookup_messages` errors return as **MCP tool errors** (`isError: true`) with structured content:

```json
{ "isError": true,
  "content": [{ "type": "text",
                "text": "<error_code>: <human message>",
                "_nanoclaw_error_code": "<code>" }] }
```

Error codes:

| Code | When |
|---|---|
| `TIMEOUT` | 120s polling exhausted |
| `FILE_TOO_LARGE` | `file_size > 20MB` (pre-flight) |
| `FILE_EXPIRED` | Telegram `getFile` returns "file is too old" |
| `EXTRACTOR_MISSING` | `pdftotext`/`pdftoppm` not on PATH |
| `UNSUPPORTED_TYPE` | mime not in any image/text branch |
| `PAGES_OUT_OF_RANGE` | `pages` exceeds 10-page cap or invalid range |
| `UPSTREAM_ERROR` | `getFile` non-retryable error after retries |

The agent SDK surfaces tool errors visibly to the model (not silently consumed), so the agent can explain to the user "не смог посмотреть файл — слишком большой" instead of hallucinating around an opaque failure.

### Reply / forward "посмотри" workflows

- User replies to a media message with "посмотри X" → new message's `<m><reply><media file_id=.../></reply></m>` → agent calls `view_media(file_id)`. Works for both `reply_to_message` (in-chat) and `external_reply` (cross-chat: linked-channel discussion groups).
- User forwards a media message and adds their own text including "посмотри" → the forward IS the current message; its `<m>` has top-level `<media file_id=.../>` AND the text the user added is in `<text>`. Agent → `view_media(file_id)`.
- Historical media → agent finds the `file_id` via `lookup_messages` (returns each row's `meta` column including `<media>`) → `view_media(file_id)`. Telegram file_ids are stable for the originating bot ("`file_id` may be used to download or reuse this file" — Bot API docs and FAQ).

## Conversation access (`lookup_messages`)

The existing message loop feeds the recent batch (FIFO, capped per `getMessagesSince`). For older history, reply-chain walking, or targeted lookups, the agent uses a new tool.

```
lookup_messages({
  tg_message_id?,     // jump to a specific message id
  sender_id?,         // filter by author tg id
  since?, until?,     // ISO range
  query?,             // substring, case-insensitive LIKE on text (NOT on meta)
  include_bot?,       // default false — bot's own replies excluded
  limit?              // default 50; server clamps to ≤200
}) -> formatted text (same style as formatMessages) including each row's meta + text
```

Hard caps enforced server-side:
- `limit` clamped to `[1, 200]` regardless of caller input.
- Response body truncated to ≤500KB; on truncation, a final `<truncated count="N"/>` row is appended so the agent knows there's more.
- When ALL filters are empty (`{}`), defaults to last 50 messages in the group's chats — never returns the full table.

**`include_bot` honesty:** bot outbound replies are currently NOT stored in `messages` — verified via grep. This implementation therefore **also adds** writing outbound bot text to `messages` with `is_from_me=1, is_bot_message=1` so `include_bot=true` actually returns the bot's past replies. Without this, the parameter is dead. The storage hook is in the wrapped `channel.sendMessage` lambda at `src/index.ts` (around the scheduler/IPC outbound paths and the streaming output callback).

Reply chain walking is just repeated calls: `<reply mid="X">` → `lookup_messages({tg_message_id: X})` → its `<reply mid="Y">` → another call. No special primitive.

## MCP tool descriptions

Each new tool ships a verbose `description` (mirrors the style of existing `schedule_task` description). The exact text is part of this spec because the agent's invocation behavior depends on it:

**`view_media`**:
> Fetch a Telegram media file by `file_id` and return it to the conversation. Use this when the user asks to look at / view / show / посмотри / покажи a photo, image, sticker, document, or PDF that you have a `file_id` for (from the current message's `<media>`, its `<reply><media>`, or a historical row from `lookup_messages`). `mode` defaults to `auto`: images come back as images, PDFs as extracted text, text files as text. Use `mode:'image'` with `pages:'1-3'` for visual PDF rendering (max 10 pages). Returns an MCP error with a specific error_code on failure — relay the code to the user instead of guessing.

**`lookup_messages`**:
> Search this group's stored message history. Use this when the user references something older than what's visible in the current context, when walking a reply chain (`<reply mid="X">`), or when you need to find a specific message by id/sender/date. Filters: `tg_message_id`, `sender_id`, `since`/`until`, `query` (text substring). Default returns last 50; max 200. Does NOT call out to Telegram — purely local DB.

**`lookup_contacts`**:
> Search this group's known people/contacts. Use this when the user references "Петя" / "тот чувак из канала Х" / "@username" / a phone number and you need contact details (id, username, bio, notes, tags). Pass `query` for free-text, `username` for exact (lowercase, no `@`), `tg_id` for exact. Returns at most `limit` rows (default 50).

**`annotate_contact`**:
> Attach a note or tag to a known contact so you remember the relationship later. Use this when the user tells you something durable about a person ("Петя — мой партнёр", "она занимается дизайном"). Identify the contact by ONE of `ident`, `username`, `tg_id`. `notes` REPLACES previous notes (use it for the canonical summary); `tags` APPENDS new comma-separated tags. The host never touches these fields outside this tool.

## Files touched

Host (`src/`):
- **NEW** `src/channels/telegram-meta.ts` — `buildMetaBlock(message): string` from a Telegram `Message`. Handles `from`/`sender_chat`, `forward_origin` (all 4 kinds), `reply_to_message` AND `external_reply` AND `reply_to_story`, `quote`, all `<media>` types with synthesized mime, full `<entities>` enumeration, `<contact>`, `<location>`. Pure function, fully unit-testable.
- **NEW** `src/channels/telegram-enrich.ts` — bounded-rate `getChat` resolver; in-memory dedupe (24h success / 7d failure).
- **MOD** `src/channels/telegram.ts` — every message handler (text/photo/document/voice/sticker/animation/contact/location/video AND `edited_message`) builds meta via `telegram-meta`, passes it as `NewMessage.meta`. Removes the auto-vision `processImage` call in `message:photo` and the `ImageAttachment[]` propagation. Trigger detection continues to test against `message.text` only (unchanged path; the rewrite preserves it for non-text handlers via caption checks where applicable).
- **MOD** `src/db.ts` — add `meta TEXT` column to `messages` (idempotent `ALTER TABLE ... ADD COLUMN` with try/catch, matching existing migration style); `contacts` schema + `upsertContact` (with COALESCE merge rules) + `promoteContactIdent` (id-promotion) + `getContactsForGroup({scope, includeUnion?})` + `annotateContact` + `lookupMessages` (group-scoped, clamped, with `truncated` marker).
- **MOD** `src/ipc.ts` — extend with request handlers for `media-requests/` and `lookup-requests/`, response writers for the matching `-responses/` dirs, **actual TTL sweep** for both request and response files (180s, runs on startup and every 5 min) AND for the existing `errors/` dir (which currently has no cleanup — confirmed by grep). Per-group `contacts.json` snapshot writer with **debounce (≥500ms)** — coalesces upsert bursts so a 20-message Telegram burst doesn't trigger 60 disk writes.
- **MOD** `src/container-runner.ts` — ensure new IPC sub-dirs exist when materializing per-group IPC; the `pendingImages` Map and `hasImages` branch in `src/index.ts` are removed in this same change set, along with the unused `pushWithImages` consumer in the agent-runner (no channel currently writes `NewMessage.images`).
- **MOD** `src/router.ts` — `formatMessages` reads `messages.meta` alongside `content`; emits unescaped `<m>...</m>` followed by `<text>${escapeXml(content)}</text>` inside the `<message>` envelope. Keeps `content`-only fallback for rows that have no meta (pre-migration history).
- **MOD** `src/index.ts` — `NewMessage` gains `meta?: string`; `storeMessage` receives and persists it; outbound bot text is stored via a new `storeOutboundMessage` call so `lookup_messages({include_bot:true})` actually has data; delete `pendingImages`+`hasImages`.

Container (`container/agent-runner/src/`):
- **MOD** `ipc-mcp-stdio.ts` — register 4 tools with the descriptions above. Shared helper `pollResponseFile(reqId, timeoutMs)` for `view_media`/`lookup_messages`. Each call holds its own reqId; concurrent calls are independent. On timeout, returns `isError:true` with `_nanoclaw_error_code: 'TIMEOUT'`.

Tests:
- **NEW** `src/channels/telegram-meta.test.ts` — pure-function tests: forward (user/hidden/chat/channel), reply (in-chat + external_reply + reply_to_story), quote, all media types (incl. sticker mime synthesis: static webp / animated tgs / video webm), entities (all 10 emitted kinds), vCard, location, edited_message marker, sender_chat path (anonymous admin / linked-channel auto-forward).
- **MOD** `src/db.test.ts` — `upsertContact` insert→update with COALESCE preservation (notes/tags never touched, bio sticky, seen_count increments); `promoteContactIdent` (un→id row consolidation); group-scope isolation; main-group union read.
- **NEW** `src/ipc-mediarequest.test.ts` — happy path (stub Telegram getFile, write request, expect response file with correct reqId), timeout path (no response within 120ms test override → tool gets TIMEOUT), oversized-file pre-flight (FILE_TOO_LARGE without calling getFile), startup sweep (orphan request gets TIMEOUT response written and request unlinked).

## Known limitations / risks

- **Edited messages lose history** — the previous version of a message is overwritten in `messages`. The user has the original in their Telegram client; the agent does not. Recovery would require diff storage; not in v1.
- **`getChat` resolves only public channels/supergroups** — per Bot API contract. User mentions of private accounts will appear in contacts with `enriched=0` and only the username; the agent should not promise to "look someone up" by bare `@username` alone.
- **`pdftotext` / `pdftoppm` not installed** → `view_media` returns `EXTRACTOR_MISSING`. Document `brew install poppler` for macOS.
- **Telegram DM limitation**: Telegram bots cannot DM an arbitrary user — the user must have `/start`ed the bot. "Write to that person" therefore means: bot composes a draft / supplies a t.me link / invokes an external tool, unless the recipient has already interacted with the bot.
- **Animated/video stickers and videos are not viewable** — `view_media` returns a descriptor, not pixels. Frame extraction is out of scope.
- **20MB file cap** — Telegram Bot API limit, not ours; pre-flight returns `FILE_TOO_LARGE` immediately.
- **PII storage**: third-party identifiers (names, usernames, phones from vCards) per explicit user consent. The host-side DB is the primary store; the per-group `contacts.json` snapshot is mounted into the same group's container by design (it's how the agent reads contacts) — this is **not** a privacy regression vs the structured block in messages, which contains the same identifiers and is also mounted.
- **Token cost**: meta block adds ~150–300 chars per message in the formatted prompt; 200-msg context ≈ 30–60KB extra. Acceptable.
- **Mixed history transition**: rows written before this change have no `meta` column populated; `formatMessages` falls back to emitting their `content` (which still has the legacy `[Forwarded from X]` strings). The agent therefore sees two formats during the transition window. A one-shot backfill job is **out of scope for v1** — the legacy prefix is human-readable so the agent copes.
- **Snapshot is the same data as the DB rows it serves** — explicit. Group-isolation is enforced at the mount boundary, not by "the DB isn't mounted" (which was a misleading framing in v1).
- **First-turn freshness for `@mention` enrichment**: the snapshot is debounced ≥500ms AND `getChat` is async post-delivery. If the user types "@some_channel что про него знаешь" and the agent calls `lookup_contacts` within the same turn, the enrichment may not yet have completed. The agent should handle a missing/`enriched=0` row gracefully (say "не знаю про @X, проверю позже" rather than hallucinate) and may retry in the next turn. Tool description explicitly documents that `lookup_contacts` is local DB only.
- **Media + caption trigger in non-text handlers** (pre-existing): `TRIGGER_PATTERN ^@Andy\b` is currently tested against `m.content.trim()`, and the bot-mention rewriter at `src/channels/telegram.ts` lives only inside `message:text`. A photo with caption `@andy_ai_bot посмотри` in a non-main group already fails to trigger. v1's structured-block prepend made this worse (broke all triggers); v2 restores the prior behavior but **does not fix the pre-existing media-caption gap**. Out of scope for this spec; flagged for a separate fix.

## Out of scope (v1)

- Cross-group contact merging (a user appearing in main AND family-group remains two `contacts` rows; main's union snapshot returns both — the agent reconciles via `annotate_contact`).
- Office document formats (.docx / .xlsx) extraction.
- Video / GIF frame extraction; OCR on stickers.
- Full-text search index (FTS5) on `messages` — v1 uses LIKE; revisit if `lookup_messages` becomes slow.
- Multi-channel media (Gmail attachments, Slack files) — Telegram only in v1. Gmail keeps its existing `[Email from ...]` text prefix; the agent encounters mixed grammar in the main group's prompt (Telegram has `<m>`, Gmail has `[Email from ...]`). Acceptable for v1; documented.
- Diff-history for edited messages.

## Verification

- Unit: `npx vitest run src/channels/telegram-meta.test.ts src/db.test.ts src/ipc-mediarequest.test.ts` — all branches green.
- Integration (manual):
  1. Forward a channel post → `contacts` row appears with `kind='channel'`, derivable `link`, `enriched` later set to 1 via `getChat`.
  2. Reply to a media post asking "посмотри" → bot calls `view_media`, returns the image. Verify both in-chat reply and cross-chat reply (linked-channel discussion group, hitting `external_reply`).
  3. Mention `@some_public_channel` → after a few seconds, `contacts` row has `enriched=1` and `bio`.
  4. Mention `@some_private_user` → row created with `enriched=0`, no bio; no spurious retry storm in logs.
  5. Album of 3 photos with one caption → 3 `<m media_group_id="...">` rows, agent correlates.
  6. Anonymous admin post in supergroup → `<sender_chat>` instead of `<from>` in meta; contacts row keyed on sender_chat id.
- Regression: existing message loop, scheduler, threadId routing, FIFO drain, sender allowlist, trigger detection, **escapeXml on user text** — all unchanged. Existing test suite stays green.

## Pre-implementation lessons (from v1 review)

Recorded so the next round of reviewers can verify they're addressed:
- v1 stored meta inside `messages.content` → escaped by `formatMessages` → unparseable XML. v2 separates `meta` and `text`.
- v1 placed `<m>` block at the start of `content` → `TRIGGER_PATTERN = ^@Andy\b` no longer matched → bot stopped responding in non-main groups. v2's `content` is unchanged; trigger detection works as before.
- v1 promised `getChat` enrichment for all `@mentions` → fails by Bot API contract for private users. v2 narrows the promise + adds a 7-day failure-cache.
- v1 missed `external_reply`, `reply_to_story`, `sender_chat`. v2 covers all three.
- v1 collapsed all forward kinds into one `<fwd>` schema with a `link` attribute that was never derivable for `kind='chat'`. v2 only emits `link` for `kind='channel'`.
- v1 left COALESCE-merge semantics implicit → notes/tags risked being clobbered. v2 spells them out.
- v1 wrote contacts.json snapshot on every upsert with no debounce → up to 4 snapshot rebuilds per inbound. v2 specifies ≥500ms debounce.
- v1 hand-waved "TTL sweep similar to errors/" — but `errors/` has no actual sweep. v2 specifies the sweep (180s, every 5 min, on startup) and adds it to `errors/` too.
- v1 set `view_media` timeout at 30s — below typical 20MB Telegram download time. v2 raises to 120s and adds size pre-flight to short-circuit oversized files.
- v1 left `include_bot` parameter on `lookup_messages` dead because outbound bot text is never stored. v2 adds the storage hook.
- v1 left tool descriptions undefined. v2 ships them inline.
- v1 listed `legacy forward_from*` as a fallback, but grammy ≥3.x dropped those fields. v2 removes the dead reference.
