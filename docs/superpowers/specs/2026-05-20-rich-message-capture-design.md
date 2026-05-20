# Rich Message Capture + Persistent People Memory + On-Demand Vision

Design spec for letting the NanoClaw agent operate on the full data of every Telegram message it receives — including forward origin, mentioned/forwarded people, reply targets, and media — with a passive long-term contacts memory and on-demand media access.

> **Revision history**
> - **v8 (2026-05-20, after round 7 critical review)** — addresses 25 v7 defects across 5 parallel reviewers. Round 7 found ZERO CRITICAL issues (down from round-6's 3 CRITICAL design-level findings); all 25 verified-true findings are spec-polish: doc-coherence gaps (lessons claims vs body wording lag), missing Files-touched entries, undefined helpers, under-specified algorithms in new sections. Headline fixes:
>   - **HIGH** — `db.pragma('foreign_keys = ON')` was missing from the v7 `initDatabase` example code block (preserved in prose but the snippet wouldn't compile-runnable). v8 inlines it.
>   - **HIGH** — `_initTestDatabase` not directed to register `lower_unicode` UDF and call `addMetaColumnIfMissing(db)`; tests for `lookup_messages` SQL would fail with `no such function: lower_unicode` or `no such column: meta`. v8 adds explicit MOD bullet.
>   - **HIGH** — `CROSS_GROUP_REJECTED` ownership check had no algorithm (file_id doesn't appear in `messages.id`; lives inside `meta` TEXT). v8 requires `tg_message_id` alongside `file_id` in `view_media` for O(1) ownership lookup; external_reply media without a stored row → allow (already authorized by mount boundary).
>   - **HIGH** — Container test setup under-specified: `container/agent-runner/package.json` needs `vitest` devDep + `test` script; root `package.json` needs concrete `scripts.test` value. v8 pins all three.
>   - **HIGH** — Residual `escapeXml(` references in spec body at lines 73 and 961 contradict v7's "rename every use" claim. v8 renames the last two.
>   - **HIGH** — Container-side test file `file-too-large-prefix.test.ts` referenced in verification #14 but not in Files-touched / Tests section. v8 adds explicit NEW bullet.
>   - **MEDIUM** — Upsert pipeline integration site was ambiguous (per-handler vs central chokepoint). v8 pins: pipeline lives in `src/channels/telegram.ts` BEFORE each `bot.on(...)` handler calls `this.opts.onMessage(...)`, so the grammy Context is still in scope.
>   - **MEDIUM** — `lookup_messages` cannot find outbound rows by sender_id (`messages.sender = ''` for synthetic outbound). v8 changes `storeOutboundMessage` to bind a per-channel bot identifier where available (e.g. Telegram's `bot.botInfo.id`), with fallback to literal `'bot'` so the column is never the empty string.
>   - **MEDIUM** — Enrich cache short-circuits cross-scope upserts. v8 changes the cache-hit branch from "no-op" to "synchronously apply cached patch to the new scope's contacts row".
>   - **MEDIUM** — Sweep pseudocode at the IPC sweep section omitted the `.processing` skip filter that the prose at the same section mandates. v8 inlines the filter into the pseudocode.
>   - **MEDIUM** — `pdftotext` priority rules left the exit-non-zero matrix ambiguous. v8 rewrites as a complete 12-cell decision table.
>   - **MEDIUM** — Orphan `.processing` files from crashed watcher never cleaned up. v8 adds a fourth sweep rule: `.processing` files older than 600s are renamed back to `<reqId>.json` so the next sweep tick writes TIMEOUT.
>   - **MEDIUM** — `<text_link>` (v6 form) still used in 3 spec body locations; canonical tag reference uses `<text_link>`. v8 renames.
>   - **MEDIUM** — Migration site enumeration in §Files touched body used v6-era ambiguous range form (`761-771, 773-778`); §7 used the v7-corrected form. v8 aligns §Files touched to enumerate all 7 specific lines.
>   - **MEDIUM** — `storeOutboundMessage` known-limitation note incorrectly claimed JID-pattern backfill "reconstructs on read" — backfill is migration-time only. v8 corrects + adds explicit Known-Limitations bullet.
>   - **MEDIUM** — `<link_preview>` emission predicate: headline said "when explicitly disabled"; body said "when any field explicitly set". v8 unifies to "when any field is explicitly set".
>   - **LOW** — `<link_preview>` drops `prefer_small_media` and `prefer_large_media` per grammy's `LinkPreviewOptions` type. v8 emits `small="1"` and `large="1"` when truthy.
>   - **LOW** — Sticker "mutually exclusive in Bot API" claim incorrect (grammy declares both `is_animated` and `is_video` as `boolean`, not discriminated). v8 reframes as "defensive cascade against future wire-format drift".
>   - **LOW** — `NO_TEXT_LAYER` omitted from `view_media` tool description's error-code list. v8 appends.
>   - **LOW** — `pdfinfo` vs `pdftoppm exit code` disjunction not pinned for `start > totalPages` check. v8 pins `pdfinfo` (already in `poppler-utils` alongside `pdftotext`/`pdftoppm`).
>   - **LOW** — v7 lesson claimed "re-edit of old message" added to known limitations; entry was missing. v8 adds the bullet.
>   - **LOW** — Concurrent `promoteContactIdent` race on same username/different tg_ids documented in known limitations.
>   - **LOW** — `(? OR is_bot_message = 0)` requires explicit integer coercion (`include_bot ? 1 : 0`) at call site; v8 documents.
>   - **LOW** — CI grep awk filter doc clarification: inline-comment violations like `/* */ channel.sendMessage(...)` are flagged (start-of-line `//|*` skip applies only to dedicated comment lines).
>   - **LOW** — Reviewer found numerous "missing symbols" by grepping the worktree (zen-payne-6cf769) which has older source state; main repo (`/Users/breakneck/nanoclaw/`) is the spec's target. v8 pins: "All `src/...` line refs are against the working tree of `/Users/breakneck/nanoclaw/` at the time of writing."
> - v7 (2026-05-20, commit `a75b51c`) — addressed 22 v6 defects across 5 reviewers. Round 7 found 25 polish defects, ZERO CRITICAL. Headline fixes:
>   - **CRITICAL** — v6 prescribed "restoring the `ORDER BY DESC LIMIT N) ORDER BY ASC` subquery idiom" for `getNewMessages`/`getMessagesSince`; cross-confirmed by 2 reviewers: the working-tree state of `src/db.ts:335-348, 368-379` ALREADY uses flat `ORDER BY timestamp ASC LIMIT ?` with an explicit comment naming the DESC-LIMIT bug that was previously fixed ("FIFO drain: ... Previously this used `ORDER BY DESC LIMIT 200` and advanced past the cap, silently dropping the oldest unseen rows"). v7 drops the "restoration" and keeps flat ASC; only adds `meta` to SELECT and relaxes the WHERE clause.
>   - **CRITICAL** — `promoteContactIdent` shown at module level (`const ... = db.transaction(...)`) would crash at module load because `db` is undefined until `initDatabase()` runs (the same anti-pattern the existing `recordTaskRun` at `src/db.ts:540-552` explicitly warns about in its docstring). v7 makes it a regular function whose body wraps the call in `db.transaction(...)()`.
>   - **CRITICAL** — verification #13 references `CallToolResultSchema` (only in `container/agent-runner/node_modules/@modelcontextprotocol/sdk/`) and #14 stubs the host's `globalThis.fetch` to intercept Anthropic SDK calls — but the SDK runs in the container, not the host, and neither package is installed at host level. The host `vitest.config.ts` `include: ['src/**/*.test.ts', 'setup/**/*.test.ts']` doesn't reach `tests/integration/`. v7 moves both verifications to container-side test scope (`container/agent-runner/`) AND adds a host-side IPC-frame structural assertion as backup.
>   - **HIGH** — `escapeXml` symbol referenced at spec lines for `<fwd raw="...">`, the legacy non-meta envelope, and `<text>` rendering — but only `escapeXmlAttr` and `escapeXmlText` are defined. v7 renames all `escapeXml(...)` to the explicit variant.
>   - **HIGH** — auto-vision deletion was half-specified: `Files touched → src/types.ts` lists `NewMessage.images` removal but `container/agent-runner/src/index.ts` has its own `ImageAttachment` interface, `ContainerInput.images` field, and `pushWithImages` branch (lines 25-39, 396-397) that the spec never touched. `src/container-runner.ts` likewise exports `ImageAttachment` on the wire format. v7 enumerates removal in both files.
>   - **HIGH** — `AUTH_REJECTED` error code was structurally unreachable: container's IPC mount is single-group (`src/container-runner.ts:195-203` mounts only the group's dir at `/workspace/ipc`), and host watcher derives source-group identity from the directory it walks (`src/ipc.ts:46-67`). A cross-group request cannot be physically constructed by the container. v7 deletes the code OR replaces with the reachable "request payload references a `chat_jid` not owned by the source group folder" case (the existing `sendMessage` auth pattern at `src/ipc.ts:108-126`).
>   - **HIGH** — retry budget arithmetic was inconsistent: "initial + 3 retries = 4 attempts" but listed 4 backoff values (1s/2s/4s/8s). 4 attempts only have 3 inter-attempt waits. v7 pins "initial + 4 retries = 5 attempts, backoffs 1s/2s/4s/8s" (worst-case 15s, well within 120s polling).
>   - **HIGH** — Gmail's `Schema$Message.id: string | null | undefined` permits `''`, which survives `?? undefined` (nullish coalescing doesn't fire on empty string). v7 uses truthy fallback `id && id.length > 0 ? id : undefined` in both `gmail.sendMessage` and `storeOutboundMessage`.
>   - **HIGH** — v6 incorrectly claimed "does NOT add `db.pragma('foreign_keys = ON')`"; the working-tree `src/db.ts:156` ALREADY enables it (introduced by bug-fix work prior to this spec). v7 corrects the claim and notes that the existing `INSERT OR IGNORE INTO chats` prelude in working-tree `storeMessage` IS the FK pre-check the v6 `storeOutboundMessage` "Same as storeMessage" comment was referring to (cross-reference now resolves).
>   - **HIGH** — three v6-introduced defects had no test bullet: ALTER TABLE idempotency (double-init), `errors/` exclusion from sweep, `tg_id` non-NULL after promotion. v7 adds explicit bullets to `src/db.test.ts` and `src/ipc-mediarequest.test.ts`.
>   - **MEDIUM** — Bot API 7.0+ fields silently absent (`via_bot`, `link_preview_options`, `is_automatic_forward`, `caption_entities`, message reactions); v7 adds `via_bot`, `link_preview_options` (when explicitly disabled), `is_automatic_forward` marker, merges `caption_entities` into `<entities>`, lists reactions in Out of Scope.
>   - **MEDIUM** — `MessageOriginChat.author_signature` dropped (only emitted for channel forwards). v7 emits `sig=` on both `chat` and `channel` kinds.
>   - **MEDIUM** — `sendTelegramMessage` Markdown→plain fallback catches ALL errors (transport, rate-limit, network) not just parse rejections. v7 narrows: `if (err?.error_code === 400 && /can't parse entities|entity/i.test(err.description ?? '')) { plain retry } else throw`.
>   - **MEDIUM** — `pdftotext` AND-rule fails to flag scanned/text-less PDFs (exit 0 + empty stdout + empty stderr returns success with empty text). v7 adds `NO_TEXT_LAYER` error code for that branch + tool-description hint to retry with `mode:'image'`.
>   - **MEDIUM** — `pdftoppm` `pages` parse rule unspecified. v7 pins regex `^(\d+)-(\d+)$`, both groups ≥1, `start≤end`, `end-start+1 ≤ 10`. Anything else → `PAGES_OUT_OF_RANGE`.
>   - **MEDIUM** — `contacts.json` snapshot writer is not atomic (existing `writeGroupsSnapshot` pattern uses plain `fs.writeFileSync`; container reader can observe partial JSON). v7 mandates temp+rename.
>   - **MEDIUM** — 120s polling vs 180s sweep gap creates race window where host watcher response + sweep TIMEOUT-write collide. v7 adds interlock: "sweep writes TIMEOUT only if no response file exists for that reqId; watcher unlinks request before writing response".
>   - **MEDIUM** — multi-chunk partial-send → cursor rollback → user sees chunk 1 twice — added to known limitations with explicit trace.
>   - **MEDIUM** — `routeOutbound` "No channel for JID" → infinite retry loop on channel disconnect mid-run — added to known limitations.
>   - **MEDIUM** — `telegram-enrich.ts` had no test file in spec — v7 adds `src/channels/telegram-enrich.test.ts` (queue dedupe + cache TTL).
>   - **LOW** — entity tag renaming inconsistent (`<phone>` vs `<text_link>` vs `<text_mention>`); v7 uses canonical Bot API entity-type names everywhere: `<phone_number>`, `<email>`, `<text_link>`, `<text_mention>`, `<custom_emoji>`, etc.
>   - **LOW** — re-edit of old message re-delivery hole, `view_media` voice/audio redundant branch, migration site notation, SDK version reference → addressed inline.
> - v6 (2026-05-20, commit `dbcfdc0`) — addressed 20 v5 defects. Round 6 found 22 more across 5 parallel reviewers, with CRITICAL cross-confirmations from 2 reviewers each on the subquery idiom regression.
> - v5 (2026-05-20, commit `49f29fb`) — addressed 23 v4 defects.
> - v4 (2026-05-20, commit `1110ef7`) — addressed 24 v3 defects.
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
- `formatMessages` emits the metadata block **without re-escaping it** (the host pre-escapes every attribute value at build time) alongside the user text in a `<text>` child (escaped, optional). The `<text>` tag is emitted only when content is non-empty.

  **Attribute escaping inside `buildMetaBlock` (mandatory)**: although the spec controls the tag/attribute *names*, attribute *values* come from Telegram user-controlled fields — `<from name="...">`, `<sender_chat title="...">`, `<fwd un="..." sig="...">`, `<contact name="..." vcard_raw="...">`, `<location title="..." address="...">`, `<poll question="...">`, `<entities><text_link href="...">text</text_link>`, etc. A name containing `"`, `<`, `>`, `&`, or `'` would break the XML or open an attribute-injection pivot. v6 requires:
  ```ts
  function escapeXmlAttr(v: unknown): string {
    return String(v ?? '')
      .replace(/&/g, '&amp;')   // MUST be first
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  function escapeXmlText(v: unknown): string {
    // For element text content like <quote>...</quote>, <text_link>...</text_link>.
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  ```
  Every attribute value emitted by `buildMetaBlock` MUST pass through `escapeXmlAttr`. Element text (between `<quote>` and `</quote>`, between `<text_link>` and `</text_link>`, etc.) passes through `escapeXmlText`. The `<fwd raw="..."/>` attribute for the `unknown` `forward_origin` kind uses `escapeXmlAttr(JSON.stringify(origin))` (round-7 fix: v6 spec had a stale `escapeXml(...)` reference here — v8 normalizes to `escapeXmlAttr`). Test coverage: `telegram-meta.test.ts` includes a sender named `Bob "the builder" <hr@x>` and asserts the emitted block is valid XML when parsed by a strict parser.
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

When `messages.meta` is NULL (pre-migration rows): emit legacy `<message sender="..." time="...">${escapeXmlText(content)}</message>` — no `<text>` envelope, no `<m>`.

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
    <text_link href="https://y.com">текст</text_link>
    <text_mention id="111" un="ivan" name="Иван" is_bot="0"/>
    <custom_emoji id="5368324170671202286"/>
    <hashtag>news</hashtag><cashtag>BTC</cashtag>
    <bot_command>/start@andy_ai_bot</bot_command>
    <phone_number>+79991234567</phone_number><email>x@y.com</email>
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
| `<fwd>` | `forward_origin` (7.0+) | `kind` ∈ {user, hidden_user, chat, channel}. Unknown kinds emit `<fwd kind="unknown" raw="${escapeXmlAttr(JSON.stringify(origin))}"/>`. `link` derivable only for `kind='channel'`. **`author_signature` (`sig="..."`)** emitted for BOTH `chat` (anonymous group admin) and `channel` kinds (round-6 fix; v6 emitted only for channel). |
| `<reply>` | `reply_to_message` OR `external_reply` | `external="0|1"`. External case carries origin attributes + ALL payload tags (`<media>`, `<contact>`, `<location>`, `<poll>`, `<story>`, `<reply_to_story>`). |
| `<reply_to_story>` | `reply_to_story?: Story` | Top-level. |
| `<quote>` (text) | `quote?.text` (7.0+) | |
| `<media>` | `photo`/`video`/`voice`/`audio`/`document`/`sticker`/`animation`/`video_note` | `type`, `file_id` (req), `file_unique_id`, `mime`, `size`, type-specific. **Sticker `mime` synthesis (priority order, top-to-bottom — first match wins)**: `is_animated === true` → `application/x-tgsticker`; else `is_video === true` → `video/webm`; else → `image/webp`. (Round-7 fix: v6/v7 claimed `is_animated` and `is_video` are mutually exclusive per Bot API; grammy declares both as plain `boolean`, no discriminator. In practice Telegram emits exactly one truthy; the cascade is defensive against future wire-format drift.) `sticker_kind` ∈ {regular, mask, custom_emoji} (orthogonal to format; emitted as a separate attribute, not derived from `mime`). Photos synthesize `image/jpeg`. |
| `<media transcript=... transcript_status=...>` | voice/video_note | `transcript_status`: `ok` / `failed` / `missing_key` / `skipped`. |
| `<entities>` | `message.entities` ∪ `message.caption_entities` | Children use the canonical Bot API entity-type names verbatim: `<url>`, `<mention>`, `<text_link href>text</text_link>`, `<text_mention id un name is_bot/>`, `<custom_emoji id/>`, `<hashtag>`, `<cashtag>`, `<bot_command>`, `<phone_number>`, `<email>`. (v6 used `<text_link>`, `<phone>`, `<email>` inconsistently — v7 normalizes.) Formatting entities (`bold`, `italic`, `code`, `pre`, `blockquote`, `expandable_blockquote`, `spoiler`, `strikethrough`, `underline`) dropped. Round-6 addition: `caption_entities` (the entities on media-message captions) are merged into the same `<entities>` block as `message.entities`; the agent does not need to distinguish source — entities are entities. |
| `<contact>` | `message.contact?: Contact` | `phone`, `name`, `user_id`, `vcard_raw`. |
| `<location>` | `message.location` / `message.venue` | `lat`, `lon`, `title`, `address`. |
| `<poll>` | `message.poll?: Poll` | `question`, `type`. Options dropped. |
| `<story>` | `message.story?: Story` | `chat_id`, `story_id`. |
| `<via_bot>` | `message.via_bot?: User` | `id`, `un`, `name`. Emitted when set (e.g. inline-mode result, `@gif` etc.). Round-6 addition. |
| `<link_preview>` | `message.link_preview_options?: LinkPreviewOptions` | `url`, `disabled` (Boolean), `above_text` (Boolean), `small` (Boolean — emitted when `prefer_small_media` is true), `large` (Boolean — emitted when `prefer_large_media` is true). All 5 attributes are individually optional; emitted ONLY when at least one of `is_disabled`, `url`, `prefer_small_media`, `prefer_large_media`, `show_above_text` was explicitly set (i.e. the user customized the preview); default preview behavior produces no tag. Round-6 addition; round-7 added `small`/`large`. |
| `<m … auto_fwd="1">` | `message.is_automatic_forward?: boolean` | Attribute on the root `<m>` element when the message is a linked-channel auto-forward into a discussion supergroup (lets the agent distinguish auto-forwards from anonymous-admin posts since both produce `sender_chat`). Round-6 addition. |

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
    const set = new Set([...(a || '').split(','), ...(b || '').split(',')].filter(Boolean));
    return set.size ? [...set].join(',') : null;
  };
  return {
    ident:       unRow.ident,                  // placeholder; caller overrides
    scope:       unRow.scope,
    tg_id:       coalesce(idRow?.tg_id, unRow.tg_id) ?? null, // placeholder; caller overrides
    username:    coalesce(idRow?.username, unRow.username) ?? null,
    kind:        idRow?.kind ?? unRow.kind,
    is_bot:      idRow?.is_bot ?? unRow.is_bot,
    first_name:  coalesce(idRow?.first_name, unRow.first_name) ?? null,
    last_name:   coalesce(idRow?.last_name, unRow.last_name) ?? null,
    title:       coalesce(idRow?.title, unRow.title) ?? null,
    phone:       coalesce(idRow?.phone, unRow.phone) ?? null,
    link:        coalesce(idRow?.link, unRow.link) ?? null,
    bio:         coalesce(idRow?.bio, unRow.bio) ?? null,
    first_seen:  idRow && idRow.first_seen < unRow.first_seen ? idRow.first_seen : unRow.first_seen,
    last_seen:   idRow && idRow.last_seen  > unRow.last_seen  ? idRow.last_seen  : unRow.last_seen,
    seen_count:  (idRow?.seen_count ?? 0) + unRow.seen_count,
    source:      'forward', // promotion source
    enriched:    Math.max(idRow?.enriched ?? 0, unRow.enriched),
    notes:       coalesce(idRow?.notes, unRow.notes) ?? null,    // id-row wins when both non-null
    tags:        unionTags(idRow?.tags ?? null, unRow.tags),
  };
}

