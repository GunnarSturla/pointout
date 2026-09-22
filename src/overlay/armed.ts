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
 */
export interface Hittability {
  arm(): void
  disarm(): void
  /** True when an event landed on the shield rather than on the Overlay itself. */
  onShield(path: EventTarget[]): boolean
}

export function createHittability(document: Document, shadow: ShadowRoot): Hittability {
  const sheet = document.createElement('style')
  sheet.textContent = ARMED_STYLESHEET
  document.head.append(sheet)

  let shield: HTMLElement | null = null

  return {
    arm() {
      if (document.getElementsByTagName('*').length <= SHIELD_ABOVE_NODES) {
        document.documentElement.setAttribute(ARMED_ATTRIBUTE, '')
        return
      }
      // Prepended, so every surface the Overlay draws stays above it and the
      // Picker can still be clicked to disarm. The hit test skips it under the
      // same rule that skips the host, because that is what it is a part of.
      shield ??= part(document, 'div', 'shield')
      shadow.prepend(shield)
    },

    disarm() {
      document.documentElement.removeAttribute(ARMED_ATTRIBUTE)
      shield?.remove()
    },

    onShield(path) {
      return shield !== null && path.includes(shield)
    },
  }
}
