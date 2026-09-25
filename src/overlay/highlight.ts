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
// A box that is not shown is not in the page at all: `hide` takes it out of the
// layer it is drawn in and `show` puts it back. The Overlay has two of these
// (`marks.ts`), and a mark nobody can see has no business being found.
//
// The motion itself is declared in `styles.ts` and nowhere else.

import { viewportBox } from './deep-element.js'
import type { ViewportBox } from './deep-element.js'
import type { OwnerFacts } from './fiber.js'
import { part } from './root.js'

/** Room the chip needs above the box before it drops below it. */
const CHIP_CLEARANCE = 22

/**
 * How long a box that is fading out stays in the page before it is taken out.
 * Longer than the fade `styles.ts` declares, so the fade is always seen through.
 */
const FADED_AFTER_MS = 200

/**
 * Which of the Overlay's two marks a box is being, which decides what it paints
 * over (`styles.ts`). `current` is the open Pick's mark, or while armed the one
 * that will become it; `live` follows the pointer while Alt is held over an
 * open Panel.
 */
export type MarkRole = 'current' | 'live'

export interface Highlight {
  /** Draw the box on this element, with the chip those facts describe. */
  show(element: Element, owner: OwnerFacts): void
  /** Re-measure the element the box is already on, after a scroll or a resize. */
  remeasure(): void
  /** Take the box out of the page at once. */
  hide(): void
  /** Fade the box out where it stands, then take it out of the page. */
  fade(): void
  /**
   * Drop to the resting treatment — a thin outline, no fill, no chip — or come
   * back from it. The box stays on its element either way.
   */
  rest(resting: boolean): void
  /** Which mark this box is being now. */
  play(role: MarkRole): void
  /** True while the box is in the page and not fading out of it. */
  shown(): boolean
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

/** A Highlight drawn into `layer`, which is where it goes whenever it is shown. */
export function createHighlight(document: Document, layer: Element): Highlight {
  const box = part(document, 'div', 'highlight')
  const chip = part(document, 'div', 'chip')
  const name = part(document, 'span', 'chip-name')
  const file = part(document, 'span', 'chip-file')

  chip.append(name, file)
  box.append(chip)

  /** The element the box is on. */
  let on: Element | null = null
  /** Where it last measured — kept for a Pick whose element has gone. */
  let seen: ViewportBox | null = null
  /** True once that element has left the page. Cleared by the next `show`. */
  let gone = false
  /** True while the box is fading out, and until it has been taken out. */
  let fading = false
  /** The timer that takes a faded box out of the page. */
  let fadedAt = 0
  let toldGone: (() => void) | null = null
  let toldMoved: (() => void) | null = null

  let watchingMutations: MutationObserver | null = null
  let watchingSize: ResizeObserver | null = null
  /** The element those two are watching, so a re-hover rebuilds nothing. */
  let watched: Element | null = null
  /** The pending re-measure, so a burst of mutations costs one measurement. */
  let scheduled = 0

  const inPage = () => box.isConnected

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
    if (!on || gone || !inPage()) return
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

  /** Stop a fade that has not finished taking the box out. */
  const unfade = () => {
    fading = false
    document.defaultView?.clearTimeout(fadedAt)
    box.removeAttribute('data-fading')
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

    // A size observer reports every target once as it starts observing it,
    // whether or not anything changed. That report is not the page moving
    // anything: taken for one, it re-placed the box a frame into the morph that
    // brought it here and cancelled the morph. So each target's first report
    // is skipped, and only a later one is a change.
    const reported = new Set<Element>()
    watchingSize = new view.ResizeObserver((entries) => {
      let changed = false
      for (const { target } of entries) {
        if (reported.has(target)) changed = true
        else reported.add(target)
      }
      if (changed) schedule()
    })
    watchingSize.observe(element)
    watchingSize.observe(inside.documentElement)

    watchingMutations = new view.MutationObserver(schedule)
    watchingMutations.observe(inside, { childList: true, subtree: true })
  }

  const hide = () => {
    unfade()
    on = null
    seen = null
    gone = false
    unwatch()
    box.removeAttribute('data-gone')
    box.removeAttribute('data-resting')
    box.remove()
  }

  return {
    show(element, owner) {
      // A box already on another element travels to this one. Everything else —
      // a first appearance, the same element re-measured, a box that had faded
      // or was fading — is placed where it belongs with nothing running.
      const travelling = inPage() && !fading && !gone && on !== null && on !== element

      unfade()
      on = element
      gone = false
      box.removeAttribute('data-gone')
      // An element with no owner is still worth marking: a Pick is never refused
      // for want of a fiber (spec §4), so the chip falls back to the tag.
      name.textContent = owner.name ?? element.tagName.toLowerCase()
      file.textContent = owner.file ?? ''
      if (!inPage()) layer.append(box)
      place(element, !travelling)
      watch(element)
    },

    remeasure() {
      track()
    },

    hide,

    fade() {
      if (!inPage() || fading) return
      fading = true
      unwatch()
      box.setAttribute('data-fading', '')
      const view = document.defaultView
      if (view) fadedAt = view.setTimeout(hide, FADED_AFTER_MS)
      else hide()
    },

    rest(resting) {
      if (resting) box.setAttribute('data-resting', '')
      else box.removeAttribute('data-resting')
    },

    play(role) {
      box.setAttribute('data-mark', role)
    },

    shown() {
      return inPage() && !fading
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
