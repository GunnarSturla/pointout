#!/bin/sh
# Stop: refuse to end a task with the lint gate red (ticket 24).
set -u

payload=$(cat)

# A blocking Stop hook re-enters itself. The harness says so in the payload, and
# ignoring it is how a Stop hook becomes a loop.
if printf '%s' "$payload" | jq -e '.stop_hook_active == true' >/dev/null 2>&1; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -x node_modules/.bin/oxlint ] || exit 0

if output=$(node_modules/.bin/oxlint --deny-warnings 2>&1); then
  exit 0
fi

printf '%s' "$output" | jq -Rs '{
  decision: "block",
  reason: ("The lint gate is red, so this task is not finished. Fix these, or say why each one should be configured in .oxlintrc.json with a comment — nothing is silenced merely because it was noisy (see docs/agents/packaging.md).\n\n" + .)
}'
