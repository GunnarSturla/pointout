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
// hitbox", counted in pixels. The 220 ms reveal lives in `styles.ts`, inside the
// one `prefers-reduced-motion: no-preference` block; under reduce it is instant.

import { memo } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { partProps } from './root.js'

/** Spec §8: the Picker arms the selection, and says so. */
const PICK = 'Pick'

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
      {wayBack && (
        <button type="button" {...partProps('picker-back')} onClick={then(onBack)}>
          {BACK}
        </button>
      )}
      <button
        type="button"
        {...partProps('picker')}
        data-armed={armed ? '' : undefined}
        onClick={then(onToggle)}
      >
        {PICK}
      </button>
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
