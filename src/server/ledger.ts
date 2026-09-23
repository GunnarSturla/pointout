import { FAILED, HELD, QUEUED_UNADDRESSED, SENT, UNKNOWN } from '../wire.js'
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
 * Spec §17's queue-TTL sentence, for the one Pick it is true of: one nobody was
 * addressed to, waiting for a prompt that never came. Written by v0 rather than
 * taken from a harness, because no harness said anything: the only evidence is
 * that the time ran out.
 */
const TTL_FAILURE =
  'Not delivered — nobody prompted Claude in this repo within 30 minutes.'

/**
 * The TTL sentence for a Pick that is still queued when its time runs out,
 * chosen by how it got where it is. One sentence for all of them was false for
 * three: a Pick written to a socket may well have arrived, a drained one went
 * out with a prompt somebody did type, and a held one was asked about and is
 * waiting on an approval (tickets 11, 13, 15). Each says only what is known.
 */
function ttlSentence(record: LedgerRecord): string {
  const name = targetName(record.pick)
  if (record.state === HELD) {
    return `Not delivered — nobody approved it in ${name} within 30 minutes.`
  }
  if (record.state === QUEUED_UNADDRESSED) return TTL_FAILURE
  if (drained(record)) {
    return 'It went out with your next prompt, and nothing acknowledged it within 30 minutes.'
  }
  // Written to the Target's socket, and never acknowledged. Silence is not
  // evidence that it did not arrive, so this does not say *not delivered*.
  return `${name} never acknowledged it within 30 minutes.`
}

/**
 * The Target's name as it stood when the Pick was addressed, for a sentence a
 * developer reads — never a session id, and never a name this server made up.
 */
export function targetName(pick: Pick): string {
  return pick.target?.name ?? 'the session you picked'
}

/**
 * Whether the hook floor is what last handed this Pick out. The floor's claim
 * is the only move from `queued-unaddressed` to `sent`: a socket write opens a
 * Pick at `sent`, and a release returns it there from `held`.
 */
function drained(record: LedgerRecord): boolean {
  const history = record.history
  for (let at = history.length - 1; at > 0; at--) {
    if (history[at]?.state === SENT) return history[at - 1]?.state === QUEUED_UNADDRESSED
  }
  return false
}

/**
 * The states in which a Pick is still in the claim-once queue: waiting for a
 * route to take it, or written and awaiting the agent's word. An entry in any
 * other state has left, whatever became of it.
 */
const QUEUED: readonly PickState[] = [QUEUED_UNADDRESSED, SENT, HELD, UNKNOWN]

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
   * Leave it for whoever the developer prompts next (spec §17): back to
   * `queued-unaddressed`, where the hook floor takes it, with a fresh TTL from
   * `at`. Undefined for a Pick this server never accepted.
   */
  requeue(pickId: string, at: number): LedgerRecord | undefined
  /**
   * Forget a Pick entirely. Only a retarget does this: the Pick lives on as a
   * new one with its own id, and the old id must not be delivered or shown.
   */
  remove(pickId: string): void
  /**
   * Every queued Pick past its TTL at `at`, failed with the sentence that fits
   * how it got there, and
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

    requeue(pickId, at) {
      const record = records.get(pickId)
      if (!record) return undefined
      move(record, QUEUED_UNADDRESSED, null)
      record.expiresAt = at + TTL_MS
      return record
    },

    remove(pickId) {
      records.delete(pickId)
    },

    // The whole of the TTL rule: which states expire — every one still in the
    // claim-once queue — and with which sentence.
    expire(at) {
      const expired: LedgerRecord[] = []
      for (const record of records.values()) {
        if (!isQueued(record.state) || record.expiresAt > at) continue
        move(record, FAILED, ttlSentence(record))
        expired.push(record)
      }
      return expired
    },
  }
}
