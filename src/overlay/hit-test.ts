// The hit test (spec §4): four rules, applied in order, that turn a point into
// the element the developer meant — and one refusal ahead of them all.
//
//   0. a point on a Host's own dev tools is no point on the page. Next.js draws
//      its indicator and its error overlay in a `nextjs-portal`, and those are
//      treated as the Overlay's own chrome is: nothing there is highlighted or
//      picked, and nothing beneath it either (ticket 06 of the Next.js
//      Connector). They are not full-viewport, so rule 1 does not reach them.
//
//   1. ignore any fixed, full-viewport element. Written as the general rule it
//      is, so the Overlay's own host, the shield it lays over a dense page, a
//      scrim the app draws and another devtool's canvas are one rule and not
//      four. `elementsFromPoint` does not pierce a shadow root, so every surface
//      the Overlay draws collapses to that host and needs no exemption.
//   2. pierce open shadow roots, to the element React rendered inside one;
//   3. descend into same-origin frames (both from `deep-element.ts`);
//   4. collapse anything inside an `<svg>` to the nearest `<svg>` ancestor,
//      because a developer who clicked an icon means the icon, not the third
//      `<path>` of its artwork.
//
// No manual widening — stepping out to the parent — in v0.

import { deepElementFrom } from './deep-element.js'

/** A box within this many pixels of the viewport's edge counts as reaching it. */
const EDGE_TOLERANCE = 1

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/** The tags a Host draws its own dev tools under, each in a shadow root. */
const HOST_TOOL_TAGS = ['nextjs-portal']

/** The element under a point that a Pick may be made of, or null. */
export function elementAtPoint(document: Document, x: number, y: number): Element | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (isHostTool(element)) return null
    if (coversViewport(element)) continue
    const deep = deepElementFrom(element, x, y)
    if (deep) return nearestSvg(deep)
  }
  return null
}

/**
 * A Host's dev tools, or inside them. True of any event whose path runs
 * through one, too: the Overlay leaves a click there to the tool.
 */
export function isHostTool(node: EventTarget): boolean {
  return node instanceof Element && HOST_TOOL_TAGS.includes(node.localName)
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

/**
 * The `<svg>` an element is drawn inside, or the element itself. Only SVG
 * content collapses: HTML inside a `<foreignObject>` is a real element of the
 * page and a developer pointing at it means it.
 */
function nearestSvg(element: Element): Element {
  if (element.namespaceURI !== SVG_NAMESPACE) return element
  if (element.localName === 'svg') return element
  return element.closest('svg') ?? element
}
