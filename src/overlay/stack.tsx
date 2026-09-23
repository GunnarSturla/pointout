// The Stack (spec §8, §17): where submitted Picks rest while their fate is
// unsettled. Bottom-right, one chip per submitted Pick, no cap — and gone
// entirely the moment nothing is outstanding, which is the whole of what
// separates it from the Picker (`CONTEXT.md`).
//
// Each chip says only what is known about *its own* Pick. The states come from
// `/__agent/status`, which carries Pick-specific evidence; the Target's live
// status never reaches this module, so §17's rule — session-level evidence
// colours the Target row and never moves a chip — holds by construction. What
// does reach it is the server's report-back clock for each Pick: offered back,
// which expands the chip into the offer (`report-back.tsx`), or paused behind a
// permission prompt, which the Stack's footer says (spec §17).
//
// A chip owns the resting Highlight of its Pick as well as its words: the two
// are one thing to the developer, and hovering the chip is what re-lights the
// box.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CLOCK_OFFERED,
  CLOCK_PAUSED,
  DONE,
  FAILED,
  HELD,
  OFFERABLE,
  QUEUED_UNADDRESSED,
  REQUEUE,
  RETARGET,
  SENT,
  UNKNOWN,
  WORKING,
} from '../wire.js'
import type {
  Candidate,
  NamedTarget,
  PickState,
  ReportAnswer,
  ReportBack,
  Target,
} from '../wire.js'
import { readSessions, readStatus, resolveOffer } from './client.js'
import type { Sessions } from './client.js'
import { viewportBox } from './deep-element.js'
import { ReportBackOffer } from './report-back.js'
import type { Reflow } from './reflow.js'
import { partProps } from './root.js'
import { watchTick } from './tick.js'
import * as words from './words.js'

/**
 * Spec §8: a `done` chip dismisses itself on a plain timer of about eight
 * seconds. Plain is the point — no condition, no hover to keep it alive.
 */
const DISMISS_DONE_MS = 8000

/** The chip reads **Sent** in both of these; only the sub-line tells them apart. */
const UNACKNOWLEDGED: readonly string[] = [SENT, QUEUED_UNADDRESSED, UNKNOWN]

/** What the Overlay hands the Stack when a Pick is accepted. */
export interface Submitted {
  pickId: string
  /** The element the Pick was made on: its resting Highlight goes here. */
  element: Element
  /** The Target's name as the Panel knew it, for as long as it stays known. */
  targetName: string | null
}

export interface StackProps {
  /** The page's own window: the tick and the dismissal timer run on it. */
  view: Window
  reflow: Reflow
  /** Every Pick outstanding, oldest first. Empty means there is no Stack at all. */
  picks: readonly Submitted[]
  /** This Pick is over: whatever else the Overlay still shows of it goes too. */
  onDismiss(pickId: string): void
  /**
   * An offer was resolved by sending the Pick to another session: it lives on
   * as a new Pick, on the same element, and the old id is gone (spec §17).
   */
  onReplaced(pickId: string, replacement: string, targetName: string): void
}

/** What the last poll said about one Pick. */
interface Told {
  state: PickState
  reason: string | null
  /** The Target, as the server has it addressed and named. Marked in the offer's list. */
  target: NamedTarget | null
  /** The server's report-back clock for this Pick, or null when none runs. */
  reportBack: ReportBack | null
}

/** One offer as this page holds it: the countdown and what has been done to it. */
interface Offered {
  /** When this page first saw it (spec §17's thirty seconds start here). */
  startedAt: number
  /** Touched, so its countdown is gone for good (story 48). */
  cancelled: boolean
  /** The list of sessions is open. */
  choosing: boolean
  /** A resolution the server refused, in its own words. */
  refusal: string | null
}

