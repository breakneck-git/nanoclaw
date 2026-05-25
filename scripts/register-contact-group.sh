#!/usr/bin/env bash
# Register the Dana DM as a restricted (MCP-locked-down) group.
#
# Idempotent: INSERT OR IGNORE — re-running this script after the row exists
# is a no-op (no errors, no clobbered config). To CHANGE her config after
# initial registration, run the explicit UPDATE statement at the bottom or
# delete the row first.
#
# Schema dependency: requires the `enabled_mcp TEXT` column added in
# src/db.ts (migration around line 175). If that column is missing, this
# script aborts before mutating the DB.
#
# Run from anywhere; the DB path is absolute.
set -euo pipefail

DB="${NANOCLAW_DB:-/Users/breakneck/nanoclaw/store/messages.db}"

if [[ ! -f "$DB" ]]; then
  echo "ERROR: SQLite DB not found at $DB" >&2
  echo "Run NanoClaw at least once to create it, or set NANOCLAW_DB." >&2
  exit 1
fi

# Sanity-check the migration is in place before mutating anything.
if ! sqlite3 "$DB" "PRAGMA table_info(registered_groups);" | grep -q "enabled_mcp"; then
  echo "ERROR: registered_groups.enabled_mcp column is missing." >&2
  echo "Rebuild and restart NanoClaw to apply the migration:" >&2
  echo "  npm run build && launchctl kickstart -k gui/\$(id -u)/com.nanoclaw" >&2
  exit 1
fi

# enabled_mcp='nanoclaw' restricts Dana to ONLY the in-container nanoclaw MCP
# server — no gmail, notion, calendar, maps, drive. The host-side
# filterMcpServers filter drops everything else; the allowedTools filter
# drops the matching mcp__*__* patterns. See container/agent-runner/src/
# mcp-whitelist.ts and src/container-runner.ts buildContainerArgs.
sqlite3 "$DB" <<SQL
INSERT OR IGNORE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at,
   container_config, requires_trigger, is_main, enabled_mcp)
VALUES
  ('tg:111111111',
   'Contact (DM)',
   'telegram_dana',
   '@Andy',
   datetime('now'),
   NULL,
   1,
   0,
   'nanoclaw');
SQL

# Echo the resulting row for verification — no secrets, just the
# registration metadata.
sqlite3 -header -column "$DB" \
  "SELECT jid, folder, name, requires_trigger, is_main, enabled_mcp
   FROM registered_groups
   WHERE jid = 'tg:111111111';"
