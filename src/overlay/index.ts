// The Overlay — everything pointout draws into the consumer's page:
// Picker, Highlight, Panel and Stack, in one open shadow root (spec §3).
//
// The whole journey: hold Alt or click the Picker, hover an element and read the
// chip, click to freeze it, write a Note in the Panel and press Enter. No motion
// by default (spec §9).

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

globalThis.__pointout = { apiBase: API_BASE, ...startOverlay(document) }
