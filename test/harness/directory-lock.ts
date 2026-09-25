// A lock across Playwright's worker processes, for the seam-2 journeys that
// must not overlap one another (hot-update-lock.ts, drain-lock.ts).
//
// It is a directory, because making one is atomic across processes. Only one
// seam 2 runs on the machine at a time (seam2-lock.ts), so one path serves
// every checkout, and seam 2's `globalSetup` clears whatever a killed run left
// behind before any worker can take it.
import { mkdirSync, rmSync } from 'node:fs'

/** Run `work` while holding `lock`, waiting up to `waitMs` for it. */
export async function holding<T>(
  lock: string,
  waitMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const until = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() > until) {
        throw new Error(`${lock} was held for ${waitMs / 1000} s`, { cause: error })
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await work()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** For `globalSetup` only, holding the machine's seam-2 lock: a killed run's leftover. */
export function clearLock(lock: string): void {
  rmSync(lock, { recursive: true, force: true })
}
