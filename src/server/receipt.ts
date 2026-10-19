import type { Logger } from './logger.js'
import { HELD, SENT } from '../wire.js'
import type { Target } from '../wire.js'
import { now } from './clock.js'
import type { DeliveryRoute } from './delivery.js'
import { targetName } from './ledger.js'
import type { Ledger } from './ledger.js'
import type { ReportBackClock } from './report-back.js'

// What comes back at the reply address, and the one rule that separates the two
// things that arrive there (spec §16, §17).
//
// A **Receipt** is the harness's own statement about one Pick. It is
// involuntary, it names the Pick rather than the session, and it reports **bad
// outcomes only** — a Pick that is simply accepted produces none, so silence is
// never evidence of arrival and nothing here ever promotes it to one. Being
// Pick-specific evidence, a Receipt moves the Pick.
//
// An **idle notice** is session-level: the Target finished a turn. It colours
// the Target row and drives the report-back clock, and it never moves a Pick —
// which is why it is kept in a log of its own, keyed by Target, rather than
// anywhere near the ledger.
//
// Neither is an Ack. An Ack is the agent's own voluntary signal about the work,
// and it arrives over HTTP with the Pick's nonce (`http.ts`).

/** Spec §16. The six a Receipt can carry; anything else is a harness that moved. */
export const RECEIPT_STATUSES = [
  'dropped',
  'held',
  'delivered',
  'denied',
  'expired',
  'refused',
] as const

export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]

/** The harness's statement about one Pick this dev server wrote. */
export interface Receipt {
  pickId: string
  status: ReceiptStatus
  /** Which branch dropped it. Only `dropped` carries one; null otherwise. */
  dropReason: string | null
  /** The harness's own prose, which is the fallback sentence. Null when absent. */
  reason: string | null
}

/** The Target of one Pick finished a turn, at its own clock's `finishedAt`. */
export interface IdleNotice {
  target: Target
  /** The Pick whose subscription this answers: what makes staleness decidable. */
  pickId: string
  finishedAt: number
}

/**
 * What a delivery route hands back about the Picks it wrote. The route does the
 * correlating — which Pick, which subscription, and whether a notice predates
 * the send — so everything that reaches here is already about a Pick this
 * server sent.
 */
export interface ReplyListener {
  receipt(receipt: Receipt): void
  idle(notice: IdleNotice): void
}

/**
 * When each Target this server wrote to last finished a turn. Session-level
 * evidence, kept apart from the ledger on purpose: nothing in here may move a
 * Pick, and keeping it in its own map is what makes that impossible rather than
 * merely unintended.
 */
export interface IdleLog {
  record(notice: IdleNotice): void
  /** The latest finish heard about for this Target, or null for none. */
  latest(target: Target): number | null
}

export function createIdleLog(): IdleLog {
  // Both halves of the identity, because a pid can be reused by another session
  // and that is the misdelivery every other comparison here also guards against.
  const key = (target: Target) => `${target.sessionId}\u0000${target.pid}`
  const finishes = new Map<string, number>()

  return {
    record(notice) {
      // The latest wins, and a notice that arrives out of order never puts the
      // clock back: two subscriptions can answer in either order.
      const seen = finishes.get(key(notice.target))
      if (seen === undefined || notice.finishedAt > seen) {
        finishes.set(key(notice.target), notice.finishedAt)
      }
    },
    latest: (target) => finishes.get(key(target)) ?? null,
  }
}

/** Everything applying what comes back needs, and nothing else. */
export interface ReplyEvidence {
  ledger: Ledger
  idle: IdleLog
  /** The one reader of idle notices that may reach a Pick, through its own clock. */
  clock: ReportBackClock
  logger: Logger
}

/**
 * Point a route's return leg at this server's ledger. Called once the ledger
 * exists; until it is, a route that hears something says so and moves nothing,
 * which is the floor v0 would have had without Receipts at all (spec §16).
 */
export function recordReplies(route: DeliveryRoute, evidence: ReplyEvidence): void {
  route.listen({
    receipt: (receipt) => applyReceipt(receipt, evidence),
    idle(notice) {
      evidence.idle.record(notice)
      evidence.logger.info(
        `pointout: session ${notice.target.sessionId} finished a turn ` +
          `at ${notice.finishedAt}, after pick ${notice.pickId}.`,
      )
      evidence.clock.idle(notice.target, notice.finishedAt, now())
    },
  })
}

