// The Target row (spec §7, §14): one line in the Panel's footer naming the
// session a Pick is addressed to, and the rows it expands into when there is a
// choice to make. Two zero states are told apart here — no session running in
// this folder, and a registry the server could not read — because the Panel
// says something different for each.

import { memo } from 'react'
import type { Candidate, NamedTarget } from '../wire.js'
import type { Sessions } from './client.js'
import { partProps } from './root.js'
import * as words from './words.js'

/** The badge on the `CLAUDE_PID` match (spec §7). */
const STARTED_THIS_SERVER = 'started this dev server'

/** The re-resolve question standing in place of the Send row (spec §14). */
export interface Offer {
  /** The Target that left, by name. Null when it was never named. */
  left: string | null
  /** What the chain yields instead: named, not written to. */
  replacement: NamedTarget
}

export interface TargetRowProps {
  /** What the last `/sessions` read said. Null until one answers, or it failed. */
  sessions: Sessions | null
  /** A read that could not be answered at all, in the server's own words. */
  unreadable: string | null
  chosen: NamedTarget | null
  expanded: boolean
  offer: Offer | null
  onToggle(): void
  onChoose(candidate: Candidate): void
}

/** What the sessions read allows: the three facts the Panel and the row share. */
export function sessionsState(sessions: Sessions | null) {
  const candidates = sessions?.candidates ?? []
  return {
    candidates,
    /** Expandable only when there is a choice to make: no picker when degraded. */
    choosable: sessions !== null && !sessions.hookFloor && candidates.length > 0,
    /** Zero Candidates: the input is replaced, and no Target is shown. */
    noSession: sessions !== null && !sessions.hookFloor && candidates.length === 0,
  }
}

/** The collapsed row: one line, plus the imperative when there is one. */
export const TargetRow = memo(function TargetRow(props: TargetRowProps) {
  const { sessions, unreadable, chosen, offer, onToggle } = props
  const { candidates, choosable, noSession } = sessionsState(sessions)

  // Zero Candidates shows no Target at all: there is nothing to name, and an
  // empty row would be a place to look for one (spec §7).
  if (noSession) return null

  // Marked rather than disabled: a row with nothing to expand into is still
  // the line that says why, and a disabled button is not read by everything.
  const expandable = choosable && !offer
  return (
    <button
      type="button"
      {...partProps('target')}
      data-expandable={expandable ? '' : undefined}
      onClick={() => {
        // While the re-resolve question stands, the row is the question.
        if (expandable) onToggle()
      }}
    >
      {line({ sessions, unreadable, chosen, offer, candidates })}
    </button>
  )
})

function line({
  sessions,
  unreadable,
  chosen,
  offer,
  candidates,
}: Pick<TargetRowProps, 'sessions' | 'unreadable' | 'chosen' | 'offer'> & {
  candidates: Candidate[]
}) {
  const said = (text: string) => <span {...partProps('target-line')}>{text}</span>

  if (offer)
    return said(words.goneAskingFor(offer.left ?? 'That session', offer.replacement.name))
  if (unreadable) return said(unreadable)
  if (sessions === null) return null
  if (sessions.hookFloor) return said(words.CANT_SEE_SESSIONS)
  // Step 4 of §14's chain: Send is off, and the row says why rather than
  // leaving a grey button to be puzzled over.
  if (!chosen) return said(words.CHOOSE_A_SESSION)

  const live = candidates.find((candidate) => candidate.sessionId === chosen.sessionId)
  if (live?.status === 'waiting') {
    return (
      <>
        {said(words.blockedOnPermission(live.name))}
        <span {...partProps('target-action')}>{words.APPROVE_IN_TERMINAL}</span>
      </>
    )
  }
  return said(
    live
      ? words.targetLine(
          live.name,
          statusOf(live, sessions.readAt),
          live.waitingFor ?? undefined,
        )
      : chosen.name,
  )
}

/** The rows the Target row expands into, inside the Panel and never a dialog. */
export const TargetChoices = memo(function TargetChoices({
  sessions,
  chosen,
  expanded,
  offer,
  onChoose,
}: TargetRowProps) {
  const { candidates, choosable } = sessionsState(sessions)
  if (!expanded || !choosable || offer || !sessions) return null
  const readAt = sessions.readAt

  return (
    <div {...partProps('targets')}>
      {candidates.map((candidate) => {
        const stale = words.idleFor(candidate.statusUpdatedAt, readAt)
        return (
          <button
            type="button"
            key={candidate.sessionId}
            {...partProps('target-row')}
            data-chosen={candidate.sessionId === chosen?.sessionId ? '' : undefined}
            onClick={() => onChoose(candidate)}
          >
            <span {...partProps('row-name')}>{candidate.name}</span>
            <span {...partProps('row-status')}>{candidate.status}</span>
            {stale && <span {...partProps('row-idle')}>{stale}</span>}
            {/* A `waiting` Candidate is flagged, never skipped (spec §14). */}
            {candidate.waitingFor && (
              <span {...partProps('row-waiting')}>{candidate.waitingFor}</span>
            )}
            {candidate.startedThisServer && (
              <span {...partProps('started-badge')}>{STARTED_THIS_SERVER}</span>
            )}
          </button>
        )
      })}
    </div>
  )
})

/** *idle for Nd* stands in for the status word only where it can be true. */
function statusOf(candidate: Candidate, readAt: number): string {
  if (candidate.status !== 'idle') return candidate.status
  return words.idleFor(candidate.statusUpdatedAt, readAt) ?? candidate.status
}
