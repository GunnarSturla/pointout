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
  if (!live) return said(chosen.name)
  const health = words.healthOf(live.status)
  if (health === 'needs') {
    return (
      <>
        <Dot health={health} />
        {said(words.blockedOnPermission(live.name))}{' '}
        <span {...partProps('target-action')}>{words.APPROVE_IN_TERMINAL}</span>
      </>
    )
  }
  const age = idleAgeOf(live, sessions.readAt)
  // Separate elements, spaced by the row rather than by a glyph between them.
  // The spaces between them are for what reads the row aloud, and are not drawn.
  return (
    <>
      <Dot health={health} />
      <span {...partProps('target-name')}>{live.name}</span>{' '}
      <span {...partProps('target-status')}>{words.statusWord(live.status)}</span>
      {age && (
        <>
          {' '}
          <Age part="target-age" age={age} />
        </>
      )}
    </>
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
        const age = idleAgeOf(candidate, readAt)
        const isChosen = candidate.sessionId === chosen?.sessionId
        return (
          <button
            type="button"
            key={candidate.sessionId}
            {...partProps('target-row')}
            data-chosen={isChosen ? '' : undefined}
            aria-current={isChosen ? 'true' : undefined}
            onClick={() => onChoose(candidate)}
          >
            <Dot health={words.healthOf(candidate.status)} />
            <span {...partProps('row-name')}>{candidate.name}</span>{' '}
            <span {...partProps('row-status')}>{words.statusWord(candidate.status)}</span>{' '}
            <span {...partProps('row-detail')}>
              {age && <Age part="row-age" age={age} />}{' '}
              {/* A `waiting` Candidate is flagged, never skipped (spec §14). */}
              {candidate.waitingFor && (
                <span {...partProps('row-waiting')}>{candidate.waitingFor}</span>
              )}{' '}
              {candidate.startedThisServer && (
                <span {...partProps('row-started')}>{words.STARTED_THIS_SERVER}</span>
              )}
            </span>
            {isChosen && (
              <span {...partProps('row-chosen')} aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
})

/**
 * A Candidate's health as a dot: green, amber or red. A status the Overlay has
 * no word for is grey, the colour that claims nothing, beside the harness's own
 * word for it. The dot is never the only signal, so it is hidden from what
 * reads the row aloud: the word beside it says the same.
 */
function Dot({ health }: { health: words.Health | null }) {
  return (
    <span {...partProps('dot')} data-status={health ?? undefined} aria-hidden="true" />
  )
}

/** `3d`, and in its title `Idle for 3 days`. */
function Age({ part, age }: { part: string; age: words.IdleAge }) {
  return (
    <span {...partProps(part)} title={age.title}>
      {age.short}
    </span>
  )
}

/** The idle age follows Ready only: a long spell in any other state is not idleness. */
function idleAgeOf(candidate: Candidate, readAt: number): words.IdleAge | null {
  return words.healthOf(candidate.status) === 'ready'
    ? words.idleAge(candidate.statusUpdatedAt, readAt)
    : null
}
