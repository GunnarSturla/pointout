// The Overlay's controller: arm, hover, pick, write, send (spec §3, §4, §7).
//
// Three states and no more. `Escape` unwinds one level — picked → armed → off —
// which is the rule the prototype settled on and the one thing about the gesture
// that is invisible from it.
//
// Ticket 08 adds the rest of the hit-test rules and the armed `pointer-events`
// forcing; ticket 09 the Highlight lifecycle and the opt-in to motion; ticket 10
// the Target row; ticket 12 the Picker's peek and the Stack.

import { createHittability } from './armed.js'
import { viewportBox } from './deep-element.js'
import { describeElement } from './describe.js'
import { readOwner, readOwnerChain } from './fiber.js'
import { createHighlight } from './highlight.js'
import { elementAtPoint } from './hit-test.js'
import { openPanel } from './panel.js'
import type { Panel } from './panel.js'
import { mountOverlayRoot, part } from './root.js'
import type { PickBody } from './client.js'

/** What arms the Overlay. Alt is held; the Picker is a toggle. */
type ArmedBy = 'alt' | 'picker'
type Mode = 'off' | 'armed' | 'picked'

export interface OverlayHandle {
  host: HTMLElement
  shadow: ShadowRoot
}

export function startOverlay(document: Document): OverlayHandle {
  const view = document.defaultView
  if (!view) throw new Error('vite-agent-inspect: the Overlay needs a window')

  const { host, shadow } = mountOverlayRoot(document)
  const highlight = createHighlight(document, shadow)
  const hittability = createHittability(document, shadow)

  const picker = part(document, 'button', 'picker')
  picker.type = 'button'
  picker.textContent = 'Pick'
  shadow.append(picker)

  let mode: Mode = 'off'
  let armedBy: ArmedBy | null = null
  let hovered: Element | null = null
  let panel: Panel | null = null
  /** The page's own cursor, put back exactly as it was found. */
  let pageCursor = ''

  const arm = (by: ArmedBy) => {
    if (mode !== 'off') return
    mode = 'armed'
    armedBy = by
    picker.setAttribute('data-armed', '')
    // Armed state changes the cursor and nothing else it can avoid (spec §4). On
    // the document element, so it inherits, and so no page element's own rules
    // are touched. Hittability is the one other thing arming changes, and it
    // changes `pointer-events` only where the page had taken it away.
    pageCursor = document.documentElement.style.cursor
    document.documentElement.style.cursor = 'crosshair'
    hittability.arm()
  }

  const off = () => {
    closePanel()
    mode = 'off'
    armedBy = null
    hovered = null
    highlight.hide()
    picker.removeAttribute('data-armed')
    document.documentElement.style.cursor = pageCursor
    hittability.disarm()
  }

  const closePanel = () => {
    panel?.close()
    panel = null
  }

  /** `Escape` unwinds exactly one level, never two (spec §4). */
  const unwind = () => {
    if (mode === 'picked') {
      closePanel()
      mode = 'armed'
      armedBy = armedBy ?? 'picker'
      // Armed again, so the page is hittable again — and re-measured, because
      // what is on it may have changed while the Panel was open.
      hittability.arm()
      return
    }
    if (mode === 'armed') off()
  }

  /**
   * The Overlay's own chrome. The shield is not: it is the Overlay's way of
   * taking the pointer *on the page's behalf*, so an event that landed on it is
   * an event about the page.
   */
  const ours = (event: Event): boolean => {
    const path = event.composedPath()
    return path.includes(host) && !hittability.onShield(path)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (mode !== 'armed') return
    const element = elementAtPoint(document, event.clientX, event.clientY)
    if (!element) {
      hovered = null
      highlight.hide()
      return
    }
    hovered = element
    highlight.show(element, readOwner(element))
  }

  const onClick = (event: MouseEvent) => {
    if (mode !== 'armed' || ours(event)) return
    // The app never sees the click that made the Pick.
    event.preventDefault()
    event.stopPropagation()

    const element = elementAtPoint(document, event.clientX, event.clientY) ?? hovered
    if (!element) return

    hovered = element
    highlight.show(element, readOwner(element))
    mode = 'picked'
    // Picked is not armed: the page goes back to the hittability its author gave
    // it while the Note is being written.
    hittability.disarm()
    panel = openPanel({
      document,
      view,
      shadow,
      element,
      pointer: () => pointerOf(view, element),
    })
  }

  /** While armed, a press on the page selects nothing and focuses nothing. */
  const onPress = (event: MouseEvent) => {
    if (mode !== 'armed' || ours(event)) return
    event.preventDefault()
    event.stopPropagation()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (mode === 'off') return
      event.preventDefault()
      unwind()
      return
    }
    if (event.altKey && mode === 'off') arm('alt')
  }

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.altKey) return
    if (mode === 'armed' && armedBy === 'alt') off()
  }

  /** A held Alt the window never sees released would leave it armed for ever. */
  const onBlur = () => {
    if (mode === 'armed' && armedBy === 'alt') off()
  }

  const onReflow = () => highlight.remeasure()

  picker.addEventListener('click', (event: MouseEvent) => {
    event.stopPropagation()
    if (mode === 'off') arm('picker')
    else off()
  })

  view.addEventListener('pointermove', onPointerMove, true)
  view.addEventListener('click', onClick, true)
  view.addEventListener('pointerdown', onPress, true)
  view.addEventListener('mousedown', onPress, true)
  view.addEventListener('keydown', onKeyDown, true)
  view.addEventListener('keyup', onKeyUp, true)
  view.addEventListener('blur', onBlur)
  view.addEventListener('scroll', onReflow, true)
  view.addEventListener('resize', onReflow)

  // No teardown: the Overlay is mounted once per page load and outlives every
  // Pick made on it. A `close()` nothing calls would be an escape hatch pretending
  // to be a lifecycle.
  return { host, shadow }
}

/**
 * The Pointer inputs, measured when the Pick is sent rather than when it was
 * made. The descriptor, the Excerpts and the redactions come from
 * `describeElement` (ticket 07), which is where the allowlist, the caps and the
 * password and hidden redaction live.
 *
 * The Owner chain is read here rather than at pick time for the same reason as
 * the geometry: a Pick that was moved carries the element it ended on — and a
 * field typed into while the Note was being written carries what it says now.
 */
function pointerOf(view: Window, element: Element): Omit<PickBody, 'note' | 'target'> {
  // In the top document's coordinates, so a Pick made inside a frame carries
  // the geometry a developer — and a Screen Capture — would see (ticket 08).
  const rect = viewportBox(element)
  const owners = readOwnerChain(element)
  const described = describeElement(element)

  return {
    url: view.location.href,
    viewport: { width: view.innerWidth, height: view.innerHeight },
    descriptor: described.descriptor,
    excerpts: described.excerpts,
    redactions: described.redactions,
    geometry: {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      x: Math.round(rect.left),
      y: Math.round(rect.top),
    },
    ownerChain: owners.links,
    walkUp: owners.walkUp,
  }
}
