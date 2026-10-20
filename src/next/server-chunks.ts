import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChunkSource, FrameAnswer } from '../server/frame-resolver.js'
import { isSourceMap } from '../server/sourcemap.js'
import type { SourceMapLike } from '../server/sourcemap.js'

// The Next.js Connector's server-chunk resolver (ADR-0005): a Server
// Component's frame, decoded against the map Turbopack wrote beside the
// server chunk the component ran in.
//
// React's Flight client replays a Server Component's stack in the page as
// `about://React/Server/<the server's own url for the chunk>?<n>`, and the
// server's url is a `file:///` path below `<distDir>/dev/server/chunks/`. The
// `?<n>` is the client's own counter for the functions it fakes, not a version
// of the chunk. Measured on 16.4.2: the chunk ends in a relative
// `sourceMappingURL`, the map sits beside it, it is an index map whose
// `sources` are `file:///` urls, and vendor sections carry `ignoreList`. No
// page loads a server chunk, so this reads both off disk, and pointout never
// asks Next's internal `__nextjs_*` endpoints.
//
// Staleness. Turbopack writes a server chunk again once a file in it changes
// and a request needs it; a page that shows a Server Component it rendered
// before then holds frames into the chunk as it was. What is knowable here is
// whether the file the position maps into changed after the chunk on disk was
// written: if it did, the map no longer describes the file, and the link is
// approximate. What it cannot see is a render older than the chunk: once a
// request has made Turbopack write the chunk again, a frame from before the
// edit reads exact. Nothing on the server dates the render; Next.js Connector
// issue 12 holds what was measured and the routes worth trying.

/** How React names a frame it replayed from the server. */
const SERVER_FRAME = 'about://React/Server/'

/** The comment a chunk names its map in, on its last line. */
const MAP_COMMENT = /\/\/# sourceMappingURL=(\S+)\s*$/

export interface ServerChunks {
  /** Whether a frame's url is a Server Component's frame at all. */
  claims(url: string): boolean
  resolve(url: string): FrameAnswer
}

/**
 * A resolver for the server chunks of the project at `projectDir`: a frame
 * that names a file outside it, or anything but a script, is not one of its
 * chunks and is never read.
 */
export function serverChunks(projectDir: string): ServerChunks {
  const project = projectDir.endsWith('/') ? projectDir : projectDir + '/'

  return {
    claims: (url) => url.startsWith(SERVER_FRAME),
    resolve(url) {
      const chunk = chunkFile(url.slice(SERVER_FRAME.length))
      if (!chunk || !chunk.startsWith(project) || !chunk.endsWith('.js')) {
        return {
          kind: 'absent',
          mode: 'unreadable-frame',
          reason: "this Server Component's frame names no server chunk of this project",
          dependency: false,
        }
      }
      const served = chunk.slice(project.length)

      let text: string
      let written: number
      try {
        text = readFileSync(chunk, 'utf8')
        written = statSync(chunk).mtimeMs
      } catch {
        return {
          kind: 'absent',
          mode: 'module-not-in-graph',
          reason: `the server chunk ${served} is no longer on disk, so which file the frame is in is not knowable`,
          dependency: false,
        }
      }

      // Only a map beside the chunk, as Turbopack writes it: a frame is the
      // page's to send, and a `sourceMappingURL` is not followed elsewhere.
      const named = decoded(MAP_COMMENT.exec(text)?.[1] ?? '')
      const beside = named !== '' && !named.includes('/') && !named.includes('\\')
      const map = beside ? readMap(join(dirname(chunk), named)) : null
      if (!map) {
        return {
          kind: 'absent',
          mode: 'no-sourcemap',
          reason: `the server chunk ${served} has no sourcemap beside it that this server can read, so which file the frame is in is not knowable`,
          dependency: false,
        }
      }

      return {
        kind: 'chunk',
        map,
        served,
        source: (name) => sourceOf(name, written),
      }
    },
  }
}

/**
 * The chunk a server url names, as a file: the `?<n>` the Flight client adds
 * is dropped. Null for anything that is not a `file:` url.
 */
function chunkFile(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl)
    if (url.protocol !== 'file:') return null
    url.search = ''
    return fileURLToPath(url)
  } catch {
    return null
  }
}

/** A `sourceMappingURL` names a file url-encoded; the disk does not. */
function decoded(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/** A map on disk, or null for one that is not there or is no map. */
function readMap(file: string): SourceMapLike | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return isSourceMap(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * A `file:///` source as a file, and whether it changed after the chunk was
 * written. A source that is no file, such as Turbopack's own runtime, is null.
 */
function sourceOf(name: string, written: number): ChunkSource | null {
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
      modified > written
        ? {
            mode: 'no-transform-timestamp',
            reason:
              'this file has changed since Turbopack last wrote the server chunk it ran in, ' +
              "and a Server Component's frame carries no version of its chunk to compare, so " +
              'which version of the file the line belongs to is not knowable here',
          }
        : null,
  }
}
