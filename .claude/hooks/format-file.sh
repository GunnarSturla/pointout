#!/bin/sh
# PostToolUse: format the file an agent just wrote (ticket 24).
#
# The extension filter lives here rather than in `.oxfmtrc.json` because oxfmt
# handles more than code — markdown especially — and this repository's prose is
# a record it does not reformat.
set -eu

file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[ -n "$file" ] || exit 0

case "$file" in
  *.ts | *.tsx | *.cts | *.mts | *.js | *.jsx | *.cjs | *.mjs | *.css | *.html) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -x node_modules/.bin/oxfmt ] || exit 0

node_modules/.bin/oxfmt "$file" >/dev/null 2>&1 || true
