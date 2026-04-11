# TimeTrack — Design Spec

**Date:** 2026-04-11  
**Status:** Approved

## Overview

Standalone Python tool that syncs ActivityWatch activity data into a Notion Time Log database and delegates AI classification of entries to a daily Claude Code scheduled task.

Two components:
1. **`timetrack sync`** — dumb data pipeline, ActivityWatch → Notion, runs every 15 min via launchd
2. **Claude Code scheduled task** — daily, reads unclassified Time Log entries, matches to Notion Tasks, writes relation back

No connection to NanoClaw. Claude subscription (Max) is used for classification via Claude Code scheduled task.

---

## Notion Databases

### Time Log (`collection://d87bd65e-7295-4a4c-b1bf-ccb715a0af86`)

| Field | Type | Notes |
|-------|------|-------|
| Entry | title | Window title of the focus block |
| Start | date (datetime) | Start timestamp of focus block |
| End | date (datetime) | End timestamp of focus block |
| Часы | formula | Converts `Время` to numeric minutes: `23м` → 23, `2ч` → 120. Read-only, not written by sync script. |
| Время | text | Active duration from AW, written by sync script as `{N}м` (e.g. `23м`). `Часы` formula reads this field. |
| Note | text | Context for AI classifier: window titles, URLs |
| Task | relation → Tasks | Set by classification task |
| Classified | checkbox | **New field.** True = processed by classifier |

The `Classified` field acts as the processing cursor: classifier queries `Classified = false`, processes, then sets `Classified = true` regardless of whether a Task was found.

### Tasks (`collection://eebbf999-d9f3-461d-99a0-f6916ad6e495`)

Key fields used for matching:
- `Name` (title)
- `done` (status): Not started / In progress / Done / Abandoned
- `Tags` (multi-select)
- `Project` (relation)
- `Time Logs` (back-relation, maintained by Notion automatically)

Classifier only considers Tasks where `done` is "Not started" or "In progress".

---

## Component 1: `timetrack sync`

### What it does

Reads ActivityWatch REST API, extracts continuous focus blocks, pushes new blocks to Notion Time Log.

### ActivityWatch API

Base URL: `http://localhost:5600/api/0`

Relevant buckets (discovered dynamically via `/buckets`):
- `aw-watcher-window_*` — active window: `app`, `title`
- `aw-watcher-afk_*` — AFK status: `status` = `"afk"` | `"not-afk"`
- `aw-watcher-web-*` — browser URLs (optional, if extension installed): `url`, `title`

Bucket names contain hostname — must be discovered at runtime, not hardcoded.

### Focus Block Algorithm

1. Fetch AFK events for the time range → build AFK timeline
2. Fetch window events for the same range
3. For each window event:
   - If overlapping AFK event has `status = "afk"` → discard
   - Else → active event
4. Group consecutive window events with the same `(app, title)`:
   - "Gap" = time between the END of one AW event and the START of the next event with the same (app, title)
   - Gap ≤ 3 min → merge into same block
   - Gap > 3 min or different (app, title) → new block
5. Discard blocks with total active duration < 2 minutes
6. AFK gap > **10 minutes** between any two events → hard session boundary (blocks from different sides are never merged)

Note: ActivityWatch stores timestamps in UTC. Sync script converts to local timezone (from system TZ) before writing to Notion.

### What goes into each Notion entry

| Field | Value |
|-------|-------|
| Entry | Window title (truncated to 100 chars) |
| Start | Start timestamp of block (ISO-8601, local TZ) |
| End | End timestamp of block (ISO-8601, local TZ) |
| Время | `{N}м` — active minutes rounded from AW event durations (e.g. `23м`) |
| Note | App name, URL (if browser), any context useful for task identification |

If `aw-watcher-web` is available, the URL for browser windows is appended to Note. This significantly improves AI classification.

### Deduplication

State stored in `~/.config/timetrack/state.json`:
```json
{
  "last_sync": "2026-04-11T22:00:00+03:00",
  "notion_entries": {
    "{aw_event_signature}": "{notion_page_id}"
  }
}
```

