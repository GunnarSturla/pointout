import type { Server as NetServer } from 'node:net'
import type { FrameAnswer, FrameResolver } from '../server/frame-resolver.js'
import { clientChunks } from './client-chunks.js'

// The Next.js Connector's frame resolver (ADR-0005): which of its resolvers a
// frame belongs to, read off its url, and nothing else. Each resolver lives in
// a module of its own and none imports another: the maintainer asked for the
// source-map resolvers to be cleanly apart.
//
// - A Turbopack client chunk, `/_next/static/chunks/…`: `client-chunks.ts`.
// - A Server Component's frame, `about://React/Server/…`, is not read yet
//   (ticket 08), and is answered `absent` with that reason rather than guessed.

/** How React prints a frame it replayed from the server. */
const SERVER_FRAME = 'about://React/Server/'

export function nextFrameResolver(server: NetServer, origin: string): FrameResolver {
  const client = clientChunks(server, origin)

  return async (frame): Promise<FrameAnswer> => {
    if (frame.url.startsWith(SERVER_FRAME)) {
      return {
        kind: 'absent',
        mode: 'no-resolver-for-host',
        reason: "the Next.js Connector does not read a Server Component's frames yet",
        dependency: false,
      }
    }

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
