# Rich Message Capture + Persistent People Memory + On-Demand Vision

Design spec for letting the NanoClaw agent operate on the full data of every Telegram message it receives — including forward origin, mentioned/forwarded people, reply targets, and media — with a passive long-term contacts memory and on-demand media access.

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

- Every inbound Telegram message delivers a single machine-readable XML block prepended to `content`; the legacy `[Forwarded from ...]` / `[Reply to ...]` string prefixes are removed.
- Auto-vision is removed. Photos are no longer base64-inlined into the prompt. Media (any type) is represented in the structured block by its Telegram `file_id`; the agent calls `view_media` only when the user asks.
- A new SQLite table `contacts` holds a deterministic, per-group log of everyone the bot has seen — forward authors (user / hidden user / chat / channel), vCard contacts, direct senders, and mentioned `@username`s (the last resolved live via Telegram `getChat`).
- The agent gets four new MCP tools: `lookup_contacts`, `annotate_contact`, `view_media`, `lookup_messages`.
- File and IPC isolation remain group-scoped; the container has no direct DB or Telegram access — both reach through the existing per-group IPC namespace.

## Structured message block

Format: a single `<m>` element prepended to `content`, with nested tags for present fields only. XML matches existing project conventions (`<message>`, `<context>`, `<internal>`), parses reliably for the model, and survives storage in `messages.content`.

```
<m id="123" date="2026-05-20T10:00:00Z">
  <from id="222222222" un="vasya" name="Вася" premium="1" lang="ru"/>
  <fwd kind="channel" chat_id="-1001..." un="durov" title="Durov"
       sig="Pavel" orig_date="2026-05-01T..." link="https://t.me/durov/123"/>
  <reply mid="120" from_id="999" un="petya" name="Петя"
         snippet="первые ~500 символов цитируемого">
    <media type="photo" file_id="AgAC..." mime="image/jpeg" w="1280" h="960"/>
  </reply>
  <quote>фрагмент Bot API 7.0 ручной цитаты</quote>
  <media type="document" file_id="BQAC..." mime="application/pdf"
         name="report.pdf" size="20480"/>
  <entities>
    <url>https://example.com</url>
    <mention>target_user</mention>
    <textlink href="https://y.com">текст</textlink>
  </entities>
  <contact phone="+79991234567" name="Иван" user_id="888"/>
  <location lat="55.75" lon="37.61" title="Кафе"/>
</m>
актуальный текст сообщения
```

Tag reference (all attributes optional unless noted):

| Tag | Source (Bot API) | Attributes |
|---|---|---|
| `<m>` (root) | `message` | `id` (telegram message_id), `date` (ISO from `message.date`) |
| `<from>` | `message.from` | `id`, `un` (username, no `@`), `name` (first+last), `premium`, `lang` |
| `<fwd>` | `message.forward_origin` (7.0+) or legacy `forward_from*` | `kind` ∈ {user,hidden_user,chat,channel}, `id`, `un`, `title`, `sig` (author_signature), `orig_date`, `link` (t.me when derivable) |
| `<reply>` | `message.reply_to_message` | `mid`, `from_id`, `un`, `name`, `snippet` (≤500 chars). Nests `<media>` if reply target has media |
| `<quote>` (text content) | `message.quote.text` (7.0+) | — |
| `<media>` | `message.{photo,video,voice,audio,document,sticker,animation,video_note}` | `type`, `file_id`, `file_unique_id`, `mime`, `size`, type-specific (`w`,`h`,`duration`,`name`,`emoji`) |
| `<entities>` | `message.entities` | child `<url>`, `<mention>` (un without `@`), `<textlink href>`, `<text_mention id un>`, `<phone>`, `<email>` |
| `<contact>` | `message.contact` | `phone`, `name`, `user_id`, optional `vcard` |
| `<location>` | `message.location`/`venue` | `lat`, `lon`, `title`, `address` |

