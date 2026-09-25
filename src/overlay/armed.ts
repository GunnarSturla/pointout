// Borrowed: the armed `pointer-events` rule — one attribute on a root element
//           enabling one `*` rule that forces every element in the document
//           hittable for as long as the picker is armed
// From: click-to-react-component — https://github.com/ericclemmons/click-to-component
// Version: 1.1.3 (2026-09-22)
// License: MIT — full text in LICENSE-THIRDPARTY
// Changes: the attribute is this package's own and sits on the document element
//   rather than on `<body>`, so a framework that replaces the body does not take
//   the rule with it; the rule gained the exemption spec §4 asks for, which
//   upstream needs none of because it draws no host of its own. Upstream's
//   second rule — the one that outlines and re-cursors the hovered element — was
//   not taken: the Highlight is this repository's.

import { viewportBox } from './deep-element.js'
import type { Frames } from './frames.js'
import { HOST_TAG, part } from './root.js'

/** The attribute that enables the rule. Set while armed, removed the moment not. */
const ARMED_ATTRIBUTE = 'data-vite-agent-inspect-armed'

/** Installed once in the host document's head; inert until the attribute is set. */
const ARMED_STYLESHEET = `
[${ARMED_ATTRIBUTE}] * { pointer-events: auto !important }
[${ARMED_ATTRIBUTE}] ${HOST_TAG} { pointer-events: none !important }
`

// --- end of borrowed code ---

/**
 * The node count above which the rule above is not used at all. `pointer-events`
 * is inherited, so forcing it on `*` restyles every element in the document:
 * react-grab profiled that at roughly 4 ms on 5,600 elements and 30 to 35 ms on
 * 16,000. A frame's budget is about 16 ms, so the escalation belongs between the
 * two rather than at either end.
 */
const SHIELD_ABOVE_NODES = 6000

/**
 * Making the page hittable while the Overlay is armed, by whichever of the two
 * routes the page's size allows (spec §4).
 *
 * Which route is taken is measured **once, when the Overlay arms**. A count per
 * hover would be the very cost this rule exists to avoid, and a route that
 * changed halfway through a gesture would make the same point answer two
 * different elements.
 *
 * Either route also lays a frame shield over each frame the Overlay cannot hear
 * (`frames.ts`), unless the shield already covers everything: a pointer over
 * that frame would otherwise be in a document where nothing the Overlay listens
 * with runs, and nothing would be highlighted or picked. With a frame shield on
 * top, the pointer stays in the top document and the hit test descends into the
 * frame from there. It covers the frame and nothing else, so everywhere else
 * the page is hit-tested exactly as it is without one.
 */
export interface Hittability {
  arm(): void
  disarm(): void
  /**
   * Lay the frame shields without arming: Alt is held over an open Panel, and
   * the live mark has to follow the pointer over a frame too.
   */
  cover(): void
  /** Take the frame shields up again, and leave the rest as it is. */
  uncover(): void
  /** Put the frame shields back over their frames, after a scroll or a resize. */
  remeasure(): void
  /**
   * True when an event landed on the shield or a frame shield rather than on
   * the Overlay itself.
   */
  onShield(path: EventTarget[]): boolean
}

export function createHittability(
  document: Document,
  shadow: ShadowRoot,
  frames: Frames,
): Hittability {
  const sheet = document.createElement('style')
  sheet.textContent = ARMED_STYLESHEET
  document.head.append(sheet)

  let shield: HTMLElement | null = null
  /** Whether frame shields are wanted: armed, or Alt held over an open Panel. */
  let covering = false
  /** Each unheard frame's shield, while one is laid over it. */
  const frameShields = new Map<Element, HTMLElement>()

  // Prepended, so every surface the Overlay draws stays above them and the
  // Picker can still be clicked to disarm. The hit test skips them under the
  // same rule that skips the host, because that is what they are a part of.
  const raiseShield = () => {
    shield ??= part(document, 'div', 'shield')
    shadow.prepend(shield)
  }

  const place = (frame: Element, over: HTMLElement) => {
    const box = viewportBox(frame)
    over.style.translate = `${box.left}px ${box.top}px`
    over.style.width = `${box.width}px`
    over.style.height = `${box.height}px`
  }

  const cover = () => {
    covering = true
    if (shield?.isConnected) return
    for (const frame of frames.unheard()) {
      let over = frameShields.get(frame)
      if (!over) {
        over = part(document, 'div', 'frame-shield')
        frameShields.set(frame, over)
        shadow.prepend(over)
      }
      place(frame, over)
    }
  }

  // A frame that cannot be heard, arriving while the shields are wanted, is
  // covered as it arrives: nothing over it would be heard until it was.
  frames.whenUnheard(() => {
    if (covering) cover()
  })

  const uncover = () => {
    covering = false
    for (const over of frameShields.values()) over.remove()
    frameShields.clear()
  }

  return {
    arm() {
      if (document.getElementsByTagName('*').length > SHIELD_ABOVE_NODES) raiseShield()
      else document.documentElement.setAttribute(ARMED_ATTRIBUTE, '')
      cover()
    },

    cover,

    remeasure() {
      for (const [frame, over] of frameShields) {
        if (frame.isConnected) place(frame, over)
        else {
          over.remove()
          frameShields.delete(frame)
        }
      }
    },

    uncover,

    disarm() {
      document.documentElement.removeAttribute(ARMED_ATTRIBUTE)
      shield?.remove()
      uncover()
    },

    onShield(path) {
      if (shield !== null && path.includes(shield)) return true
      for (const over of frameShields.values()) if (path.includes(over)) return true
      return false
    },
  }
}
