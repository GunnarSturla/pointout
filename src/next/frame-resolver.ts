import type { Server as NetServer } from 'node:net'
import type { FrameAnswer, FrameResolver } from '../server/frame-resolver.js'
import { clientChunks } from './client-chunks.js'
import { serverChunks } from './server-chunks.js'

// The Next.js Connector's frame resolver (ADR-0005): which of its resolvers a
// frame belongs to, read off its url, and nothing else. Each resolver lives in
// a module of its own and none imports another: the maintainer asked for the
// source-map resolvers to be cleanly apart.
//
// - A Server Component's frame, `about://React/Server/…`: `server-chunks.ts`,
//   which reads the server chunk and its map off disk.
// - A Turbopack client chunk, `/_next/static/chunks/…`: `client-chunks.ts`,
//   which asks Next for the map it serves.

export interface NextFrameResolverOptions {
  /** Next's listening server, which pages load client chunks from. */
  server: NetServer
  /** That server's loopback origin, which a client chunk's map is asked of. */
  origin: string
  /** The project Next serves, which every server chunk is below. */
  projectDir: string
}

export function nextFrameResolver({
  server,
  origin,
  projectDir,
}: NextFrameResolverOptions): FrameResolver {
  const client = clientChunks(server, origin)
  const onServer = serverChunks(projectDir)

  return async (frame): Promise<FrameAnswer> => {
    if (onServer.claims(frame.url)) return onServer.resolve(frame.url)

    const url = frameUrl(frame.url)
    if (!url) {
      return {
        kind: 'absent',
        mode: 'unreadable-frame',
        reason: 'its frame names no url this server can read',
        dependency: false,
      }
    }
    if (client.claims(url)) return client.resolve(url, frame)

    return {
      kind: 'absent',
      mode: 'module-not-in-graph',
      reason: `${url.pathname} is no chunk this dev server serves`,
      dependency: false,
    }
  }
}

/**
 * A frame's url, parsed. Null for a frame that names no url at all, and the
 * frame's own text never travels with the refusal: the raw stacks are Excerpts
 * and nothing lifted from one is ever interpolated into the body (spec §13).
 */
function frameUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