`aw_event_signature` = `sha256(app + title + start_iso)` — stable identifier for a block.

On each sync run:
1. Fetch events from `last_sync - 30min` (overlap to catch late-arriving AW events)
2. For each computed block: check signature against `notion_entries`
3. Only create Notion pages for new signatures
4. Update `last_sync` and `notion_entries` after successful push

### Initial sync

Config key `initial_sync_days` (default: 7). On first run (no `state.json`), syncs the last N days. After that, cursor-based incremental sync.

### Config

File: `~/.config/timetrack/config.toml`

```toml
[notion]
token = "..."          # Notion integration token
timelog_db = "35b4cfe8-1f3a-457a-80a8-fe61aa465a18"

[activitywatch]
base_url = "http://localhost:5600"
afk_threshold_min = 10
min_block_duration_sec = 120
merge_gap_sec = 180

[sync]
initial_sync_days = 7
```

### Error handling

- ActivityWatch not running → log warning, exit 0 (launchd won't restart)
- Notion API rate limit (3 req/s) → exponential backoff, retry up to 3x
- Notion API error → log error, preserve state (don't advance cursor)
- Unknown bucket types → skip silently

### Launchd plist

Runs every 15 minutes. Label: `com.timetrack.sync`.  
`StandardOutPath` / `StandardErrorPath` → `~/Library/Logs/timetrack/sync.log`

---

## Component 2: Claude Code Scheduled Task

### Purpose

Daily AI classification: read all `Classified = false` Time Log entries, match each to the best-fit Task, write Task relation, set `Classified = true`.

### Schedule

Daily at 23:00 local time (configurable). Set up via Claude Code `/schedule`.

### Prompt (given to the agent)

```
You have access to Notion via MCP.

1. Query Time Log database (35b4cfe8-...) for all entries where Classified = false.
2. Query Tasks database (283efefe-...) for all tasks where done = "Not started" or "In progress".
3. For each Time Log entry, examine Entry + Note fields (app name, window title, URL if present).
   Match it to the most relevant Task based on semantic similarity.
   If no reasonable match exists, leave Task empty.
4. For each entry:
   - Set Task relation (if matched)
   - Set Classified = true
5. Do this for ALL unclassified entries before finishing.
```

### Idempotency

Only processes `Classified = false` entries. Re-running is safe — already classified entries are skipped. Manual corrections to Task relation are preserved (they were already `Classified = true`).

### Scale

With Claude Max subscription (200k context), a full day of entries (50-100) + full task list (100-200 tasks) fits comfortably in one pass.

---

## Project Structure

```
timetrack/
├── timetrack/
│   ├── __init__.py
│   ├── cli.py          # Entry point: `timetrack sync`
│   ├── activitywatch.py # AW REST client + focus block algorithm
│   ├── notion.py        # Notion API client (create pages, query)
│   ├── state.py         # state.json read/write
│   └── config.py        # config.toml loading
├── com.timetrack.sync.plist  # launchd plist template
├── pyproject.toml
└── README.md
```

Dependencies: `requests`, `tomli` (Python < 3.11) or stdlib `tomllib`, `notion-client`.

---

## Notion Schema Change Required

Before first sync, add `Classified` checkbox property to Time Log database. Can be done manually in Notion or via API at setup time.

---

## Data Flow Summary

```
ActivityWatch (localhost:5600)
        │
        │ REST API, every 15 min
        ▼
  timetrack sync
  (focus block algorithm + dedup)
        │
        │ Notion API
        ▼
  Time Log (Classified = false)
        │
        │ Claude Code scheduled task, 23:00 daily
        ▼
  Time Log (Task relation set, Classified = true)
        │
        │ Notion back-relation (automatic)
        ▼
  Tasks ← Time Logs (rollup / linked)
```

---

## Open Questions (non-blocking)

- Should the classifier also handle merging multiple Time Log entries into one Task per day (aggregation), or just link individually? Recommendation: link individually, use Notion rollup/timeline view for aggregation.
- Should `timetrack sync` also run once on install (initial historical import) or only go forward? Handled by `initial_sync_days`.
