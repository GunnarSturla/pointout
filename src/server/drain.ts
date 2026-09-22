import { timingSafeEqual } from 'node:crypto'
import { HOOK_OUTPUT_LIMIT, encodedLength } from '../api.js'
import type { Refusal } from './guard.js'
import { SENT } from './ledger.js'
import type { Ledger } from './ledger.js'
import { normalizeToWorktreeRoot } from './paths.js'
import type { Parsed } from './pick.js'
import type { PickQueue, QueueEntry } from './queue.js'
import { renderPicks } from './render.js'

// The hook floor's half of the delivery story (spec §15, §18). A Pick nothing
// could address, or that a write failed to reach, waits here until the developer
// prompts any Claude session in this repo — and then rides in as their own
// words, with their own standing, because a hook's `additionalContext` is
// attached to the turn they typed.
//
// Two rules make the floor safe to run on every prompt:
//
//   - **Only `queued-unaddressed` entries are drained.** An entry written to a
//     session socket is `sent-awaiting-ack` and stays there, so a developer who
//     types before the agent acks does not receive the Pick twice (spec §15).
//   - **A drain claims what it renders.** The entries it returns are marked
//     sent before the answer leaves, so two hooks firing at once cannot both
//     take the same Pick.
//
// Nothing here renders: `render.ts` does, and the CLI is a pass-through wrapper
// around this endpoint. If a drained Pick reads wrong, the fix is in the
// renderer (ticket 15's note).

/** What a hook's wrapper sends. Every field is required but the budget. */
export interface DrainRequest {
  /** The hook's own cwd, which this server normalizes again before comparing. */
  cwd: string
  /** The per-server secret, read out of the discovery entry (spec §11). */
  secret: string
  /** Which hook is asking — `UserPromptSubmit` or `Stop`. Stated, not guessed. */
  event: string
  /**
   * How many characters of *JSON-encoded* text the caller can still carry, as
   * `JSON.stringify(text).length - 2`. The caller knows the cost of its own
   * envelope and nothing else; what fits inside the budget is decided here.
   */
  budget: number
}

export interface DrainResult {
  /** The rendered Picks, ready to print. Empty when nothing was claimed. */
  text: string
  drained: number
  /** Still `queued-unaddressed` afterwards, waiting for the next prompt. */
  remaining: number
  /** Why nothing was drained, when something was there (spec §21). */
  reason?: string
}

const refuse = (status: number, error: string, reason: string): Parsed<never> => ({
  ok: false,
  refusal: { status, body: { error, reason } },
})

/** The ingest check on the drain body. Every refusal names the part (spec §21). */
export function parseDrainBody(text: string): Parsed<DrainRequest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return refuse(
      400,
      'malformed-json',
      `refused a drain whose body is not JSON: ${(error as Error).message}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return refuse(
      400,
      'malformed-json',
      'refused a drain whose body is not a JSON object.',
    )
  }

  const { cwd, secret, event, budget } = parsed as Record<string, unknown>
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return refuse(400, 'cwd-missing', 'refused a drain that named no cwd to route by.')
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    return refuse(
      400,
      'secret-missing',
      'refused a drain carrying no secret: the secret in this dev server’s ' +
        'discovery entry is the credential, and this endpoint has no other.',
    )
  }
  if (typeof event !== 'string' || event.length === 0) {
    return refuse(
      400,
      'event-missing',
      'refused a drain that did not say which hook it is: a pick is delivered ' +
        'under the event name it rides in on.',
    )
  }
  if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget))) {
    return refuse(
      400,
      'budget-not-a-number',
      'refused a drain whose budget is not a number.',
    )
  }

  return {
    ok: true,
    value: {
      cwd,
      secret,
      event,
      budget: clamp(typeof budget === 'number' ? budget : HOOK_OUTPUT_LIMIT),
    },
  }
}

/**
 * The drain Guard (spec §11): the secret first, because it is the credential
 * and the cwd check costs a `git` subprocess; then the root, because a hook in
 * another checkout is asking the wrong dev server.
 */
export function refuseDrainCaller(
  request: DrainRequest,
  { secret, root }: { secret: string; root: string },
): Refusal | null {
  if (!sameSecret(request.secret, secret)) {
    return {
      status: 403,
      body: {
        error: 'secret-mismatch',
        reason:
          'refused a drain whose secret is not the one in this dev server’s ' +
          'discovery entry. Nothing was taken from the queue.',
      },
    }
  }
  const asked = normalizeToWorktreeRoot(request.cwd)
  if (asked !== root) {
    return {
      status: 403,
      body: {
        error: 'cwd-mismatch',
        reason:
          `refused a drain for ${asked}: this dev server is serving ${root}, and ` +
          'a pick about one checkout never leaves it.',
      },
    }
  }
  return null
}

export interface DrainOptions {
  queue: PickQueue
  ledger: Ledger
  /** This server's own loopback origin: the ack and done URLs hang off it. */
  origin: string
  budget: number
}

/**
 * Claim and render as many `queued-unaddressed` entries as the budget holds,
 * oldest first, and say how many are still waiting.
 */
export function drainQueue({ queue, ledger, origin, budget }: DrainOptions): DrainResult {
  const waiting = queue.drainable()
  if (waiting.length === 0) return { text: '', drained: 0, remaining: 0 }

  // Reserved up front against the longest remainder line this drain could need,
  // so the line that says what was left over is itself inside the budget.
  const reserved = waiting.length > 1 ? encodedLength(remainderLine(waiting.length)) : 0

  let body = ''
  let fitted = 0
  for (let count = 1; count <= waiting.length; count++) {
    const candidate = renderPicks(picksOf(waiting.slice(0, count)), { origin })
    if (encodedLength(candidate) + reserved > budget) break
    body = candidate
    fitted = count
  }

  if (fitted === 0) {
    // Fail closed and say so (spec §21): the Pick stays queued rather than
    // being silently shortened, and the developer is told which one it is.
    const line = tooLargeLine(waiting[0]!)
    return {
      text: encodedLength(line) <= budget ? line : '',
      drained: 0,
      remaining: waiting.length,
      reason: line.trim(),
    }
  }

  for (const entry of waiting.slice(0, fitted)) {
    queue.markSent(entry.pick.id)
    ledger.advance(entry.pick.id, SENT)
  }

  const remaining = waiting.length - fitted
  return {
    text: remaining > 0 ? body + remainderLine(remaining) : body,
    drained: fitted,
    remaining,
  }
}

function picksOf(entries: QueueEntry[]) {
  return entries.map((entry) => entry.pick)
}

/** Nothing accumulates silently (spec §15): what was left over is stated. */
function remainderLine(remaining: number): string {
  const picks = remaining === 1 ? 'more pick' : 'more picks'
  const arrive = remaining === 1 ? 'it arrives' : 'they arrive'
  return `\n${remaining} ${picks} still queued in this dev server; ${arrive} at your next prompt.\n`
}

function tooLargeLine(entry: QueueEntry): string {
  return (
    `vite-agent-inspect — pick ${entry.pick.id} is larger than the ` +
    `${HOOK_OUTPUT_LIMIT}-character budget a hook can carry, so it was not ` +
    'delivered. It stays queued until it expires.\n'
  )
}

function clamp(budget: number): number {
  return Math.max(0, Math.min(HOOK_OUTPUT_LIMIT, Math.floor(budget)))
}

/**
 * Constant-time, unlike the ack nonce (ticket 11). The difference is the
 * caller: a nonce is compared for a local shell, which §11 declares out of
 * scope, while this secret is what stops a *page* from draining the queue with
 * a blind cross-origin POST — and a page can time one.
 */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}
