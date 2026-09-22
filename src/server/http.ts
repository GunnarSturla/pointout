import type { ServerResponse } from 'node:http'
import type { Connect, Logger, ViteDevServer } from 'vite'
import { API_BASE, PICK_PATH, SESSIONS_PATH } from '../api.js'
import { refuseForeignOrigin, refuseNonLoopback } from './guard.js'
import type { Refusal } from './guard.js'
import { readCandidates } from './registry.js'
import type { ServerFacts } from './index.js'

// The HTTP surface (spec §20). Mounted inside `configureServer`'s body, so it
// runs ahead of Vite's own middlewares and the SPA fallback never swallows an
// unknown `/__agent` path.

/**
 * `read` is loopback-only, like everything here. `ingress` additionally requires
 * an Origin this server is serving on: the callers differ, and a browser sends
 * no Origin on a same-origin GET.
 */
type Policy = 'read' | 'ingress'

type Handler = (
  request: Connect.IncomingMessage,
  response: ServerResponse,
  facts: ServerFacts,
) => void

interface Endpoint {
  method: string
  path: string
  policy: Policy
  handle: Handler
}

const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: SESSIONS_PATH, policy: 'read', handle: sessions },
  { method: 'POST', path: PICK_PATH, policy: 'ingress', handle: pickIngestNotBuilt },
]

export function installAgentEndpoints(server: ViteDevServer, facts: ServerFacts): void {
  const { logger } = server.config
  const ownOrigins = onceOwnOrigins(server)

  // Nothing here calls `next`: every `/__agent` path is answered or refused,
  // and Vite's SPA fallback never sees one.
  server.middlewares.use(API_BASE, (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'

    // Loopback first, and for every path: whether an endpoint exists here is
    // not something a caller off this machine gets to learn.
    const offMachine = refuseNonLoopback(request)
    if (offMachine) return sendRefusal(logger, response, offMachine)

    const atPath = ENDPOINTS.filter((endpoint) => endpoint.path === path)
    if (atPath.length === 0) {
      return sendRefusal(logger, response, {
        status: 404,
        body: { error: 'unknown-endpoint', reason: `no endpoint at ${API_BASE}${path}` },
      })
    }

    const endpoint = atPath.find((allowed) => allowed.method === request.method)
    if (!endpoint) {
      return sendRefusal(logger, response, {
        status: 405,
        body: {
          error: 'method-not-allowed',
          reason: `${API_BASE}${path} answers ${atPath
            .map((allowed) => allowed.method)
            .join(', ')}, not ${request.method}`,
        },
      })
    }

    if (endpoint.policy === 'ingress') {
      const foreign = refuseForeignOrigin(request, ownOrigins())
      if (foreign) return sendRefusal(logger, response, foreign)
    }

    return endpoint.handle(request, response, facts)
  })
}

function sessions(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  facts: ServerFacts,
): void {
  const { registry, candidates } = readCandidates(facts)
  sendJson(response, 200, {
    registry: {
      state: registry.state,
      hookFloor: registry.hookFloor,
      rejected: registry.rejected,
      directory: registry.directory,
    },
    candidates,
  })
}

function pickIngestNotBuilt(
  request: Connect.IncomingMessage,
  response: ServerResponse,
): void {
  // The Guard covers this path from ticket 02 on; the ingest itself is ticket 03.
  sendJson(response, 404, {
    error: 'not-implemented',
    reason: 'Pick ingest is not built yet: this dev server accepts no Pick.',
  })
}

/**
 * The origins this dev server is actually serving on. Vite knows them only once
 * it is listening, and no request can arrive before that, so they are worked
 * out on the first one and kept.
 */
function onceOwnOrigins(server: ViteDevServer): () => Set<string> {
  let origins: Set<string> | null = null

  return () => {
    if (origins) return origins
    origins = new Set<string>()

    const resolved = server.resolvedUrls
    for (const url of [...(resolved?.local ?? []), ...(resolved?.network ?? [])]) {
      try {
        origins.add(new URL(url).origin)
      } catch {
        // Vite printed something that is not a URL. Nothing to allow.
      }
    }

    // Vite lists the URLs it advertises; the Overlay can also be loaded through
    // any loopback spelling of the port it is bound to.
    const address = server.httpServer?.address()
    if (address && typeof address === 'object') {
      const scheme = server.config.server.https ? 'https' : 'http'
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        origins.add(`${scheme}://${host}:${address.port}`)
      }
    }
    return origins
  }
}

function sendRefusal(logger: Logger, response: ServerResponse, refusal: Refusal): void {
  logger.warn(`vite-agent-inspect: ${refusal.body.reason}`)
  sendJson(response, refusal.status, refusal.body)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}
