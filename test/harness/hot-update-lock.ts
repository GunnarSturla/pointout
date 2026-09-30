// A hot update reaches every page open on the seam-2 dev server, in every worker
// and engine, and relays each of them out — which re-measures any Highlight on
// it. A journey that watches a morph frame by frame reads that as a morph cut
// short. So the hot update and any such journey take this lock, and never
// overlap (test/seam2/highlight.spec.ts).
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearLock, holding } from './directory-lock.js'

const HOT_UPDATE_LOCK = join(tmpdir(), 'pointout-seam2-hot-update.lock')

/** Longer than any holder keeps it: a hot update and its revert, under load. */
const WAIT_MS = 60_000

/** Run `work` while no hot update, or other frame-watching journey, is. */
export function apartFromHotUpdates<T>(work: () => Promise<T>): Promise<T> {
  return holding(HOT_UPDATE_LOCK, WAIT_MS, work)
}

/** For `globalSetup` only, holding the machine's seam-2 lock: a killed run's leftover. */
export function clearHotUpdateLock(): void {
  clearLock(HOT_UPDATE_LOCK)
}
