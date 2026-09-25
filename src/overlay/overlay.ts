// The Overlay's controller: arm, hover, pick, write, send (spec §3, §4, §7).
//
// Three states and no more. `Escape` unwinds one level — picked → armed → off —
// which is the rule the prototype settled on and the one thing about the gesture
// that is invisible from it. The fourth thing a click can mean is written down
// here for the same reason: while a Pick is open, Alt-click *moves* it (spec
// §7). Sending it closes its Panel and minimizes it into the Stack, and the
// Overlay is off again: an Alt-click after that starts a new Pick.
//
// What is on screen is decided here and handed to the React surfaces as props
// (`surfaces.tsx`); the Highlight and the page's hittability are driven by hand,
// because both change on every pointer move and neither has any state of its
// own worth a component.

import type { CaptureCoordinates, PickBody } from '../wire.js'
import { createHittability } from './armed.js'
import { createCamera } from './capture.js'
import { topDocumentPoint, viewportBox } from './deep-element.js'
import type { Point, ViewportBox } from './deep-element.js'
import { describeElement } from './describe.js'
import { readOwner, readOwnerChain } from './fiber.js'
import { createFrames } from './frames.js'
import { elementAtPoint } from './hit-test.js'
import { createMarks } from './marks.js'
import type { Accepted, PanelCamera, PointerInputs } from './panel.js'
import { inViewport } from './placement.js'
import { createReflow } from './reflow.js'
import { mountOverlayRoot, part } from './root.js'
import type { Submitted } from './stack.js'
import { mountSurfaces } from './surfaces.js'

/** What arms the Overlay. Alt is held; the Picker is a toggle. */
type ArmedBy = 'alt' | 'picker'
type Mode = 'off' | 'armed' | 'picked'

/**
 * How long the shutter stays closed around a Screen Capture (spec §10). A fixed
 * span, the same whether a capture is taken, skipped or unavailable, so the
 * Overlay reads identically in all three (story 68). It has to outlast the
 * capture itself, which the dev server starts after this page has asked: the
 * real `screencapture` measured 75–110 ms for a whole run of a 200 px region on
 * the machine this was built on, process start included, and the request adds
 * its own few. 250 ms covers that more than twice over and is still a blink.
 */
const SHUTTER_MS = 250

export interface OverlayHandle {
  host: HTMLElement
  shadow: ShadowRoot
}

