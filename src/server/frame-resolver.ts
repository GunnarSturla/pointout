import type { SourceMapLike } from './sourcemap.js'

// The seam between the Owner chain and a Host (ADR-0005). The core owns the
// decoder, the Owner chain and Confidence; it never sees a URL scheme or a Host
// path. A Connector supplies one of these, and it is the only thing that reads a
// served frame's URL: it finds the map the frame decodes against, says whether
// the module has moved since the page read the frame, and whether it is vendor
// code. Or it says why there is nothing to find.

/** One frame as the page's engine printed it: served URL, 1-based line and column. */
export interface ServedFrame {
  url: string
  line: number
  column: number
}

/**
 * The module has been replaced since the page read the frame, or may have been
 * and the frame cannot say. The reason is the Connector's, since only it knows
 * how its Host marks a transform.
 */
export interface Drift {
  mode: 'stale-transform' | 'no-transform-timestamp'
  reason: string
}

export type FrameAnswer =
  | {
      kind: 'found'
      /** The source file the module was served from, absolute. */
      file: string
      /**
       * What the frame decodes against. Null when the Host served the module
       * without one: the position is then the served module's own.
       */
      map: SourceMapLike | null
      /** How a reason names the served module, such as its served path. */
      served: string
      drift: Drift | null
      /** Vendor code: a package rather than the developer's own source. */
      dependency: boolean
    }
  | {
      kind: 'absent'
      /**
       * `no-resolver-for-host`: the Connector cannot read any frame its Host
       * serves yet, whatever the frame says.
       */
      mode: 'unreadable-frame' | 'module-not-in-graph' | 'no-resolver-for-host'
      reason: string
      dependency: boolean
    }

export type FrameResolver = (frame: ServedFrame) => Promise<FrameAnswer>
