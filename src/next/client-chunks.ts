import type { FrameAnswer, ServedFrame } from '../server/frame-resolver.js'
import { isSourceMap } from '../server/sourcemap.js'
import type { SourceMapLike } from '../server/sourcemap.js'
import { chunkSource } from './chunk-source.js'
import { askLoopback } from './loopback.js'
import type { LoopbackAnswer } from './loopback.js'

// The Next.js Connector's client-chunk resolver (ADR-0005): a frame in a
// Turbopack client chunk, `/_next/static/chunks/<name>.js`, decoded against the
// map Next serves beside it, `<name>.js.map`.
//
// Measured on 16.4.2: the map is an index map with one section per module, its
// `sources` are `file:///` urls, and vendor sections carry `ignoreList`. The
// same chunk and map are also on disk below `<distDir>/dev/static/chunks/`, but
// this reads the served one: the frame names the served path, which is all a
// request needs, while the disk path would need the config's `distDir` and
// Next's own `dev/` layout, which 16 changed. pointout never asks Next's
// internal `__nextjs_*` endpoints.
//
// Staleness. A chunk's url never changes when Turbopack rewrites it: an edit
// reaches the page through the HMR socket, and the frames React prints after
// one still name the chunk and the line the page first loaded (measured, all
// three engines). So a frame cannot say which version of its chunk it is in,
// and the map served now may have moved under it. What the Pick says is when
// its page began to load, and every chunk that page holds was loaded after
// that: a source file that has changed since then may be one the frame's
// chunk predates, and the link is approximate. A page loaded after the edit
// holds the chunk as it is now, so a reload clears it; another page loading
// the chunk does not, since this page's frames are still its own. Without
// that moment, the baseline is when pointout started.

/** Where Turbopack's client chunks are served, below any `basePath`. */
const CLIENT_CHUNKS = '/_next/static/chunks/'

/** How long a map request may take. Maps of React itself run to 2 MB. */
const MAP_TIMEOUT_MS = 10_000

export interface ClientChunks {
  /** Whether a frame's url names a client chunk at all. */
  claims(url: URL): boolean
  resolve(url: URL, frame: ServedFrame): Promise<FrameAnswer>
}

/** A resolver for the client chunks served at `origin` (loopback), whose maps it asks for. */
export function clientChunks(origin: string): ClientChunks {
  // A frame from a page that did not say when it loaded is judged against
  // when pointout started: a chunk from an earlier server is older still.
  const startedAt = Date.now()

  return {
    claims: (url) => isChunk(url.pathname),
    async resolve(url, frame) {
      const path = url.pathname
      const map = await served(origin + path + '.map')
      if (map.kind === 'unreadable') {
        return {
          kind: 'absent',
          mode: 'no-sourcemap',
          reason: `the map Next served for the chunk ${path} is not a source map this server can read`,
          dependency: false,
        }
      }
      if (map.kind === 'missing') {
        // Told apart by asking for the chunk itself: a chunk Next serves with
        // no map has no file to name, and a chunk it does not serve has gone.
        const chunk = await status(origin + path)
        return chunk === 200
          ? {
              kind: 'absent',
              mode: 'no-sourcemap',
              reason: `Next served the chunk ${path} without a sourcemap, so which file the frame is in is not knowable`,
              dependency: false,
            }
          : {
              kind: 'absent',
              mode: 'module-not-in-graph',
              reason: `this dev server serves no chunk at ${path}`,
              dependency: false,
            }
      }

      const since = frame.pageLoadedAt
      return {
        kind: 'chunk',
        map: map.map,
        served: path,
        source: (name) =>
          chunkSource(
            name,
            since ?? startedAt,
            since === null ? SINCE_STARTED : SINCE_LOADED,
          ),
      }
    },
  }
}

const SINCE_LOADED =
  'this file has changed since the page this frame came from began to load, and a ' +
  'Turbopack frame carries no version of its chunk to compare — the url stays the same ' +
  'across hot updates — so which version of the file the line belongs to is not ' +
  'knowable here'

const SINCE_STARTED =
  'this file has changed since this dev server started, the Pick did not say when its ' +
  'page loaded, and a Turbopack frame carries no version of its chunk to compare, so ' +
  'which version of the file the line belongs to is not knowable here'

/** A chunk path, below any `basePath`: a script, not its map or a stylesheet. */
function isChunk(path: string): boolean {
  return path.includes(CLIENT_CHUNKS) && path.endsWith('.js')
}

type MapAnswer =
  | { kind: 'map'; map: SourceMapLike }
  | { kind: 'missing' }
  | { kind: 'unreadable' }

async function served(url: string): Promise<MapAnswer> {
  const { status: code, body } = await get(url)
  if (code !== 200) return { kind: 'missing' }
  try {
    const parsed = JSON.parse(body) as unknown
    return isSourceMap(parsed) ? { kind: 'map', map: parsed } : { kind: 'unreadable' }
  } catch {
    return { kind: 'unreadable' }
  }
}

async function status(url: string): Promise<number> {
  return (await get(url, 'HEAD')).status
}

/** A map that cannot be fetched is a map that is not there; the link says so. */
function get(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<LoopbackAnswer> {
  return askLoopback(url, { method, timeoutMs: MAP_TIMEOUT_MS }).catch(() => ({
    status: 0,
    body: '',
  }))
}