All block construction lives in one module so every channel handler is one-line: `content = buildMetaBlock(message) + '\n' + (text || '')`.

## Contacts memory

### Schema (SQLite, host-side)

```sql
CREATE TABLE contacts (
  ident       TEXT PRIMARY KEY,         -- "<scope>|id:<tgId>" | "<scope>|un:<lower>" | "<scope>|name:<n>"
  scope       TEXT NOT NULL,            -- group_folder; isolation boundary
  tg_id       TEXT,
  username    TEXT,                     -- without "@", lowercased
  kind        TEXT NOT NULL,            -- 'user' | 'hidden_user' | 'chat' | 'channel'
  first_name  TEXT,
  last_name   TEXT,
  title       TEXT,                     -- for chat/channel
  phone       TEXT,
  link        TEXT,                     -- t.me link if derivable
  bio         TEXT,                     -- from getChat enrichment
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  seen_count  INTEGER NOT NULL DEFAULT 1,
  source      TEXT NOT NULL,            -- 'sender' | 'forward' | 'reply' | 'vcard' | 'mention' | 'getChat'
  enriched    INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,                     -- freeform, written by agent
  tags        TEXT                      -- comma-separated, written by agent
);
CREATE INDEX contacts_scope_username ON contacts(scope, username);
CREATE INDEX contacts_scope_tg_id ON contacts(scope, tg_id);
```

Identity resolution at upsert: prefer `tg_id` (`"<scope>|id:<tgId>"`); else lowered `username` (`"<scope>|un:<u>"`); else best-effort `name`. A person first seen by `@username` and later by id can produce two rows in v1 — see Known limitations.

### Host upsert rules

For every inbound message, deterministically and synchronously upsert (before agent delivery):

| Trigger | Source value | Notes |
|---|---|---|
| `message.from` | `sender` | always |
| `forward_origin` (user/hidden/chat/channel) or legacy `forward_from*` | `forward` | `hidden_user` keys on name (best effort) |
| `reply_to_message.from` | `reply` | only when reply target is present |
| `message.contact` (vCard) | `vcard` | populates `phone`; if `user_id` present, key on it |

For `@mention` / `text_mention` entities in inbound messages, run an async post-delivery enrichment job that does not block the message loop:

- For `@username` (entity `mention`): host calls `bot.api.getChat('@'+username)` → maps result to a contact row → upsert with `source='getChat'`, `enriched=1`, `bio` from `description`/`bio`.
- For `text_mention` (entity carries a `User` object): upsert with the inline user data; no extra network call.
- In-memory throttle: don't re-enrich a (scope, username) pair if `enriched=1` and `last_seen` is within 24h.
- All failures (404, 400, rate limit) become debug log entries.

### MCP tools

Both follow existing patterns (`list_tasks` for reads, `schedule_task` for writes).

**`lookup_contacts({ query?, username?, tg_id?, limit? })`** — read path
- Host periodically writes `data/ipc/<group>/contacts.json` (snapshot of contacts for that scope) and refreshes on upsert/annotate.
- Tool reads the snapshot, filters in memory, returns a formatted text list (matches the `list_tasks` style).

**`annotate_contact({ ident? | username? | tg_id?, notes?, tags? })`** — write path
- Tool writes an IPC file under `data/ipc/<group>/contact-writes/<ts>-<rand>.json` (fire-and-forget).
- Host watcher applies the merge (notes overwrite; tags append-unique) and refreshes the snapshot.

Pulling relevant contacts into `groups/<g>/CLAUDE.md` uses the agent's existing file tools — no new tool needed.

## On-demand media (`view_media`)

Container has no Telegram token or network to Telegram; the host performs every download. Mechanism: request/response over file IPC.

### Flow

