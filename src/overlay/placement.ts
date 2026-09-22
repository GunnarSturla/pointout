// Where the Panel goes (spec §7): below the element at its start edge, above it
// when there is more room there, and never partly off-screen when it opens.
// After that it rides with its element — the offset it opened at is kept and
// only the element is measured again — so a scroll takes the Panel off-screen
// with the thing it is about rather than pinning it to an edge, and the way
// back is the element's, not the Panel's.
//
// Arithmetic only. The Panel sits in a fixed host at inset zero, so viewport
// coordinates are the whole story and nothing here needs an offset parent.

import type { ViewportBox } from './deep-element.js'

/** Spec §7: the gap to the element, and the least the viewport keeps around the Panel. */
export const ELEMENT_GAP = 8
export const VIEWPORT_PADDING = 8

export interface Size {
  width: number
  height: number
}

export interface Position {
  left: number
  top: number
}

/**
 * Open placement: beside the anchor, flipped above when below has no room and
 * above has more, and shifted whole into the viewport.
 */
export function placeBeside(anchor: ViewportBox, panel: Size, viewport: Size): Position {
  const below = anchor.top + anchor.height + ELEMENT_GAP
  const above = anchor.top - ELEMENT_GAP - panel.height
  const overflowBelow = below + panel.height - (viewport.height - VIEWPORT_PADDING)
  const overflowAbove = VIEWPORT_PADDING - above

  let top = below
  if (overflowBelow > 0) top = overflowAbove < overflowBelow ? above : below

  return {
    left: clamp(
      anchor.left,
      VIEWPORT_PADDING,
      viewport.width - panel.width - VIEWPORT_PADDING,
    ),
    top: clamp(top, VIEWPORT_PADDING, viewport.height - panel.height - VIEWPORT_PADDING),
  }
}

/** Where the Panel sits relative to its anchor: what riding keeps constant. */
export function offsetFrom(anchor: ViewportBox, position: Position): Position {
  return { left: position.left - anchor.left, top: position.top - anchor.top }
}

/** Riding: the anchor moved, and the Panel keeps the offset it opened at. */
export function ride(anchor: ViewportBox, offset: Position): Position {
  return { left: anchor.left + offset.left, top: anchor.top + offset.top }
}

/** Whether any of a box is inside the viewport. */
export function inViewport(box: ViewportBox, viewport: Size): boolean {
  return (
    box.top + box.height > 0 &&
    box.top < viewport.height &&
    box.left + box.width > 0 &&
    box.left < viewport.width
  )
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high))
}
