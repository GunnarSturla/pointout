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

# Tracked files only. The gate is repository-wide on purpose, but with several
# agents sharing one working tree it kept firing at this session for another
# agent's brand-new, untracked files — three times, every one of them somebody
# else's in-flight work. Restricting it to what git already tracks keeps it
# honest about finished work without making it a bulletin board for whatever is
# half-written next door. ADR-0002 records the reasoning.
# Quoted literally, never through a variable: an unquoted pattern is expanded by
# the shell against the working directory before git ever sees it.
lintable() {
  git ls-files "$1" -- '*.ts' '*.tsx' '*.cts' '*.mts' '*.js' '*.jsx' '*.cjs' '*.mjs'
}

# Nothing tracked to lint: not this hook's problem.
if [ "$(lintable --cached | wc -l)" -eq 0 ]; then
  exit 0
fi

# Piped, never stored in a variable: command substitution strips the NUL
# separators that `-z` exists for, and xargs then sees one enormous filename.
if output=$(lintable -z | xargs -0 node_modules/.bin/oxlint --deny-warnings 2>&1); then
  exit 0
fi

printf '%s' "$output" | jq -Rs '{
  decision: "block",
  reason: ("The lint gate is red, so this task is not finished. Fix these, or say why each one should be configured in .oxlintrc.json with a comment — nothing is silenced merely because it was noisy (see docs/agents/packaging.md).\n\n" + .)
}'
