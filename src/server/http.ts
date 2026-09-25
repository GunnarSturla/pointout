import type { ServerResponse } from 'node:http'
import type { Connect, Logger, ViteDevServer } from 'vite'
import {
  API_BASE,
  CAPTURE_PATH,
  DRAIN_PATH,
  NONCE_PARAM,
  PICK_PATH,
  SESSIONS_PATH,
  STATUS_PATH,
  parseCaptureId,
  parsePickAction,
  parseReportPath,
  parseWithdrawPath,
} from '../api.js'
import type { PickAction } from '../api.js'
import {
  CAPTURE_DISABLED,
  CLOCK_OFFERED,
  UNKNOWN_CAPTURE,
  UNKNOWN_PICK,
  DONE,
  NOT_WITHDRAWABLE,
  OFFERABLE,
  QUEUED_UNADDRESSED,
  REQUEUE,
  SENT,
  SENT_AWAITING_ACK,
  WORKING,
  isWithdrawable,
} from '../wire.js'
import type {
  CaptureDeleted,
  CaptureStarted,
  NamedTarget,
  NotWithdrawableBody,
  PickAccepted,
  PickActionAnswer,
  PickState,
  ReportAnswer,
  SessionsResponse,
  StatusResponse,
  WithdrawAnswer,
} from '../wire.js'
import { boundAddress } from './bound-host.js'
import type { CaptureService } from './capture/index.js'
import { parseCaptureBody } from './capture/region.js'
import { now } from './clock.js'
import type { DeliveryOutcome, DeliveryRoute } from './delivery.js'
import type { Discovery } from './discovery.js'
import { drainQueue, parseDrainBody, refuseDrainCaller } from './drain.js'
import { refuseForeignOrigin, refuseNonLoopback, refuseWrongNonce } from './guard.js'
import type { Refusal } from './guard.js'
import { createLedger, writtenTo } from './ledger.js'
import type { Ledger } from './ledger.js'
import { resolveOwnerChain } from './owner-chain.js'
import { readRequestBody } from './parse.js'
import { fitPayload } from './payload.js'
import { mintPick, parsePickBody, reissuePick } from './pick.js'
import type { Pick } from './pick.js'
import { createIdleLog, recordReplies } from './receipt.js'
import type { IdleLog } from './receipt.js'
import { addresses, readCandidates, sessionOf } from './registry.js'
import type { Registry } from './registry.js'
import { createReportBackClock, parseReportBody } from './report-back.js'
import type { ReportBackClock } from './report-back.js'
import { pickStatuses } from './status.js'
import { resolveTarget } from './targeting.js'
import type { ServerFacts, Services } from './index.js'

// The HTTP surface (spec §20). Mounted inside `configureServer`'s body, so it
// runs ahead of Vite's own middlewares and the SPA fallback never swallows an
// unknown `/__agent` path.

/**
 * `read` is loopback-only, like everything here. `ingress` additionally requires
 * an Origin this server is serving on: the callers differ, and a browser sends
 * no Origin on a same-origin GET. `credential` is a caller that carries one of
 * its own — the agent's shell with the Pick's nonce, or the drain CLI with this
 * server's secret — and sends no Origin at all, so an Origin is checked there
 * only when one is present (spec §11).
 */
type Policy = 'read' | 'ingress' | 'credential'

/** Everything the endpoints share, worked out once per dev server. */
interface RequestContext {
  facts: ServerFacts
  /** The dev server itself: the module graph is where an Owner chain is remapped. */
  server: ViteDevServer
  /** What became of every Pick, and which of them may still be delivered. */
  ledger: Ledger
  /** When each Target last finished a turn. Never moves a Pick (spec §17). */
  idle: IdleLog
  /** Each written Pick's report-back clock (spec §17). */
  clock: ReportBackClock
  route: DeliveryRoute
  /** Screen Capture, available or disabled with its reason (spec §10). */
  captures: CaptureService
  /** The hook discovery entry, whose secret is the drain's credential (§18). */
  discovery: Discovery
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
  {
    method: 'POST',
    path: `${PICK_PATH}/<id>/report`,
    matches: (path) => parseReportPath(path) !== null,
    policy: 'ingress',
    handle: resolveReport,
  },
  {
    method: 'DELETE',
    path: `${PICK_PATH}/<id>`,
    matches: (path) => parseWithdrawPath(path) !== null,
    policy: 'ingress',
    handle: withdrawPick,
  },
  { method: 'POST', path: DRAIN_PATH, policy: 'credential', handle: drainPicks },
]

