// The Picker (spec §8): the Overlay's persistent affordance, bottom-centre. It
// is there before any Pick exists and after the last one, which is what
// separates it from the Stack (`CONTEXT.md`).
//
// It **peeks** when idle: part of it sits below the bottom edge and the rest is
// visibly there, so it is found by looking rather than by discovering an
// invisible hitbox. It comes out on hover, on focus, and for as long as anything
// is unresolved — spec §8 forbids auto-hiding while a Pick is in flight.
//
// How far it may tuck is bounded by its own hitbox: the tuck keeps the button's
// own centre inside the viewport, so the thing a developer aims at is the thing
// they hit. That is the same rule as "never a flush tuck behind an invisible
// hitbox", counted in pixels. How it comes out is the stylesheet's business
// (`styles.ts`), and so is everything else it does with its shape.
//
// Armed, it says so in words and in colour: **Picking…** on the one solid blue
// control in the Overlay. The label is written as "Pick" and a tail, "ing…",
// that is always there and is zero wide until the Picker is armed; `styles.ts`
// says why. The two parts are separate boxes, which an accessible name would
// read as two words, so the button is named outright with the word on show.
//
// "Back to your pick" hangs off the Picker's right edge rather than sitting
// beside it in the row, so appearing never pushes the Picker off centre.

import { memo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { CrosshairIcon } from './icons.js'
import { partProps } from './root.js'

/** Spec §8: the Picker arms the selection, and says so. */
const PICK = 'Pick'

/** What turns "Pick" into "Picking…" while armed. */
const PICKING_TAIL = 'ing…'

/** The Picker's word while armed: it is picking now, and a click stops it. */
const PICKING = `${PICK}${PICKING_TAIL}`

/**
 * The way back to a Panel that has ridden off-screen with its element (spec §7,
 * story 16). The Panel keeps focus the whole time; this is how the developer
 * gets their eyes back to it, and it is on the Picker because the Picker is the
 * one surface that is always where they left it.
 */
const BACK = 'Back to your pick'

export interface PickerProps {
  armed: boolean
  /** Held out of its tuck. Anything unresolved holds it out (spec §8). */
  held: boolean
  /** Offer the way back to the open Panel, which has ridden off-screen. */
  wayBack: boolean
  /** The Picker is a toggle: off arms, armed disarms. */
  onToggle(): void
  /** Bring the open Panel, and the element it is anchored to, back into view. */
  onBack(): void
}

export const Picker = memo(function Picker({
  armed,
  held,
  wayBack,
  onToggle,
  onBack,
}: PickerProps) {
  return (
    <div {...partProps('picker-peek')} data-out={held ? '' : undefined}>
      <div className="picker-anchor">
        <button
          type="button"
          {...partProps('picker')}
          data-armed={armed ? '' : undefined}
          aria-label={armed ? PICKING : PICK}
          onClick={then(onToggle)}
        >
          <CrosshairIcon />
          <span className="picker-label">
            {PICK}
            <span {...partProps('picker-tail')}>{PICKING_TAIL}</span>
          </span>
        </button>
        {wayBack && (
          <button type="button" {...partProps('picker-back')} onClick={then(onBack)}>
            {BACK}
          </button>
        )}
      </div>
    </div>
  )
})

/** The Overlay's own clicks are its own: the page never sees one. */
function then(handler: () => void) {
  return (event: ReactMouseEvent) => {
    event.stopPropagation()
    handler()
  }
}