1. Agent reads a `file_id` from the structured block of the current message, its `<reply>` block, or a historical message via `lookup_messages`.
2. Agent calls `view_media({ file_id, mode?: 'auto'|'image'|'text', pages?: '1-3' })`.
3. Tool writes `data/ipc/<group>/media-requests/<reqId>.json`, then polls `data/ipc/<group>/media-responses/<reqId>.json` with a bounded timeout (≈30s).
4. Host watcher: validates the request comes from the group's IPC namespace (same per-group isolation that already authorizes tasks), calls Telegram `getFile(file_id)` → downloads → routes by mime → writes the response file → deletes the request file. Response files have a TTL sweep similar to the existing `errors/` handling.
5. Tool reads the response, returns it as an MCP content block.

### Mime routing (`mode='auto'` default)

| Mime / type | Handling | MCP content returned |
|---|---|---|
| `image/*` (including image documents, static stickers) | download → `processImage()` (existing helper, resizes for vision) | `{ type:'image', data, mimeType }` |
| `application/pdf` | `pdftotext` (default), or `pdftoppm` when `mode:'image'` / `pages:'N-M'` | `{ type:'text', text }` or one or more `{ type:'image' }` |
| `text/*`, JSON/YAML/Markdown | UTF-8 decode, trim to ≤200KB | `{ type:'text', text }` |
| other (video, audio, office) | no download | `{ type:'text', text:'тип X не отображается; <descriptor>' }` |

`pdftotext`/`pdftoppm` come from `poppler-utils` (`brew install poppler` on macOS). If absent, host returns an explicit "extractor not installed" error — the rest of the system keeps working.

Voice messages keep their existing Groq-transcription path; `view_media` does not duplicate it.

### Reply / forward "посмотри" workflows

- User replies to a media message with "посмотри X" → new message's structured block has `<reply><media file_id=.../></reply>` → agent calls `view_media(file_id)`. Already supported by the design; no special case.
- User forwards a media message and adds their own text including "посмотри" → the forward IS the current message, its block has top-level `<media file_id=.../>` and the user's text is the same message's text → agent calls `view_media(file_id)`. Same code path.
- Historical media (no fresh reply) → agent finds the file_id via `lookup_messages` (it survives in stored `content`) → `view_media(file_id)`. Telegram file_ids are stable for the originating bot.

## Conversation access (`lookup_messages`)

The existing message loop already feeds the agent the recent batch (FIFO, capped per `getMessagesSince`). For older history, reply-chain walking, or targeted lookups, the agent uses a new tool.

```
lookup_messages({
  tg_message_id?,     // jump to a specific message id
  sender_id?,         // filter by author tg id
  since?, until?,     // ISO range
  query?,             // substring, case-insensitive LIKE on content
  include_bot?,       // default false — bot's own replies excluded
  limit?              // default 50
}) -> formatted text (same style as `formatMessages`) including each row's full `content`
```

- Request/response over IPC (`lookup-requests/` + `lookup-responses/`), polling pattern identical to `view_media`.
- Group-scoped: host filters `chat_jid IN (jids of group)` — same authorization as tasks/contacts.
- Result includes the full structured block, so any `file_id`s in the row are available to feed into `view_media`.
- Reply chain walking is just repeated calls: `<reply mid="X">` → `lookup_messages({tg_message_id: X})` → its `<reply mid="Y">` → another call. No special chain primitive.

The inline `<reply snippet="...">` is widened from 120 chars to 500 chars to cover most replies without a round-trip; `lookup_messages` is the escape hatch for full text.

## Files touched

