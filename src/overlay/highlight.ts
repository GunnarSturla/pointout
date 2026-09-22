// The Highlight (spec §5): one outline plus a very-low-opacity fill on a single
// fixed box outside the host's layout flow, with the hover chip riding it.
//
// The chip carries component name and filename only. No line number: they are in
// transformed coordinates until the server remaps them, and a debounced answer
// landing after the cursor moved is the jump this design forbids.
//
// Placed instantly, every time. Nothing here declares any motion; the frozen and
// resting treatments and the lifecycle are ticket 09.

import { part } from './root.js'
import type { OwnerFacts } from './fiber.js'

/** Room the chip needs above the box before it drops below it. */
const CHIP_CLEARANCE = 22

export interface Highlight {
  /** Draw the box on this element, with the chip those facts describe. */
  show(element: Element, owner: OwnerFacts): void
  /** Re-measure the element the box is already on, after a scroll or a resize. */
  remeasure(): void
  hide(): void
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

  let on: Element | null = null

  const place = (element: Element) => {
    const rect = element.getBoundingClientRect()
    box.style.left = `${rect.left}px`
    box.style.top = `${rect.top}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
    if (rect.top < CHIP_CLEARANCE) chip.setAttribute('data-below', '')
    else chip.removeAttribute('data-below')
  }

  return {
    show(element, owner) {
      on = element
      // An element with no owner is still worth marking: a Pick is never refused
      // for want of a fiber (spec §4), so the chip falls back to the tag.
      name.textContent = owner.name ?? element.tagName.toLowerCase()
      file.textContent = owner.file ?? ''
      place(element)
      box.hidden = false
    },

    remeasure() {
      if (on && !box.hidden) place(on)
    },

    hide() {
      on = null
      box.hidden = true
    },
  }
}
