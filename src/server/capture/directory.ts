import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Where an image of the physical display lives, and how little time it lives for
// (spec §10). Two rules, and the second is why this module exists at all:
//
//   1. one directory per dev server, named `<pid>-<6 hex>` under a shared root
//      in the OS temp directory, mode 0700, removed whole at shutdown;
//   2. at startup the root is swept of everything that is not a live dev
//      server's directory — a dev server that was killed leaves images of
//      somebody's screen behind, and nothing else will ever come for them.
//
// The liveness test is what keeps rule 2 from reaching into a second dev server
// running beside this one, on this machine, right now.

/** Named in full, in the posture block, on purpose: see `docs/screen-capture.md`. */
const ROOT_NAME = 'vite-agent-inspect-captures'

/** `<pid>-<6 hex>`: the only shape the startup sweep spares. */
const OWNED = /^(\d+)-[0-9a-f]{6}$/

export interface CaptureDirectory {
  path: string
  /** What the startup sweep removed, for the posture line to state. */
  swept: number
  /** The shutdown sweep. Idempotent: a dev server may be closed twice. */
  close(): void
}

/**
 * Sweep the root, then take a directory in it. Throws only if the temp root
 * itself cannot be written, which the caller turns into a disabled reason.
 */
export function openCaptureDirectory(): CaptureDirectory {
  const root = join(tmpdir(), ROOT_NAME)
  mkdirSync(root, { recursive: true, mode: 0o700 })

  const swept = sweep(root)
  const path = join(root, `${process.pid}-${randomSuffix()}`)
  mkdirSync(path, { mode: 0o700 })

  return {
    path,
    swept,
    close() {
      rmSync(path, { recursive: true, force: true })
    },
  }
}

/** Everything in the root that no live dev server owns. Returns how many. */
function sweep(root: string): number {
  let removed = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const owner = entry.isDirectory() ? OWNED.exec(entry.name) : null
    if (owner && alive(Number(owner[1]))) continue
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true })
      removed++
    } catch {
      // Another user's leftovers under a shared temp root. Not ours to remove,
      // and not ours to read either.
    }
  }
  return removed
}

/**
 * Signal 0 asks the kernel about a pid without sending anything. A pid we are
 * not allowed to signal is somebody else's live process, which is exactly the
 * case the sweep must leave alone; a pid below 1 is not a process at all, and
 * is never asked about, because 0 would name this process's whole group.
 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Not a secret — but a temp path a stranger can predict is one they can own. */
function randomSuffix(): string {
  return randomBytes(3).toString('hex')
}
