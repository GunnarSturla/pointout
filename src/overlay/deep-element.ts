// Borrowed: the deep element-at-point descent — pierce an open shadow root,
//           then step into a same-origin frame with the point converted into
//           that frame's own coordinates — and the walk back out that returns a
//           point inside a frame to the top document's coordinates
// From: react-grab — https://github.com/aidenybai/react-grab
// Version: 0.2.0 (2026-09-22)
// License: MIT — full text in LICENSE-THIRDPARTY
// Changes: the descent starts at an element the caller has already chosen,
//   because this repository's fixed-full-viewport rule runs first and upstream's
//   `elementFromPoint` entry would undo it; the recursion is a loop carrying the
//   converted point, which is the same walk written the other way up; piercing
//   reads the shadow root's whole stack rather than its topmost element, because
//   `elementFromPoint` on a shadow root hit-tests the *document* and retargets,
//   so anything drawn above the host — a scrim, another devtool's canvas — comes
//   back instead of what is inside it. Upstream's position, geometry and
//   cross-origin caches were not taken, so every call measures; neither were its
//   visibility, own-overlay and caret-bounds passes: the rules here are spec
//   §4's four and no more.

/** Tag names are compared in the HTML namespace, which an SVG `<iframe>` is not. */
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

/** A point, in the coordinates of whichever document it was measured in. */
interface Point {
  x: number
  y: number
}

function isFrame(element: Element): element is HTMLIFrameElement {
  return element.namespaceURI === HTML_NAMESPACE && element.localName === 'iframe'
}

/** A frame's document, or null when the frame will not be read. */
function frameDocument(frame: HTMLIFrameElement): Document | null {
  try {
    return frame.contentDocument
  } catch {
    // A cross-origin frame throws rather than answering, and a Pick of it is a
    // Pick of the `<iframe>` element itself.
    return null
  }
}

/** The frame element a window is inside, or null when it is a top window. */
function frameOf(view: Window): Element | null {
  try {
    return view.frameElement
  } catch {
    return null
  }
}

function px(value: string): number {
  const measured = Number.parseFloat(value)
  return Number.isFinite(measured) ? measured : 0
}

/** Where a frame's content starts inside its border box, and its laid-out size. */
interface FrameBox {
  offsetX: number
  offsetY: number
  width: number
  height: number
}

function frameBox(frame: Element): FrameBox {
  const style = frame.ownerDocument.defaultView?.getComputedStyle(frame)
  const box = frame as HTMLElement
  if (!style) {
    return {
      offsetX: frame.clientLeft,
      offsetY: frame.clientTop,
      width: box.offsetWidth,
      height: box.offsetHeight,
    }
  }

  const borderX = px(style.borderLeftWidth) + px(style.borderRightWidth)
  const borderY = px(style.borderTopWidth) + px(style.borderBottomWidth)
  const padX = px(style.paddingLeft) + px(style.paddingRight)
  const padY = px(style.paddingTop) + px(style.paddingBottom)
  const inBorderBox = style.boxSizing === 'border-box'
  const width = inBorderBox ? px(style.width) : px(style.width) + borderX + padX
  const height = inBorderBox ? px(style.height) : px(style.height) + borderY + padY

  return {
    offsetX: px(style.borderLeftWidth) + px(style.paddingLeft),
    offsetY: px(style.borderTopWidth) + px(style.paddingTop),
    width: width > 0 ? width : box.offsetWidth,
    height: height > 0 ? height : box.offsetHeight,
  }
}

/**
 * The element of *this* shadow tree at a point, or null when the point reaches
 * nothing inside it. The whole stack is read and everything outside the tree
 * dropped, because a shadow root's own `elementFromPoint` hit-tests the document
 * and retargets: the answer is whatever is topmost at the point, which above a
 * scrim is the scrim and not what the root holds.
 */
function pierce(root: ShadowRoot, x: number, y: number): Element | null {
  for (const element of root.elementsFromPoint(x, y)) {
    if (element.getRootNode() === root) return element
  }
  return null
}

/** How much larger a frame is drawn than it was laid out — a transform, or 1. */
function scaleOf(drawn: number, laid: number): number {
  return laid > 0 ? drawn / laid : 1
}

/** A point in the document a frame sits in, expressed in the frame's own. */
function pointInFrame(frame: Element, x: number, y: number): Point {
  const rect = frame.getBoundingClientRect()
  const box = frameBox(frame)
  return {
    x: (x - rect.left) / scaleOf(rect.width, box.width) - box.offsetX,
    y: (y - rect.top) / scaleOf(rect.height, box.height) - box.offsetY,
  }
}

/**
 * The deepest element at a point below the one the caller chose: through every
 * open shadow root, and into every same-origin frame. A frame that will not be
 * read is itself the answer.
 */
export function deepElementFrom(
  start: Element | null,
  x: number,
  y: number,
): Element | null {
  let found = start
  let atX = x
  let atY = y

  while (found) {
    const root = found.shadowRoot
    const pierced = root ? pierce(root, atX, atY) : null
    if (pierced && pierced !== found) {
      found = pierced
      continue
    }

    if (!isFrame(found)) return found
    const inside = frameDocument(found)
    if (!inside) return found

    const at = pointInFrame(found, atX, atY)
    const deeper = inside.elementFromPoint(at.x, at.y)
    if (!deeper) return found
    atX = at.x
    atY = at.y
    found = deeper
  }

  return null
}

/** A point in a window's own coordinates, put back into the top document's. */
function toTopDocumentPoint(
  view: Window,
  x: number,
  y: number,
): { x: number; y: number; scaleX: number; scaleY: number } {
  let atX = x
  let atY = y
  let scaleX = 1
  let scaleY = 1
  let inside: Window | null = view

  while (inside) {
    const frame = frameOf(inside)
    if (!frame || !isFrame(frame)) break

    const rect = frame.getBoundingClientRect()
    const box = frameBox(frame)
    const frameScaleX = scaleOf(rect.width, box.width)
    const frameScaleY = scaleOf(rect.height, box.height)

    atX = rect.left + (box.offsetX + atX) * frameScaleX
    atY = rect.top + (box.offsetY + atY) * frameScaleY
    scaleX *= frameScaleX
    scaleY *= frameScaleY
    inside = frame.ownerDocument.defaultView
  }

  return { x: atX, y: atY, scaleX, scaleY }
}

// --- end of borrowed code ---

/** An element's box, in the coordinates of the page the Overlay is drawn on. */
export interface ViewportBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where an element is, seen from the top document. For an element of the page
 * itself this is its own client rect; for one inside a frame it is that rect
 * walked back out through every frame above it, which is what keeps the
 * Highlight on the element rather than on the frame's top-left corner.
 */
export function viewportBox(element: Element): ViewportBox {
  const rect = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView
  if (!view)
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }

  const at = toTopDocumentPoint(view, rect.left, rect.top)
  return {
    left: at.x,
    top: at.y,
    width: rect.width * at.scaleX,
    height: rect.height * at.scaleY,
  }
}
