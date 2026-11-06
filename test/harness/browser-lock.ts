// One full browser suite at a time on this machine. Two browser suites side by side,
// from two worktrees, roughly double every test's time, and a test that was
// written against one suite's timing then fails against the other's. So the
// suite's `globalSetup` takes this lock before it boots anything, and a second run
// waits for the first rather than racing it.
//
// The lock is a directory under the OS temp dir holding the owner's pid. It is
// made whole — pid and all — beside the lock and renamed into place, because a
// rename onto a directory that already exists fails, which is what makes taking
// it atomic. A lock whose pid is no longer alive (a run killed outright) is
// taken over. It is released on teardown, and on exit if teardown never ran.
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The one lock every checkout on this machine shares. */
export const BROWSER_LOCK_DIR = join(tmpdir(), 'pointout-browser.lock')

/** How long a run waits for another to finish before it gives up. */
export const BROWSER_LOCK_WAIT_MS = 10 * 60 * 1000

const POLL_MS = 1000

/**
 * Take the lock, waiting for a live owner to let it go. Answers the function
 * that releases it.
 */
export async function takeBrowserLock(
  say: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<() => void> {
  const started = Date.now()
  let announced: number | undefined

  for (;;) {
    if (tryTake()) break

    const owner = ownerOf()
    if (owner === process.pid) break
    if (owner !== undefined && !alive(owner)) {
      takeOver(owner)
      continue
    }

    if (owner !== undefined && owner !== announced) {
      say(`waiting for another browser-suite run, pid ${owner}`)
      announced = owner
    }
    if (Date.now() - started >= BROWSER_LOCK_WAIT_MS) {
      throw new Error(
        `the browser suite waited ${BROWSER_LOCK_WAIT_MS / 60_000} min for another browser-suite run, ` +
          `pid ${owner ?? 'unknown'}, which still holds ${BROWSER_LOCK_DIR}. Let it ` +
          'finish, or, if that pid is not a browser-suite run, remove the directory.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }

  let released = false
  const release = () => {
    if (released) return
    released = true
    process.off('exit', release)
    // Only ever our own: a lock that was taken over after this process was
    // thought dead belongs to whoever took it.
    if (ownerOf() !== process.pid) return
    const aside = moveAside()
    if (aside !== undefined) rmSync(aside, { recursive: true, force: true })
  }
  process.on('exit', release)
  return release
}

/** Make the lock whole beside it, then rename it into place; false if it exists. */
function tryTake(): boolean {
  const staging = mkdtempSync(`${BROWSER_LOCK_DIR}.staging-`)
  writeFileSync(join(staging, 'pid'), String(process.pid))
  try {
    renameSync(staging, BROWSER_LOCK_DIR)
    return true
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'ENOTEMPTY') return false
    throw error
  }
}

/**
 * Clear a lock whose owner is gone, and nothing will ever release it. It is
 * renamed aside first, which only one waiter can do, and removed only if what
 * was renamed is still the dead owner's: two waiters that both saw it dead can
 * never remove the lock the faster one has just taken. If the rename caught a
 * live lock instead, it is put back; if even that loses a race, it is left
 * aside, never removed.
 */
function takeOver(dead: number): void {
  const aside = moveAside()
  if (aside === undefined) return // Someone else moved it first.
  if (ownerOf(aside) === dead) {
    rmSync(aside, { recursive: true, force: true })
    return
  }
  try {
    renameSync(aside, BROWSER_LOCK_DIR)
  } catch {
    // Taken again in between; the aside copy is inert.
  }
}

/**
 * Rename the lock out of its place and answer where it went. Removing it in
 * place would empty the directory before removing it, and a rename onto an
 * empty directory succeeds, so a lock taken in that moment would be removed
 * with it.
 */
function moveAside(): string | undefined {
  const aside = `${BROWSER_LOCK_DIR}.aside-${process.pid}-${Date.now()}`
  try {
    renameSync(BROWSER_LOCK_DIR, aside)
    return aside
  } catch {
    return undefined
  }
}

function ownerOf(lock: string = BROWSER_LOCK_DIR): number | undefined {
  try {
    const pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, and someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