export function installAgentEndpoints(
  server: ViteDevServer,
  facts: ServerFacts,
  { route, captures, discovery }: Services,
): void {
  const { logger } = server.config
  const ownOrigins = onceOwnOrigins(server)
  const ledger = createLedger(now)
  const context: RequestContext = {
    facts,
    server,
    route,
    captures,
    discovery,
    logger,
    ledger,
    idle: createIdleLog(),
    clock: createReportBackClock({ ledger, logger }),
    origin: () => loopbackOrigin(server),
  }

  // The route bound its reply address before this server had a ledger to move.
  // It has one now, so what comes back stops being logged and starts counting.
  recordReplies(route, context)

  // Nothing here calls `next`: every `/__agent` path is answered or refused,
  // and Vite's SPA fallback never sees one.
  server.middlewares.use(API_BASE, (request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'

    // Loopback first, and for every path: whether an endpoint exists here is
    // not something a caller off this machine gets to learn, and a caller off
    // this machine makes this server do nothing else either.
    const offMachine = refuseNonLoopback(request)
    if (offMachine) return sendRefusal(logger, response, offMachine)

    // Before anything is matched, let alone handled: the report-back clock has
    // read the registry, and a Pick past its TTL has left the queue by the time
    // any route could reach it (spec §15, §17).
    tickReportBack(context)
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
  const answer: SessionsResponse = {
    registry: {
      state: registry.state,
      hookFloor: registry.hookFloor,
      rejected: registry.rejected,
      directory: registry.directory,
    },
    candidates,
  }
  sendJson(response, 200, answer)
}

/**
 * Every Pick this dev server accepted, in the state the ledger holds it, with
 * the Target row read live beside each (spec §17, §20). Loopback like the rest,
 * and no Origin requirement: the Overlay polls it on a same-origin GET.
 */
function reportStatus(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { facts, ledger, idle, clock }: RequestContext,
): void {
  const answer: StatusResponse = { picks: pickStatuses(facts, ledger, idle, clock) }
  sendJson(response, 200, answer)
}

/**
 * Ack and done (spec §11, §17). The nonce is the credential; an unknown Pick and
 * a wrong nonce are each refused with no state changed. Either takes the Pick
 * out of the claim-once queue, which is what keeps a developer who types before
 * the agent answers from receiving the same Pick a second time (spec §15).
 */
function recordPickAction(
  action: PickAction,
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { ledger, logger }: RequestContext,
): void {
  const url = request.url ?? '/'
  const [path = '/', query = ''] = url.split('?')
  const parsed = parsePickAction(path)
  const record = parsed ? ledger.get(parsed.pickId) : undefined
  if (!record) {
    return sendRefusal(logger, response, {
      status: 404,
      body: {
        error: UNKNOWN_PICK,
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

  const state = action === 'ack' ? WORKING : DONE
  ledger.advance(record.pick.id, state)
  const answer: PickActionAnswer = { pickId: record.pick.id, state }
  sendJson(response, 200, answer)
}

/**
 * The hook floor (spec §15, §18). The drain CLI asks on every prompt and at the
 * end of every turn, so the empty answer is the common one and costs nothing;
 * a drain that claims Picks says so in the log, because nothing else tells the
 * developer it happened — the harness writes no transcript entry for a hook.
 */
async function drainPicks(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { facts, ledger, discovery, logger, origin }: RequestContext,
): Promise<void> {
  const body = await readRequestBody(request)
  if (!body.ok) return sendRefusal(logger, response, body.refusal)

  const parsed = parseDrainBody(body.value)
  if (!parsed.ok) return sendRefusal(logger, response, parsed.refusal)

  const refused = refuseDrainCaller(parsed.value, {
    secret: discovery.secret,
    root: facts.root,
  })
  if (refused) return sendRefusal(logger, response, refused)

  const drained = drainQueue({ ledger, origin: origin(), budget: parsed.value.budget })
  if (drained.reason) logger.warn(`vite-agent-inspect: ${drained.reason}`)
  else if (drained.drained > 0) {
    logger.info(
      `vite-agent-inspect: ${drained.drained} ` +
        `${drained.drained === 1 ? 'pick' : 'picks'} drained into ${parsed.value.event}` +
        (drained.remaining > 0 ? `, ${drained.remaining} still queued` : ''),
    )
  }
  sendJson(response, 200, drained)
}

/**
 * Spec §15 and §21: a Pick nobody drained within its TTL leaves the queue, and
 * says so — in the log and in the ledger — rather than quietly staying put.
 */
function expireStale({ ledger, logger }: RequestContext): void {
  for (const record of ledger.expire(now())) {
    logger.warn(`vite-agent-inspect: pick ${record.pick.id} expired. ${record.reason}`)
  }
}

/**
 * One registry sample for every report-back clock still running (spec §17).
 * Blind is null: a registry that cannot be read, or a Target no longer in it,
 * leaves the clock with no signal, and only the TTL governs from there.
 */
function tickReportBack({ facts, clock }: RequestContext): void {
  if (!clock.running()) return
  const { registry } = readCandidates(facts)
  clock.observe(now(), (target) => {
    if (registry.hookFloor) return null
    return registry.entries.find((entry) => addresses(entry, target))?.status ?? null
  })
}

/**
 * Resolve a report-back offer (spec §17, §20): leave the Pick for whoever the
 * developer prompts next, or send it to another session as a new Pick. Only an
 * offer is resolved: a Pick the agent acked in the meantime, or one never
 * offered back, is refused with what it is instead, and nothing moves.
 */
async function resolveReport(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  const { facts, ledger, clock, logger } = context
  const path = (request.url ?? '/').split('?')[0] ?? '/'
  const pickId = parseReportPath(path)
  const record = pickId ? ledger.get(pickId) : undefined
  if (!record) {
    return sendRefusal(logger, response, {
      status: 404,
      body: {
        error: UNKNOWN_PICK,
        reason: 'refused a report for a pick this dev server never accepted.',
      },
    })
  }

  const body = await readRequestBody(request)
  if (!body.ok) return sendRefusal(logger, response, body.refusal)
  const parsed = parseReportBody(body.value)
  if (!parsed.ok) return sendRefusal(logger, response, parsed.refusal)

  const oldId = record.pick.id
  const offered =
    clock.stateOf(oldId)?.state === CLOCK_OFFERED && OFFERABLE.includes(record.state)
  if (!offered) {
    return sendRefusal(logger, response, {
      status: 409,
      body: {
        error: 'no-offer',
        reason:
          `refused to resolve pick ${oldId}: it was not offered back, ` +
          `and it is ${record.state} now.`,
      },
    })
  }

  // From the check above to the moment the offer is taken, nothing here awaits:
  // a second resolution arriving meanwhile — a double click, or the countdown
  // running out under a retarget — finds no offer and is refused.
  if (parsed.value.resolve === REQUEUE) {
    ledger.requeue(oldId, now())
    clock.forget(oldId)
    logger.info(
      `vite-agent-inspect: pick ${oldId} is left for the next prompt in ` +
        'this repo, with a fresh 30 minutes.',
    )
    const answer: ReportAnswer = { pickId: oldId, state: QUEUED_UNADDRESSED }
    return sendJson(response, 200, answer)
  }

  // A retarget is re-checked like any named Target: never silently exchanged
  // for another, and a 409 names the replacement when there is one (spec §14).
  const { registry, candidates } = readCandidates(facts)
  const choice = resolveTarget(parsed.value.target, candidates)
  if (!choice.ok) return sendRefusal(logger, response, choice.refusal)
  // A named Target that resolves is always a Candidate; this only narrows it.
  const chosen = choice.target
  if (!chosen) throw new Error(`a retarget of pick ${oldId} resolved to no session`)
  const target: NamedTarget = {
    sessionId: chosen.sessionId,
    pid: chosen.pid,
    name: chosen.name,
  }

  const reissued = reissuePick(record.pick, target, writtenTo(record).targetName)
  const fitted = fitPayload(reissued, {
    origin: context.origin(),
  })
  if (!fitted.ok) return sendRefusal(logger, response, fitted.refusal)
  const { pick, body: rendered } = fitted.value

  // The old entry goes before the write: its id's ack and done URLs answer for
  // nothing now, and the Pick lives on under the new one.
  ledger.remove(oldId)
  clock.forget(oldId)

  const unwritten = await deliverRendered(context, registry, pick, rendered)
  const state: PickState = unwritten === undefined ? SENT : QUEUED_UNADDRESSED
  ledger.open(pick, state, unwritten)
  if (unwritten === undefined) clock.watch(pick.id, target, now(), chosen.status)
  logger.info(
    `vite-agent-inspect: pick ${oldId} was sent again to ${target.name} as pick ${pick.id}.`,
  )

  const answer: ReportAnswer = {
    pickId: pick.id,
    state,
    replaces: oldId,
    ...(unwritten ? { reason: unwritten } : {}),
  }
  sendJson(response, 200, answer)
}

/**
 * Withdraw (`CONTEXT.md`, spec §20): the developer takes back a submitted Pick
 * that went wrong. Everything this server still holds of it goes — the queue
 * entry, the report-back clock, the Screen Capture, the ledger row — and the
 * answer says whether a session already has it, because nothing here can take
 * a write back (spec §21). A Pick an agent acknowledged, finished or is holding
 * is refused with the state it is in, and nothing moves.
 */
function withdrawPick(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  { ledger, clock, captures, logger }: RequestContext,
): void {
  const path = (request.url ?? '/').split('?')[0] ?? '/'
  const pickId = parseWithdrawPath(path)
  const record = pickId ? ledger.get(pickId) : undefined
  if (!record) {
    return sendRefusal(logger, response, {
      status: 404,
      body: {
        error: UNKNOWN_PICK,
        reason:
          'refused to withdraw a pick this dev server is not holding. It was ' +
          'withdrawn already, or it was never accepted here.',
      },
    })
  }

  const id = record.pick.id
  const reportBack = clock.stateOf(id)
  if (!isWithdrawable(record.state, reportBack)) {
    const body: NotWithdrawableBody = {
      error: NOT_WITHDRAWABLE,
      reason:
        `refused to withdraw pick ${id}: it is ${record.state}` +
        // Only a Pick with a clock can still be offered back; a drained one
        // has none, and waits for its TTL instead.
        (reportBack ? ', and it has not been offered back.' : '.'),
      state: record.state,
    }
    return sendRefusal(logger, response, { status: 409, body })
  }

  // Nothing awaits between the check and the removal: a drain, an ack or a
  // second withdraw arriving meanwhile finds no Pick.
  const written = writtenTo(record)
  ledger.remove(id)
  clock.forget(id)
  if (record.pick.captureFile) captures.discard(record.pick.captureFile)

  logger.info(
    `vite-agent-inspect: pick ${id} was withdrawn. ` +
      (written.alreadyWritten
        ? `It had already been written to ${written.targetName ?? 'a prompt in this repo'}, ` +
          'which may still act on it: a write cannot be recalled.'
        : 'No session had it.'),
  )
  const answer: WithdrawAnswer = { pickId: id, ...written }
  sendJson(response, 200, answer)
}

/**
 * Write one rendered Pick to its Target's socket. Undefined when it was
 * written; otherwise the reason it was not, which is logged here and carried by
 * the caller — a Pick that went nowhere is never silent about it (spec §21).
 */
async function deliverRendered(
  { route, logger }: RequestContext,
  registry: Registry,
  pick: Pick,
  rendered: string,
): Promise<string | undefined> {
  if (!pick.target) return undefined
  const session = sessionOf(registry, pick.target)
  const outcome: DeliveryOutcome = session
    ? await route.deliver({
        pickId: pick.id,
        body: rendered,
        target: pick.target,
        session,
      })
    : {
        written: false,
        reason: `session ${pick.target.sessionId} is no longer in the registry`,
      }
  if (outcome.written) return undefined
  logger.warn(`vite-agent-inspect: pick ${pick.id} was not delivered: ${outcome.reason}`)
  return outcome.reason
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
      body: { error: CAPTURE_DISABLED, reason: captures.disabledReason },
    })
  }

  const body = await readRequestBody(request)
  if (!body.ok) return sendRefusal(logger, response, body.refusal)

  const coordinates = parseCaptureBody(body.value)
  if (!coordinates.ok) return sendRefusal(logger, response, coordinates.refusal)

  const answer: CaptureStarted = { captureId: captures.start(coordinates.value) }
  sendJson(response, 200, answer)
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
        error: UNKNOWN_CAPTURE,
        reason:
          'refused to abort a capture this dev server is not holding. It was ' +
          'aborted already, or it was never started here.',
      },
    })
  }
  const answer: CaptureDeleted = { captureId: id, deleted: true }
  sendJson(response, 200, answer)
}

