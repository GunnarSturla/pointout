// The Stack (spec §8, §17): where submitted Picks rest while their fate is
// unsettled. Bottom-right, one minimized Panel per submitted Pick, no cap — and
// gone entirely the moment nothing is outstanding, which is the whole of what
// separates it from the Picker (`CONTEXT.md`).
//
// A minimized Panel is the submitted form of the Panel the Pick was written in:
// one line with its traffic light, the component, the Note's first line and a
// camera when a Screen Capture went, and a second, small line when there is
// something to read. It says only what is known about *its own* Pick. The
// states come from `/__agent/status`, which carries Pick-specific evidence; the
// Target's live status never reaches this module, so §17's rule — session-level
// evidence colours the Target row and never moves a Pick — holds by
// construction. What does reach it is the server's report-back clock for each
// Pick: offered back, which expands the minimized Panel into the offer
// (`report-back.tsx`), or paused behind a permission prompt, which the Stack's
// footer says (spec §17).
//
// A minimized Panel owns the resting Highlight of its Pick as well as its
// words: the two are one thing to the developer, and hovering the one is what
// re-lights the other.
//
// Pressing a minimized Panel opens it above the Stack, to be read: the whole
// Note and where it went. It is still the same Panel, so its slot stays where
// it is, marked, and closing it puts it back there. At most one is open, and
// opening it never takes focus from an unsubmitted Panel's Note.

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
import { growFrom, landIn, leaveBehind } from './presence.js'
import type { Sessions } from './client.js'
import type { Accepted } from './panel.js'
import { viewportBox } from './deep-element.js'
import { Dot } from './dot.js'
import { CameraIcon } from './icons.js'
import { ReportBackOffer } from './report-back.js'
import type { Reflow } from './reflow.js'
import { partProps } from './root.js'
import { watchTick } from './tick.js'
import * as words from './words.js'
import type { Light } from './words.js'

/**
 * Spec §8: a `done` Pick dismisses itself on a plain timer of about eight
 * seconds. Plain is the point — no condition, no hover to keep it alive.
 */
const DISMISS_DONE_MS = 8000

/** Nothing has acknowledged a Pick in any of these: what the summary counts. */
const UNACKNOWLEDGED: readonly string[] = [SENT, QUEUED_UNADDRESSED, UNKNOWN]

/**
 * What the Overlay hands the Stack when a Pick is accepted: what its Panel
 * knew of it, and what the element is called. Its resting Highlight goes on
 * `element`. What the dev server said as it accepted it — `reason` and
 * `trimmed` — is said for as long as the Pick is, because the Panel it was
 * said in is gone.
 */
export interface Submitted extends Accepted {
  /** What the element is called: the component that wrote it, or its tag. */
  name: string
  /**
   * Its place in the Stack, for as long as it is outstanding: an offer that
   * sends it on replaces its id and keeps its place.
   */
  slot: string
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
  /** The Pick whose minimized Panel is hovered: its resting box is the live treatment again. */
  const [lit, setLit] = useState<string | null>(null)
  /** The slot whose Panel is open above the Stack, when one is. */
  const [open, setOpen] = useState<string | null>(null)
  const toggle = useCallback(
    (slot: string) => setOpen((was) => (was === slot ? null : slot)),
    [],
  )
  const close = useCallback(() => setOpen(null), [])
  /** The Picks whose dismissal timer is running: a second poll must not restart it. */
  const dismissing = useRef(new Set<string>())

  // Spec §14: one tick, running only while something is outstanding. A poll
  // that could not be answered changes nothing: a Pick may only move on
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
   * What the server answered a resolution with is evidence: the Panel says it at
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
  const rows = picks.map((pick) => {
    const heard = told.get(pick.pickId)
    const state = heard?.state ?? SENT
    const offered =
      heard?.reportBack?.state === CLOCK_OFFERED && OFFERABLE.includes(state)
    const offer = offered ? (offers.get(pick.pickId) ?? null) : null
    const name = heard?.target?.name ?? pick.targetName ?? ''
    return {
      pick,
      state,
      name,
      target: heard?.target ?? null,
      offer,
      said: say(state, heard?.reason ?? null, name, offer !== null),
      // A `held` Pick already names the prompt; the footer is for the sent
      // ones stalled behind a Target's own.
      paused: heard?.reportBack?.state === CLOCK_PAUSED && state !== HELD,
    }
  })
  // One Pick says everything about itself on its own minimized Panel; the
  // summary exists for the case story 49 names, which is several Picks in
  // flight — and it counts them, attributing nothing to any one (spec §17).
  const unacknowledged = rows.filter((row) => UNACKNOWLEDGED.includes(row.state)).length
  // Spec §17: the paused clock's footer names the Target and the one action
  // that unblocks it — the phrase the Target row and a `held` Pick use.
  const waitingOn = [...new Set(rows.filter((row) => row.paused).map((row) => row.name))]
  const opened = rows.find((row) => row.pick.slot === open) ?? null