export const Stack = memo(function Stack({
  view,
  reflow,
  picks,
  onDismiss,
  onReplaced,
}: StackProps) {
  const [told, setTold] = useState<ReadonlyMap<string, Told>>(() => new Map())
  const [offers, setOffers] = useState<ReadonlyMap<string, Offered>>(() => new Map())
  /** The sessions the offer's list chooses from, read when it opens. */
  const [sessions, setSessions] = useState<Sessions | null>(null)
  /** The Pick whose chip is hovered: its resting box is the live treatment again. */
  const [lit, setLit] = useState<string | null>(null)
  /** The Picks whose dismissal timer is running: a second poll must not restart it. */
  const dismissing = useRef(new Set<string>())

  // Spec §14: one tick, running only while something is outstanding. A poll
  // that could not be answered changes nothing: a chip may only move on
  // evidence, and a failed read is the absence of evidence (spec §17, §21).
  useEffect(() => {
    if (picks.length === 0) return
    const poll = async () => {
      const read = await readStatus()
      if (!read.ok) return
      const ours = read.picks.filter((status) =>
        picks.some((pick) => pick.pickId === status.pickId),
      )
      setTold((previous) => {
        const next = new Map(previous)
        for (const status of ours) {
          const target = status.target
          const name = target?.name ?? null
          next.set(status.pickId, {
            state: status.state,
            reason: status.reason,
            target: target && name !== null ? { ...addressOf(target), name } : null,
            reportBack: status.reportBack ?? null,
          })
        }
        return next
      })
      // An offer's thirty seconds start when this page first sees it.
      setOffers((previous) => {
        const fresh = ours.filter(
          (status) =>
            status.reportBack?.state === CLOCK_OFFERED && !previous.has(status.pickId),
        )
        if (fresh.length === 0) return previous
        const next = new Map(previous)
        for (const status of fresh) {
          next.set(status.pickId, {
            startedAt: Date.now(),
            cancelled: false,
            choosing: false,
            refusal: null,
          })
        }
        return next
      })
      for (const status of ours) {
        if (status.state !== DONE || dismissing.current.has(status.pickId)) continue
        dismissing.current.add(status.pickId)
        view.setTimeout(() => onDismiss(status.pickId), DISMISS_DONE_MS)
      }
    }
    return watchTick(view, () => void poll())
  }, [view, picks, onDismiss])

  const change = useCallback((pickId: string, patch: Partial<Offered>) => {
    setOffers((previous) => {
      const offer = previous.get(pickId)
      if (!offer) return previous
      const next = new Map(previous)
      next.set(pickId, { ...offer, ...patch })
      return next
    })
  }, [])

  /**
   * What the server answered a resolution with is evidence: the chip says it at
   * once rather than on the next poll. The offer is over either way.
   */
  const settle = useCallback(
    (pickId: string, answer: ReportAnswer, target?: NamedTarget) => {
      setTold((previous) => {
        const next = new Map(previous)
        next.set(answer.pickId, {
          state: answer.state,
          reason: answer.reason ?? null,
          target: target ?? previous.get(pickId)?.target ?? null,
          reportBack: null,
        })
        return next
      })
    },
    [],
  )

  const leave = useCallback(
    async (pickId: string) => {
      change(pickId, { cancelled: true })
      const resolved = await resolveOffer(pickId, { resolve: REQUEUE })
      if (!resolved.ok) return change(pickId, { refusal: resolved.reason })
      settle(pickId, resolved.answer)
    },
    [change, settle],
  )

  const sendElsewhere = useCallback(
    async (pickId: string) => {
      change(pickId, { cancelled: true, choosing: true })
      const read = await readSessions()
      if (read.ok) setSessions(read.sessions)
      else change(pickId, { refusal: read.reason })
    },
    [change],
  )

  const choose = useCallback(
    async (pickId: string, candidate: Candidate) => {
      const resolved = await resolveOffer(pickId, {
        resolve: RETARGET,
        target: { sessionId: candidate.sessionId, pid: candidate.pid },
      })
      if (!resolved.ok) {
        // The session chose left between the list and the click: the reason
        // names what would take it instead, and the list is read again so that
        // it is there to be chosen (spec §14 — never taken without asking).
        change(pickId, { refusal: resolved.reason })
        const read = await readSessions()
        if (read.ok) setSessions(read.sessions)
        return
      }
      settle(pickId, resolved.answer, { ...addressOf(candidate), name: candidate.name })
      onReplaced(pickId, resolved.answer.pickId, candidate.name)
    },
    [change, settle, onReplaced],
  )

  if (picks.length === 0) return null

  // Sent is what is known the moment the server accepted a Pick; the first poll
  // is what tells an addressed Pick from one the hook floor will carry.
  const chips = picks.map((pick) => {
    const heard = told.get(pick.pickId)
    const state = heard?.state ?? SENT
    const offered =
      heard?.reportBack?.state === CLOCK_OFFERED && OFFERABLE.includes(state)
    return {
      pick,
      state,
      reason: heard?.reason ?? null,
      name: heard?.target?.name ?? pick.targetName ?? '',
      target: heard?.target ?? null,
      offer: offered ? (offers.get(pick.pickId) ?? null) : null,
      // A `held` Pick's chip already names the prompt; the footer is for the
      // sent ones stalled behind a Target's own.
      paused: heard?.reportBack?.state === CLOCK_PAUSED && state !== HELD,
    }
  })
  // One Pick says everything about itself on its own chip; the summary exists
  // for the case story 49 names, which is several Picks in flight — and it
  // counts them, attributing nothing to any one (spec §17).
  const unacknowledged = chips.filter((chip) =>
    UNACKNOWLEDGED.includes(chip.state),
  ).length
  // Spec §17: the paused clock's footer names the Target and the one action
  // that unblocks it — the phrase the Target row and the `held` chip use.
  const waitingOn = [
    ...new Set(chips.filter((chip) => chip.paused).map((chip) => chip.name)),
  ]

  return (
    <>
      {chips.map(({ pick }) => (
        <RestingBox
          key={pick.pickId}
          element={pick.element}
          reflow={reflow}
          lit={lit === pick.pickId}
        />
      ))}
      <div {...partProps('stack')}>
        {chips.length >= 2 && unacknowledged > 0 && (
          <div {...partProps('summary')}>{words.noneAcknowledgedYet(unacknowledged)}</div>
        )}
        {chips.map(({ pick, state, reason, name, target, offer }) => (
          <Chip
            key={pick.pickId}
            pickId={pick.pickId}
            state={state}
            {...say(state, reason, name)}
            onHover={setLit}
          >
            {offer && (
              <ReportBackOffer
                view={view}
                name={name}
                startedAt={offer.startedAt}
                cancelled={offer.cancelled}
                choosing={offer.choosing}
                sessions={sessions}
                chosen={target}
                refusal={offer.refusal}
                onTouch={() => change(pick.pickId, { cancelled: true })}
                onLeave={() => void leave(pick.pickId)}
                onSendElsewhere={() => void sendElsewhere(pick.pickId)}
                onChoose={(candidate) => void choose(pick.pickId, candidate)}
              />
            )}
          </Chip>
        ))}
        {waitingOn.map((name) => (
          <div key={name} {...partProps('stack-waiting')}>
            <span {...partProps('stack-waiting-line')}>{words.pausedFor(name)}</span>
            <span {...partProps('target-action')}>{words.APPROVE_IN_TERMINAL}</span>
          </div>
        ))}
      </div>
    </>
  )
})

