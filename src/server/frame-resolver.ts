import type { DegradedMode } from './owner-chain.js'
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
  /**
   * When the page that printed the frame began to load, in epoch milliseconds,
   * or null when the Pick did not say. Every script the frame can name was
   * loaded after it.
   */
  pageLoadedAt: number | null
}

/**
 * The module has been replaced since the page read the frame, or may have been
 * and the frame cannot say. The reason is the Connector's, since only it knows
 * how its Host marks a transform.
 */
export interface Drift {
  mode: Extract<DegradedMode, 'stale-transform' | 'no-transform-timestamp'>
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
      /**
       * A bundle of many source files, such as a Turbopack chunk: which file
       * the frame is in is whichever source the map names at its position.
       */
      kind: 'chunk'
      /** What the frame decodes against. A chunk with no map is `absent`. */
      map: SourceMapLike
      /**
       * The source the map names at the frame's position, as a file: its
       * absolute path, whether it has moved since the page loaded the chunk,
       * and whether it is vendor code by its path (the map's `ignoreList` adds
       * to that). Null for a source that is no file on this machine, such as
       * a bundler's own runtime. The source's spelling is the Connector's to
       * read; the core never sees its scheme.
       */
      source: (name: string) => ChunkSource | null
      served: string
    }
  | {
      kind: 'absent'
      /**
       * `no-sourcemap`: the frame is in a bundle of many files with no map to
       * say which.
       */
      mode: Extract<
        DegradedMode,
        'unreadable-frame' | 'module-not-in-graph' | 'no-sourcemap'
      >
      reason: string
      dependency: boolean
    }

/** One source file of a chunk, as the Connector found it. */
export interface ChunkSource {
  file: string
  drift: Drift | null
  dependency: boolean
}

export type FrameResolver = (frame: ServedFrame) => Promise<FrameAnswer>

/**
 * A frame's url, parsed, for a Connector to read. Null for a frame that names no url at all, and the
 * frame's own text never travels with the refusal: the raw stacks are Excerpts
 * and nothing lifted from one is ever interpolated into the body (spec §13).
 */
export function parseFrameUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
