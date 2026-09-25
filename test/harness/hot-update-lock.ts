// A hot update reaches every page open on the seam-2 dev server, in every worker
// and engine, and relays each of them out — which re-measures any Highlight on
// it. A journey that watches a morph frame by frame reads that as a morph cut
// short. So the hot update and any such journey take this lock, and never
// overlap (test/seam2/highlight.spec.ts).
//
// It is a directory, because making one is atomic across Playwright's worker
// processes. Only one seam 2 runs on the machine at a time (seam2-lock.ts), so
// one path serves every checkout, and seam 2's `globalSetup` clears whatever a
// killed run left behind before any worker can take it.
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOT_UPDATE_LOCK = join(tmpdir(), 'vite-agent-inspect-seam2-hot-update.lock')

/** Longer than any holder keeps it: a hot update and its revert, under load. */
const WAIT_MS = 60_000

/** Run `work` while no hot update, or other frame-watching journey, is. */
export async function apartFromHotUpdates<T>(work: () => Promise<T>): Promise<T> {
  const until = Date.now() + WAIT_MS
  for (;;) {
    try {
      mkdirSync(HOT_UPDATE_LOCK)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() > until) {
        throw new Error(`${HOT_UPDATE_LOCK} was held for ${WAIT_MS / 1000} s`, {
          cause: error,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await work()
  } finally {
    rmSync(HOT_UPDATE_LOCK, { recursive: true, force: true })
  }
}

/** For `globalSetup` only, holding the machine's seam-2 lock: a killed run's leftover. */
export function clearHotUpdateLock(): void {
  rmSync(HOT_UPDATE_LOCK, { recursive: true, force: true })
}
