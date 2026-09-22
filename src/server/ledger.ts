import { FAILED, HELD, QUEUED_UNADDRESSED, SENT } from '../wire.js'
import type { PickState, Transition } from '../wire.js'
import type { Pick } from './pick.js'

// The ledger (spec §15, §17): every Pick this dev server accepted, in the state
// it is in now and with the history of how it got there. It answers both of the
// questions the server has about a Pick — *can this still be delivered*, which
// is spec §15's claim-once queue, and *what became of it*, which is what the
// Overlay reads — because the first is a function of the second: a Pick is in
// the queue exactly while its state says it is waiting.
//
// **The rule this module exists to enforce**: a Pick's state advances only on
// Pick-specific evidence — an ack, a done, a Receipt or this server's own
// clock. Session-level evidence (registry status, an idle notice) colours the
// Target row and never moves a Pick. So nothing here takes a session as an
// argument, and nothing here can.

/** Spec §15. Every entry gets it from the moment it is created. */
export const TTL_MS = 30 * 60 * 1000

/**
 * Spec §17's sentence for the one failure the clock alone can produce. Written
 * by v0 rather than taken from a harness, because no harness said anything: the
 * only evidence is that the time ran out.
 */
export const TTL_FAILURE =
  'Not delivered — nobody prompted Claude in this repo within 30 minutes.'

/**
 * The states in which a Pick is still in the claim-once queue: waiting for a
 * route to take it, or written and awaiting the agent's word. An entry in any
 * other state has left, whatever became of it.
 */
const QUEUED: readonly PickState[] = [QUEUED_UNADDRESSED, SENT, HELD]

export function isQueued(state: PickState): boolean {
  return QUEUED.includes(state)
}

/** Everything this server knows about one Pick after ingest. */
export interface LedgerRecord {
  pick: Pick
  state: PickState
  reason: string | null
  /** The moment past which no route may deliver it (spec §15). */
  expiresAt: number
  /** Oldest first. The report-back clock reads the send time off it. */
  history: Transition[]
}

export interface Ledger {
  /** Record an accepted Pick, in the state ingest left it in. */
  open(pick: Pick, state: PickState, reason?: string): LedgerRecord
  /**
   * Pick-specific evidence arrived. Returns the record, or undefined for a Pick
   * this server never accepted — which the caller refuses rather than invents.
   */
  advance(pickId: string, state: PickState, reason?: string): LedgerRecord | undefined
  get(pickId: string): LedgerRecord | undefined
  /** Every Pick this server accepted, oldest first. */
  all(): LedgerRecord[]
  /**
   * Every Pick still `queued-unaddressed`, oldest first: exactly what the hook
   * floor may take (spec §15). A Pick written to a socket is not among them,
   * which is what keeps a developer who types before the agent acks from
   * receiving the same Pick twice.
   */
  drainable(): LedgerRecord[]
  /**
   * Every queued Pick past its TTL at `at`, failed with the sentence above and
   * handed back so the caller can say so out loud (spec §15, §21). Called before
   * any route reads the ledger, so an expired Pick is never delivered by any of
   * them.
   */
  expire(at: number): LedgerRecord[]
}

export function createLedger(clock: () => number): Ledger {
  // Insertion-ordered, which is the order the floor drains in.
  const records = new Map<string, LedgerRecord>()

  // Every transition is kept, including one that repeats the state: an agent
  // that acks twice said it twice, and dropping the second would be this
  // server editing the evidence.
  const move = (record: LedgerRecord, state: PickState, reason: string | null) => {
    record.state = state
    record.reason = reason
    record.history.push({ state, at: clock(), reason })
  }

  return {
    open(pick, state, reason) {
      const record: LedgerRecord = {
        pick,
        state,
        reason: reason ?? null,
        expiresAt: pick.createdAt + TTL_MS,
        history: [{ state, at: pick.createdAt, reason: reason ?? null }],
      }
      records.set(pick.id, record)
      return record
    },

    advance(pickId, state, reason) {
      const record = records.get(pickId)
      if (!record) return undefined
      move(record, state, reason ?? null)
      return record
    },

    get: (pickId) => records.get(pickId),
    all: () => [...records.values()],

    drainable: () =>
      [...records.values()].filter((record) => record.state === QUEUED_UNADDRESSED),

    expire(at) {
      const expired: LedgerRecord[] = []
      for (const record of records.values()) {
        if (!isQueued(record.state) || record.expiresAt > at) continue
        move(record, FAILED, TTL_FAILURE)
        expired.push(record)
      }
      return expired
    },
  }
}
