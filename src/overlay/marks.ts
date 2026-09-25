// The Overlay's two Highlights (spec §5, §7): the one that is the Pick, and a
// second, live one that shows what an Alt-click would pick while a Panel is
// open.
//
// While armed there is one mark, and it follows the pointer; the click that
// makes a Pick freezes it where it is. With a Panel open and Alt held, a second
// mark follows the pointer instead — fill, chip and morph, the whole live
// treatment — and the Pick's own drops to the resting one, so the page shows
// both what is picked and what is about to be. Letting go of Alt fades the
// live mark where it stands and relights the Pick's. An Alt-click hands the
// Pick to the live mark as it stands, and it is the old one that fades: the
// box on the new element never moves or blinks.
//
// So the two boxes trade roles, and each says which one it is playing
// (`data-mark`); `styles.ts` paints the live mark over the current one and the
// current one over the Stack's resting marks, whichever box is which.

import type { ViewportBox } from './deep-element.js'
import type { OwnerFacts } from './fiber.js'
import { createHighlight } from './highlight.js'
import type { Highlight } from './highlight.js'

export interface Marks {
  /** Put the current mark on this element: the armed hover, or a new Pick. */
  show(element: Element, owner: OwnerFacts): void
  /** Take both marks off the page at once. */
  hide(): void
  /** Alt is held over an open Panel: the live mark goes here, the current one rests. */
  preview(element: Element, owner: OwnerFacts): void
  /** Alt is let go: the live mark fades, and the current one relights. */
  release(): void
  /**
   * Alt-click: the live mark becomes the current one on this element, lit, and
   * the mark it replaces fades where it stood.
   */
  promote(element: Element, owner: OwnerFacts): void
  /** Re-measure both, after a scroll or a resize. */
  remeasure(): void
  /** Where the current mark's element last was (see `Highlight.lastBox`). */
  lastBox(): ViewportBox | null
  /** Told when the current mark's element leaves the page. */
  whenGone(listener: () => void): void
  /** Told when the page itself moved either mark's element. */
  whenMoved(listener: () => void): void
}

export function createMarks(document: Document, layer: Element): Marks {
  let current: Highlight = createHighlight(document, layer)
  let live: Highlight = createHighlight(document, layer)
  current.play('current')
  live.play('live')

  let toldGone: (() => void) | null = null
  let toldMoved: (() => void) | null = null
  for (const mark of [current, live]) {
    // Either box can be the current one by the time its element goes.
    mark.whenGone(() => {
      if (mark === current) toldGone?.()
    })
    mark.whenMoved(() => toldMoved?.())
  }

  return {
    show(element, owner) {
      current.rest(false)
      current.show(element, owner)
    },

    hide() {
      current.hide()
      live.hide()
    },

    preview(element, owner) {
      current.rest(true)
      // The live box may be the one an Alt-click just left behind, still
      // wearing the resting treatment it had as the Pick's mark.
      live.rest(false)
      live.show(element, owner)
    },

    release() {
      if (!live.shown()) return
      live.fade()
      current.rest(false)
    },

    promote(element, owner) {
      live.show(element, owner)
      live.rest(false)
      ;[current, live] = [live, current]
      current.play('current')
      live.play('live')
      live.fade()
    },

    remeasure() {
      current.remeasure()
      live.remeasure()
    },

    lastBox() {
      return current.lastBox()
    },

    whenGone(listener) {
      toldGone = listener
    },

    whenMoved(listener) {
      toldMoved = listener
    },
  }
}