export function startOverlay(document: Document): OverlayHandle {
  const view = document.defaultView
  if (!view) throw new Error('vite-agent-inspect: the Overlay needs a window')

  const { host, shadow } = mountOverlayRoot(document)
  // The two Highlights are drawn into a layer of their own, ahead of the
  // surfaces. Which box paints over which is `styles.ts`'s, by role, not the
  // order they happen to be in.
  const layer = part(document, 'div', 'marks')
  shadow.append(layer)
  const marks = createMarks(document, layer)
  // The page is heard in every same-origin frame's document as well as its own
  // (`listenIn`, below), and covered while armed where a frame cannot be.
  const frames = createFrames(document)
  const hittability = createHittability(document, shadow, frames)
  const reflow = createReflow()
  const surfaces = mountSurfaces(document, shadow)

  let mode: Mode = 'off'
  let armedBy: ArmedBy | null = null
  let hovered: Element | null = null
  /** The element the open Panel is on, or null when no Panel is open. */
  let picked: Element | null = null
  /** How many Picks have been opened: a new Pick is a new Panel, not a re-anchoring. */
  let pickCount = 0
  /** True once the picked element has left the page while its Panel is open. */
  let gone = false
  /** Every Pick outstanding, oldest first: what the Stack shows. */
  let submitted: readonly Submitted[] = []
  /** The Stack slot the open Panel is being sent into, for the one render that closes it. */
  let landing: string | null = null
  /** Whether the Picker was last drawn offering the way back to the Panel. */
  let offeredWayBack = false
  /** The page's own cursor, put back exactly as it was found. */
  let pageCursor = ''
  /**
   * Where the pointer last was on the page, so Alt pressed over an open Panel
   * previews at once. Null while it is over the Overlay's own chrome.
   */
  let lastPointer: Point | null = null
  /** When the shutter opens again, while it is closed. */
  let shutterOpens = 0

  // The camera toggle and the one capture an unsubmitted Pick holds. What the
  // Panel is handed is one object between changes, so the Panel is drawn again
  // when the toggle changes and not on every scroll.
  let panelCamera: PanelCamera | null = null
  const camera = createCamera(view, () => {
    panelCamera = null
    render()
  })
  const cameraForPanel = (): PanelCamera => {
    panelCamera ??= {
      state: camera.state(),
      onToggle: () => camera.toggle(),
      carry: (send, accepted) => camera.carry(send, accepted),
    }
    return panelCamera
  }

  // Stable across renders: the surfaces are memoized on their props, and a
  // callback that changed identity on every render would render them again on
  // every scroll.
  const onToggle = () => {
    if (mode === 'off') arm('picker')
    else off()
  }
  const onBack = () => {
    picked?.scrollIntoView({ block: 'center', inline: 'nearest' })
    render()
  }
  /**
   * A Pick the dev server accepted rests in the Stack, minimized. When its
   * Panel is still the open one, the Panel closes and the Overlay is off: the
   * frozen Highlight becomes the Stack's resting one, one box on the element
   * and not two (spec §5). A Send answered after its Panel was put away — or
   * replaced by a newer Pick — still rests there, and leaves whatever is open
   * now alone.
   */
  const onSubmitted = (count: number, accepted: Accepted) => {
    const { element } = accepted
    const name = readOwner(element).name ?? element.tagName.toLowerCase()
    // Its place in the Stack is named for the id it was first accepted under,
    // and keeps that name when an offer sends it on as a new Pick.
    const slot = accepted.pickId
    submitted = [...submitted, { ...accepted, name, slot }]
    if (count === pickCount && picked) {
      landing = slot
      off({ sent: true })
      landing = null
    } else render()
  }
  /**
   * The open Panel's `onSubmitted`: `onSubmitted` told which Pick the Panel
   * was opened for, so that a late answer can be told from the open Pick's.
   * Kept while that Panel is, because the Panel is memoized on its props and a
   * new function on every render would draw it again on every scroll.
   */
  let submittedHandler: { count: number; handle: (accepted: Accepted) => void } | null =
    null
  const submittedHandlerFor = (count: number) => {
    if (submittedHandler?.count !== count) {
      submittedHandler = { count, handle: (accepted) => onSubmitted(count, accepted) }
    }
    return submittedHandler.handle
  }
  const onDismiss = (pickId: string) => {
    submitted = submitted.filter((pick) => pick.pickId !== pickId)
    render()
  }
  // A Pick sent on to another session from its report-back offer is a new Pick
  // on the same element: its minimized Panel and the resting Highlight stay
  // where they are, under the new id (spec §17).
  const onReplaced = (pickId: string, replacement: string, targetName: string) => {
    submitted = submitted.map((pick) =>
      pick.pickId === pickId ? { ...pick, pickId: replacement, targetName } : pick,
    )
    render()
  }
  const pointer = (): PointerInputs => {
    if (!picked) throw new Error('vite-agent-inspect: no Pick is open to send')
    return pointerOf(view, picked, marks.lastBox())
  }

  /** The open Panel has ridden out of the viewport with its element (spec §7). */
  const panelOffScreen = (): boolean =>
    picked !== null &&
    picked.isConnected &&
    !inViewport(viewportBox(picked), { width: view.innerWidth, height: view.innerHeight })

  /**
   * Push the controller's state down. The Picker peeks only when there is
   * nothing to come back to: armed, a Panel open or a Pick outstanding all hold
   * it out (spec §8), and an open Panel that has ridden off-screen puts the way
   * back to it on the Picker (spec §7). A `held` Pick is outstanding until it is
   * dismissed, so this is also §8's rule that a `held` Pick pulls the Picker back
   * out — and the Stack, which exists for as long as any minimized Panel does.
   */
  const render = () => {
    offeredWayBack = panelOffScreen()
    surfaces.render({
      picker: {
        armed: mode === 'armed',
        held: mode !== 'off' || submitted.length > 0,
        wayBack: offeredWayBack,
        onToggle,
        onBack,
      },
      panel: picked
        ? {
            key: String(pickCount),
            props: {
              view,
              reflow,
              element: picked,
              gone,
              pointer,
              camera: cameraForPanel(),
              onSubmitted: submittedHandlerFor(pickCount),
            },
          }
        : null,
      landing,
      stack: { view, reflow, picks: submitted, onDismiss, onReplaced },
    })
  }

  const arm = (by: ArmedBy) => {
    if (mode !== 'off') return
    mode = 'armed'
    armedBy = by
    // Armed state changes the cursor and nothing else it can avoid (spec §4). On
    // the document element, so it inherits, and so no page element's own rules
    // are touched. Hittability is the one other thing arming changes, and it
    // changes `pointer-events` only where the page had taken it away.
    pageCursor = document.documentElement.style.cursor
    document.documentElement.style.cursor = 'crosshair'
    hittability.arm()
    render()
  }

  /** Off: nothing armed and no Panel. A Panel closed by its own Send keeps its capture. */
  const off = (closing: { sent?: boolean } = {}) => {
    closePanel(closing)
    mode = 'off'
    armedBy = null
    hovered = null
    marks.hide()
    document.documentElement.style.cursor = pageCursor
    hittability.disarm()
    render()
  }

  const closePanel = ({ sent = false }: { sent?: boolean } = {}) => {
    // An unsubmitted Pick that is put away takes its capture with it: the
    // developer's screen is not left on disk for a Pick that never went. A sent
    // one's capture is the server's already.
    if (picked && !sent) camera.discard()
    picked = null
    gone = false
  }

  /**
   * The Pick this click makes, on the element it landed on. One Panel per Pick
   * and at most one unsubmitted Pick, so whatever was open has already gone.
   */
  const pickOn = (element: Element) => {
    hovered = element
    picked = element
    gone = false
    pickCount += 1
    captureAt(element)
    marks.show(element, readOwner(element))
    mode = 'picked'
    // Picked is not armed: the page goes back to the hittability its author gave
    // it while the Note is being written.
    hittability.disarm()
    render()
  }

  /**
   * The moment a Pick is made or moved (spec §10, story 67). The shutter closes
   * first — the Highlight's fill and its chip leave the page for the frame, and
   * its outline stays to mark the element — and the capture is asked for in the
   * same task, so the request cannot reach the dev server before the page has
   * stopped drawing them. Toggle or no toggle, capture or none: the same
   * shutter, every time.
   *
   * Nothing else is behind the shutter. The Stack and the Picker are nowhere
   * near the element, and the Panel's entrance is never gated on a capture; a
   * large element's capture may catch it at its edge.
   */
  const captureAt = (element: Element) => {
    host.setAttribute('data-shutter', '')
    view.clearTimeout(shutterOpens)
    shutterOpens = view.setTimeout(() => host.removeAttribute('data-shutter'), SHUTTER_MS)
    camera.take(coordinatesOf(view, element))
  }

  // The picked element can leave the page while its Panel is open (spec §5,
  // user story 25). The Highlight fades where it stood; the Panel is what says
  // so, and the Pick it belongs to is still sendable.
  marks.whenGone(() => {
    if (!picked) return
    gone = true
    render()
  })
  // A hot update moved the element under the Highlight: everything else
  // anchored to the page moves with it.
  marks.whenMoved(() => reflow.emit())

  /** `Escape` unwinds exactly one level, never two (spec §4). */
  const unwind = () => {
    if (mode === 'picked') {
      marks.release()
      closePanel()
      mode = 'armed'
      armedBy = armedBy ?? 'picker'
      // Armed again, so the page is hittable again — and re-measured, because
      // what is on it may have changed while the Panel was open.
      hittability.arm()
      render()
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

  /**
   * The event is about the submitted Panel open above the Stack: in it, or on
   * the minimized line that opened it. Anywhere else, Escape is as it was.
   */
  const inSubmittedPanel = (event: Event): boolean =>
    ours(event) &&
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof Element &&
          (node.getAttribute('data-part') === 'expanded' ||
            (node.getAttribute('data-part') === 'minimized-line' &&
              node.getAttribute('aria-expanded') === 'true')),
      )

  const onPointerMove = (event: PointerEvent) => {
    const at = pointOf(view, event)
    // Over the Overlay's own chrome an Alt-click means nothing to the page, so
    // there is nothing to preview there.
    lastPointer = ours(event) ? null : at
    if (mode === 'picked') {
      if (event.altKey && lastPointer) previewAt(lastPointer)
      else release()
      return
    }
    if (mode !== 'armed') return
    const element = elementAtPoint(document, at.x, at.y)
    if (!element) {
      hovered = null
      marks.hide()
      return
    }
    hovered = element
    marks.show(element, readOwner(element))
  }

  /**
   * Alt is let go over an open Panel: the live mark fades, and the frame
   * shields laid so it could follow the pointer over a frame are taken up.
   */
  const release = () => {
    marks.release()
    hittability.uncover()
  }

  /**
   * With a Panel open and Alt held, the live mark shows what an Alt-click here
   * would pick, and the Pick's own mark rests under it (spec §5, §7).
   */
  const previewAt = (at: Point) => {
    const element = elementAtPoint(document, at.x, at.y)
    if (!element) {
      marks.release()
      return
    }
    hovered = element
    marks.preview(element, readOwner(element))
  }

  const onClick = (event: MouseEvent) => {
    if (mode === 'off' || ours(event)) return
    // With a Panel already open, only Alt-click means anything: a plain click is
    // the developer using their app, and the Panel is not modal (`CONTEXT.md`).
    if (mode === 'picked' && !event.altKey) return
    // The app never sees the click that made the Pick.
    event.preventDefault()
    event.stopPropagation()

    const at = pointOf(view, event)
    const element = elementAtPoint(document, at.x, at.y) ?? hovered
    if (!element) return

    // Spec §7: an open Panel is an unsubmitted one, and it *moves* — the Note
    // the developer already wrote is theirs and travels with the Pick. The live
    // mark is already on the element, and it becomes the Pick's.
    if (mode === 'picked') {
      marks.promote(element, readOwner(element))
      picked = element
      hovered = element
      gone = false
      captureAt(element)
      render()
      return
    }

    pickOn(element)
    // Still held: the next Alt-click is a move, and it has to be heard.
    if (event.altKey) hittability.cover()
  }

  /**
   * A press that belongs to a Pick selects nothing and focuses nothing: while
   * armed, and while a Panel is open and Alt is held, because that press is the
   * start of a move. Letting it through would take focus out of the Note, and
   * the Note is where the developer is still typing (spec §7, story 19).
   */
  const onPress = (event: MouseEvent) => {
    if (mode === 'off' || ours(event)) return
    if (mode === 'picked' && !event.altKey) return
    event.preventDefault()
    event.stopPropagation()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      // A submitted Panel that has focus closes on its own Escape, and leaves
      // the unsubmitted one alone (`stack.tsx`).
      if (mode === 'off' || inSubmittedPanel(event)) return
      event.preventDefault()
      unwind()
      return
    }
    if (event.altKey && mode === 'off') arm('alt')
    if (event.altKey && mode === 'picked') {
      hittability.cover()
      if (lastPointer) previewAt(lastPointer)
    }
  }

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.altKey) return
    if (mode === 'picked') release()
    if (mode === 'armed' && armedBy === 'alt') off()
  }

  /** A held Alt the window never sees released would leave it armed for ever. */
  const onBlur = () => {
    if (mode === 'picked') release()
    if (mode === 'armed' && armedBy === 'alt') off()
  }

  const onReflow = () => {
    marks.remeasure()
    hittability.remeasure()
    reflow.emit()
    // Whether the Panel has ridden off-screen is a question about where the page
    // is, so it is answered where the page moves (spec §7, story 16) — and only
    // a changed answer is worth drawing.
    if (panelOffScreen() !== offeredWayBack) render()
  }

  /** Every listener that hears the page, on the top window or a frame's document. */
  const listenIn = (target: Pick<Document, 'addEventListener'>) => {
    target.addEventListener('pointermove', onPointerMove, true)
    target.addEventListener('click', onClick, true)
    target.addEventListener('pointerdown', onPress, true)
    target.addEventListener('mousedown', onPress, true)
    target.addEventListener('keydown', onKeyDown, true)
    target.addEventListener('keyup', onKeyUp, true)
    target.addEventListener('scroll', onReflow, true)
  }
  // A pointer over a same-origin frame is in the frame's document, and the top
  // one hears nothing of it (spec §4). Its keys are too, once focus is in there,
  // and its scrolls move whatever a Highlight is on — so each frame document
  // `frames` finds gets every one of these. `blur`, `resize` and `pagehide`
  // stay the top window's: they are about the page as a whole.
  listenIn(view)
  frames.listen(listenIn)
  view.addEventListener('blur', onBlur)
  view.addEventListener('resize', onReflow)
  // A reload or a navigation with an unsubmitted Pick open is a discard too
  // (story 72), and the page will not be here to wait for the answer.
  view.addEventListener('pagehide', () => camera.leave())

  render()

  // No teardown: the Overlay is mounted once per page load and outlives every
  // Pick made on it. A `close()` nothing calls would be an escape hatch pretending
  // to be a lifecycle.
  return { host, shadow }
}

