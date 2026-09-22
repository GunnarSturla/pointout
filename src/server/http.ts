import type { ServerResponse } from 'node:http'
import type { Connect, Logger, ViteDevServer } from 'vite'
import {
  API_BASE,
  CAPTURE_PATH,
  NONCE_PARAM,
  PICK_PATH,
  SESSIONS_PATH,
  STATUS_PATH,
  parseCaptureId,
  parsePickAction,
} from '../api.js'
import type { PickAction } from '../api.js'
import type { CaptureService } from './capture/index.js'
import { parseCaptureBody } from './capture/region.js'
import { now } from './clock.js'
import type { DeliveryRoute } from './delivery.js'
import { refuseForeignOrigin, refuseNonLoopback, refuseWrongNonce } from './guard.js'
import type { Refusal } from './guard.js'
import { DONE, FAILED, SENT, TTL_FAILURE, WORKING, createLedger } from './ledger.js'
import type { Ledger } from './ledger.js'
import { resolveOwnerChain } from './owner-chain.js'
import { parsePickBody, readRequestBody } from './pick.js'
import { QUEUED_UNADDRESSED, createPickQueue } from './queue.js'
import type { PickQueue } from './queue.js'
import { readCandidates } from './registry.js'
import { renderPicks } from './render.js'
import { pickStatuses } from './status.js'
import { resolveTarget } from './targeting.js'
import type { ServerFacts } from './index.js'

// The HTTP surface (spec §20). Mounted inside `configureServer`'s body, so it
// runs ahead of Vite's own middlewares and the SPA fallback never swallows an
// unknown `/__agent` path.

/**
 * `read` is loopback-only, like everything here. `ingress` additionally requires
 * an Origin this server is serving on: the callers differ, and a browser sends
 * no Origin on a same-origin GET. `credential` is the agent's own shell, which
 * carries the Pick's nonce and sends no Origin at all — so an Origin is checked
 * there only when one is present (spec §11).
 */
type Policy = 'read' | 'ingress' | 'credential'

/** Everything the endpoints share, worked out once per dev server. */
interface RequestContext {
  facts: ServerFacts
  /** The dev server itself: the module graph is where an Owner chain is remapped. */
  server: ViteDevServer
  queue: PickQueue
  /** What became of every Pick, after its entry has left the queue. */
  ledger: Ledger
  route: DeliveryRoute
  /** Screen Capture, available or disabled with its reason (spec §10). */
  captures: CaptureService
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
  /** How this endpoint is named in a refusal, and how an exact path is matched. */
  path: string
  /** For a path with a Pick id in it. Exact equality on `path` otherwise. */
  matches?: (path: string) => boolean
  policy: Policy
  handle: Handler
}

/** `POST /__agent/pick/<id>/ack` and its twin: the Pick's nonce is the credential. */
function pickActionEndpoint(action: PickAction): Endpoint {
  return {
    method: 'POST',
    path: `${PICK_PATH}/<id>/${action}`,
    matches: (path) => parsePickAction(path)?.action === action,
    policy: 'credential',
    handle: (request, response, context) =>
      recordPickAction(action, request, response, context),
  }
}

const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: SESSIONS_PATH, policy: 'read', handle: sessions },
  { method: 'GET', path: STATUS_PATH, policy: 'read', handle: reportStatus },
  { method: 'POST', path: PICK_PATH, policy: 'ingress', handle: ingestPick },
  { method: 'POST', path: CAPTURE_PATH, policy: 'ingress', handle: startCapture },
  {
    method: 'DELETE',
    path: `${CAPTURE_PATH}/<id>`,
    matches: (path) => parseCaptureId(path) !== null,
    policy: 'ingress',
    handle: abortCapture,
  },
  pickActionEndpoint('ack'),
  pickActionEndpoint('done'),
]

