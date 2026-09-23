import type { Target } from '../wire.js'
import type { PostureLine } from './posture.js'
import type { ReplyListener } from './receipt.js'
import type { SessionEntry } from './registry.js'

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
  /**
   * The registry entry the Target was resolved from, which is where its inbox
   * is. Carried so the route writes to the session the Target was chosen from
   * rather than reading the registry a second time and finding something else.
   */
  session: SessionEntry
}

/** Written, or refused with the reason said out loud (spec §21). */
export type DeliveryOutcome = { written: true } | { written: false; reason: string }

export interface DeliveryRoute {
  /** The one line this route contributes to the startup posture block. */
  postureLine: PostureLine
  deliver(delivery: Delivery): Promise<DeliveryOutcome>
  /**
   * Where what the route hears back goes (spec §16). A route correlates what
   * arrives to the Picks it wrote and hands on only those; a route that has no
   * return leg, or is told nothing, simply never calls it — which is the floor
   * v0 would have had without Receipts at all. Registered once.
   */
  listen(listener: ReplyListener): void
  /** Release whatever the route is holding. Safe to call twice. */
  close(): void
}
