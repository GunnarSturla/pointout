import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// The four test-only overrides seam 1 fakes the harness through. The names are
// normative and documented in docs/agents/testing.md; the plugin reads them
// from `process.env` by the same strings (ticket 02 onward).
export const ENV_REGISTRY_DIR = 'VITE_AGENT_INSPECT_REGISTRY_DIR'
export const ENV_SOCKET_DIR = 'VITE_AGENT_INSPECT_SOCKET_DIR'
export const ENV_CLAUDE_PID = 'CLAUDE_PID'
export const ENV_PATH = 'PATH'

/** A 1×1 PNG. What the fake `screencapture` writes when it is asked to succeed. */
const KNOWN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// The fake reads its behaviour at call time, so a test can change its mind
// between picks: `png` (default) writes the known file, `empty` writes a
// zero-byte one, `sleep` hangs. The real CLI takes the output path last.
const FAKE_SCREENCAPTURE = `#!/bin/sh
# Test double for macOS screencapture. Written by test/harness/fixture-env.mjs.
out=""
for arg in "$@"; do out="$arg"; done
case "\${FAKE_SCREENCAPTURE_MODE:-png}" in
  empty) : > "$out" ;;
  sleep) sleep "\${FAKE_SCREENCAPTURE_SLEEP:-30}" ;;
  fail)  echo "fake screencapture: refused" >&2; exit 1 ;;
  *)     cp "$KNOWN_PNG" "$out" ;;
esac
`

/**
 * Build one throwaway harness environment: a registry directory to write fake
 * session files into, a socket directory to bind fake session sockets in, a
 * `PATH` with a fake `screencapture` first, and a `CLAUDE_PID` for the
 * preselect. Returns the patch; it is applied by the caller.
 */
export function createFixtureEnv({ claudePid = process.pid } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vite-agent-inspect-'))
  const registryDir = join(dir, 'registry')
  const socketDir = join(dir, 'sockets')
  const binDir = join(dir, 'bin')
  for (const d of [registryDir, socketDir, binDir]) mkdirSync(d)

  const knownPng = join(dir, 'known.png')
  writeFileSync(knownPng, Buffer.from(KNOWN_PNG_BASE64, 'base64'))

  const screencapture = join(binDir, 'screencapture')
  writeFileSync(screencapture, FAKE_SCREENCAPTURE)
  chmodSync(screencapture, 0o755)

  return {
    dir,
    registryDir,
    socketDir,
    binDir,
    knownPng,
    env: {
      [ENV_REGISTRY_DIR]: registryDir,
      [ENV_SOCKET_DIR]: socketDir,
      [ENV_CLAUDE_PID]: String(claudePid),
      [ENV_PATH]: binDir + delimiter + process.env.PATH,
      KNOWN_PNG: knownPng,
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Apply an env patch to this process and hand back the undo. */
export function applyEnv(patch) {
  const previous = new Map()
  for (const [key, value] of Object.entries(patch)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return function restoreEnv() {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
