// The report-back offer (spec §8, §17, stories 46 to 48): what a chip expands
// into, in place, when its Pick's Target never picked it up. The words, the
// question, its two answers, and a thirty-second countdown drawn as a thin line
// that shortens once a second. When the line runs out, the Pick is left for
// whoever the developer prompts next — so walking away is never the outcome
// with no defence. Touching the offer stops the countdown for good: reading it
// never sets off the default under the developer's hand.
//
// The countdown is this page's, not the server's. It starts when this page
// first sees the offer, and a reload starts it again from thirty seconds; the
// server holds the offer until something resolves it.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Candidate, NamedTarget } from '../wire.js'
import type { Sessions } from './client.js'
import { partProps } from './root.js'
import { TargetChoices } from './target-row.js'
import * as words from './words.js'

/** Spec §17: thirty seconds, then the default. */
const OFFER_MS = 30_000

/** How often the line is redrawn: once a second, one thirtieth each time. */
const STEP_MS = 1000

export interface ReportBackOfferProps {
  view: Window
  /** The Target that never picked it up, by name. */
  name: string
  /** When this page first saw the offer, on the page's own clock. */
  startedAt: number
  /** Touched: the countdown is gone, and it never comes back. */
  cancelled: boolean
  /** The list of sessions is open: *send it to another session* was chosen. */
  choosing: boolean
  /** What the last `/sessions` read said, once the list has asked. */
  sessions: Sessions | null
  /** The Target the Pick went to, marked in the list. */
  chosen: NamedTarget | null
  /** A resolution the server refused, in its own words (spec §21). */
  refusal: string | null
  onTouch(): void
  onLeave(): void
  onSendElsewhere(): void
  onChoose(candidate: Candidate): void
}

export function ReportBackOffer(props: ReportBackOfferProps) {
  const { view, name, startedAt, cancelled, choosing, sessions, chosen, refusal } = props
  const { onTouch, onLeave, onSendElsewhere, onChoose } = props

  // Hovering, pressing or focusing anything in the offer is touching it. Read
  // off the element's own events, like the chip's hover, because a pointer
  // arriving from the page is retargeted at the host on its way in.
  const touch = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return
      const touched = () => onTouch()
      for (const type of ['pointerenter', 'pointerdown', 'focusin']) {
        node.addEventListener(type, touched)
      }
      return () => {
        for (const type of ['pointerenter', 'pointerdown', 'focusin']) {
          node.removeEventListener(type, touched)
        }
      }
    },
    [onTouch],
  )

  return (
    <div ref={touch} {...partProps('offer')}>
      <div {...partProps('chip-words')}>{words.neverPickedUp(name)}</div>
      <div {...partProps('offer-question')}>{words.SEND_OR_LEAVE}</div>
      <div {...partProps('offer-answers')}>
        <button type="button" {...partProps('offer-elsewhere')} onClick={onSendElsewhere}>
          {words.SEND_ELSEWHERE}
        </button>
        <button type="button" {...partProps('offer-leave')} onClick={onLeave}>
          {words.LEAVE_FOR_NEXT}
        </button>
      </div>
      {choosing && (
        <ChooseSession sessions={sessions} chosen={chosen} onChoose={onChoose} />
      )}
      {refusal && <div {...partProps('offer-refusal')}>{refusal}</div>}
      {!cancelled && <Countdown view={view} startedAt={startedAt} onZero={onLeave} />}
    </div>
  )
}

/**
 * Ticket 10's in-Panel list of sessions, opened inside the chip. The Target
 * that never picked it up is listed too, marked: a developer who has just
 * fixed that session may want it again.
 */
function ChooseSession({
  sessions,
  chosen,
  onChoose,
}: Pick<ReportBackOfferProps, 'sessions' | 'chosen' | 'onChoose'>) {
  if (sessions === null) return null
  if (sessions.hookFloor) {
    return <div {...partProps('offer-refusal')}>{words.CANT_SEE_SESSIONS}</div>
  }
  if (sessions.candidates.length === 0) {
    return <div {...partProps('offer-refusal')}>{words.NO_SESSION}</div>
  }
  return (
    <TargetChoices
      sessions={sessions}
      unreadable={null}
      chosen={chosen}
      expanded
      offer={null}
      onToggle={() => {}}
      onChoose={onChoose}
    />
  )
}

/**
 * The line. It carries two lengths: `--left`, the time actually left, and
 * `--next`, where it will be one second from now. Where the stylesheet eases
 * between steps it draws `--next`, so the line reaches empty at the moment the
 * time is up rather than one second after it. Where it does not ease it draws
 * `--left`, in whole steps, and never shows less time than there is. The
 * default fires on its own timer, at the exact moment, whatever the line.
 */
function Countdown({
  view,
  startedAt,
  onZero,
}: {
  view: Window
  startedAt: number
  onZero(): void
}) {
  const [now, setNow] = useState(() => Date.now())
  // The latest handler, read when the time is up: a re-render must not restart
  // the countdown, and the Stack hands a fresh handler on every poll.
  const zero = useRef(onZero)
  useEffect(() => {
    zero.current = onZero
  }, [onZero])

  useEffect(() => {
    const due = Math.max(0, startedAt + OFFER_MS - Date.now())
    const deadline = view.setTimeout(() => zero.current(), due)
    let step = 0
    const redraw = () => {
      setNow(Date.now())
      step = view.setTimeout(redraw, STEP_MS)
    }
    step = view.setTimeout(redraw, STEP_MS)
    return () => {
      view.clearTimeout(deadline)
      view.clearTimeout(step)
    }
  }, [view, startedAt])

  const left = leftAt(startedAt, now)
  const next = leftAt(startedAt, now + STEP_MS)
  return (
    <div
      {...partProps('countdown')}
      data-left={left.toFixed(3)}
      data-next={next.toFixed(3)}
      style={{ '--left': String(left), '--next': String(next) } as CSSProperties}
    />
  )
}

/** How much of the line is left at `at`, as a fraction of the whole. */
function leftAt(startedAt: number, at: number): number {
  return Math.max(0, startedAt + OFFER_MS - at) / OFFER_MS
}