function applyReceipt(receipt: Receipt, { ledger, logger }: ReplyEvidence): void {
  const record = ledger.get(receipt.pickId)
  if (!record) {
    logger.warn(
      `pointout: ignored a ${receipt.status} receipt for pick ` +
        `${receipt.pickId}, which this dev server has no ledger record of.`,
    )
    return
  }

  // Never a session id in a sentence a developer reads, and never a name this
  // server made up: the Target's name as it stood when the Pick was addressed.
  const name = targetName(record.pick)

  if (receipt.status === 'held') {
    // §17 gives `held` fixed words — the chip and the imperative under it are
    // the Overlay's — so the state carries no reason of its own. Whatever the
    // harness said for itself is said out loud here rather than published as a
    // sentence this server would then be the author of (spec §21).
    ledger.advance(receipt.pickId, HELD)
    logger.info(
      `pointout: pick ${receipt.pickId} is held at ${name} until it is ` +
        'approved there.' +
        (receipt.reason ? ` The harness said: ${receipt.reason}` : ''),
    )
    return
  }

  if (receipt.status === 'delivered') {
    // Spec §17: a `delivered` Receipt is a held message released — it returns a
    // held Pick to `sent` and is never a state of its own, because the only
    // thing it establishes is what `sent` already says. For a Pick in any other
    // state it is evidence about something already past, and moving on it would
    // put better evidence back.
    if (record.state !== HELD) {
      logger.info(
        `pointout: pick ${receipt.pickId} was released by the harness ` +
          `while this server had it as ${record.state}; nothing to return to sent.`,
      )
      return
    }
    ledger.advance(receipt.pickId, SENT)
    logger.info(`pointout: pick ${receipt.pickId} was released, and is sent.`)
    return
  }

  // Dropped, refused, denied, expired. The harness will not deliver it, so no
  // route here may either: `failed` takes it out of the claim-once queue, which
  // also keeps the TTL sweep from writing its own sentence over this one.
  const sentence = failureSentence(receipt, name)
  ledger.failByReceipt(receipt.pickId, sentence)
  logger.warn(`pointout: pick ${receipt.pickId} ${receipt.status}. ${sentence}`)
}

const NOT_DELIVERED = 'Not delivered — '

/**
 * Spec §17's table. The sentence is v0's, written from the machine value rather
 * than from the harness's prose, because the prose is one paragraph covering
 * four branches at once and a developer is owed the branch that happened.
 *
 * Only `duplicate` was measured live (spike 16). The other three are the
 * harness's own words for the branches it names beside it, spelled as machine
 * values; being wrong about one of them costs the harness's prose verbatim
 * instead of a sentence, which is the fallback either way.
 */
const DROP_SENTENCES = new Map<string, (name: string) => string>([
  ['duplicate', () => `${NOT_DELIVERED}an identical pick was just sent.`],
  ['rate_limit', () => `${NOT_DELIVERED}too many picks too quickly.`],
  ['full_queue', (name) => `${NOT_DELIVERED}${name} has too much queued.`],
  ['relay_loop', () => `${NOT_DELIVERED}it came back to where it started.`],
])

/** Only the four statuses that fail reach here; `applyReceipt` is the guard. */
function failureSentence(receipt: Receipt, name: string): string {
  if (receipt.status === 'refused')
    return `${NOT_DELIVERED}${name} isn't accepting picks.`
  if (receipt.status === 'denied') return `${NOT_DELIVERED}you declined it in ${name}.`
  if (receipt.status === 'expired') return `${NOT_DELIVERED}it wasn't approved in time.`

  const written = DROP_SENTENCES.get(machineValue(receipt.dropReason))
  if (written) return written(name)

  // A branch v0 has never heard of. The harness's own prose, verbatim: a
  // sentence this project invented for it would be a guess about what happened
  // (spec §21). Verbatim means verbatim — it is not prefixed with v0's words.
  if (receipt.reason) return receipt.reason
  return `${NOT_DELIVERED}${name} dropped it, and said no more than that.`
}

/**
 * One spelling for a value spelled several ways. `duplicate` is the only drop
 * reason that was measured, so the three beside it are matched through this
 * rather than through a guess at the harness's casing.
 */
function machineValue(value: string | null): string {
  return (value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
