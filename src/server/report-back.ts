import type { Logger } from './logger.js'
import {
  CLOCK_OFFERED,
  CLOCK_PAUSED,
  CLOCK_RUNNING,
  HELD,
  REQUEUE,
  RETARGET,
  SENT,
  UNKNOWN,
} from '../wire.js'
import type { PickState, ReportBack, ReportBody, Target } from '../wire.js'
import { targetName } from './ledger.js'
import type { Ledger } from './ledger.js'
import { isFiniteNumber, isRecord, isText, refuse } from './parse.js'
import type { Parsed } from './parse.js'

// The report-back clock (spec §17): one per Pick written to a socket, so that a
// Pick that never landed is said while the developer is still at the browser.
//
// | Target status after the write | meaning                      | clock            |
// | ----------------------------- | ---------------------------- | ---------------- |
// | flips to `busy`               | it landed                    | no report        |
// | still `idle` at 60 s          | it never landed              | report back      |
// | `busy → idle`, no ack         | the turn ended without it    | report back now  |
// | `waiting`                     | the ack is behind the prompt | pauses           |
// | registry unreadable           | no signal left               | the TTL governs  |
//
// The clock reads session-level evidence — the registry's `status`, and idle
// notices — and that is the one place such evidence may reach a Pick: through
// this server's own clock, which is Pick-specific evidence of its own (spec
// §17). The rest of what the Target says colours the Target row and moves
// nothing. `updatedAt` is not read; it is not a heartbeat.
//
// Like the TTL sweep, the clock is read lazily, on every `/__agent` request:
// the Overlay polls exactly while something is outstanding, so a report lands
// within one of its ticks of being due. With nothing polling, it lands on the
// next request instead.

/** Spec §17: a Target still idle a minute after the write never picked it up. */
const REPORT_AFTER_MS = 60 * 1000

/** The states in which the clock has anything to say about a Pick. */
const CLOCKED: readonly PickState[] = [SENT, UNKNOWN, HELD]

/** One Pick's clock. */
interface Watch {
  pickId: string
  target: Target
  /** When the write went — or the release, for a held Pick — on this server's clock. */
  writtenAt: number
  /**
   * Whether a turn that *started after the write* has been seen: the Target
   * was seen not busy since the write, and then busy. Only the end of such a
   * turn says the Pick was passed over. A turn already running when the Pick
   * arrived ends without it in the ordinary course, and the Pick is taken in
   * the next one.
   */
  sawTurn: boolean
  /** Whether the Target has been seen anything but busy since the write. */
  sawRest: boolean
  /** How long the clock has stood paused, in total, before the current pause. */
  pausedMs: number
  /** When the current pause began, or null while running. */
  pausedSince: number | null
  /** When the offer was made, or null before it. The clock stops there. */
  offeredAt: number | null
}

/** What one sample of the registry says a Target's status is. Null is blind. */
export type StatusOf = (target: Target) => string | null

export interface ReportBackClock {
  /**
   * A Pick was written to `target` at `at`, when the registry had it in
   * `statusAtWrite` (null for blind). Start its clock.
   */
  watch(pickId: string, target: Target, at: number, statusAtWrite: string | null): void
  /** Take one registry sample across every running clock. */
  observe(at: number, statusOf: StatusOf): void
  /**
   * An idle notice: `target` finished a turn at `finishedAt`, on its own clock,
   * and the notice reached this server at `at`, on this one.
   */
  idle(target: Target, finishedAt: number, at: number): void
  /** Where this Pick's clock stands, or null when it has none. */
  stateOf(pickId: string): ReportBack | null
  /** The offer was resolved, or the Pick is gone. Its clock stops for good. */
  forget(pickId: string): void
  /** Whether any clock needs a registry sample. */
  running(): boolean
}

