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

# git grep pathspec note: directory pathspecs recurse by default; *.test.ts
# exclude works across all depths without **.
matches=$(git grep --untracked -nE "$PATTERN" \
  -- 'src/' 'container/agent-runner/src/' \
  ':!*.test.ts' ':!*.test.tsx' ':!*.d.ts' || true)

# Filter out allowlisted paths AND comment-only lines.
allow_csv=$(IFS=,; echo "${ALLOWLIST[*]}")
violations=$(echo "$matches" | awk -F: -v allow_csv="$allow_csv" '
  BEGIN {
    n = split(allow_csv, parts, ",");
    for (i = 1; i <= n; i++) allow[parts[i]] = 1;
  }
  {
    file=$1;
    line=$0;
    sub(/^[^:]+:[0-9]+:/, "", line);
    if (file in allow) next;
    if (line ~ /^[[:space:]]*(\/\/|\*|\/\*)/) next;
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
