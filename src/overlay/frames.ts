// Every same-origin frame's document, so the Overlay can listen in it (spec §4).
//
// A pointer over a frame is in the frame's document, not the top one: the top
// document is told nothing about it at all. So the hit test's descent into a
// same-origin frame (`deep-element.ts`) is only half of picking inside one; the
// other half is hearing the pointer there. This finds the frames — the ones on
// the page now, the ones added later, the ones inside those — and hands each
// frame document to the controller once.
//
// Some frames cannot be heard even so. WebKit runs no listener at all — not
// even one this page added — for an event in a frame whose sandbox withholds
// `allow-scripts`, where Chromium and Firefox run them. Which frames those are
// is measured, not guessed from the attribute: a probe event is dispatched in
// each frame document as it is found, and a frame whose probe nobody heard is
// one the Overlay lays a frame shield over instead (`armed.ts`), so the pointer over it
// stays in the top document, where the hit test descends into it.
//
// A cross-origin frame has no document this page may read, so it is neither
// heard nor covered: a Pick of it is a Pick of the `<iframe>` element, as the
// hit test already says.
//
// Frames inside a shadow root are not found: a mutation observer on a document
// does not see into one. Nothing in v0 draws one.

import { frameDocument, isFrame } from './deep-element.js'

/** The event dispatched in a frame document to learn whether it can be heard. */
const PROBE = 'pointout-probe'

export interface Frames {
  /**
   * Start watching: hand every same-origin frame document below the top one
   * that can be heard to `heard`, once each — now, and as frames arrive — and
   * keep count of the ones that cannot.
   */
  listen(heard: (inside: Document) => void): void
  /** The same-origin frames on the page that the Overlay cannot hear. */
  unheard(): HTMLIFrameElement[]
  /** Told when a frame that cannot be heard arrives, so it can be covered at once. */
  whenUnheard(listener: () => void): void
}

export function createFrames(top: Document): Frames {
  const view = top.defaultView

  const seenDocuments = new WeakSet<Document>()
  const seenFrames = new WeakSet<HTMLIFrameElement>()
  const unheardFrames = new Set<HTMLIFrameElement>()
  let heard: (inside: Document) => void = () => {}
  let listening = false
  let toldUnheard: (() => void) | null = null

  const enter = (frame: HTMLIFrameElement) => {
    if (!seenFrames.has(frame)) {
      seenFrames.add(frame)
      // A frame that loads is a new document — its `src`, or an engine
      // replacing the initial `about:blank` — and the one before it is gone.
      frame.addEventListener('load', () => enter(frame))
    }
    const inside = frameDocument(frame)
    if (!inside || seenDocuments.has(inside)) return
    seenDocuments.add(inside)
    if (canHear(inside)) {
      unheardFrames.delete(frame)
      heard(inside)
    } else {
      unheardFrames.add(frame)
      toldUnheard?.()
    }
    observe(inside)
  }

  const scan = (node: Node) => {
    if (!isElement(node)) return
    if (isFrame(node)) enter(node)
    for (const frame of node.getElementsByTagName('iframe')) {
      if (isFrame(frame)) enter(frame)
    }
  }

  // Only what was added is looked at, never the whole document again: a React
  // app mutates on every render, and a frame can only arrive by being added.
  // The observer is the top window's, so a frame that runs no script of its own
  // is still watched.
  const observe = (inside: Document) => {
    if (!view) return
    new view.MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) scan(node)
    }).observe(inside, { childList: true, subtree: true })
    scan(inside.documentElement)
  }

  return {
    listen(listener) {
      if (listening) return
      listening = true
      heard = listener
      observe(top)
    },

    whenUnheard(listener) {
      toldUnheard = listener
    },

    unheard() {
      for (const frame of unheardFrames)
        if (!frame.isConnected) unheardFrames.delete(frame)
      return [...unheardFrames]
    },
  }
}

/** Whether a listener added to this document runs when an event reaches it. */
function canHear(inside: Document): boolean {
  let ran = false
  const listener = () => {
    ran = true
  }
  inside.addEventListener(PROBE, listener)
  inside.dispatchEvent(new Event(PROBE))
  inside.removeEventListener(PROBE, listener)
  return ran
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1
}