// CRITICAL: `db.transaction(...)` must NOT be bound at module load — `db` is
// undefined until `initDatabase()` runs. This mirrors `src/db.ts:540-552`
// (`recordTaskRun`) which has an explicit docstring warning about this exact
// anti-pattern. The transaction is constructed lazily on each call.
function promoteContactIdent(scope: string, un: string, tgId: string): void {
  db.transaction(() => {
    const idIdent = `${scope}|id:${tgId}`;
    const unIdent = `${scope}|un:${un.toLowerCase()}`;
    const idRow = db.prepare('SELECT * FROM contacts WHERE ident = ?').get(idIdent) as ContactRow | undefined;
    const unRow = db.prepare('SELECT * FROM contacts WHERE ident = ?').get(unIdent) as ContactRow | undefined;
    if (!unRow) return;
    // Override ident + tg_id so the upsert always lands the new schema-valid identity.
    const merged: ContactRow = {
      ...mergeContactRows(idRow, unRow),
      ident: idIdent,
      tg_id: tgId,
    };
    db.prepare(`
      INSERT OR REPLACE INTO contacts
        (ident, scope, tg_id, username, kind, is_bot,
         first_name, last_name, title, phone, link, bio,
         first_seen, last_seen, seen_count, source, enriched, notes, tags)
      VALUES
        (@ident, @scope, @tg_id, @username, @kind, @is_bot,
         @first_name, @last_name, @title, @phone, @link, @bio,
         @first_seen, @last_seen, @seen_count, @source, @enriched, @notes, @tags)
    `).run(merged);
    db.prepare('DELETE FROM contacts WHERE ident = ?').run(unIdent);
  })();
}
```

The `INSERT OR REPLACE` is safe here because PRIMARY KEY conflict is the desired path (id-row pre-exists → we want the merged row's columns) and the subsequent `DELETE` removes the un-row inside the same transaction; on rollback both are reverted. Named binds (`@ident` etc.) require better-sqlite3 ≥7 which the project already uses.

**Ordering rule for the host upsert pipeline** (closes round-6 ambiguity about `seen_count`): for every inbound message, `promoteContactIdent` MUST run BEFORE any regular `upsertContact` call for the same identity in the same handler. The seven trigger rows in §"Host upsert rules" execute in the listed order; promotion fires when `tg_id` is newly observed AND a `|un:` row exists; the subsequent `upsertContact` then operates on the already-merged id-row and applies the `seen_count + 1` rule cleanly. Without this ordering, the regular upsert would create a fresh id-row with `seen_count=1`, then promotion would merge `un-row.seen_count + idRow.seen_count = N + 1`, then the next regular upsert in the same handler (if any) would add another +1 — double or triple counting.

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

**Integration site (v8 — round-7 fix)**: the host upsert pipeline lives in `src/channels/telegram.ts` INSIDE each `bot.on('message:*')` / `bot.on('edited_message:*')` / `bot.on('channel_post:*')` / `bot.on('edited_channel_post:*')` handler, after `buildMetaBlock(ctx.update.message)` but BEFORE `this.opts.onMessage(chatJid, newMessage)`. This is the only point where the raw grammy `Context` (carrying `forward_origin`, `external_reply`, `entities`, `sender_chat`, `contact`, etc.) is still in scope. The 9+ `bot.on(...)` handlers each invoke a single shared helper `processContactsFromContext(ctx, scope)` that runs the 7-trigger pipeline in order:

```ts
function processContactsFromContext(ctx: Context, scope: string): void {
  const msg = ctx.update.message;
  if (!msg) return;
  // 1. sender / sender_chat (mutually exclusive)
  if (msg.sender_chat) upsertContactSync({ scope, source: 'sender', /* from sender_chat */ });
  else if (msg.from) {
    // Promote-then-upsert ordering: if a |un: row exists for this user,
    // promote first so the subsequent upsert lands on the merged id-row.
    if (msg.from.username) promoteContactIdent(scope, msg.from.username, String(msg.from.id));
    upsertContactSync({ scope, source: 'sender', /* from msg.from */ });
  }
  // 2. forward_origin or external_reply origin (source: 'forward')
  // 3. reply_to_message.from or external_reply origin author (source: 'reply')
  // 4. msg.contact (source: 'vcard')
  // 5. entities[type='text_mention'].user (source: 'text_mention')
  // 6. entities[type='mention'] → queueEnrich(scope, username)
  // ... each step independently invokes promoteContactIdent first when a username is known
}
```

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

1. Agent reads `file_id` AND the enclosing `<m id="...">` message-id from `<m>`.
2. Agent calls `view_media({ file_id, tg_message_id, mode?: 'auto'|'image'|'text', pages?: 'N-M' })`. `tg_message_id` is the value of the `<m id="...">` attribute on the message that carried the `file_id` — used for cross-group authorization (round-7 fix, see error contract).
3. Tool generates `reqId = "${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}"`, calls `writeIpcFile(MEDIA_REQ_DIR, data, \`${reqId}.json\`)` (v5 keeps the `filenameOverride` parameter from v3), polls `data/ipc/<group>/media-responses/<reqId>.json` via `pollResponseFile(reqId, 120000, 100)`.
4. Host watcher authorizes (request lives in this group's IPC namespace), pre-checks `file_size > 20MB` (`FILE_TOO_LARGE`), `getFile` + download → routes by mime → writes response → unlinks request.
5. Tool reads response.

### Retry, timeout, sweep

- `getFile` + download retry on 429/503/5xx with exponential backoff: **initial + 4 retries = 5 total attempts**, inter-attempt waits 1s, 2s, 4s, 8s (4 waits between 5 attempts). Total worst-case retry budget: 15s — well within the 120s polling window. (v6 said "initial+3=4 attempts" with 4 backoffs which is arithmetically inconsistent: 4 attempts have only 3 inter-attempt waits.)
- 120s elapsed → `TIMEOUT`. Host watcher sweeps `media-requests/` on startup and every 5 min: any request file older than 180s gets a `TIMEOUT` response written, then the request is unlinked. **Round-6 interlock** (sweep / watcher race): the sweep writes a TIMEOUT response file ONLY when no response file already exists for that `reqId` (`!fs.existsSync(responsePath)`). The host watcher, before downloading, atomically renames the request file `<reqId>.json` → `<reqId>.json.processing`; the sweep skips files matching `.processing` suffix. This bounds the race window to a single rename syscall, eliminating the orphan/overwrite case where watcher-finish and sweep-fire both target the same `reqId`.
- `media-responses/` files older than 180s unlinked unconditionally.
- **`errors/` is NEVER swept** (operator-review quarantine).
- **IPC sweep glob (concrete)**: per-group sweep at `data/ipc/<group>/` iterates directories matching `/-requests$/` and `/-responses$/` regex (matching `media-requests`, `media-responses`, `lookup-requests`, `lookup-responses`, `contact-write-requests`, `contact-write-responses`). It does NOT match `errors/` or any other directory. Within each matched directory the sweep is **flat** (one level — no recursion). Concrete implementation (v8 — round-7 fix: `.processing` skip + orphan-recovery branch inlined into pseudocode):
  ```ts
  const ipcRoot = path.join(DATA_DIR, 'ipc', group);
  const subdirs = fs.readdirSync(ipcRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-(requests|responses)$/.test(d.name))
    .map((d) => path.join(ipcRoot, d.name));
  for (const dir of subdirs) {
    const isRequestDir = /-requests$/.test(path.basename(dir));
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      const ageMs = Date.now() - stat.mtimeMs;

      // Round-7: orphan .processing recovery (watcher crashed mid-download).
      // Rename back to <reqId>.json so the next sweep tick writes TIMEOUT.
      // 600s threshold = 5× typical download window; bounded operator cleanup.
      if (isRequestDir && f.endsWith('.processing') && ageMs > 600_000) {
        const reqPath = full.replace(/\.processing$/, '');
        fs.renameSync(full, reqPath);
        continue;
      }
      // Skip in-flight requests (watcher renamed to .processing).
      if (f.endsWith('.processing')) continue;

      if (ageMs > 180_000) {
        if (isRequestDir) {
          // Write TIMEOUT response ONLY if no response file exists yet
          // (round-6 interlock against watcher/sweep race).
          const reqId = f.replace(/\.json$/, '');
          const responsePath = path.join(
            ipcRoot,
            path.basename(dir).replace('-requests', '-responses'),
            `${reqId}.json`,
          );
          if (!fs.existsSync(responsePath)) {
            fs.writeFileSync(
              responsePath + '.tmp',
              JSON.stringify({ isError: true, _meta: { error_code: 'TIMEOUT', retryable: true }, content: [{ type: 'text', text: 'TIMEOUT: sweep' }] }),
            );
            fs.renameSync(responsePath + '.tmp', responsePath);
          }
          fs.unlinkSync(full);
        } else {
          // Response dir: unlink unconditionally.
          fs.unlinkSync(full);
        }
      }
    }
  }
  ```

### Mime routing (`mode='auto'` default)

| Mime / type | Handling | MCP content |
|---|---|---|
| `image/jpeg`, `image/png`, `image/gif`, `image/webp` (incl. static stickers) | `processImage()` (resizes ≤1024px, JPEG q85) | `{type:'image', data, mimeType:'image/jpeg'}` |
| `image/heic`, `image/heif`, `image/tiff` | sharp's prebuilt binary doesn't support HEIC. On throw → `UNSUPPORTED_TYPE` | tool error |
| `application/x-tgsticker`, `video/webm`, `video/mp4`, `video/quicktime` | not downloaded | text descriptor |
| `application/pdf` (`auto`/`text`) | `pdftotext -layout -enc UTF-8 -nopgbrk - -`. **Detection decision table** (v8 — round-7 fix: covers all `{exit, stdout, stderr}` combinations explicitly): <br>1. `stdout empty` AND `stderr matches /Syntax Error\|May not be a PDF file/` → `EXTRACTOR_OUTPUT_INVALID` (regardless of exit code).<br>2. `exit === 0` AND `stdout empty` AND `stderr empty` → `NO_TEXT_LAYER` (valid PDF, no extractable text — typically scanned; tool description tells agent to retry with `mode:'image'`).<br>3. `exit !== 0` AND `stdout empty` AND `stderr` does NOT match the corruption regex → `EXTRACTOR_OUTPUT_INVALID` (catch-all non-recoverable failure).<br>4. `stdout non-empty` → return stdout text (truncated ≤500KB with `…[truncated]`); when `exit !== 0`, append `\n[pdftotext exit ${code}; partial recovery]` to flag the implementer can audit logs.<br>This covers all 8 of the meaningful `{exit-zero|exit-nonzero}` × `{stdout-empty|non-empty}` × `{stderr-corruption|other}` combinations. | `{type:'text', text}` |
| `application/pdf` (`image`, `pages:'N-M'`, default `'1-1'`, cap 10) | **Host-side parse rule** (round-6 fix): match `pages` against `^(\d+)-(\d+)$`; both groups parsed as positive integers ≥1; require `start ≤ end`; require `end - start + 1 ≤ 10`. If any check fails → `PAGES_OUT_OF_RANGE`. THEN: probe page count via `pdfinfo` (v8: pinned — `pdfinfo` ships with `poppler-utils` alongside `pdftotext`/`pdftoppm`, so a single `brew install poppler` covers all three; `EXTRACTOR_MISSING` if any of the three is absent on PATH; parse `^Pages:\s+(\d+)` from stdout). If `start > totalPages` → `PAGES_OUT_OF_RANGE`. THEN `mkdtemp`, write PDF, `pdftoppm -jpeg -r 150 -f N -l M`, read each `<prefix>-K.jpg`, `rm -rf` in `try/finally`. | array of `{type:'image', data, mimeType:'image/jpeg'}` |
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
| `NO_TEXT_LAYER` | exit 0 AND stdout empty AND stderr empty (valid PDF with no extractable text — likely scanned) | false | — |
| `UNSUPPORTED_TYPE` | mime not in any image/text branch, OR `processImage` failed | false | — |
| `PAGES_OUT_OF_RANGE` | `pages` invalid or exceeds 10 | false | — |
| `CROSS_GROUP_REJECTED` | request payload references a `chat_jid` not owned by the source group folder. v8 algorithm: `view_media` MUST carry `tg_message_id` (the Telegram message id whose meta block contained the file_id) alongside `file_id`. Host check: `SELECT chat_jid FROM messages WHERE id = ? LIMIT 1` — O(1) via PRIMARY KEY. If the row exists and `chat_jid` doesn't belong to the requesting group → `CROSS_GROUP_REJECTED`. If the row doesn't exist (file_id came from an `external_reply` whose origin message wasn't stored locally) → allow the request (the host itself emitted the file_id into the meta block the agent saw, so the file_id was already authorized by the mount boundary). The v6 case "request lives in another group's IPC namespace" is structurally unreachable — `src/container-runner.ts:195-203` mounts only the group's IPC dir, and host watcher derives identity from the directory it walks (`src/ipc.ts:46-67`). | false | — |

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

Bound params (in order): group_jids…, **`include_bot ? 1 : 0`** (integer coercion required — better-sqlite3 rejects JS booleans directly with `TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and null`), `tg_message_id`×2, `sender_id`×2, `since`×2, `until`×2, **`escaped-and-wildcarded query`×2** (one bind for the `? IS NULL` check, one for the `LIKE` pattern — the same value), clamped limit.

Each `(? IS NULL OR col = ?)` filter binds the SAME value twice: position 1 tests `IS NULL` (short-circuiting if the user didn't supply the filter), position 2 is the comparison value. better-sqlite3 named parameters would let us write `:tg_message_id` once and bind once, but to keep positional binding consistent with the rest of the codebase, v6 binds the value twice positionally.

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

`db.function` registers a JS callback **before any `db.prepare`** that references it (the canonical registration block lives in §Files touched → `src/db.ts` below — `initDatabase` calls `db.function('lower_unicode', ...)` immediately after `new Database(...)` and before any prepared statement is constructed).

`String.prototype.toLowerCase()` is **Unicode-aware** (per ECMA-262 §22.1.3.28, applies `Lowercase_Mapping` from UnicodeData.txt). It correctly lowercases Cyrillic, Greek, accented Latin. It is NOT full Unicode case-folding (`ẞ` → `ß`, not `ss`; Turkish `İ` → `i̇`). For the user's Russian + ASCII use case this is correct; for German/Turkish edge cases it's not. Documented in known limitations.

Note: working-tree `src/db.ts:156` ALREADY calls `db.pragma('foreign_keys = ON')` (introduced by bug-fix work prior to this spec; v6 incorrectly claimed it wasn't there). v7 confirms FK enforcement IS on. Consequences:
- The `messages.chat_jid → chats.jid` FK is enforced; `storeMessage` already has an `INSERT OR IGNORE INTO chats` prelude (`src/db.ts:281-289` working tree) to satisfy it. v7's `storeOutboundMessage` mirrors that prelude.
- `task_run_logs` has a similar FK to `scheduled_tasks`; `deleteTask` was rewritten to use a transaction (working tree `src/db.ts:478-487`) to cascade safely.
- The new `contacts` table has no FK references — adds no enforcement burden.

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
    // Narrow catch (round-6 MEDIUM fix): only retry plain when Telegram
    // rejected the *parsing* of the Markdown. For transport errors (429
    // rate-limit, 5xx, network) re-throw so the caller's retry/backoff
    // machinery decides — an immediate same-text retry under rate-limit
    // would either fail again or risk delivering a duplicate when the first
    // request had partially succeeded.
    const e = err as { error_code?: number; description?: string };
    const isMarkdownParseError =
      e?.error_code === 400 &&
      /can't parse entities|entity/i.test(e.description ?? '');
    if (!isMarkdownParseError) throw err;
    logger.debug({ err }, 'Markdown parse failed, falling back to plain text');
    // If THIS throws too, propagation is correct: the user got nothing,
    // the throw is the canonical "send failed" signal for routeOutbound.
    result = await api.sendMessage(chatId, text, options);
  }
  return { messageId: String(result.message_id) };  // grammy returns number; coerce to string
}
```

Notes on the type coercion: `grammy.api.sendMessage` returns `Message.TextMessage` with `message_id: number` (`@grammyjs/types/message.d.ts:10`). `Channel.sendMessage` returns `messageId: string`. v5 coerces with `String()`. `messages.id TEXT` then receives a numeric string consistently.

Notes on double-throw semantics (round-6 LOW): if the plain-text fallback ALSO rejects (e.g. transient network error during the retry), that second throw propagates uncaught through `sendTelegramMessage` → `TelegramChannel.sendMessage` → `routeOutbound` → caller's `streamingSendFailed` handler. This is intentional: the user received nothing, the agent's cursor should roll back. v7 documents this rather than wrapping in another try.

#### 3. `TelegramChannel.sendMessage` — multi-chunk capture

```ts
async sendMessage(jid: string, text: string, opts?: SendMessageOptions) {
  // ... existing setup ...
  const chunks = splitForTelegram(text, MAX_LENGTH);
  let firstId: string | undefined;
  for (let i = 0; i < chunks.length; i++) {
    // No try/catch here — any throw aborts further chunks AND propagates to
    // the caller (routeOutbound), which means `streamingSendFailed` triggers
    // and the cursor rolls back. Chunks 0..i-1 are already delivered; that
    // is the documented partial-delivery known limitation.
    const r = await sendTelegramMessage(this.bot.api, numericId, chunks[i], options);
    if (i === 0) firstId = r.messageId;
  }
  return { messageId: firstId };
}
```

#### 4. Gmail `sendMessage` — handles `id?: string | null | ''`

```ts
async sendMessage(jid: string, text: string, _opts?: SendMessageOptions) {
  // ... existing build of `requestBody` ...
  const res = await this.gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage, threadId },
  });
  // googleapis Schema$Message.id: string | null | undefined.
  // CRITICAL: `?? undefined` does NOT fire on '' (nullish coalescing skips
  // empty string). An empty-string id would survive into messages.id PRIMARY
  // KEY and the NEXT empty-id send would INSERT OR REPLACE the prior row.
  // Use a truthy fallback so '' also falls through to the synthetic-id path.
  const rawId = res.data?.id;
  const id = rawId && rawId.length > 0 ? rawId : undefined;
  return { messageId: id };
}
```

Gmail's `id` is the internal opaque id (NOT RFC-2822 Message-ID — that would require an extra `users.messages.get({format:'metadata', metadataHeaders:['Message-ID']})` round-trip, out of scope for v1). Empirically Gmail does not return empty-string ids in practice, but the type permits it and the defense costs one extra comparison.

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
export function storeOutboundMessage(
  jid: string,
  text: string,
  channelMessageId?: string,
  senderId?: string,  // round-7 addition: bot's identity per-channel (e.g. Telegram bot.botInfo.id)
): void {
  // Truthy check (length > 0) so an empty-string id from a misbehaving channel
  // also falls through to synthetic. `?? undefined` is NOT enough.
  const id = (channelMessageId && channelMessageId.length > 0)
    ? channelMessageId
    : `out-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;  // 16 hex chars
  const isSynthetic = !(channelMessageId && channelMessageId.length > 0);
  // Round-7 fix: never bind '' as sender — `lookup_messages({sender_id})`
  // exact-equality filter wouldn't find these rows when the agent queries
  // by the bot's own id. Fall back to literal 'bot' when no per-channel
  // identifier is supplied.
  const sender = (senderId && senderId.length > 0) ? senderId : 'bot';
  const timestamp = new Date().toISOString();
  // FK pre-check — same as the working-tree storeMessage at src/db.ts:281-289
  // (the existing INSERT OR IGNORE chats prelude that the bug-fix work added
  // when `foreign_keys = ON` was enabled at src/db.ts:156). For new outbound
  // JIDs that have never sent or received inbound, this seeds the chats row;
  // for existing JIDs it's a no-op.
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time, channel, is_group)
     VALUES (?, NULL, ?, NULL, 0)`,
  ).run(jid, timestamp);
  db.prepare(
    `INSERT OR REPLACE INTO messages
     (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, jid, sender, ASSISTANT_NAME, text, timestamp,
        1 /*is_from_me*/, 1 /*is_bot_message*/,
        isSynthetic ? `<m kind="outbound-synthetic"/>` : null);
}
```

`routeOutbound` resolves the channel (`channels.find(c => c.ownsJid(jid))`) and threads its bot identifier when available:
```ts
const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
if (!channel) throw new Error(`No channel for JID: ${jid}`);
const result = await channel.sendMessage(jid, text, opts);
try {
  const messageId = /* extract as before */;
  const senderId = channel.botSenderId?.();  // optional method; channels that don't implement it return undefined → 'bot' fallback
  storeOutboundMessage(jid, text, messageId, senderId);
} catch (err) {
  logger.error({ jid, err }, 'storeOutboundMessage failed (message was delivered)');
}
```
`Channel.botSenderId(): string | undefined` is an optional method (round-7 addition); `TelegramChannel` returns `String(this.bot.botInfo?.id)`, Gmail returns the configured `'me'` email or undefined. Channels without an obvious identity return undefined and the synthetic-sender path uses literal `'bot'`.

Note on `channel = NULL, is_group = 0`: the hard-coded NULL/0 in the chats INSERT OR IGNORE loses the channel-name and is_group info that `routeOutbound` already resolved (`channels.find((c) => c.ownsJid(jid))`). For JIDs with a channel-name prefix (`tg:`, `wa:`) the existing JID-pattern backfill at `src/db.ts:131-148` reconstructs them on read. For Gmail JIDs (no prefix marker) `channel` stays NULL forever — a minor data-quality gap. v7 documents this as a known limitation rather than threading channel info through (would widen `storeOutboundMessage`'s signature unnecessarily; the JID-prefix backfill handles 2 of 3 cases).

#### 7. Migration: seven direct `channel.sendMessage` call sites rewritten

Every existing site is replaced with `routeOutbound(channels, jid, text, opts)`:
- `src/index.ts:304` (streaming output callback in `runAgent`)
- `src/index.ts:647`, `667`, `676`, `682` (remote-control branches in `handleRemoteControl`; the `667` and `676` sites are multi-line calls — the listed line is the call expression's opening `channel.sendMessage(` token)
- `src/index.ts:769` (one call inside the `deps.sendMessage` lambda passed to `startSchedulerLoop`; the lambda body spans lines 761-771)
- `src/index.ts:777` (one call inside the `deps.sendMessage` lambda passed to `startIpcWatcher`; the lambda body spans lines 773-778)

Verified empirically (round-6 by agent dispatched against the working tree): `git grep -cE 'channel\.sendMessage\(' src/index.ts` returns exactly **7** — matches the seven sites enumerated above. The CI grep script in §8 returns precisely these 7 lines as violations on the pre-migration tree.

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

# git grep pathspec note: `'src/**/*.ts'` without `:(glob)` magic does NOT
# recurse — it's literal-pathname matching that only matches files directly
# inside `src/` with names containing `**`. v6 uses directory pathspecs +
# explicit extension exclude. Verified by running:
#   git grep -l 'channel\.sendMessage' -- 'src/' 'container/agent-runner/src/' ':!*.test.ts'
# which DOES recurse and DOES skip *.test.ts.
matches=$(git grep -nE "$PATTERN" \
  -- 'src/' 'container/agent-runner/src/' \
  ':!*.test.ts' ':!*.test.tsx' ':!*.d.ts' || true)

# Filter out allowlisted paths AND comment-only lines.
# Why the comment filter: `// channel.sendMessage throwing` appears in
# explanatory comments in `src/index.ts` and would false-positive the lint.
# The awk skips any line where the matched content (after the `file:lineno:`
# prefix) begins with optional whitespace + `//` or `*`.
violations=$(echo "$matches" | awk -F: -v allow="$(IFS=\|; echo "${ALLOWLIST[*]}")" '
  {
    file=$1;
    # Reconstruct the code line: everything after "file:lineno:"
    line=$0;
    sub(/^[^:]+:[0-9]+:/, "", line);
    # Skip allowlisted files
    if (file ~ allow) next;
    # Skip JS/TS comment lines (single-line // or block * continuation)
    if (line ~ /^[[:space:]]*(\/\/|\*)/) next;
    print $0;
  }
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

**Empirical verification of the pathspec fix**: before v6 the script used `'src/**/*.ts'` which (per `git help gitglossary` "pathspec" section) requires the `:(glob)` magic prefix or it's treated as a literal path. `git grep ... -- 'src/**/*.ts'` returns 0 matches even when violations exist; directory-form pathspecs (`'src/'`) recurse by default. The v6 form also handles the `:!*.test.ts` exclude correctly (no `**` needed since `git ls-tree`-style exclude already matches across all depths).

## MCP tool descriptions

**`view_media`** — Fetch a Telegram media file by `file_id`. Use when the user asks to look at / view / show / посмотри / покажи a photo, image, sticker, document, or PDF you have a `file_id` for. **Pass `tg_message_id` alongside `file_id`** — it's the `<m id="...">` value on the message that contained the file_id; used by the host for cross-group authorization. `mode` default `auto`: images → image content, PDFs → extracted text. `mode:'image'` with `pages:'1-3'` for visual PDF rendering (max 10 pages). On failure the response text starts with the error code followed by `:` — e.g. `TIMEOUT: ...`, `FILE_TOO_LARGE: ...`, `FILE_EXPIRED: ...`, `EXTRACTOR_MISSING: ...`, `EXTRACTOR_OUTPUT_INVALID: ...`, `NO_TEXT_LAYER: ... (PDF has no extractable text — retry with mode:'image' and a small pages range to render the scan)`, `UNSUPPORTED_TYPE: ...`, `PAGES_OUT_OF_RANGE: ...`, `UPSTREAM_ERROR: ...`, `CROSS_GROUP_REJECTED: ...`. Parse the prefix from the first line and relay the code to the user.

**`lookup_messages`** — Search this group's stored message history. Use when the user references something older than the recent context, when walking a reply chain (`<reply mid="X">`), or to find a specific message. Filters: `tg_message_id`, `sender_id`, `since`/`until`, `query` (case-insensitive substring on text — incl. Cyrillic; `%` and `_` in the query are escaped and matched literally). `include_bot` default `false`; pass `true` to UNION the bot's own past replies into the result (not "only bot"). Default returns last 50; max 200.

**`lookup_contacts`** — Search this group's known people/contacts. Use when the user references a person by name / nickname / `@username` / phone. `query` for free-text; `username` exact (lowercase, no `@`); `tg_id` exact. Returns up to `limit` rows (default 50). Reads a snapshot file refreshed within ~500ms of last upsert — enrichment from `@mention` resolution may not be reflected on the same turn; if a row is missing or `enriched=0`, say so honestly.

**`annotate_contact`** — Attach a note or tag. Identify by ONE of `ident`, `username`, `tg_id`. `notes` REPLACES previous notes (use for the canonical summary); `tags` APPENDS unique comma-separated tags.

## Files touched

Host (`src/`):
- **NEW** `src/channels/telegram-meta.ts` — `buildMetaBlock(message): string`. Pure function (no I/O); produces the `<m>...</m>` string with all attribute values pre-escaped via `escapeXmlAttr` / `escapeXmlText`.
- **NEW** `src/channels/telegram-enrich.ts` — bounded-rate `getChat` resolver. Concrete shape:
  ```ts
  // Module-level state, scoped per process (single Bot instance):
  type EnrichRecord = { kind: 'success' | 'failure'; ts: number; data?: ContactPatch };
  const enrichCache = new Map<string, EnrichRecord>();   // key: lowered username
  const enrichQueue: Array<{ scope: string; username: string }> = [];
  const inFlight = new Set<string>();                    // dedupe by `${scope}|${un}`
  const RATE_PER_SEC = 1;                                // token bucket size 1, refill 1/s
  const TTL_SUCCESS_MS = 24 * 3600 * 1000;
  const TTL_FAILURE_MS = 7 * 24 * 3600 * 1000;

  // Public API:
  export function queueEnrich(scope: string, username: string): void;
  // Idempotent: caller calls per inbound mention.
  // (a) If cache fresh AND record.kind === 'success':
  //     synchronously call upsertContact(scope, record.data, source:'getChat', enriched:1)
  //     for the requesting scope — applies the already-known patch to scope's
  //     contact row even though we don't need to re-call the API.
  //     (Round-7 fix: v7 said "no-op on cache hit" which short-circuited
  //     cross-scope upserts. v8 applies the cached patch per-scope.)
  // (b) If cache fresh AND record.kind === 'failure': no-op (the failure
  //     was a Bot API rejection — same outcome for any scope; don't retry).
  // (c) If queued or inFlight for this `${scope}|${un}` already: no-op.
  // (d) Otherwise push into queue.

  export function startEnrichWorker(bot: Bot, db: Database.Database): void;
  // Long-running setInterval (1000ms) that pops up to RATE_PER_SEC entries
  // per tick, runs `bot.api.getChat(`@${username}`)`, on success upserts a
  // contacts row (source='getChat', enriched=1, with bio/title/etc), on
  // failure caches a failure record. Both paths set cache TTL.
  ```
  Persistence: the cache is in-memory only (cold-start re-resolves; this is acceptable since enrichment is best-effort). Queue is in-memory too — on process restart unfinished entries are lost (next inbound mention re-queues). No backpressure: queue is unbounded but practically capped by mention rate × cache TTL.
- **MOD** `src/channels/telegram.ts`:
  - Wire FOUR update kinds: `bot.on('message:*')`, `bot.on('edited_message:*')`, `bot.on('channel_post:*')`, `bot.on('edited_channel_post:*')`.
  - Each handler builds meta via `telegram-meta` and passes via `NewMessage.meta`.
  - Remove auto-vision in `message:photo` (no `processImage`, no `images` field on `NewMessage`).
  - **Rewrite `sendTelegramMessage`** as shown in §2 above — returns `Promise<{ messageId: string }>`.
  - **Rewrite `TelegramChannel.sendMessage`** as shown in §3 above — captures the first chunk's id.
- **MOD** `src/db.ts`:
  - **`ALTER TABLE messages ADD COLUMN meta TEXT` made idempotent via PRAGMA-check wrapper** (SQLite raises `duplicate column name: meta` if the column already exists, so a naked `ALTER TABLE` is NOT idempotent across restarts):
    ```ts
    function addMetaColumnIfMissing(database: Database.Database): void {
      const cols = database
        .prepare('PRAGMA table_info(messages)')
        .all() as { name: string }[];
      if (!cols.some((c) => c.name === 'meta')) {
        database.exec('ALTER TABLE messages ADD COLUMN meta TEXT');
      }
    }
    ```
    Called from `initDatabase` AFTER `createSchema(db)`. Wrap in try/catch only if you also want to tolerate the column-already-exists race; the PRAGMA check is sufficient under the single-process model NanoClaw uses.
  - **Register `db.function('lower_unicode', ...)` immediately after `new Database(dbPath)` and BEFORE any `db.prepare` that references it** (existing `createSchema` uses `database.exec(...)` only — no prepared statements — so registration ordering between `createSchema` and prepared-statement init doesn't matter; the *future* `lookup_messages` prepared statement is what needs the function registered first):
    ```ts
    // src/db.ts, inside initDatabase (working-tree v8 form):
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');  // preserved — bug-fix work prior to this spec added it
    db.function('lower_unicode', { deterministic: true }, (s: string | null) =>
      s == null ? null : s.toLowerCase(),
    );
    createSchema(db);
    addMetaColumnIfMissing(db);
    // …subsequent code may now `db.prepare('… lower_unicode(?) …')` safely.
    ```

    **Apply the SAME sequence to `_initTestDatabase`** (round-7 HIGH defect): the in-memory test DB also needs `db.function('lower_unicode')` and `addMetaColumnIfMissing(db)`, otherwise unit tests for `lookup_messages` SQL throw `SqliteError: no such function: lower_unicode` and meta-projection tests throw `no such column: meta`. Factor a shared helper if cleaner:
    ```ts
    function wireDatabaseFeatures(database: Database.Database): void {
      database.pragma('foreign_keys = ON');
      database.function('lower_unicode', { deterministic: true }, (s: string | null) =>
        s == null ? null : s.toLowerCase(),
      );
    }
    export function initDatabase(): void {
      // ... mkdir ...
      db = new Database(dbPath);
      wireDatabaseFeatures(db);
      createSchema(db);
      addMetaColumnIfMissing(db);
      migrateJsonState();
    }
    export function _initTestDatabase(): void {
      db = new Database(':memory:');
      wireDatabaseFeatures(db);
      createSchema(db);
      addMetaColumnIfMissing(db);
    }
    ```
  - **Extend SELECT projection in `getNewMessages` and `getMessagesSince`** to include `meta`. The working-tree `src/db.ts:335-348` and `:368-379` ALREADY use **flat `ORDER BY timestamp ASC LIMIT ?`** (the "FIFO drain" idiom with a self-documenting comment explaining the prior DESC-LIMIT bug was already fixed). v7 preserves that — adds `meta` to SELECT projection and adds the `OR meta IS NOT NULL` predicate to the WHERE clause; does NOT touch the sort/limit structure or WHERE bind order:

    ```sql
    -- getNewMessages: drop-in addition to existing flat ASC; binds unchanged (lastTimestamp, ...jids, botPrefix, limit).
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
    -- getMessagesSince: drop-in addition to existing flat ASC; binds unchanged (chatJid, sinceTimestamp, botPrefix, limit).
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, meta
    FROM messages
    WHERE chat_jid = ?
      AND timestamp > ?
      AND is_bot_message = 0
      AND content NOT LIKE ?
      AND ((content != '' AND content IS NOT NULL) OR meta IS NOT NULL)
    ORDER BY timestamp ASC
    LIMIT ?;
    ```

    Rationale for keeping flat ASC: working-tree `src/db.ts:335-339` comment explicitly says: *"FIFO drain: take the OLDEST `limit` unseen messages so a backlog larger than the limit doesn't lose its tail. Previously this used `ORDER BY DESC LIMIT 200` and advanced past the cap, silently dropping the oldest unseen rows."* Re-introducing the DESC subquery (which v5 and v6 incorrectly prescribed) would re-introduce that bug.

    Rationale for keeping WHERE bind order: existing callers pass arguments in the order matching this WHERE clause. Reshuffling would silently break the message loop (bind-position mismatch — string vs string both typecheck, fail at runtime by returning empty results).
  - Updated `NewMessage` type carries `meta?: string`.
  - `storeMessage` carries `meta`; **`storeOutboundMessage`** as shown in §6 above.
  - `contacts` schema + `upsertContact` (COALESCE merge) + `promoteContactIdent` (read-merge-write with `mergeContactRows` as shown above) + `getContactsForGroup({scope, includeUnion?})` + `annotateContact` + `lookupMessages` (group-scoped, clamped, `lower_unicode` LIKE with `ESCAPE '\'`, full SQL above).
- **MOD** `src/ipc.ts`:
  - New request/response namespaces: `media-requests/` ↔ `media-responses/`, `lookup-requests/` ↔ `lookup-responses/`, `contact-write-requests/` ↔ `contact-write-responses/` (renamed from `contact-writes/` so it matches the `*-requests/` / `*-responses/` sweep glob).
  - `lookup_contacts` does NOT use IPC; it reads the mounted `contacts.json` directly.
  - TTL sweep at 180s, startup + every 5 min, for `*-requests/` and `*-responses/` ONLY (glob matches all three new namespaces). `errors/` left alone.
  - `contacts.json` snapshot writer: **trailing-edge debounce, 500ms, per-scope timer**. On SIGTERM, `flushAllSnapshots()` synchronously fires all pending timers. **Atomic write (round-6 MEDIUM fix)**: writer uses temp+rename:
    ```ts
    const tmp = `${snapshotPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, snapshotPath);  // POSIX atomic rename
    ```
    Without temp+rename, large snapshots (1000+ contacts) can be observed mid-write by the container's `fs.readFileSync` + `JSON.parse`, which then throws — the `lookup_contacts` tool intermittently fails. The existing `writeGroupsSnapshot` at `src/container-runner.ts:887-897` has the same race for `available_groups.json` (out of scope for this spec to fix, but flagged as a related known bug class).
- **MOD** `src/container-runner.ts`:
  - Ensure new IPC sub-dirs exist (`media-requests/`, `media-responses/`, `lookup-requests/`, `lookup-responses/`, `contact-write-requests/`, `contact-write-responses/`).
  - **Remove `ImageAttachment` interface and `ContainerInput.images?: ImageAttachment[]` field** (auto-vision wire format dead post-migration).
  - Delete `pendingImages` Map and `hasImages` branch in `src/index.ts` in the same change set.
- **MOD** `src/router.ts`:
  - `formatMessages` reads both `content` and `meta`. When `meta` present: `<message ...>${meta}\n${content ? '<text>' + escapeXmlText(content) + '</text>' : ''}</message>`. When `meta` NULL: legacy `<message ...>${escapeXmlText(content)}</message>`. The `meta` payload is emitted verbatim (host pre-escaped every attribute at build time via `escapeXmlAttr` and every element-text-content via `escapeXmlText`).
  - **`routeOutbound`** as shown in §5 above — isolation of send vs store.
- **MOD** `src/types.ts`:
  - `Channel.sendMessage` returns `Promise<{ messageId?: string } | void>`.
  - Add `NewMessage.meta?: string`.
  - **Remove `NewMessage.images?: ImageAttachment[]`** (auto-vision deprecated; nothing should produce or consume it post-migration). The `ImageAttachment` type itself can be removed if no other consumer exists — confirm with a grep before deletion.
- **MOD** `src/index.ts`:
  - All seven direct `channel.sendMessage(...)` migrated to `routeOutbound(channels, jid, text, opts)` at lines **304, 647, 667, 676, 682, 769, 777** (the last two are the single call inside each `deps.sendMessage` lambda — lambda bodies span 761-771 and 773-778 respectively).
  - Delete `pendingImages` Map and `hasImages` branch.
- **MOD** `src/channels/gmail.ts` — `sendMessage` as shown in §4 above; handles `id | null | undefined`.

Container (`container/agent-runner/src/`):
- **MOD** `ipc-mcp-stdio.ts`:
  - Register 4 new tools with the descriptions above.
  - `writeIpcFile(dir, data, filenameOverride?: string)` — when provided, writes to `dir/${filenameOverride}` via temp+rename. Preserves existing default-filename behavior when absent.
  - Shared helper `pollResponseFile(reqId, timeoutMs=120000, intervalMs=100): Promise<unknown>`.
  - `lookup_contacts` reads `/workspace/ipc/contacts.json` via `fs.readFileSync` and filters in memory.
- **MOD** `container/agent-runner/src/index.ts` — auto-vision deletion (round-6 HIGH defect): remove `ImageAttachment` interface (lines 25-39 of working tree), `ContainerInput.images?: ImageAttachment[]` field, `pushWithImages` call site (lines 396-397). After deletion the container only ingests text prompts; media access flows exclusively through `view_media`.
- **NEW** `container/agent-runner/vitest.config.ts` + container-side test scaffolding (v8 spelling-out of round-7 HIGH defect):
  - **NEW** `container/agent-runner/vitest.config.ts`:
    ```ts
    import { defineConfig } from 'vitest/config';
    export default defineConfig({
      test: { include: ['src/**/*.test.ts'] },
    });
    ```
  - **MOD** `container/agent-runner/package.json` — add to `devDependencies`:
    ```json
    "vitest": "^4.0.18"
    ```
    matching host root's pinned version (verify `package.json` at repo root for the exact version). Also add to `scripts`:
    ```json
    "test": "vitest run"
    ```
  - **MOD** root `package.json` `scripts.test` — concrete value:
    ```json
    "test": "vitest run && (cd container/agent-runner && npm test) && bash scripts/check-outbound-chokepoint.sh"
    ```
  - **Note on container build**: `vitest` is a devDependency; `container/build.sh` strips devDependencies via `npm ci --omit=dev` at image-build time. Test discovery happens at the HOST level (host runs `cd container/agent-runner && npm test` against the host filesystem with `--include=dev` installed). No new runtime overhead inside the container image.
- **NEW** `container/agent-runner/src/file-too-large-prefix.test.ts` — host-runs container-package vitest discovers it; body shown verbatim in verification #14 below. Exports needed from `container/agent-runner/src/ipc-mcp-stdio.ts`: the test imports `handleViewMediaRequest` but only uses `CallToolResultSchema.parse(...)` — the import is decorative and may be removed for v8 (the test is purely a wire-frame structural assertion).

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
  - **`promoteContactIdent` tg_id non-NULL invariant** (round-6 HIGH defect): cover BOTH cases — (a) `idRow` undefined + `unRow.tg_id` NULL (the formerly-broken path that v6's caller-override `tg_id: tgId` fixes), assert `SELECT tg_id FROM contacts WHERE ident = ?` returns the new tgId, not NULL; (b) `idRow` present with notes/tags pre-promotion, assert tg_id still equals the new tgId.
  - **`addMetaColumnIfMissing` idempotency** (round-6 HIGH defect): call `_initTestDatabase()` twice in a row; assert the second call does not throw. Then call a separate helper that re-runs `addMetaColumnIfMissing(db)` directly; assert no throw and `meta` column still present.
  - `lookup_messages` LIKE wildcard escape: query `тратил 50%` matches a row with literal `тратил 50%` and does NOT match `тратил 5000`.
  - Cyrillic case insensitivity: `Петя` ↔ `петя` via `lower_unicode`.
  - **`promoteContactIdent` does NOT crash at module load** (round-6 CRITICAL defect): `import * as db from './db.js'` in a fresh process; before `_initTestDatabase()` runs, the module is fully loadable (no `TypeError: Cannot read properties of undefined`). Asserted indirectly by the test suite booting at all; can be made explicit with `expect(() => require('./db.js')).not.toThrow()` if needed.
- **NEW** `src/ipc-mediarequest.test.ts` — happy path; timeout (TIMEOUT with `_meta.retryable=true` at the wire level AND text prefix `TIMEOUT:`); oversized-file pre-flight (FILE_TOO_LARGE without `getFile`); pdftotext AND-rule cases (stderr noise + non-empty stdout → return text; stderr noise + empty stdout → EXTRACTOR_OUTPUT_INVALID; exit 0 + empty stdout + empty stderr → **NO_TEXT_LAYER** with hint to retry as image); startup sweep; `writeIpcFile` filename-override round-trip; HEIC → UNSUPPORTED_TYPE; **routeOutbound DB-failure isolation** (mock `storeOutboundMessage` to throw; assert `routeOutbound` does NOT throw and the calling fixture's `streamingSendFailed` remains false); **`errors/` exclusion from sweep** (round-6 HIGH defect): place a file with `mtime = now - 1h` at `data/ipc/<group>/errors/foo.json`; run the sweep; assert the file still exists; **CROSS_GROUP_REJECTED authorization** (round-6 fix): construct a `view_media` request whose `file_id` resolves to a `messages` row in another group; assert response is `CROSS_GROUP_REJECTED` with `_meta.error_code` set.
- **NEW** `src/channels/telegram-enrich.test.ts` (round-6 MEDIUM defect — telegram-enrich was specified but untested): (a) call `queueEnrich('g', 'vasya')` 100 times in a tight loop; assert the queue contains exactly 1 entry (dedupe via `inFlight` Set); (b) populate cache with a 23h59m-old success record; call `queueEnrich`; assert no queue push (TTL hit); (c) populate cache with a 25h-old success; call `queueEnrich`; assert queue push (TTL expired); (d) populate cache with a 6d23h-old failure; call `queueEnrich`; assert no queue push (failure TTL 7d); **(e) round-7 cross-scope test**: populate cache with a fresh success record for `'vasya'` (key is username-only); call `queueEnrich('group-A', 'vasya')`; observe one `upsertContact(scope='group-A', source='getChat', enriched=1)` call. Then call `queueEnrich('group-B', 'vasya')`; observe another `upsertContact(scope='group-B', source='getChat', enriched=1)` call (NOT a no-op) — proves the cache-hit branch applies the patch per-scope.
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
- **Partial multi-chunk failure → user sees chunk 1 twice** (round-6 trace): if chunk 1 succeeds and chunk 2 throws, the throw propagates through `routeOutbound` (the SEND path is NOT inside the storeOutboundMessage try). In `src/index.ts:281-353` (working tree) the streaming callback's `outputSentToUser` flag is set to `true` ONLY after `await channel.sendMessage(...)` resolves successfully — chunk 2's rejection prevents that assignment. The catch sets `streamingSendFailed = true`. With `outputSentToUser = false`, the cursor rollback path executes; the next poll re-processes the same inbound messages, the agent runs again, generates the same output (likely-deterministic), and chunk 1 is re-delivered. User sees chunk 1 twice. Out of scope to fix in v1 because it requires the streaming callback to learn partial-progress from `TelegramChannel.sendMessage` mid-loop.
- **`routeOutbound` "No channel for JID" infinite-retry loop on mid-run disconnect** (round-6): if a channel disconnects between `routeOutbound`'s `channels.find(c => c.ownsJid(jid) && c.isConnected())` returning `null` and the next poll, the throw triggers `streamingSendFailed = true` → cursor rollback → re-run → same throw. Loops until the channel reconnects (Telegram's long-polling auto-restart at `src/channels/telegram.ts:540-566` typically resolves it within seconds) or the process is killed. v7 documents but doesn't fix — distinguishing "transient send failure" from "permanent missing channel" would require a separate exception class.
- **Gmail outbound id is internal** — not RFC-2822 Message-ID. Capturing the RFC-2822 ID would require an extra `users.messages.get({format:'metadata'})` round-trip, out of scope for v1.
- **`business_message`/`edited_business_message`** — not wired in v1.
- **`lookup_messages` query on text-only** — photo-no-caption rows have `content=''` and are unsearchable by `query`; agent must use `tg_message_id` / temporal filters.
- **`promoteContactIdent` data-loss edge** — when both `id:` and `un:` rows have non-null `notes` written by the agent before promotion fires, the id-row's notes win and the un-row's notes are lost. Tags are unioned. To preserve both, the agent must annotate AFTER promotion (i.e. after the bot has both seen the tg_id directly and any previous mention). Out of scope to merge note strings programmatically.
- **`String.prototype.toLowerCase` is Unicode-aware, not full case-folding** — handles Cyrillic / Greek / accented Latin (the user's actual languages). Does not perform Turkish `İ`→`i̇` or German `ẞ`→`ss` folds.
- **Snapshot mounted into container** — `contacts.json` lives in the group's IPC mount by design. Group isolation enforced at the mount boundary.
- **`_meta` is host-side only** — Anthropic agent SDK doesn't propagate MCP content-block `_meta` to the model. v5 places error metadata on `CallToolResult._meta` (top-level, in the SDK's event stream) but the model only reads the `text` prefix. The `_meta` exists for tests, hooks, and host-side telemetry.
- **`retry_after_ms` is informational only** — SDK doesn't honor it automatically; the agent (text-prefix-only view) can't consume it directly.
- **Re-edit of message before cursor doesn't re-deliver** (round-7 addition) — `timestamp = max(message.date, edit_date)`. If both `message.date` and `edit_date` are earlier than the message-loop cursor (e.g. agent process restarted past the edit window), `WHERE timestamp > cursor` excludes the edit row even though it was just stored. The INSERT OR REPLACE updates `meta.edited` correctly; the agent just doesn't see it on the next poll. To recover, agent must `lookup_messages({tg_message_id})` explicitly.
- **`storeOutboundMessage` channel/is_group hardcoded** (round-7 addition) — the chats INSERT OR IGNORE writes `channel=NULL, is_group=0` for new outbound JIDs. The JID-prefix backfill at `src/db.ts:131-148` is a one-shot migration (wrapped in try/catch around the schema ALTER) and does NOT run on subsequent boots. So for any JID first-seen via outbound after the migration: tg:/wa:-prefixed JIDs stay `channel=NULL` until inbound traffic populates them; Gmail JIDs (no prefix marker) stay `channel=NULL` indefinitely. Out of scope to widen `storeOutboundMessage`'s signature; the data-quality gap affects `getAllChats()` rendering only.
- **Concurrent `promoteContactIdent` race for same username, different `tg_id`s** (round-7 addition) — rare scenario: same `@vasya` username resolved to two different tg_ids (recycled username, or `text_mention` vs `getChat` resolution disagreement). `db.transaction` serializes the calls; first call wins (un-row consumed, history merged into `id:<tgId-1>`). Second call finds no un-row, early-returns. The agent's annotations from the un-row attach only to the first tgId; second tgId's id-row exists separately with no merged history. Agent must manually annotate the second id-row.
- **`view_media` voice/audio branch is historical-recovery only** (round-7 documentation) — for first-turn voice messages, the transcript is already inline in the inbound meta block (`<m><media transcript=...>`); calling `view_media` returns only a pointer string `'voice: see message transcript'`. The branch exists for the case where the agent has the file_id from compacted history but no longer has the meta inline. Even then the tool can't return the transcript because the transcript was never persisted as a separately-fetchable resource — it's stored inside `messages.meta` and must be retrieved via `lookup_messages({tg_message_id})` followed by meta-parsing on the agent side.

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
- **Message reactions** — `message_reaction` and `message_reaction_count` Bot API update kinds are not wired (round-6). Agent cannot answer "what reactions did message X get". Adding requires two new handlers plus a `reactions` column or a separate `message_reactions` table.
- **Atomic `writeGroupsSnapshot`** — fixing the pre-existing non-atomic write at `src/container-runner.ts:887-897` is a related-but-separate cleanup. v7 only fixes `contacts.json`.
- **Distinguishing "missing channel" from "transient send failure"** in `routeOutbound` — see known limitation.
- **`MessageOrigin.unknown` recovery for future Bot API kinds** — currently `<fwd kind="unknown" raw="..."/>` carries the JSON dump; the agent has structural data but no semantic interpretation.

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
  11. Bot reply → `messages` row with `is_bot_message=1` and real Telegram `message_id` (numeric-string coerced via `String()`); `lookup_messages({tg_message_id: <id>, include_bot: true})` finds it. Without `include_bot:true` the row is filtered (default excludes bot messages); the verification MUST pass `include_bot: true` explicitly.
  12. Edit a channel post → `meta.edited` set; row re-delivered.
  13. **`_meta` wire-level round-trip — host-side structural assertion** (host vitest doesn't have access to `@modelcontextprotocol/sdk` — it lives only in `container/agent-runner/node_modules/`):
      ```ts
      // src/ipc-mediarequest.test.ts — host-side coverage
      // Induce FILE_TOO_LARGE through the IPC contract layer; assert the JSON
      // response written to media-responses/<reqId>.json has the expected shape:
      const raw = fs.readFileSync(responseFile, 'utf-8');
      const parsed = JSON.parse(raw) as {
        isError: true;
        _meta: { error_code: string; retryable: boolean; retry_after_ms?: number };
        content: Array<{ type: 'text'; text: string }>;
      };
      expect(parsed.isError).toBe(true);
      expect(parsed._meta.error_code).toBe('FILE_TOO_LARGE');
      expect(parsed.content[0].text).toMatch(/^FILE_TOO_LARGE:/);
      ```
      This proves the host writes the correct shape; the container's MCP layer then forwards it. Schema validation via `CallToolResultSchema.parse(...)` belongs in the container-side test below.
  14. **Container-side model-facing-text assertion** (the SDK runs in the container, not the host — `@anthropic-ai/claude-agent-sdk` is at `container/agent-runner/node_modules/`). v7 adds a vitest config + test suite under `container/agent-runner/`:
      ```ts
      // container/agent-runner/src/file-too-large-prefix.test.ts
      // Mocks the IPC response (no need to actually run the host pipeline) and
      // exercises the MCP tool implementation in ipc-mcp-stdio.ts.
      import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
      import { handleViewMediaRequest } from './ipc-mcp-stdio.js';

      // Pre-populate the polled response file with a FILE_TOO_LARGE error frame
      // that the host would have written.
      const wireFrame = {
        isError: true,
        _meta: { error_code: 'FILE_TOO_LARGE', retryable: false },
        content: [{ type: 'text' as const, text: 'FILE_TOO_LARGE: file exceeds 20MB cap' }],
      };
      // Schema validates structurally:
      const parsed = CallToolResultSchema.parse(wireFrame);
      expect(parsed._meta?.error_code).toBe('FILE_TOO_LARGE');
      expect(parsed.content[0]).toEqual({ type: 'text', text: 'FILE_TOO_LARGE: file exceeds 20MB cap' });
      // CRITICAL contract assertion: the MCP SDK strips content[N]._meta when
      // forwarding to the model; only top-level _meta is exposed to the SDK
      // consumer. Verified by tracing `XGq` in the cli.js content-block
      // normalizer of @anthropic-ai/claude-agent-sdk@0.2.76.
      expect((parsed.content[0] as any)._meta).toBeUndefined();
      ```
      To make this discoverable, **add** `container/agent-runner/vitest.config.ts` and a `test` script in `container/agent-runner/package.json`. `npm test` at the repo root invokes BOTH (host: `vitest run` for `src/**`; container: `cd container/agent-runner && vitest run`). The full SDK→Anthropic wire-level intercept (originally proposed in v6 with `vi.stubGlobal('fetch', ...)`) is dropped from v7 because (a) the SDK uses an internal fetch instance whose interception point is unstable across 0.2.x patches; (b) the structural assertion above is sufficient — `XGq` is verifiable by reading the SDK source once; (c) installing the SDK at host level just for this test would double project install footprint.
  15. **Cyrillic `lookup_messages`**: store `Петя`; query `'петя'` returns the row.
  16. **LIKE wildcard escape**: store two rows, content `'тратил 50% налога'` and `'тратил 5000 налога'`. Query `'50%'` returns ONLY the first row (the `%` is escaped, matched literally).
  17. **CI grep enforcement**: running `scripts/check-outbound-chokepoint.sh` on the post-migration tree returns 0. Reverting any one of the 7 enumerated migrations makes it return 1.
  18. **`routeOutbound` DB-failure isolation**: mock `storeOutboundMessage` to throw `SQLITE_BUSY`. Call `routeOutbound(channels, jid, 'hello')`. Assert: it does NOT throw; the channel's `sendMessage` was called (user got the message); an `error` log entry was made.
- Regression: existing message loop, scheduler, threadId routing, FIFO drain, sender allowlist, trigger detection — all unchanged. The existing `escapeXml` helper at `src/router.ts:4-11` (escapes `&<>"`) is **kept** as a separate export; v8 ADDS `escapeXmlAttr` (escapes `&<>"'`) and `escapeXmlText` (escapes `&<>`) as new functions. The four helpers coexist; v8's `formatMessages` uses `escapeXmlText(content)` for the user-text envelope (functionally equivalent to existing `escapeXml(content)` modulo `"` handling — both are legal inside XML element content, and Telegram's user-text doesn't carry attribute-injection risk).

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

**v5 lessons (resolved in v6)**:
- **CI grep pathspec was empirically broken** (CRITICAL) — v5's `'src/**/*.ts'` without `:(glob)` magic matches nothing in git's pathspec parser. `git grep -- 'src/**/*.ts'` returns 0 hits even with violations. v6 switches to directory pathspecs (`'src/' 'container/agent-runner/src/'`) with `':!*.test.ts' ':!*.test.tsx' ':!*.d.ts'` excludes (no `**` needed in excludes — git's exclusion already matches across all depths).
- **CI grep would false-positive on `//` comment lines** (CRITICAL) — `src/index.ts` contains `// channel.sendMessage throwing` as part of a code comment, which v5's awk filter would flag. v6 adds awk-side `^[[:space:]]*(\/\/|\*)` line-skip after reconstructing the code from `file:lineno:` prefix.
- **`mergeContactRows` could leave merged row with NULL `tg_id`** (HIGH) — `coalesce(idRow?.tg_id, unRow.tg_id)` returns null when both are null/undefined; the un-row often has null tg_id by construction, and the id-row may also be undefined (the common case: un-row exists but no id-row yet, the merge happens just before INSERT under the new id-ident). The merged row's invariant says identity is `id:<tgId>` but `tg_id` column would be null. v6 explicit caller override: `{ ...mergeContactRows(idRow, unRow), ident: idIdent, tg_id: tgId }`.
- **`promoteContactIdent` used pseudocode `/* INSERT OR REPLACE ... */`** (HIGH) — not actually implementable without re-reading the spec. v6 inlines verbatim SQL with named binds (`@ident`, `@scope`, …) so the agent has copy-pasteable code.
- **XML attribute escaping unspecified for user-controlled fields** (HIGH) — v5 said "we control the block's content" but attribute *values* (`<from name="...">`, `<sender_chat title="...">`, `<fwd un="..." sig="...">`, `<contact name vcard_raw>`, `<location title address>`, `<poll question>`, `<textlink href>`) come from inbound messages and can contain `"`, `<`, `>`, `&`, `'`. v6 mandates `escapeXmlAttr` for all attribute values and `escapeXmlText` for element text content, with a test case using `Bob "the builder" <hr@x>` to assert valid-XML output.
- **`getMessagesSince` v5 SQL swapped WHERE bind order** (HIGH) — existing code in `src/db.ts:348-372` uses `WHERE chat_jid = ? AND timestamp > ?` with binds in `(chatJid, sinceTimestamp, ...)` order. v5 spec wrote `WHERE timestamp > ? AND chat_jid = ?` — flipping the binds would silently break existing callers (both binds are strings, no typecheck failure, returns empty results at runtime). v6 preserves the original WHERE order.
- **v5 lost the "ORDER BY DESC LIMIT N) ORDER BY ASC" subquery idiom** (HIGH) — existing `getNewMessages`/`getMessagesSince` take the N most recent messages after the cursor and re-sort chronologically. v5's flat `ORDER BY timestamp ASC LIMIT N` returns the N oldest after the cursor, which under burst load would drop the newest messages. v6 restores the subquery idiom for both functions.
- **`lookup_messages` bind list comment was misleading** (MEDIUM) — v5 said "query-or-null, escaped-and-wildcarded query" implying two distinct values; both binds are the SAME value (one tests `IS NULL`, the other is the `LIKE` pattern). v6 clarifies "escaped-and-wildcarded query × 2 (one for the `IS NULL` test, one for the `LIKE` pattern — the same value)" — and generalizes the rule for every `(? IS NULL OR col = ?)` filter.
- **`ALTER TABLE messages ADD COLUMN meta` not idempotent** (MEDIUM) — v5 claimed "(idempotent)" but SQLite throws `duplicate column name: meta` on the second run. v6 wraps with a `PRAGMA table_info(messages)` check.
- **`db.pragma('foreign_keys = ON')` was in spec but NOT in existing code** (LOW) — v5 example code included it; existing `src/db.ts` doesn't, and turning FK enforcement on now would surface latent data-integrity issues out of this feature's scope. v6 explicitly notes v6 does NOT add it.
- **`telegram-enrich.ts` shape underspecified** (MEDIUM) — v5 said "bounded-rate `getChat` resolver" with no concrete API or persistence story. v6 specifies module-level state (cache, queue, inFlight Set), public API (`queueEnrich`, `startEnrichWorker`), TTLs (24h success / 7d failure), rate (1/sec via setInterval), and cold-start posture (in-memory, re-resolves on restart).
- **IPC sweep glob spec was prose-only** (MEDIUM) — v5 said "sweep glob `*-requests/` and `*-responses/` ONLY". v6 inlines the actual `readdirSync({withFileTypes:true})` + `/-(requests|responses)$/` regex check, and pins per-group sweep root as `data/ipc/<group>/` with flat (non-recursive) inner traversal.
- **Verification #11 would fail without `include_bot:true`** (MEDIUM) — bot's own reply has `is_bot_message=1`. `lookup_messages` default excludes those. v6 explicitly notes the test must pass `include_bot: true`.
- **Verification #14 mock recipe was prose-level** (MEDIUM) — v5 said "use the Anthropic SDK's request interceptor" without showing how. v6 inlines a vitest recipe using `vi.stubGlobal('fetch', spy)` + body-parse + `tool_result` assertions.
- **`NewMessage.images` removal wasn't explicit** (LOW) — v5 said "auto-vision removed" but didn't list the type-field deletion in `Files touched → src/types.ts`. v6 adds an explicit bullet.
- **Dead `lastErr` variable in `TelegramChannel.sendMessage` example** (LOW) — captured but never used; removed in v6 along with the now-redundant try/catch (the throw propagates anyway).
- **Sticker mime priority ordering not pinned** (LOW) — v5 listed three rules but didn't specify priority. v6 pins top-to-bottom evaluation: `is_animated` first → `is_video` second → else `image/webp`. Mutually exclusive per Bot API but the spec pins the order anyway for implementer-determinism.
- **Synthetic-id for outbound when `messageId` is null** — v6 inherits v5's pattern (`storeOutboundMessage` passes `'out-${ts}-${rand}'` when `channelMessageId` is undefined) and adds clarification: when `messageId` is null (Gmail can return null), the column gets the synthetic id AND `meta` gets `<m kind="outbound-synthetic"/>` for downstream introspection.

**v6 lessons (resolved in v7)**:
- **CRITICAL — Subquery idiom "restoration" regresses a documented fix** (cross-confirmed by 2 reviewers): working-tree `src/db.ts:335-339` carries an explicit comment naming the prior `ORDER BY DESC LIMIT 200` bug ("silently dropping the oldest unseen rows") and explaining why the current `ORDER BY timestamp ASC LIMIT ?` is correct. v5/v6 incorrectly believed the existing code uses DESC subquery (true at HEAD's committed dbcfdc0, FALSE in working tree where the bug fix lives). v7 drops the "restoration" and keeps flat ASC.
- **CRITICAL — `promoteContactIdent` crashes at module load** — `const promoteContactIdent = db.transaction(...)` evaluated when the file is `import`ed; `db` is undefined at that point. The existing `recordTaskRun` at `src/db.ts:540-552` has an explicit anti-pattern warning. v7 makes it a function whose body calls `db.transaction(...)()`.
- **CRITICAL — Host vs container test boundary breaks verifications #13 and #14** — `@modelcontextprotocol/sdk` and `@anthropic-ai/claude-agent-sdk` are installed only in `container/agent-runner/node_modules/`; host `vitest.config.ts` `include` doesn't reach `tests/integration/`. v7 splits #13 into a host-side IPC-frame structural test and #14 into a new container-side test suite (with new `container/agent-runner/vitest.config.ts` + `package.json` `test` script).
- **HIGH — `escapeXml` undefined symbol** (cross-confirmed by 2 reviewers): v6 defined only `escapeXmlAttr` and `escapeXmlText` but referenced `escapeXml(...)` at lines 71, 112, 738, 865. v7 renames every use to the explicit variant — `escapeXmlText` for element-content (`<text>`, `<quote>`, legacy non-meta envelope), `escapeXmlAttr` for attribute values (the `<fwd raw="...">` JSON dump).
- **HIGH — Container-side auto-vision deletion was half-specified** — v6's "Files touched" listed `src/types.ts` `NewMessage.images` removal but not `container/agent-runner/src/index.ts` (own `ImageAttachment` + `containerInput.images` branch) nor `src/container-runner.ts` (`ContainerInput.images` on the wire format). v7 enumerates both.
- **HIGH — `AUTH_REJECTED` structurally unreachable** — per-group IPC mount makes cross-group requests physically impossible from the container side. v7 renames to `CROSS_GROUP_REJECTED` and re-grounds it on the reachable "request payload references a chat_jid not owned by the source group" check (analogous to the existing sendMessage auth pattern at `src/ipc.ts:108-126`).
- **HIGH — Retry budget arithmetic** — "initial + 3 retries = 4 attempts, backoffs 1s/2s/4s/8s" is inconsistent (4 attempts have 3 waits). v7 pins "initial + 4 retries = 5 attempts, waits 1/2/4/8s = 15s worst case".
- **HIGH — Gmail `''` id PRIMARY KEY collision** — `res.data?.id ?? undefined` doesn't fire on empty string. v7 uses `rawId && rawId.length > 0 ? rawId : undefined` in both `gmail.sendMessage` and `storeOutboundMessage`.
- **HIGH — v6 wrongly claimed "does NOT add `db.pragma('foreign_keys = ON')`"** — working-tree `src/db.ts:156` ALREADY enables it (bug-fix work prior to this spec). v7 corrects the claim and confirms the existing `INSERT OR IGNORE INTO chats` prelude in `storeMessage` IS the FK pre-check that v6's `storeOutboundMessage` cross-references.
- **HIGH — No verification for ALTER TABLE idempotency, errors/ exclusion, tg_id non-NULL** — three v6 fixes had no corresponding test bullet. v7 adds all three to `src/db.test.ts` and `src/ipc-mediarequest.test.ts`.
- **MEDIUM — Missing Bot API 7.0+ fields** — v6 omitted `via_bot`, `link_preview_options`, `is_automatic_forward`, `caption_entities`, message reactions. v7 adds first four as `<via_bot>`, `<link_preview>`, `<m auto_fwd="1">`, merge `caption_entities` into `<entities>`. Reactions go to Out of Scope.
- **MEDIUM — `MessageOriginChat.author_signature` dropped** — only emitted for channel forwards. v7 emits `sig=` for both `chat` (anonymous admin) and `channel` kinds.
- **MEDIUM — `sendTelegramMessage` Markdown→plain fallback catches all errors** — v7 narrows to `err.error_code === 400 && /can't parse entities/i.test(err.description)`.
- **MEDIUM — pdftotext AND-rule fails for scanned PDFs** (exit 0 + empty stdout + empty stderr → silent success-with-empty-text). v7 adds `NO_TEXT_LAYER` error code + tool hint to retry as image.
- **MEDIUM — pdftoppm `pages` parse rule unspecified** — v7 pins regex `^(\d+)-(\d+)$`, ≥1, start≤end, end-start+1 ≤ 10. Any deviation → `PAGES_OUT_OF_RANGE`.
- **MEDIUM — `contacts.json` snapshot writer non-atomic** — v7 mandates temp+rename. Documents the related pre-existing race in `writeGroupsSnapshot` as out of scope.
- **MEDIUM — 120s poll vs 180s sweep race** — v7 adds interlock: sweep writes TIMEOUT only if no response file exists; watcher renames request to `.processing` before download; sweep skips `.processing` files.
- **MEDIUM — `telegram-enrich.ts` was specified but untested** — v7 adds `src/channels/telegram-enrich.test.ts` covering dedupe and cache TTL.
- **MEDIUM — Multi-chunk failure → user sees chunk 1 twice** — full trace through `src/index.ts:281-353` working-tree code added to known limitations.
- **MEDIUM — `routeOutbound` infinite-retry on mid-run channel disconnect** — added to known limitations with trace.
- **LOW — Entity tag renaming inconsistent** — v6 had `<phone>`, `<email>`, `<text_link>` mixed with `<text_mention>`, `<custom_emoji>` underscored variants. v7 uses canonical Bot API names throughout.
- **LOW — Re-edit of old message before cursor** — `edit_date < cursor` means re-edit doesn't re-deliver. v7 documents in known limitations.
- **LOW — `view_media` voice/audio redundant branch** — transcript is already in inbound meta. v7 keeps the branch but documents it as "historical-recovery only; first-turn voice is already inline via `<m><media transcript=...>`".
- **LOW — SDK version reference "2.x" wrong** — installed is 0.2.76. v7 drops the version-flexible footnote (recipe now scoped to container-side test where the SDK actually runs).
- **LOW — Migration site notation `761-771` ambiguous** — v7 changes to `src/index.ts:769 (inside the lambda body 761-771)`.
