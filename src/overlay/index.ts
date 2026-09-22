// The Overlay — everything vite-agent-inspect draws into the consumer's page:
// Picker, Highlight, Panel and Stack, in one open shadow root (spec §3).
//
// Ticket 04 builds the first complete journey through it: hold Alt or click the
// Picker, hover an element and read the chip, click to freeze it, write a Note
// in the Panel and press Enter. Zero motion anywhere (spec §9).

import { API_BASE } from '../api.js'
import { startOverlay } from './overlay.js'
import type { OverlayHandle } from './overlay.js'

/** What the Overlay publishes to the page it is drawn into. */
export interface OverlayMarker extends OverlayHandle {
  apiBase: string
}

declare global {
  var __viteAgentInspect: OverlayMarker | undefined
}

globalThis.__viteAgentInspect = { apiBase: API_BASE, ...startOverlay(document) }