  return (
    <>
      {rows.map(({ pick }) => (
        <RestingBox
          key={pick.slot}
          element={pick.element}
          reflow={reflow}
          lit={lit === pick.pickId}
        />
      ))}
      <div {...partProps('stack')}>
        {opened && (
          <Expanded
            key={opened.pick.slot}
            view={view}
            pick={opened.pick}
            said={opened.said}
            name={opened.name}
            onClose={close}
          />
        )}
        {rows.length >= 2 && unacknowledged > 0 && (
          <div {...partProps('summary')}>{words.noneAcknowledgedYet(unacknowledged)}</div>
        )}
        {rows.map(({ pick, state, said, name, target, offer }) => (
          <Minimized
            key={pick.slot}
            pick={pick}
            state={state}
            said={said}
            open={pick.slot === open}
            onHover={setLit}
            onToggle={toggle}
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
          </Minimized>
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
 * A submitted Pick's Panel, minimized in the Stack. Its hover is read through
 * the element's own `pointerenter` and `pointerleave` rather than React's:
 * React derives those two from over/out pairs, and a pointer arriving from the
 * consumer's own React tree is retargeted at the shadow host on the way in, so
 * the pair never forms. The Overlay and the app share one React, and this is
 * the one place the two trees hand a pointer across.
 */
function Minimized({
  pick,
  state,
  said,
  open,
  onHover,
  onToggle,
  children,
}: {
  pick: Submitted
  state: PickState
  said: Said
  /** It is open above the Stack, and this is its slot. */
  open: boolean
  onHover(pickId: string | null): void
  onToggle(slot: string): void
  /** The offer, when there is one: the Panel expands into it in place (spec §8). */
  children?: ReactNode
}) {
  const { pickId } = pick
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

  // The spaces between the parts are for what reads the Panel aloud; the line
  // spaces them itself. An offer stands in for the second line: it says what
  // that line would have said about the Pick, and what to do about it.
  //
  // The first line is what opens it. A press on it keeps focus wherever it
  // was, which is the Note, when one is being written; the keyboard reaches it
  // as any button, and Escape on it closes what it opened.
  return (
    <div
      ref={hover}
      {...partProps('minimized')}
      data-pick={pickId}
      data-slot={pick.slot}
      data-state={state}
      data-offered={children ? '' : undefined}
      data-open={open ? '' : undefined}
    >
      <button
        type="button"
        {...partProps('minimized-line')}
        aria-expanded={open}
        aria-controls={open ? expandedId(pick.slot) : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onToggle(pick.slot)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !open) return
          event.preventDefault()
          onToggle(pick.slot)
        }}
      >
        <span
          {...partProps('light')}
          role="img"
          aria-label={said.title}
          title={said.title}
        >
          <Dot light={said.light} />
        </span>{' '}
        <span {...partProps('minimized-name')}>{pick.name}</span>{' '}
        <span {...partProps('minimized-note')}>
          {firstLine(pick.note) ?? words.STAND_BY}
        </span>
        {pick.captured && (
          <>
            {' '}
            <span
              {...partProps('minimized-camera')}
              role="img"
              aria-label={words.CAPTURE_SENT}
              title={words.CAPTURE_SENT}
            >
              <CameraIcon />
            </span>
          </>
        )}
      </button>
      {children ??
        ((said.words || said.next) && (
          <div {...partProps('minimized-said')}>
            {said.words && <span {...partProps('minimized-words')}>{said.words}</span>}
            {said.words && said.next && ' '}
            {said.next && <span {...partProps('minimized-next')}>{said.next}</span>}
          </div>
        ))}
      {pick.reason && <div {...partProps('minimized-reason')}>{pick.reason}</div>}
      {pick.trimmed && <div {...partProps('trimmed')}>{pick.trimmed}</div>}
    </div>
  )
}

/**
 * A submitted Pick's Panel, open above the Stack (docs/overlay-design.md): the
 * same card as the unsubmitted Panel, read-only, with the whole Note as text
 * and the session it went to. It comes up out of its slot and goes back into
 * it (`presence.ts`), however it is closed — pressed again, Escape while it has
 * focus, another opened, or its Pick over.
 *
 * It takes focus only when it is clicked into, so it can hear its Escape.
 */
function Expanded({
  view,
  pick,
  said,
  name,
  onClose,
}: {
  view: Window
  pick: Submitted
  said: Said
  /** The session it went to, as the Stack last heard it named. */
  name: string
  onClose(): void
}) {
  const panel = useRef<HTMLDivElement>(null)
  const { slot } = pick

  useLayoutEffect(() => {
    const node = panel.current
    if (!node) return
    const from = node.parentElement && slotIn(node.parentElement, slot)
    if (from) growFrom(node, view, from.getBoundingClientRect())
    return () => {
      const into = node.parentElement && slotIn(node.parentElement, slot)
      // Focus in it goes back to what opened it, rather than out of the
      // Overlay, however it closes.
      const focused = (node.getRootNode() as Document | ShadowRoot).activeElement
      if (focused && node.contains(focused)) {
        into?.querySelector<HTMLElement>('[data-part="minimized-line"]')?.focus()
      }
      const copy = leaveBehind(node, view, { landing: true })
      if (into) landIn(copy, into.getBoundingClientRect())
    }
  }, [view, slot])

  return (
    <div
      ref={panel}
      {...partProps('expanded')}
      id={expandedId(slot)}
      data-slot={slot}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onClose()
      }}
    >
      <div {...partProps('expanded-head')}>
        <Dot light={said.light} />
        <span {...partProps('expanded-state')}>{said.title}</span>
        <span {...partProps('expanded-name')}>{pick.name}</span>
        {pick.captured && (
          <span
            {...partProps('expanded-camera')}
            role="img"
            aria-label={words.CAPTURE_SENT}
            title={words.CAPTURE_SENT}
          >
            <CameraIcon />
          </span>
        )}
      </div>
      <div {...partProps('expanded-note')} data-empty={pick.note ? undefined : ''}>
        {pick.note ?? words.STAND_BY}
      </div>
      <div {...partProps('expanded-target')}>{words.sentTo(name)}</div>
    </div>
  )
}

/** The minimized Panel in `slot`, wherever in `scope` the Stack has drawn it. */
export function slotIn(scope: ParentNode, slot: string): HTMLElement | null {
  return scope.querySelector<HTMLElement>(
    `[data-part="minimized"][data-slot="${CSS.escape(slot)}"]`,
  )
}

/** The id of the Panel in `slot` opened above the Stack, which its line controls. */
function expandedId(slot: string): string {
  return `expanded-${slot}`
}

/** The Note's first line, or null for a Pick sent without one. */
function firstLine(note: string | null): string | null {
  if (!note) return null
  return note.split('\n', 1)[0] ?? ''
}

/** What one minimized Panel says about its Pick. */
interface Said {
  /** The traffic light's colour: null is grey. */
  light: Light | null
  /** The light's state in words, in its `title`. */
  title: string
  /** §17's words for the state, on the second line. */
  words: string | null
  /** Under them, the next action, or the route the Pick will take. */
  next: string | null
}

/**
 * The traffic light and its word, and the second line — §17's words, and under
 * them the next action, or the route a Pick nobody is addressed to will
 * actually take. One arm per state of §17's table, from Pick-specific evidence
 * and nothing else.
 */
function say(
  state: PickState,
  reason: string | null,
  name: string,
  offered: boolean,
): Said {
  // The offer brings its own words, and the light says what it is about.
  if (offered)
    return { light: 'failed', title: words.NEVER_PICKED_UP, words: null, next: null }
  switch (state) {
    // §17 gives `held` fixed words, so they come from the state; the server
    // leaves `reason` null for it on purpose.
    case HELD:
      return {
        light: 'needs',
        title: words.NEEDS_APPROVAL,
        words: words.askingToApprove(name),
        next: words.APPROVE_IN_TERMINAL,
      }
    case WORKING:
      return {
        light: 'working',
        title: words.WORKING,
        words: words.workingOn(name),
        next: null,
      }
    case DONE:
      return {
        light: 'ready',
        title: words.DONE,
        words: words.doneReportedBy(name),
        next: null,
      }
    case FAILED:
      return {
        light: 'failed',
        title: words.FAILED,
        words: reason ?? words.NOT_DELIVERED,
        next: words.SEND_AGAIN,
      }
    // Sent, as far as the Pick goes: the light says so, and the line says when.
    case QUEUED_UNADDRESSED:
      return {
        light: null,
        title: words.WAITING_FOR_PROMPT,
        words: null,
        next: words.NEXT_PROMPT,
      }
    case SENT:
      return { light: null, title: words.SENT, words: null, next: null }
    case UNKNOWN:
      return {
        light: 'failed',
        title: words.NO_ACK_YET,
        words: words.NO_ACK_YET,
        next: words.CHECK_TERMINAL,
      }
  }
}

/**
 * The resting Highlight of a submitted Pick (spec §5): a thin outline, no fill
 * and no chip, desaturated — and the live treatment again while its minimized
 * Panel is hovered. There is no chip element here at all, so "no chip" is a fact about
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