/**
 * Where a pointer event happened, in the top document's viewport — the one
 * `viewportBox` measures in. An event from inside a frame gives its point in
 * the frame's own coordinates; the frame's window, which the event names, is
 * how it is walked back out. The page's own events are taken as they are.
 *
 * Known gap, shared with `viewportBox`: the walk goes to the outermost
 * same-origin window, not to this page's. On a page that is itself framed by a
 * same-origin parent, a point from one of its own frames comes back in the
 * parent's coordinates. Nothing in v0 frames the Overlay's page.
 */
function pointOf(view: Window, event: MouseEvent): Point {
  const from = event.view
  if (!from || from === view) return { x: event.clientX, y: event.clientY }
  return topDocumentPoint(from, event.clientX, event.clientY)
}

/**
 * What the dev server needs to find the element on the physical display (spec
 * §10). The page cannot see the display, so it says where the element is in
 * the viewport, where the window is on the screen, and how much larger the
 * window is than its viewport; the server does the rest.
 */
function coordinatesOf(view: Window, element: Element): CaptureCoordinates {
  const box = viewportBox(element)
  return {
    rect: { x: box.left, y: box.top, width: box.width, height: box.height },
    screenX: view.screenX,
    screenY: view.screenY,
    chromeWidth: view.outerWidth - view.innerWidth,
    chromeHeight: view.outerHeight - view.innerHeight,
    screen: { width: view.screen.width, height: view.screen.height },
  }
}

/**
 * The Pointer inputs, measured when the Pick is sent rather than when it was
 * made. The descriptor, the Excerpts and the redactions come from
 * `describeElement`, which is where the allowlist, the caps and the password
 * and hidden redaction live.
 *
 * The Owner chain is read here rather than at pick time for the same reason as
 * the geometry: a Pick that was moved carries the element it ended on — and a
 * field typed into while the Note was being written carries what it says now.
 */
function pointerOf(
  view: Window,
  element: Element,
  lastSeen: ViewportBox | null,
): Omit<PickBody, 'note' | 'target'> {
  // In the top document's coordinates, so a Pick made inside a frame carries
  // the geometry a developer — and a Screen Capture — would see.
  //
  // An element that has left the page measures as nothing at all, so a Pick of
  // one carries the box the Highlight last saw it in. Zeroes would be a silent
  // lie to the agent about something the developer really was looking at
  // (spec §21).
  const rect = element.isConnected
    ? viewportBox(element)
    : (lastSeen ?? viewportBox(element))
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
