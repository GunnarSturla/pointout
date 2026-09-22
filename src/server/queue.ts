import type { Pick } from './pick.js'

// One claim-once queue per dev server (spec §15). Membership is the whole of
// what it says: an entry in here may still be delivered, and an entry that has
// left may not, whatever became of it. What became of it is `ledger.ts`.

/** Spec §15. Read here so the entry carries it from the moment it is created. */
export const TTL_MS = 30 * 60 * 1000

/**
 * The two states an entry can be in while it is still in the queue. An entry
 * that has left it — acked, expired — is in neither, and only the ledger has
 * anything left to say about it.
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
  /** The entry, while it is still here. Undefined once it has left. */
  get(pickId: string): QueueEntry | undefined
  /**
   * Take an entry out: an ack or a done, and nothing else in v0. Returns what
   * was there, and undefined when it had already left — both of which the ack
   * survives, because an ack is evidence about the Pick, not about the queue.
   */
  remove(pickId: string): QueueEntry | undefined
  /**
   * Every entry past its TTL at `at`, removed. Called before any route reads
   * the queue, so an expired entry is never delivered by any of them (spec
   * §15); the caller states the expiry out loud and ledgers it (spec §21).
   */
  sweep(at: number): QueueEntry[]
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

    get: (pickId) => entries.get(pickId),

    remove(pickId) {
      const entry = entries.get(pickId)
      entries.delete(pickId)
      return entry
    },

    sweep(at) {
      const expired: QueueEntry[] = []
      for (const [pickId, entry] of entries) {
        if (entry.expiresAt <= at) {
          expired.push(entry)
          entries.delete(pickId)
        }
      }
      return expired
    },
  }
}
