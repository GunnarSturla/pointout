// Drawing the Overlay into a page, and publishing what it drew. Each Connector's
// entry decides *when*: Vite's draws it as soon as the module runs, and the
// Next.js Connector's waits until React has hydrated the page.

import { API_BASE } from '../api.js'
import { startOverlay } from './overlay.js'
import type { OverlayHandle } from './overlay.js'

/** What the Overlay publishes to the page it is drawn into. */
export interface OverlayMarker extends OverlayHandle {
  apiBase: string
}

declare global {
  var __pointout: OverlayMarker | undefined
}

export function mountOverlay(document: Document): OverlayMarker {
  const marker = { apiBase: API_BASE, ...startOverlay(document) }
  globalThis.__pointout = marker
  return marker
}