export function installAgentEndpoints(
  server: ViteDevServer,
  facts: ServerFacts,
  route: DeliveryRoute,
  captures: CaptureService,
): void {
  const { logger } = server.config
  const ownOrigins = onceOwnOrigins(server)
  const context: RequestContext = {
    facts,
    server,
    route,
    captures,
    logger,
    queue: createPickQueue(),
    ledger: createLedger(now),
    origin: () => loopbackOrigin(server),
  }

  // Nothing here calls `next`: every `/__agent` path is answered or refused,
  // and Vite's SPA fallback never sees one.
  server.middlewares.use(API_BASE, (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'

    // Loopback first, and for every path: whether an endpoint exists here is
    // not something a caller off this machine gets to learn, and a caller off
    // this machine makes this server do nothing else either.
    const offMachine = refuseNonLoopback(request)
    if (offMachine) return sendRefusal(logger, response, offMachine)

    // Before anything is matched, let alone handled: an entry past its TTL has
    // left the queue by the time any route could reach it (spec §15).
    expireStale(context)

    const atPath = ENDPOINTS.filter((endpoint) =>
      endpoint.matches ? endpoint.matches(path) : endpoint.path === path,
    )
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

    // An Origin is required on ingress and merely checked on the credential
    // endpoints: a shell sends none, and a browser that sent one must still be
    // this dev server's own page (spec §11).
    const originMatters =
      endpoint.policy === 'ingress' ||
      (endpoint.policy === 'credential' && request.headers.origin !== undefined)
    if (originMatters) {
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
 * Every Pick this dev server accepted, in the state the ledger holds it, with
 * the Target row read live beside each (spec §17, §20). Loopback like the rest,
 * and no Origin requirement: the Overlay polls it on a same-origin GET.
 */
function reportStatus(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { facts, queue, ledger }: RequestContext,
): void {
  sendJson(response, 200, { picks: pickStatuses(facts, queue, ledger) })
}

/**
 * Ack and done (spec §11, §17). The nonce is the credential; an unknown Pick and
 * a wrong nonce are each refused with no state changed. The ack takes the entry
 * out of the claim-once queue, which is what keeps a developer who types before
 * the agent answers from receiving the same Pick a second time (spec §15).
 */
function recordPickAction(
  action: PickAction,
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { queue, ledger, logger }: RequestContext,
): void {
  const url = request.url ?? '/'
  const [path = '/', query = ''] = url.split('?')
  const parsed = parsePickAction(path)
  const record = parsed ? ledger.get(parsed.pickId) : undefined
  if (!record) {
    return sendRefusal(logger, response, {
      status: 404,
      body: {
        error: 'unknown-pick',
        reason:
          `refused an ${action} for a pick this dev server never accepted. ` +
          'A pick is known only to the server that minted it.',
      },
    })
  }

  const wrongNonce = refuseWrongNonce(
    new URLSearchParams(query).get(NONCE_PARAM),
    record.pick.nonce,
  )
  if (wrongNonce) return sendRefusal(logger, response, wrongNonce)

  // Done as well as ack: a finished Pick is not one the floor may hand out.
  queue.remove(record.pick.id)
  const state = action === 'ack' ? WORKING : DONE
  ledger.advance(record.pick.id, state)
  sendJson(response, 200, { pickId: record.pick.id, state })
}

/**
 * Spec §15 and §21: an entry nobody drained within its TTL leaves the queue,
 * and says so — in the log and in the ledger — rather than quietly staying put.
 */
function expireStale({ queue, ledger, logger }: RequestContext): void {
  for (const entry of queue.sweep(now())) {
    ledger.advance(entry.pick.id, FAILED, TTL_FAILURE)
    logger.warn(`vite-agent-inspect: pick ${entry.pick.id} expired. ${TTL_FAILURE}`)
  }
}

/**
 * Start a Screen Capture (spec §10, §20). The id is answered at once and the
 * tool runs behind it: the Panel's entrance is never gated on a capture. One
 * that is disabled answers the reason it is disabled, at the point of use as
 * well as in the startup posture block (spec §21).
 */
async function startCapture(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { captures, logger }: RequestContext,
): Promise<void> {
  if (captures.disabledReason) {
    return sendRefusal(logger, response, {
      status: 409,
      body: { error: 'capture-disabled', reason: captures.disabledReason },
    })
  }

  const body = await readRequestBody(request)
  if (!body.ok) return sendRefusal(logger, response, body.refusal)

  const coordinates = parseCaptureBody(body.value)
  if (!coordinates.ok) return sendRefusal(logger, response, coordinates.refusal)

  sendJson(response, 200, { captureId: captures.start(coordinates.value) })
}

/**
 * Abort and delete (spec §10): the developer moved the Pick, or discarded it.
 * Idempotence is not claimed — a second DELETE names a capture this server no
 * longer holds, and says so.
 */
function abortCapture(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { captures, logger }: RequestContext,
): void {
  const path = (request.url ?? '/').split('?')[0] ?? '/'
  const id = parseCaptureId(path)
  if (!id || !captures.abort(id)) {
    return sendRefusal(logger, response, {
      status: 404,
      body: {
        error: 'unknown-capture',
        reason:
          'refused to abort a capture this dev server is not holding. It was ' +
          'aborted already, or it was never started here.',
      },
    })
  }
  sendJson(response, 200, { captureId: id, deleted: true })
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
  const { facts, queue, ledger, route, logger } = context

  const body = await readRequestBody(request)
  if (!body.ok) return sendRefusal(logger, response, body.refusal)

  const parsed = parsePickBody(body.value)
  if (!parsed.ok) return sendRefusal(logger, response, parsed.refusal)
  const pick = parsed.value

  // Resolved here, at ingest, against the module graph as it stands now: a Pick
  // drained an hour later must carry the position its frames meant when it was
  // made, not one remapped through a transform that has moved since (spec §12).
  pick.pointer.ownerChain = await resolveOwnerChain(
    context.server,
    facts.root,
    pick.ownerLinks,
  )

  const { candidates } = readCandidates(facts)
  const choice = resolveTarget(pick.target, candidates)
  if (!choice.ok) return sendRefusal(logger, response, choice.refusal)

  // The entry carries the Target it was resolved to, not the one the body
  // named: a preselected Pick was addressed here, and the queue is what knows it.
  pick.target = choice.target
    ? { sessionId: choice.target.sessionId, pid: choice.target.pid }
    : null

  // The capture the Overlay started at pick time becomes one prose line, or
  // nothing at all — and the file is deleted here when the toggle was off. A
  // capture that failed never stops the Pick: it says so and travels (spec §10).
  pick.captureLine = await context.captures.resolve(pick.captureRequest)

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

  // A write that failed leaves the Pick `queued-unaddressed` rather than
  // `failed`: the hook floor can still take it, and the reason is carried so
  // nothing about the attempt is silent (spec §21).
  ledger.open(
    entry,
    entry.state === QUEUED_UNADDRESSED ? QUEUED_UNADDRESSED : SENT,
    unwritten,
  )

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
