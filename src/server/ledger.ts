import type { Pick } from './pick.js'
import { QUEUED_UNADDRESSED } from './queue.js'
import type { QueueEntry } from './queue.js'

// The ledger (spec §17): what became of every Pick this dev server accepted,
// kept after the entry has left the claim-once queue. The two answer different
// questions — the queue answers "can this still be delivered", the ledger
// answers "what happened to it" — and the Overlay reads the second one.
//
// **The rule this module exists to enforce**: a Pick's state advances only on
// Pick-specific evidence — an ack, a done, a Receipt (ticket 13) or this
// server's own clock. Session-level evidence (registry status, an idle notice)
// colours the Target row and never moves a Pick. So nothing here takes a
// session as an argument, and nothing here can.

/** Spec §17. `held` and `unknown` arrive with tickets 13 and 14. */
export const SENT = 'sent'
export const WORKING = 'working'
export const DONE = 'done'
export const FAILED = 'failed'

/**
 * The states a Pick can be reported in today. `queued-unaddressed` is the
 * queue's own word, published unchanged: §17 gives that Pick the chip **Sent**
 * with a sub-line of its own — *arrives when you next prompt Claude in this
 * repo* — and the word is what ticket 12 tells the two apart by.
 */
export type PickState =
  | typeof QUEUED_UNADDRESSED
  | typeof SENT
  | typeof WORKING
  | typeof DONE
  | typeof FAILED

/**
 * Spec §17's sentence for the one failure this ticket can produce. Written by
 * v0 rather than taken from a harness, because no harness said anything: the
 * only evidence is that the clock ran out.
 */
export const TTL_FAILURE =
  'Not delivered — nobody prompted Claude in this repo within 30 minutes.'

/** One state change, with the moment it happened. */
export interface Transition {
  state: PickState
  at: number
  /** Why, when the state has a reason. Null rather than absent. */
  reason: string | null
}

/** Everything this server knows about one Pick after ingest. */
export interface LedgerRecord {
  pick: Pick
  state: PickState
  reason: string | null
  /** The moment past which no route may deliver it (spec §15). */
  expiresAt: number
  /** Oldest first. Ticket 14's report-back clock reads the send time off it. */
  history: Transition[]
}

export interface Ledger {
  /** Record an accepted Pick, in the state ingest left it in. */
  open(entry: QueueEntry, state: PickState, reason?: string): LedgerRecord
  /**
   * Pick-specific evidence arrived. Returns the record, or undefined for a Pick
   * this server never accepted — which the caller refuses rather than invents.
   */
  advance(pickId: string, state: PickState, reason?: string): LedgerRecord | undefined
  get(pickId: string): LedgerRecord | undefined
  /** Every Pick this server accepted, oldest first. */
  all(): LedgerRecord[]
}

export function createLedger(clock: () => number): Ledger {
  const records = new Map<string, LedgerRecord>()

  return {
    open(entry, state, reason) {
      const record: LedgerRecord = {
        pick: entry.pick,
        state,
        reason: reason ?? null,
        expiresAt: entry.expiresAt,
        history: [{ state, at: entry.createdAt, reason: reason ?? null }],
      }
      records.set(entry.pick.id, record)
      return record
    },

    advance(pickId, state, reason) {
      const record = records.get(pickId)
      if (!record) return undefined
      // Every transition is kept, including one that repeats the state: an
      // agent that acks twice said it twice, and dropping the second would be
      // this server editing the evidence.
      record.state = state
      record.reason = reason ?? null
      record.history.push({ state, at: clock(), reason: reason ?? null })
      return record
    },

    get: (pickId) => records.get(pickId),
    all: () => [...records.values()],
  }
}
