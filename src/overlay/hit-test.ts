// The hit test — first rule only (spec §4). The remaining rules (piercing open
// shadow roots, descending into same-origin iframes, collapsing to the nearest
// `<svg>`) and the armed `pointer-events` forcing are ticket 08.
//
// The one rule here is written as the general rule it is: **ignore any fixed,
// full-viewport element**. That covers the Overlay's own host, a scrim the app
// draws, and another tool's canvas as one rule rather than three. The Overlay's
// own surfaces collapse to the host under `elementsFromPoint`, which does not
// pierce a shadow root, so the same rule is what keeps the Picker and the Panel
// out of their own hit test.

/** A box within this many pixels of the viewport's edge counts as reaching it. */
const EDGE_TOLERANCE = 1

/** The element under a point that a Pick may be made of, or null. */
export function elementAtPoint(document: Document, x: number, y: number): Element | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (coversViewport(element)) continue
    return element
  }
  return null
}

/** Fixed, and reaching every edge of the viewport. */
function coversViewport(element: Element): boolean {
  const view = element.ownerDocument.defaultView
  if (!view) return false
  if (view.getComputedStyle(element).position !== 'fixed') return false

  const box = element.getBoundingClientRect()
  return (
    box.left <= EDGE_TOLERANCE &&
    box.top <= EDGE_TOLERANCE &&
    box.right >= view.innerWidth - EDGE_TOLERANCE &&
    box.bottom >= view.innerHeight - EDGE_TOLERANCE
  )
}
