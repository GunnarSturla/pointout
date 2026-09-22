import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

// The four test-only overrides seam 1 fakes the harness through. The names are
// normative and documented in docs/agents/testing.md; the plugin reads them
// from `process.env` by the same strings (ticket 02 onward).
export const ENV_REGISTRY_DIR = 'VITE_AGENT_INSPECT_REGISTRY_DIR'
export const ENV_SOCKET_DIR = 'VITE_AGENT_INSPECT_SOCKET_DIR'
export const ENV_CLAUDE_PID = 'CLAUDE_PID'
export const ENV_PATH = 'PATH'

/**
 * Not a harness boundary — the server's own clock. Thirty minutes is longer
 * than any test is allowed to take, so seam 1 moves the clock instead of
 * waiting for it. Test-only, like the four above; a consumer never sets it.
 */
export const ENV_CLOCK_SKEW = 'VITE_AGENT_INSPECT_CLOCK_SKEW_MS'

/**
 * Make time pass for every dev server in this process. `0` puts the clock back,
 * which is what a test does in `afterEach`.
 */
export function advanceClock(milliseconds: number): void {
  if (milliseconds === 0) delete process.env[ENV_CLOCK_SKEW]
  else process.env[ENV_CLOCK_SKEW] = String(milliseconds)
}

/** A 1×1 PNG. What the fake `screencapture` writes when it is asked to succeed. */
const KNOWN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// Resolved before any fixture patches `PATH`, so the `git` shim below can hand
// the call on to the real thing rather than to itself.
const REAL_GIT = resolveRealGit()

// The fake reads its behaviour at call time, so a test can change its mind
// between picks: `png` (default) writes the known file, `empty` writes a
// zero-byte one, `sleep` hangs. The real CLI takes the output path last.
const FAKE_SCREENCAPTURE = `#!/bin/sh
# Test double for macOS screencapture. Written by test/harness/fixture-env.ts.
out=""
for arg in "$@"; do out="$arg"; done
case "\${FAKE_SCREENCAPTURE_MODE:-png}" in
  empty) : > "$out" ;;
  sleep) sleep "\${FAKE_SCREENCAPTURE_SLEEP:-30}" ;;
  fail)  echo "fake screencapture: refused" >&2; exit 1 ;;
  *)     cp "$KNOWN_PNG" "$out" ;;
esac
`

export interface FixtureEnvOptions {
  /** The pid the started-this-server preselect should match. */
  claudePid?: number
  /** Put a recording `git` in front of the real one on `PATH`. */
  gitShim?: boolean
}

/** One throwaway harness environment, and the handles a test reads it through. */
export interface FixtureEnv {
  dir: string
  registryDir: string
  socketDir: string
  binDir: string
  knownPng: string
  /** Every argument line the `git` shim recorded, oldest first. */
  gitCalls(): string[]
  env: Record<string, string>
  cleanup(): void
}

/**
 * Build one throwaway harness environment: a registry directory to write fake
 * session files into, a socket directory to bind fake session sockets in, a
 * `PATH` with a fake `screencapture` first, and a `CLAUDE_PID` for the
 * preselect. Returns the patch; it is applied by the caller.
 *
 * `gitShim` rides on the same `PATH` override: it puts a `git` in front that
 * records its arguments and then execs the real one, so a test can count the
 * subprocesses the server spawns without knowing anything about its internals.
 */
export function createFixtureEnv({
  claudePid = process.pid,
  gitShim = false,
}: FixtureEnvOptions = {}): FixtureEnv {
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

  const gitLog = join(dir, 'git-calls.log')
  if (gitShim) {
    writeFileSync(gitLog, '')
    const git = join(binDir, 'git')
    writeFileSync(
      git,
      [
        '#!/bin/sh',
        '# Test double for git. Written by test/harness/fixture-env.ts.',
        `printf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}`,
        `exec ${JSON.stringify(REAL_GIT)} "$@"`,
        '',
      ].join('\n'),
    )
    chmodSync(git, 0o755)
  }

  return {
    dir,
    registryDir,
    socketDir,
    binDir,
    knownPng,
    gitCalls() {
      try {
        return readFileSync(gitLog, 'utf8').split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
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
export function applyEnv(patch: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>()
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

function resolveRealGit(): string {
  try {
    return execFileSync('which', ['git'], { encoding: 'utf8' }).trim() || '/usr/bin/git'
  } catch {
    return '/usr/bin/git'
  }
}
