import type { Ledger, PickState, Transition } from './ledger.js'
import type { PickQueue } from './queue.js'
import { readCandidates } from './registry.js'
import type { RegistryQuery } from './registry.js'
import { addresses } from './targeting.js'

// What `GET /__agent/status` answers (spec §20): every Pick this dev server
// accepted, in the state the ledger holds it, with the Target row beside it.
//
// The two halves come from different places on purpose (spec §17). The state is
// Pick-specific evidence and lives in the ledger; the Target row is
// session-level evidence, read live from the registry on every poll, and it
// colours the row without ever moving the Pick.

/** The Target row §17 draws under a Pick, as this server can answer it. */
export interface TargetRow {
  /** Who the Pick was addressed to, as the queue resolved it. */
  sessionId: string
  pid: number
  /**
   * The three live fields, or null when that session is no longer in the
   * registry. Null says the row cannot be drawn; it never stands in for a value.
   */
  name: string | null
  status: string | null
  waitingFor: string | null
}

/** One Pick, as the Overlay polls it. */
export interface PickStatus {
  pickId: string
  state: PickState
  /** Why, when the state has a reason. Null rather than absent. */
  reason: string | null
  /**
   * Still in the claim-once queue, and so still deliverable. False once an ack
   * or an expiry has taken it out — which is how the Overlay, and a test, can
   * see that a second delivery of the same Pick is no longer possible.
   */
  queued: boolean
  createdAt: number
  expiresAt: number
  history: Transition[]
  target: TargetRow | null
}

export function pickStatuses(
  facts: RegistryQuery,
  queue: PickQueue,
  ledger: Ledger,
): PickStatus[] {
  // One registry read for the whole poll: two reads could answer two Picks
  // addressed to the same session differently.
  const { candidates } = readCandidates(facts)

  return ledger.all().map((record) => {
    const target = record.pick.target
    const live = target
      ? candidates.find((candidate) => addresses(candidate, target))
      : undefined

    return {
      pickId: record.pick.id,
      state: record.state,
      reason: record.reason,
      queued: queue.get(record.pick.id) !== undefined,
      createdAt: record.pick.createdAt,
      expiresAt: record.expiresAt,
      history: record.history,
      target: target
        ? {
            sessionId: target.sessionId,
            pid: target.pid,
            name: live?.name ?? null,
            status: live?.status ?? null,
            waitingFor: live?.waitingFor ?? null,
          }
        : null,
    }
  })
}