/**
 * Pick ingest (spec §11, §13, §14, §15): check the body, resolve what it names,
 * mint the Pick, fit it under the cap, write it, ledger it. Every refusal names
 * its part; an accepted Pick that could not be addressed is still accepted, and
 * says so.
 */
async function ingestPick(
  request: Connect.IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  const { facts, ledger, clock, captures, logger } = context

  const body = await readRequestBody(request)
  if (!body.ok) return sendRefusal(logger, response, body.refusal)

  const parsed = parsePickBody(body.value)
  if (!parsed.ok) return sendRefusal(logger, response, parsed.refusal)
  const input = parsed.value

  // Resolved here, at ingest, against the module graph as it stands now: a Pick
  // drained an hour later must carry the position its frames meant when it was
  // made, not one remapped through a transform that has moved since (spec §12).
  const ownerChain = await resolveOwnerChain(context.server, facts.root, input.ownerChain)

  // The Pick carries the Target it was resolved to, not the one the body named:
  // a preselected Pick was addressed here, and the ledger is what knows it.
  const { registry, candidates } = readCandidates(facts)
  const choice = resolveTarget(input.target, candidates)
  if (!choice.ok) return sendRefusal(logger, response, choice.refusal)
  const target: NamedTarget | null = choice.target
    ? {
        sessionId: choice.target.sessionId,
        pid: choice.target.pid,
        name: choice.target.name,
      }
    : null

  // The capture the Overlay started at pick time becomes one prose line, or
  // nothing at all. A capture that failed never stops the Pick: it says so and
  // travels (spec §10). Nothing is kept or deleted yet — see below.
  const capture = await captures.resolve(input.capture ?? null)

  // The 32 KiB cap, before the write and before the ledger: a Pick too big to
  // send is one the developer is asked to shorten, not one that waits around to
  // fail later. Excerpts are all it may trim, and it says what it took (§13).
  const fitted = fitPayload(
    mintPick(input, {
      ownerChain,
      target,
      captureLine: capture.line,
    }),
    { origin: context.origin() },
  )
  // A refusal leaves the capture exactly as it was: the page still holds its id
  // and sends it again with the shortened Pick (spec §21).
  if (!fitted.ok) return sendRefusal(logger, response, fitted.refusal)
  // Accepted, so the capture is this Pick's now: kept for the agent, or deleted
  // when the toggle was off. Nothing was awaited since `resolve`. The Pick
  // holds only a file it really took, so a Withdraw deletes nothing of another's.
  const pick: Pick = { ...fitted.value.pick, captureFile: capture.take() }
  const rendered = fitted.value.body

  const unwritten = await deliverRendered(context, registry, pick, rendered)
  const written = pick.target !== null && unwritten === undefined

  // A write that failed leaves the Pick `queued-unaddressed` rather than
  // `failed`: the hook floor can still take it, and the reason is carried so
  // nothing about the attempt is silent (spec §21). Ledgered only now, after
  // the write has settled: a Pick the floor could see while its socket write
  // was still in flight would be one it could take twice.
  ledger.open(pick, written ? SENT : QUEUED_UNADDRESSED, unwritten)
  // A Pick written to a socket is one that may never land, so its report-back
  // clock starts now (spec §17). One the floor will carry has none.
  if (written && pick.target) {
    const status = choice.target?.status ?? null
    clock.watch(pick.id, pick.target, now(), status)
  }

  // The Pick id, and whether anything was written. The Target row, the chip
  // words and every later state are the status endpoint's; what a 200 must
  // not be is silent about a Pick that went nowhere (spec §21).
  const accepted: PickAccepted = {
    pickId: pick.id,
    state: written ? SENT_AWAITING_ACK : QUEUED_UNADDRESSED,
    ...(unwritten ? { reason: unwritten } : {}),
    // Information, not a refusal: the Pick was accepted and the Note travelled
    // whole. The Panel renders it as one quiet line (spec §7).
    ...(pick.trimNote ? { trimmed: pick.trimNote } : {}),
  }
  sendJson(response, 200, accepted)
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
 * The origin the ack and done URLs are printed with: the address this server is
 * bound to, not a name (`bound-host.ts`). The caller is the agent's shell on
 * this machine, and a hostname it would have to resolve is one more thing that
 * can be wrong.
 *
 * In middleware mode there is no `httpServer` and no port to print — but there
 * are also no `resolvedUrls`, so `onceOwnOrigins` is empty and every Pick is
 * already refused at the Origin check before a body is ever rendered.
 */
function loopbackOrigin(server: ViteDevServer): string {
  const { host, port } = boundAddress(server)
  const scheme = server.config.server.https ? 'https' : 'http'
  return `${scheme}://${host}:${port}`
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
