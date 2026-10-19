import { statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Server as NetServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { ChunkSource, FrameAnswer, ServedFrame } from '../server/frame-resolver.js'
import type { SourceMapLike } from '../server/sourcemap.js'

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
// and the map served now may have moved under it. What this can say is when a
// page first loaded the chunk from this server, and whether the source file the
// position maps into has changed since: if it has, the link is approximate.

/** Where Turbopack's client chunks are served, below any `basePath`. */
const CLIENT_CHUNKS = '/_next/static/chunks/'

/** Marks the requests this resolver makes of its own server. */
const OWN_REQUEST = 'x-pointout-resolver'

/** How long a map request may take. Maps of React itself run to 2 MB. */
const MAP_TIMEOUT_MS = 10_000

export interface ClientChunks {
  /** Whether a frame's url names a client chunk at all. */
  claims(url: URL): boolean
  resolve(url: URL, frame: ServedFrame): Promise<FrameAnswer>
}

/**
 * A resolver for the client chunks `server` serves. It watches `server` for
 * the requests pages make for chunks, which is how it knows when a page first
 * loaded one, and asks `origin` (loopback) for their maps.
 */
export function clientChunks(server: NetServer, origin: string): ClientChunks {
  // Before any page loaded a chunk, the baseline is when pointout started:
  // a frame in a chunk this server never served came from an earlier one.
  const startedAt = Date.now()
  const firstServed = new Map<string, number>()

  server.prependListener(
    'request',
    (request: IncomingMessage, response: ServerResponse) => {
      const path = request.url?.split('?')[0]
      if (!path || !isChunk(path) || firstServed.has(path)) return
      // pointout's own question about a chunk is no page loading it.
      if (request.headers[OWN_REQUEST] !== undefined) return
      // When the response is written, not when it is asked for: Turbopack may
      // still be writing the chunk as the request arrives.
      response.once('finish', () => {
        if (!firstServed.has(path)) firstServed.set(path, Date.now())
      })
    },
  )

  return {
    claims: (url) => isChunk(url.pathname),
    async resolve(url) {
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

      const baseline = firstServed.get(path) ?? startedAt
      return {
        kind: 'chunk',
        map: map.map,
        served: path,
        source: (name) => sourceOf(name, baseline),
      }
    },
  }
}

/** A chunk path, below any `basePath`: a script, not its map or a stylesheet. */
function isChunk(path: string): boolean {
  return path.includes(CLIENT_CHUNKS) && path.endsWith('.js')
}

/**
 * A `file:///` source as a file, and whether it changed after `baseline`.
 * Turbopack names its own runtime `turbopack:///[turbopack]/…`, which is no
 * file: null.
 */
function sourceOf(name: string, baseline: number): ChunkSource | null {
  let file: string
  try {
    file = fileURLToPath(name)
  } catch {
    return null
  }
  let modified: number
  try {
    modified = statSync(file).mtimeMs
  } catch {
    return null
  }
  return {
    file,
    dependency: file.includes('/node_modules/'),
    drift:
      modified > baseline
        ? {
            mode: 'no-transform-timestamp',
            reason:
              'this file has changed since a page first loaded the chunk it is in, and a ' +
              'Turbopack frame carries no version of its chunk to compare — the url stays the same ' +
              'across hot updates — so which version of the file the line belongs to is not ' +
              'knowable here',
          }
        : null,
  }
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

/** Enough of a map's shape to decode against: a flat map, or sections of them. */
function isSourceMap(value: unknown): value is SourceMapLike {
  if (typeof value !== 'object' || value === null) return false
  const map = value as { mappings?: unknown; sections?: unknown }
  if (typeof map.mappings === 'string') return true
  if (!Array.isArray(map.sections)) return false
  return map.sections.every((section: unknown) => {
    const { offset, map: inner } = (section ?? {}) as { offset?: unknown; map?: unknown }
    const at = (offset ?? {}) as { line?: unknown; column?: unknown }
    return (
      typeof at.line === 'number' &&
      typeof at.column === 'number' &&
      typeof (inner as { mappings?: unknown } | null)?.mappings === 'string'
    )
  })
}

function get(
  url: string,
  method: 'GET' | 'HEAD' = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest
    // A dev server's certificate is its own; this is loopback to itself.
    const headers = { [OWN_REQUEST]: '1' }
    const outgoing = send(
      url,
      { method, headers, rejectUnauthorized: false },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
      },
    )
    outgoing.setTimeout(MAP_TIMEOUT_MS, () => outgoing.destroy(new Error('timed out')))
    // A map that cannot be fetched is a map that is not there; the link says so.
    outgoing.on('error', () => resolve({ status: 0, body: '' }))
    outgoing.end()
  })
}
