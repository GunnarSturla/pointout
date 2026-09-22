// The Picker (spec §8): the Overlay's persistent affordance, bottom-centre. It
// is there before any Pick exists and after the last one, which is what
// separates it from the Stack (`CONTEXT.md`).
//
// It **peeks** when idle: part of it sits below the bottom edge and the rest is
// visibly there, so it is found by looking rather than by discovering an
// invisible hitbox. It comes out on hover, on focus, and for as long as anything
// is unresolved — spec §8 forbids auto-hiding while a Pick is in flight, and
// tickets 27 and 14 add two more reasons to pull it out.
//
// How far it may tuck is bounded by its own hitbox: the tuck keeps the button's
// own centre inside the viewport, so the thing a developer aims at is the thing
// they hit. That is the same rule as "never a flush tuck behind an invisible
// hitbox", counted in pixels.
//
// The 220 ms reveal is the one piece of motion ticket 12 carries, and it lives
// where every other piece will: inside `prefers-reduced-motion: no-preference`.
// Under reduce there is no declaration at all, so the reveal is instant.

import { part } from './root.js'

/** Spec §8: the Picker arms the selection, and says so. */
const PICK = 'Pick'

/**
 * The way back to a Panel that has ridden off-screen with its element (spec §7,
 * story 16). The Panel keeps focus the whole time; this is how the developer
 * gets their eyes back to it, and it is on the Picker because the Picker is the
 * one surface that is always where they left it.
 */
const BACK = 'Back to your pick'

export interface PickerHandlers {
  /** The Picker is a toggle: off arms, armed disarms. */
  toggle(): void
  /** Bring the open Panel, and the element it is anchored to, back into view. */
  back(): void
}

export interface Picker {
  setArmed(armed: boolean): void
  /** Hold it out of its tuck. Anything unresolved holds it out (spec §8). */
  hold(held: boolean): void
  offerWayBack(offer: boolean): void
}

export function createPicker(
  document: Document,
  shadow: ShadowRoot,
  handlers: PickerHandlers,
): Picker {
  const peek = part(document, 'div', 'picker-peek')
  const button = part(document, 'button', 'picker')
  button.type = 'button'
  button.textContent = PICK

  const back = part(document, 'button', 'picker-back')
  back.type = 'button'
  back.textContent = BACK

  peek.append(button)
  shadow.append(peek)

  button.addEventListener('click', (event: MouseEvent) => {
    event.stopPropagation()
    handlers.toggle()
  })
  back.addEventListener('click', (event: MouseEvent) => {
    event.stopPropagation()
    handlers.back()
  })

  return {
    setArmed(armed) {
      if (armed) button.setAttribute('data-armed', '')
      else button.removeAttribute('data-armed')
    },

    hold(held) {
      if (held) peek.setAttribute('data-out', '')
      else peek.removeAttribute('data-out')
    },

    offerWayBack(offer) {
      if (offer && !back.isConnected) peek.prepend(back)
      else if (!offer) back.remove()
    },
  }
}