/**
 * One chip. Its hover is read through the element's own `pointerenter` and
 * `pointerleave` rather than React's: React derives those two from over/out
 * pairs, and a pointer arriving from the consumer's own React tree is retargeted
 * at the shadow host on the way in, so the pair never forms. The Overlay and the
 * app share one React, and this is the one place the two trees hand a pointer
 * across.
 */
function Chip({
  pickId,
  state,
  text,
  next,
  onHover,
  children,
}: {
  pickId: string
  state: string
  text: string
  next: string | null
  onHover(pickId: string | null): void
  /** The offer, when there is one: the chip expands into it in place (spec §8). */
  children?: ReactNode
}) {
  const hover = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return
      const enter = () => onHover(pickId)
      const leave = () => onHover(null)
      node.addEventListener('pointerenter', enter)
      node.addEventListener('pointerleave', leave)
      return () => {
        node.removeEventListener('pointerenter', enter)
        node.removeEventListener('pointerleave', leave)
      }
    },
    [pickId, onHover],
  )

  // An offer stands in for the chip's words: it says what they would have said
  // about the Pick, and what to do about it.
  return (
    <div
      ref={hover}
      {...partProps('stack-chip')}
      data-pick={pickId}
      data-state={state}
      data-offered={children ? '' : undefined}
    >
      {children ?? (
        <>
          <div {...partProps('chip-words')}>{text}</div>
          {next && <div {...partProps('chip-next')}>{next}</div>}
        </>
      )}
    </div>
  )
}

/**
 * What one chip says: its words, and the sub-line under them — the next action,
 * or the route a Pick nobody is addressed to will actually take. One arm per
 * state of §17's table, from Pick-specific evidence and nothing else.
 */
function say(
  state: PickState,
  reason: string | null,
  name: string,
): { text: string; next: string | null } {
  switch (state) {
    // §17 gives `held` fixed words, so they come from the state; the server
    // leaves `reason` null for it on purpose.
    case HELD:
      return { text: words.askingToApprove(name), next: words.APPROVE_IN_TERMINAL }
    case WORKING:
      return { text: words.workingOn(name), next: null }
    case DONE:
      return { text: words.doneReportedBy(name), next: null }
    case FAILED:
      return { text: reason ?? words.NOT_DELIVERED, next: words.SEND_AGAIN }
    case QUEUED_UNADDRESSED:
      return { text: words.SENT, next: words.NEXT_PROMPT }
    case SENT:
      return { text: words.SENT, next: null }
    case UNKNOWN:
      return { text: words.NO_ACK_YET, next: words.CHECK_TERMINAL }
  }
}

/**
 * The resting Highlight of a submitted Pick (spec §5): a thin outline, no fill
 * and no chip, desaturated — and the live treatment again while its chip is
 * hovered. There is no chip element here at all, so "no chip" is a fact about
 * the box rather than a rule that could be overridden. It is placed and
 * re-measured and never travels: it belongs to one element for as long as the
 * Pick is outstanding, which is what `data-placing` says, and it stays on.
 */
function RestingBox({
  element,
  reflow,
  lit,
}: {
  element: Element
  reflow: Reflow
  lit: boolean
}) {
  const box = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const place = () => {
      const node = box.current
      if (!node) return
      // The element a Pick was made on can leave the page while the Pick is
      // still in flight (spec §5). A detached element measures 0×0 at the
      // page's corner, so the box goes rather than marking nothing, and the
      // Pick carries on.
      node.hidden = !element.isConnected
      if (node.hidden) return
      const rect = viewportBox(element)
      node.style.translate = `${rect.left}px ${rect.top}px`
      node.style.width = `${rect.width}px`
      node.style.height = `${rect.height}px`
    }
    place()
    return reflow.subscribe(place)
  }, [element, reflow])

  return (
    <div
      ref={box}
      {...partProps('highlight')}
      data-placing=""
      data-resting={lit ? undefined : ''}
    />
  )
}

/** The two halves of a session's identity, and nothing else. */
function addressOf(session: Target): Target {
  return { sessionId: session.sessionId, pid: session.pid }
}
