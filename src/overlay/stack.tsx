// The Stack (spec §8, §17): where submitted Picks rest while their fate is
// unsettled. Bottom-right, one chip per submitted Pick, no cap — and gone
// entirely the moment nothing is outstanding, which is the whole of what
// separates it from the Picker (`CONTEXT.md`).
//
// Each chip says only what is known about *its own* Pick. The states come from
// `/__agent/status`, which carries Pick-specific evidence; the Target's live
// status never reaches this module, so §17's rule — session-level evidence
// colours the Target row and never moves a chip — holds by construction.
//
// A chip owns the resting Highlight of its Pick as well as its words: the two
// are one thing to the developer, and hovering the chip is what re-lights the
// box.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DONE, FAILED, HELD, QUEUED_UNADDRESSED, SENT, WORKING } from '../wire.js'
import type { PickState } from '../wire.js'
import { readStatus } from './client.js'
import { viewportBox } from './deep-element.js'
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
const UNACKNOWLEDGED: readonly string[] = [SENT, QUEUED_UNADDRESSED]

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
}

/** What the last poll said about one Pick. */
interface Told {
  state: PickState
  reason: string | null
  name: string | null
}

export const Stack = memo(function Stack({ view, reflow, picks, onDismiss }: StackProps) {
  const [told, setTold] = useState<ReadonlyMap<string, Told>>(() => new Map())
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
          next.set(status.pickId, {
            state: status.state,
            reason: status.reason,
            name: status.target?.name ?? null,
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

  if (picks.length === 0) return null

  // Sent is what is known the moment the server accepted a Pick; the first poll
  // is what tells an addressed Pick from one the hook floor will carry.
  const chips = picks.map((pick) => {
    const heard = told.get(pick.pickId)
    return {
      pick,
      state: heard?.state ?? SENT,
      reason: heard?.reason ?? null,
      name: heard?.name ?? pick.targetName ?? '',
    }
  })
  // One Pick says everything about itself on its own chip; the summary exists
  // for the case story 49 names, which is several Picks in flight — and it
  // counts them, attributing nothing to any one (spec §17).
  const unacknowledged = chips.filter((chip) =>
    UNACKNOWLEDGED.includes(chip.state),
  ).length

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
        {chips.map(({ pick, state, reason, name }) => (
          <Chip
            key={pick.pickId}
            pickId={pick.pickId}
            state={state}
            {...say(state, reason, name)}
            onHover={setLit}
          />
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
}: {
  pickId: string
  state: string
  text: string
  next: string | null
  onHover(pickId: string | null): void
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

  return (
    <div ref={hover} {...partProps('stack-chip')} data-pick={pickId} data-state={state}>
      <div {...partProps('chip-words')}>{text}</div>
      {next && <div {...partProps('chip-next')}>{next}</div>}
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
