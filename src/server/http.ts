import type { ServerResponse } from 'node:http'
import type { Connect, Logger, ViteDevServer } from 'vite'
import { API_BASE, PICK_PATH, SESSIONS_PATH } from '../api.js'
import type { DeliveryRoute } from './delivery.js'
import { refuseForeignOrigin, refuseNonLoopback } from './guard.js'
import type { Refusal } from './guard.js'
import { parsePickBody, readRequestBody } from './pick.js'
import { createPickQueue } from './queue.js'
import type { PickQueue } from './queue.js'
import { readCandidates } from './registry.js'
import { renderPicks } from './render.js'
import { resolveTarget } from './targeting.js'
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

/** Everything the endpoints share, worked out once per dev server. */
interface RequestContext {
  facts: ServerFacts
  queue: PickQueue
  route: DeliveryRoute
  logger: Logger
  /** This server's own loopback origin: the ack and done URLs hang off it. */
  origin(): string
}

type Handler = (
  request: Connect.IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
) => void | Promise<void>

interface Endpoint {
  method: string
  path: string
  policy: Policy
  handle: Handler
}

const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: SESSIONS_PATH, policy: 'read', handle: sessions },
  { method: 'POST', path: PICK_PATH, policy: 'ingress', handle: ingestPick },
]

export function installAgentEndpoints(
  server: ViteDevServer,
  facts: ServerFacts,
  route: DeliveryRoute,
): void {
  const { logger } = server.config
  const ownOrigins = onceOwnOrigins(server)
  const context: RequestContext = {
    facts,
    route,
    logger,
    queue: createPickQueue(),
    origin: () => loopbackOrigin(server),
  }

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

    // A handler that throws is a bug in this plugin, and a bug that answered
    // nothing would look to the Overlay like a network that dropped the Pick.
    Promise.resolve(endpoint.handle(request, response, context)).catch((error: Error) => {
      logger.error(
        `vite-agent-inspect: ${API_BASE}${path} threw: ${error.stack ?? error.message}`,
      )
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: 'internal-error',
          reason: `vite-agent-inspect failed to answer ${API_BASE}${path}: ${error.message}`,
        })
      }
    })
    return undefined
  })
}

function sessions(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { facts }: RequestContext,
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

/**
 * Pick ingest (spec §11, §13, §14, §15): check the body, mint the Pick, resolve
 * the Target, queue it, render it, and write it. Every refusal names its part;
 * an accepted Pick that could not be addressed is still accepted, and says so.
 */
async function ingestPick(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  const { facts, queue, route, logger } = context

  const body = await readRequestBody(request)
  if (!body.ok) return sendRefusal(logger, response, body.refusal)

  const parsed = parsePickBody(body.value)
  if (!parsed.ok) return sendRefusal(logger, response, parsed.refusal)
  const pick = parsed.value

  const { candidates } = readCandidates(facts)
  const choice = resolveTarget(pick.target, candidates)
  if (!choice.ok) return sendRefusal(logger, response, choice.refusal)

  // The entry carries the Target it was resolved to, not the one the body
  // named: a preselected Pick was addressed here, and the queue is what knows it.
  pick.target = choice.target
    ? { sessionId: choice.target.sessionId, pid: choice.target.pid }
    : null

  const entry = queue.add(pick)
  let unwritten: string | undefined

  if (pick.target) {
    const outcome = await route.deliver({
      pickId: pick.id,
      body: renderPicks([pick], { origin: context.origin() }),
      target: pick.target,
    })
    if (outcome.written) queue.markSent(pick.id)
    else {
      unwritten = outcome.reason
      logger.warn(
        `vite-agent-inspect: pick ${pick.id} was not delivered: ${outcome.reason}`,
      )
    }
  }

  // The Pick id, and the queue state that says whether anything was written.
  // The Target row, the chip words and every later state belong to ticket 11's
  // status endpoint; what a 200 must not be is silent about a Pick that went
  // nowhere (spec §21).
  sendJson(response, 200, {
    pickId: pick.id,
    state: entry.state,
    ...(unwritten ? { reason: unwritten } : {}),
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

/**
 * The origin the ack and done URLs are printed with. Loopback by address, not
 * by name: the caller is the agent's shell on this machine, and a hostname it
 * would have to resolve is one more thing that can be wrong.
 *
 * In middleware mode there is no `httpServer` and no port to print — but there
 * are also no `resolvedUrls`, so `onceOwnOrigins` is empty and every Pick is
 * already refused at the Origin check before a body is ever rendered.
 */
function loopbackOrigin(server: ViteDevServer): string {
  const address = server.httpServer?.address()
  const port = address && typeof address === 'object' ? address.port : 0
  const scheme = server.config.server.https ? 'https' : 'http'
  return `${scheme}://127.0.0.1:${port}`
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
