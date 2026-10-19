// The Overlay's entry on a Next.js page (`pointout/next/overlay`), which
// `withPointout()` adds to `instrumentationClientInject`. Next runs it on every
// page of both routers, before React hydrates the page, so it draws nothing
// until React has.
//
// Measured on Next 16.4.2 (ticket 06 of the Next.js Connector): drawn at once,
// the Overlay printed no hydration warning on either router, but it broke every
// event handler on an App Router page. The Overlay's surfaces are a React root
// of their own, made with the same React DOM the App Router hydrates
// `document` with, and React marks the *document* as listened to whenever it
// starts a root anywhere in it. The App Router's root, started on `document`
// after that, then registers no listeners at all: the page renders and nothing
// on it answers a click. The Pages Router hydrates `#__next`, and was not hurt.
//
// So the Overlay waits until each root Next hydrates has committed. React keeps
// that on the root: a `__reactContainer$…` key on the container, whose root
// state says `isDehydrated` until the first commit. This reads React's
// internals, as the Owner chain already does (`fiber.ts`).

import { mountOverlay } from '../overlay/mount.js'

/** How React hangs its root off a container it rendered into. */
const CONTAINER_KEY_PREFIX = '__reactContainer$'

/** The Pages Router's container; the App Router hydrates `document` itself. */
const PAGES_ROUTER_CONTAINER = '__next'

/** How often the Overlay looks again while it waits. */
const POLL_MS = 50

/** How long it waits before it says, once, that it is still waiting. */
const SLOW_MS = 10_000

interface RootFiberLike {
  stateNode?: { current?: { memoizedState?: { isDehydrated?: unknown } | null } }
}

type Hydration = 'not-started' | 'hydrating' | 'hydrated'

/** Where Next's React root is, and whether it has committed yet. */
function hydration(document: Document): Hydration {
  const containers: (Node | null)[] = [
    document,
    document.getElementById(PAGES_ROUTER_CONTAINER),
  ]
  let found = false
  for (const container of containers) {
    const root = rootOf(container)
    if (!root) continue
    found = true
    if (root.stateNode?.current?.memoizedState?.isDehydrated !== false) return 'hydrating'
  }
  return found ? 'hydrated' : 'not-started'
}

function rootOf(container: Node | null): RootFiberLike | null {
  if (!container) return null
  const record = container as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!key.startsWith(CONTAINER_KEY_PREFIX)) continue
    const value = record[key]
    if (value && typeof value === 'object') return value as RootFiberLike
  }
  return null
}

/**
 * A page in a same-origin frame is the frame's page's to pick in: the Overlay
 * that page draws already reaches into it (`frames.ts`), and a second Overlay
 * inside the frame would arm on the same Alt and draw a second Picker.
 */
function framedBySameOrigin(view: Window): boolean {
  if (view.parent === view) return false
  try {
    return view.parent.document !== null
  } catch {
    // A cross-origin parent cannot reach into this frame, so it draws its own.
    return false
  }
}

function whenHydrated(document: Document, then: () => void): void {
  const started = Date.now()
  let said = false
  const look = () => {
    if (hydration(document) === 'hydrated') {
      then()
      return
    }
    if (!said && Date.now() - started > SLOW_MS) {
      said = true
      console.warn(
        `pointout: React has not finished hydrating this page after ${SLOW_MS / 1000} s, ` +
          'and the Overlay is drawn only once it has. It is still waiting.',
      )
    }
    setTimeout(look, POLL_MS)
  }
  look()
}

if (!framedBySameOrigin(window)) whenHydrated(document, () => mountOverlay(document))