Host (`src/`):
- **NEW** `src/channels/telegram-meta.ts` — builds `<m>` block from a Telegram `Message`. Replaces `forwardContext` + `replyContext` string functions. Pure-function, fully unit-testable.
- **NEW** `src/channels/telegram-enrich.ts` — throttled `getChat` resolver; fire-and-forget enrichment queue.
- **MOD** `src/channels/telegram.ts` — every message handler builds content via `telegram-meta`; remove auto-vision (`processImage` call + `images` field) in `message:photo`; trigger enrichment on mention entities.
- **MOD** `src/db.ts` — `contacts` schema + `upsertContact` + `getContactsForGroup` + `annotateContact` + `lookupMessages` (group-scoped query helper).
- **MOD** `src/ipc.ts` — new request namespaces `media-requests/`, `lookup-requests/`, `contact-writes/`; response-dir TTL sweep; snapshot writer for `contacts.json` (per group, refresh on upsert/annotate).
- **MOD** `src/container-runner.ts` — ensure new IPC sub-dirs exist when materializing per-group IPC; pass `contacts.json` alongside `current_tasks.json`.
- **MOD** `src/index.ts` — delete `pendingImages` Map + `hasImages` branch (dead after auto-vision removal); `NewMessage.images` stays optional for forward-compat with other channels.

Container (`container/agent-runner/src/`):
- **MOD** `ipc-mcp-stdio.ts` — register 4 tools: `lookup_contacts`, `annotate_contact`, `view_media`, `lookup_messages`. Helper for request/response polling (bounded timeout, returns parsed JSON or error).

Tests:
- **NEW** `src/channels/telegram-meta.test.ts` — branches for forward (user/hidden/chat/channel + legacy), reply with nested media, entities (url/text_link/mention/text_mention/phone/email), vCard, location, quote, media types (photo/document/sticker/voice).
- **MOD** `src/db.test.ts` — `upsertContact` insert→update path, identity resolution priority (`id > username > name`), group-scope isolation on `getContactsForGroup` / `lookupMessages`.
- IPC happy-path stubs for the new namespaces (parse a fake request, write a fake response — no actual Telegram network).

## Known limitations / risks

- **Identity fragmentation**: a person first seen by `@username` and later by `id` is two `contacts` rows in v1. The agent reconciles via `annotate_contact`; no auto-merge.
- **`pdftotext` / `pdftoppm` not installed** → `view_media` returns a descriptive error. Document `brew install poppler`. Other paths continue working.
- **`getChat` resolves only public usernames**; private/restricted users fail silently and are not enriched. Acceptable for v1 — the contact row from the originating message (sender/forward/reply) still exists with whatever fields were inline.
- **Token cost**: the structured block adds ~150–300 chars per message. On a 200-msg context that's ~30–60KB extra. Acceptable; revisit if Anthropic's per-request size becomes a constraint.
- **Telegram DM limitation**: Telegram bots cannot DM an arbitrary user — the user must have `/start`ed the bot. "Write to that person" therefore means: bot composes a draft / supplies a t.me link / invokes an external tool, unless the recipient has already interacted with the bot.
- **PII storage**: the contacts table holds third-party identifiers (names, usernames, phones from vCards) by explicit user request. Group-scope isolation preserved; the DB remains host-side and is not mounted into containers.

## Out of scope (v1)

- Cross-group contact merging.
- Office document formats (.docx / .xlsx) extraction.
- Video / GIF frame extraction; OCR on stickers.
- Full-text search index (FTS5) on `messages` — v1 uses LIKE; revisit if `lookup_messages` becomes slow on long histories.
- Auto-merge of duplicate `id`-vs-`username` contact rows.
- Multi-channel media (Gmail attachments, Slack files) — Telegram only in v1.

## Verification

- Unit: `npx vitest run src/channels/telegram-meta.test.ts src/db.test.ts` — all branches green.
- Integration (manual): forward a channel message → check that `contacts` has the channel row with `link`, `enriched=0`, `kind='channel'`; reply to it asking "посмотри" → bot calls `view_media`, sees the photo. Mention `@someone` → after a few seconds, `contacts` row appears with `enriched=1` and `bio` if public.
- Regression: existing message loop, scheduler, threadId routing, FIFO drain, sender allowlist — all unchanged; existing test suite (`npx vitest run`) stays green.
