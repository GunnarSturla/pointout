import type { Target } from './pick.js'

// The second-harness seam (spec §18). Everything a delivery route needs to be
// asked is here, in this project's own vocabulary; everything Claude Code
// specific — the inbox socket, the NDJSON frames, the peer token, the reply
// address — lives under `claude/` behind this interface, and neither the
// renderer nor the Overlay names any of it.

/** One rendered Pick, addressed. */
export interface Delivery {
  /** The Pick id. The route carries it so a Receipt can name the Pick. */
  pickId: string
  /** The rendered body, already a plain string (`render.ts`). */
  body: string
  target: Target
}

/** Written, or refused with the reason said out loud (spec §21). */
export type DeliveryOutcome = { written: true } | { written: false; reason: string }

export interface DeliveryRoute {
  /** The one line this route contributes to the startup posture block. */
  postureLine: string
  deliver(delivery: Delivery): Promise<DeliveryOutcome>
  /** Release whatever the route is holding. Safe to call twice. */
  close(): void
}
