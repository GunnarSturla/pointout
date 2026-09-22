// The Highlight (spec §5): one outline plus a very-low-opacity fill on a single
// fixed box outside the host's layout flow, with the hover chip riding it.
//
// The chip carries component name and filename only. No line number: they are in
// transformed coordinates until the server remaps them, and a debounced answer
// landing after the cursor moved is the jump this design forbids.
//
// **It is anchored to the element, not to the viewport.** The box is drawn in
// fixed coordinates because it must sit outside the host's layout flow, so
// staying on the element is something this module does rather than something CSS
// does for it: it re-measures on scroll, on resize, and on whatever a hot update
// did to the page, and it notices when the element leaves the page altogether.
//
// Two rules govern when the box moves and when it merely appears:
//
//   - **Nothing travels on its first appearance.** A box that is appearing has
//     nowhere to travel *from*; left to itself it flies in from the last element
//     it was on, or from the page's corner. It is placed instantly instead, with
//     the `data-placing` attribute suppressing the morph for that one placement.
//   - **Tracking is not travelling.** A scroll, a resize or a hot update moves
//     the element under a box that is already on it, and a box that eased its
//     way after a scroll would lag behind the thing it marks. Only a change of
//     element — the morph, spec §5 — is animated, and only under
//     `prefers-reduced-motion: no-preference`.
//
// The motion itself is declared in `styles.ts` and nowhere else.

import { viewportBox } from './deep-element.js'
import type { ViewportBox } from './deep-element.js'
import type { OwnerFacts } from './fiber.js'
import { part } from './root.js'

/** Room the chip needs above the box before it drops below it. */
const CHIP_CLEARANCE = 22

export interface Highlight {
  /** Draw the box on this element, with the chip those facts describe. */
  show(element: Element, owner: OwnerFacts): void
  /** Re-measure the element the box is already on, after a scroll or a resize. */
  remeasure(): void
  hide(): void
  /**
   * Where the element the box is on last was. A Pick whose element has since
   * left the page carries this rather than the zeroes a detached element
   * measures (spec §21: nothing is silently wrong).
   */
  lastBox(): ViewportBox | null
  /**
   * Told when the element the box is on leaves the page. One listener, the
   * Overlay's: the Highlight fades where it stood, and the Panel is what says so
   * (spec §5, user story 25).
   */
  whenGone(listener: () => void): void
  /**
   * Told when the page itself moved the element — a hot update, a reflow the
   * page made on its own — as opposed to a scroll or resize the Overlay already
   * saw. The Overlay re-measures everything else anchored to the page on it.
   */
  whenMoved(listener: () => void): void
}

export function createHighlight(document: Document, shadow: ShadowRoot): Highlight {
  const box = part(document, 'div', 'highlight')
  const chip = part(document, 'div', 'chip')
  const name = part(document, 'span', 'chip-name')
  const file = part(document, 'span', 'chip-file')

  chip.append(name, file)
  box.append(chip)
  box.hidden = true
  shadow.append(box)

  /** The element the box is on. */
  let on: Element | null = null
  /** Where it last measured — kept for a Pick whose element has gone. */
  let seen: ViewportBox | null = null
  /** True once that element has left the page. Cleared by the next `show`. */
  let gone = false
  let toldGone: (() => void) | null = null
  let toldMoved: (() => void) | null = null

  let watchingMutations: MutationObserver | null = null
  let watchingSize: ResizeObserver | null = null
  /** The element those two are watching, so a re-hover rebuilds nothing. */
  let watched: Element | null = null
  /** The pending re-measure, so a burst of mutations costs one measurement. */
  let scheduled = 0

  const place = (element: Element, instant: boolean) => {
    // The box is fixed in the top document, and the element may be inside a
    // frame, so its own client rect is not where it is.
    const rect = viewportBox(element)
    seen = rect

    if (instant) box.setAttribute('data-placing', '')
    box.style.translate = `${rect.left}px ${rect.top}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
    if (rect.top < CHIP_CLEARANCE) chip.setAttribute('data-below', '')
    else chip.removeAttribute('data-below')
    if (!instant) return

    // Reading the layout back commits this placement before the box is allowed
    // to move again: the next change is then a move from here, and this one was
    // never a move at all. The value is not wanted; the read is.
    box.getBoundingClientRect()
    box.removeAttribute('data-placing')
  }

  /** Measure again, or notice that there is nothing left to measure. */
  const track = () => {
    if (!on || gone || box.hidden) return
    if (!on.isConnected) {
      leave()
      return
    }
    place(on, true)
  }

  const leave = () => {
    gone = true
    unwatch()
    box.setAttribute('data-gone', '')
    toldGone?.()
  }

  const schedule = () => {
    const view = document.defaultView
    if (!view || scheduled !== 0) return
    scheduled = view.requestAnimationFrame(() => {
      scheduled = 0
      track()
      toldMoved?.()
    })
  }

  const unwatch = () => {
    watchingMutations?.disconnect()
    watchingMutations = null
    watchingSize?.disconnect()
    watchingSize = null
    watched = null
  }

  /**
   * Watch the page the element is in, not the page the Overlay is drawn on: an
   * element inside a same-origin frame is moved by that frame's own reflows.
   *
   * Two observers, because they answer different questions. The size observer
   * catches the element's own box changing — the usual shape of a hot update.
   * The mutation observer catches everything that moves the element without
   * resizing it, and it is also how an unmount is noticed at all: nothing
   * announces a node that has been removed.
   */
  const watch = (element: Element) => {
    // Hovering while armed calls `show` on every pointer move, and most of those
    // are the same element again. Two observers torn down and rebuilt per move
    // would be the cost this watch exists to keep small.
    if (watched === element && watchingMutations) return
    unwatch()
    watched = element
    const inside = element.ownerDocument
    const view = inside.defaultView
    if (!view) return

    watchingSize = new view.ResizeObserver(schedule)
    watchingSize.observe(element)
    watchingSize.observe(inside.documentElement)

    watchingMutations = new view.MutationObserver(schedule)
    watchingMutations.observe(inside, { childList: true, subtree: true })
  }

  return {
    show(element, owner) {
      // A box already on another element travels to this one. Everything else —
      // a first appearance, the same element re-measured, a box that had faded
      // — is placed where it belongs with nothing running.
      const travelling = !box.hidden && !gone && on !== null && on !== element

      on = element
      gone = false
      box.removeAttribute('data-gone')
      // An element with no owner is still worth marking: a Pick is never refused
      // for want of a fiber (spec §4), so the chip falls back to the tag.
      name.textContent = owner.name ?? element.tagName.toLowerCase()
      file.textContent = owner.file ?? ''
      box.hidden = false
      place(element, !travelling)
      watch(element)
    },

    remeasure() {
      track()
    },

    hide() {
      on = null
      seen = null
      gone = false
      unwatch()
      box.removeAttribute('data-gone')
      box.hidden = true
    },

    lastBox() {
      return seen
    },

    whenGone(listener) {
      toldGone = listener
    },

    whenMoved(listener) {
      toldMoved = listener
    },
  }
}
