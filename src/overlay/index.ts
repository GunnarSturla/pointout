// The Overlay — everything pointout draws into the consumer's page:
// Picker, Highlight, Panel and Stack, in one open shadow root (spec §3).
//
// The whole journey: hold Alt or click the Picker, hover an element and read the
// chip, click to freeze it, write a Note in the Panel and press Enter. No motion
// by default (spec §9).
//
// This is the Vite Connector's entry, which draws it at once: a Vite page is
// rendered on the client, so there is nothing to hydrate. The Next.js
// Connector's entry is `src/next/overlay.ts`.

import { mountOverlay } from './mount.js'

export type { OverlayMarker } from './mount.js'

mountOverlay(document)
