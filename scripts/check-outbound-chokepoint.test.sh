#!/usr/bin/env bash
set -euo pipefail
echo 'channel.sendMessage(jid, text)' > src/__lint_fixture.ts
if bash scripts/check-outbound-chokepoint.sh; then
  echo "FAIL: script should have detected fixture violation"; rm src/__lint_fixture.ts; exit 1
fi
rm src/__lint_fixture.ts
if ! bash scripts/check-outbound-chokepoint.sh; then
  echo "FAIL: script should pass on clean tree"; exit 1
fi
echo "OK"
