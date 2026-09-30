// A drain takes every `queued-unaddressed` Pick the seam-2 dev server holds,
// whichever worker and engine made it. So a journey that drains, and any
// journey that holds a Pick in that queue while it reads what became of it,
// take this lock and never overlap (test/seam2/withdraw.spec.ts,
// test/seam2/report-back.spec.ts).
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearLock, holding } from './directory-lock.js'

const DRAIN_LOCK = join(tmpdir(), 'pointout-seam2-drain.lock')

/** Longer than any holder keeps it: a Pick offered back, requeued and read. */
const WAIT_MS = 90_000

/** Run `work` while no other journey drains, or holds a Pick in the queue. */
export function apartFromDrains<T>(work: () => Promise<T>): Promise<T> {
  return holding(DRAIN_LOCK, WAIT_MS, work)
}

/** For `globalSetup` only, holding the machine's seam-2 lock: a killed run's leftover. */
export function clearDrainLock(): void {
  clearLock(DRAIN_LOCK)
}