export function createReportBackClock({
  ledger,
  logger,
}: {
  ledger: Ledger
  logger: Logger
}): ReportBackClock {
  const watches = new Map<string, Watch>()

  /** The Pick's state, or null once it has left the clock's hands for good. */
  const clocked = (watch: Watch): PickState | null => {
    const state = ledger.get(watch.pickId)?.state
    if (state && CLOCKED.includes(state)) return state
    watches.delete(watch.pickId)
    return null
  }

  const offer = (watch: Watch, at: number, why: string) => {
    watch.offeredAt = at
    const record = ledger.get(watch.pickId)
    logger.warn(
      `pointout: ${record ? targetName(record.pick) : 'its session'} never ` +
        `picked up pick ${watch.pickId} (${why}); the Overlay offers it back.`,
    )
  }

  /**
   * A `held` Pick is waiting on the same kind of prompt a `waiting` Target is:
   * the ack is blocked behind it, so the clock stands still — and when it is
   * released it has, in effect, only now been handed over, so it starts again.
   * An offer raised before the hold is withdrawn: the Receipt is newer evidence.
   */
  const hold = (watch: Watch, at: number) => {
    watch.writtenAt = at
    watch.sawTurn = false
    watch.sawRest = false
    watch.pausedMs = 0
    watch.pausedSince = at
    watch.offeredAt = null
  }

  return {
    watch(pickId, target, at, statusAtWrite) {
      watches.set(pickId, {
        pickId,
        target,
        writtenAt: at,
        sawTurn: false,
        sawRest: statusAtWrite !== 'busy',
        pausedMs: 0,
        pausedSince: null,
        offeredAt: null,
      })
    },

    observe(at, statusOf) {
      for (const watch of watches.values()) {
        const state = clocked(watch)
        if (!state) continue
        if (state === HELD) {
          if (watch.pausedSince === null || watch.offeredAt !== null) hold(watch, at)
          continue
        }
        if (watch.offeredAt !== null) continue
        const status = statusOf(watch.target)

        if (status === 'waiting') {
          watch.pausedSince ??= at
          continue
        }
        if (watch.pausedSince !== null) {
          watch.pausedMs += at - watch.pausedSince
          watch.pausedSince = null
        }

        const elapsed = at - watch.writtenAt - watch.pausedMs
        if (status === 'busy' && watch.sawRest) watch.sawTurn = true
        else if (status !== 'busy') watch.sawRest = true

        if (status === 'idle' && watch.sawTurn) {
          offer(watch, at, 'its turn ended with no acknowledgement')
        } else if (status === 'idle' && elapsed >= REPORT_AFTER_MS) {
          offer(watch, at, 'it stayed idle for a minute')
        } else if (elapsed >= REPORT_AFTER_MS && state === SENT) {
          // Busy with no ack, or no signal at all: nothing more is known, and
          // saying `unknown` is the one thing that is true (spec §17, §21).
          ledger.advance(watch.pickId, UNKNOWN)
          logger.warn(
            `pointout: pick ${watch.pickId} has had no acknowledgement in a ` +
              (status === 'busy'
                ? 'minute while its session was busy.'
                : 'minute, and its session can no longer be seen; the TTL governs it now.'),
          )
        }
      }
    },

    // The notice's `finished_at` is the Target's own clock and `writtenAt` is
    // this server's — the same comparison the route already makes to call a
    // notice stale (ticket 13). A turn that ended after the write, with no ack,
    // is the turn the Pick should have been in — unless it was already running
    // when the Pick arrived, which ends without it in the ordinary course.
    idle(target, finishedAt, at) {
      for (const watch of watches.values()) {
        if (watch.target.sessionId !== target.sessionId) continue
        if (watch.target.pid !== target.pid) continue
        const state = clocked(watch)
        if (!state || state === HELD || watch.offeredAt !== null) continue
        if (finishedAt < watch.writtenAt) continue
        // That was the turn in progress at the write. What follows it is the
        // registry's to show — at rest, then a turn of its own — and a registry
        // that still says busy for a moment after the notice must not read as
        // that new turn, so the notice itself settles nothing.
        if (!watch.sawRest) continue
        offer(watch, at, 'its session finished a turn with no acknowledgement')
      }
    },

    stateOf(pickId) {
      const watch = watches.get(pickId)
      const state = watch ? clocked(watch) : null
      if (!watch || !state) return null
      if (state === HELD)
        return { state: CLOCK_PAUSED, at: watch.pausedSince ?? watch.writtenAt }
      if (watch.offeredAt !== null) return { state: CLOCK_OFFERED, at: watch.offeredAt }
      if (watch.pausedSince !== null)
        return { state: CLOCK_PAUSED, at: watch.pausedSince }
      return { state: CLOCK_RUNNING, at: watch.writtenAt }
    },

    forget(pickId) {
      watches.delete(pickId)
    },

    running: () => watches.size > 0,
  }
}

/** The body of `POST /__agent/pick/<id>/report`, checked (spec §20). */
export function parseReportBody(text: string): Parsed<ReportBody> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return refuse(
      400,
      'malformed-json',
      `refused a report whose body is not JSON: ${(error as Error).message}`,
    )
  }
  if (!isRecord(parsed)) {
    return refuse(400, 'malformed-json', 'refused a report whose body is not an object.')
  }
  if (parsed.resolve === REQUEUE) return { ok: true, value: { resolve: REQUEUE } }
  if (parsed.resolve === RETARGET) {
    const target = parsed.target
    if (!isRecord(target) || !isText(target.sessionId) || !isFiniteNumber(target.pid)) {
      return refuse(
        400,
        'target-malformed',
        'refused a retarget that names no session: it needs a sessionId and a pid.',
      )
    }
    return {
      ok: true,
      value: {
        resolve: RETARGET,
        target: { sessionId: target.sessionId, pid: target.pid },
      },
    }
  }
  return refuse(
    400,
    'resolve-unknown',
    `refused a report that resolves neither by "${REQUEUE}" nor by "${RETARGET}".`,
  )
}
