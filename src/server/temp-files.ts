import { randomBytes } from 'node:crypto'
import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Two of this server's directories live under the OS temp root and are named by
// the dev server's pid: the Screen Captures, and the hook discovery entries.
// Both have the same problem — a dev server that was killed leaves its files
// behind, and nothing else will ever come for them — and the same answer: at
// startup, sweep everything in the shared root that no live dev server owns.
// The liveness test is what keeps that sweep from reaching a second dev server
// running beside this one, on this machine, right now.

/**
 * Signal 0 asks the kernel about a pid without sending anything. A pid we are
 * not allowed to signal is somebody else's live process, which is exactly the
 * case a sweep must leave alone; a pid below 1 is not a process at all, and is
 * never asked about, because 0 would name this process's whole group.
 */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove every entry of `directory` that `owned` does not claim for a live pid.
 * `owned` matches an entry's name and captures the owner's pid as its first
 * group. Returns how many were removed, for the posture line to state.
 */
export function sweepDead(directory: string, owned: RegExp): number {
  let removed = 0
  for (const name of readdirSync(directory)) {
    const owner = owned.exec(name)
    if (owner && alive(Number(owner[1]))) continue
    try {
      rmSync(join(directory, name), { recursive: true, force: true })
      removed++
    } catch {
      // Another user's leftovers under a shared temp root. Not ours to remove,
      // and not ours to read either.
    }
  }
  return removed
}

/** Six hex characters. Not a secret — but a temp path a stranger can predict is one they can own. */
export function randomSuffix(): string {
  return randomBytes(3).toString('hex')
}
