import type { Pick } from './pick.js'

// One claim-once queue per dev server (spec §15). Ticket 11 owns the removal
// transitions — ack, TTL expiry, failure — and the ledger that outlives them;
// every field they need is stored here now so nothing is reshaped later.

/** Spec §15. Read here so the entry carries it from the moment it is created. */
export const TTL_MS = 30 * 60 * 1000

/**
 * The two states an entry can be in while it is still in the queue. Removal is
 * ticket 11's; an entry that has left the queue is not in either state.
 */
export const QUEUED_UNADDRESSED = 'queued-unaddressed'
export const SENT_AWAITING_ACK = 'sent-awaiting-ack'

export type QueueState = typeof QUEUED_UNADDRESSED | typeof SENT_AWAITING_ACK

export interface QueueEntry {
  pick: Pick
  state: QueueState
  createdAt: number
  expiresAt: number
}

export interface PickQueue {
  /** Enter an accepted Pick, `queued-unaddressed` until something writes it. */
  add(pick: Pick): QueueEntry
  /**
   * A socket write succeeded. Returns false when the entry was already sent,
   * which is how v0 keeps from writing one delivery twice.
   */
  markSent(pickId: string): boolean
}

export function createPickQueue(): PickQueue {
  // Insertion-ordered, which is the order the floor drains in.
  const entries = new Map<string, QueueEntry>()

  return {
    add(pick) {
      const entry: QueueEntry = {
        pick,
        state: QUEUED_UNADDRESSED,
        createdAt: pick.createdAt,
        expiresAt: pick.createdAt + TTL_MS,
      }
      entries.set(pick.id, entry)
      return entry
    },

    markSent(pickId) {
      const entry = entries.get(pickId)
      if (!entry || entry.state === SENT_AWAITING_ACK) return false
      entry.state = SENT_AWAITING_ACK
      return true
    },
  }
}
