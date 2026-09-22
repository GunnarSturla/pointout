// The Overlay's half of the HTTP surface (spec §20). Same-origin requests only:
// every path is relative to the page, so a consumer with `connect-src 'self'`
// never has to widen anything.
//
// Every refusal this reads is shown at the point it happens (spec §21); nothing
// here swallows one.

import { API_BASE, PICK_PATH, SESSIONS_PATH, STATUS_PATH } from '../api.js'
import type {
  Candidate,
  NamedTarget,
  PickAccepted,
  PickBody,
  PickStatus,
  RefusalBody,
  SessionsResponse,
  StatusResponse,
} from '../wire.js'

export type { Candidate, NamedTarget, PickBody, PickStatus }

/**
 * What the registry turned out to be, and who is in it. `hookFloor` is the
 * server's own word for a registry it could not read: the Candidates are empty
 * for a reason that is not "nobody is running", and the Panel says so
 * differently (spec §7's two zero states).
 */
export interface Sessions {
  candidates: Candidate[]
  hookFloor: boolean
  /** When this read was answered: what *idle for Nd* is counted from. */
  readAt: number
}

/** Accepted, with whatever the server wants said about it; or refused, with why. */
export type Sent =
  /**
   * `trimmed` is the server's own sentence about Excerpts that did not fit
   * inside the 32 KiB payload cap. Information, not a refusal: the Pick was
   * accepted and the Note travelled whole (spec §7, §13).
   */
  | { ok: true; pickId: string; reason?: string; trimmed?: string }
  /**
   * Refused. `replacement` is the 409's own: the named Target has left and this
   * is what the chain yields instead — offered, never taken (spec §14, §21).
   */
  | { ok: false; reason: string; replacement?: NamedTarget }

/** What one request came back with: the body, or the reason there is none. */
type Answer<T> =
  | { ok: true; body: T }
  | { ok: false; reason: string; refusal: Partial<RefusalBody> }

/**
 * One request to the dev server, and one reading of what came back. A refusal's
 * own reason travels through; a status with no words, and a server that could
 * not be reached, each get a sentence here so nothing arrives silent (spec §21).
 */
async function request<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  try {
    const response = await fetch(API_BASE + path, init)
    const body = (await response.json()) as T & Partial<RefusalBody>
    if (!response.ok) {
      return {
        ok: false,
        reason:
          body.reason ??
          `the dev server answered ${response.status} and said nothing about why.`,
        refusal: body,
      }
    }
    return { ok: true, body }
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `could not reach the dev server: ${said}`, refusal: {} }
  }
}

/**
 * The Candidates, read on demand (spec §14: at pick time, then on the Overlay's
 * one tick while something is watching — never on a background timer).
 */
export async function readSessions(): Promise<
  { ok: true; sessions: Sessions } | { ok: false; reason: string }
> {
  const answer = await request<SessionsResponse>(SESSIONS_PATH)
  if (!answer.ok) return { ok: false, reason: answer.reason }
  return {
    ok: true,
    sessions: {
      candidates: answer.body.candidates ?? [],
      hookFloor: answer.body.registry?.hookFloor === true,
      readAt: Date.now(),
    },
  }
}

/**
 * Every Pick this dev server accepted, polled on the Overlay's one tick while
 * something is outstanding (spec §14, §20) — and never otherwise. The state
 * words are §17's; an unknown word is carried through rather than guessed at.
 */
export async function readStatus(): Promise<
  { ok: true; picks: PickStatus[] } | { ok: false; reason: string }
> {
  const answer = await request<StatusResponse>(STATUS_PATH)
  if (!answer.ok) return { ok: false, reason: answer.reason }
  return { ok: true, picks: answer.body.picks ?? [] }
}

/** Ingest one Pick. A 4xx's reason is handed straight back to the Panel. */
export async function sendPick(body: PickBody): Promise<Sent> {
  const answer = await request<PickAccepted>(PICK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!answer.ok) {
    const replacement = named(answer.refusal.replacement)
    return { ok: false, reason: answer.reason, ...(replacement ? { replacement } : {}) }
  }
  const { pickId, reason, trimmed } = answer.body
  return {
    ok: true,
    pickId: pickId ?? '',
    ...(reason ? { reason } : {}),
    ...(trimmed ? { trimmed } : {}),
  }
}

/**
 * Spec §14's preselect chain, the browser's half of it: the last Target used
 * from this origin while it is still a Candidate, else the entry that started
 * this dev server, else the sole Candidate, else nothing — and the Panel
 * disables Send and says why. A Candidate in `waiting` stays in the chain,
 * flagged by the row rather than skipped by it.
 *
 * §14 numbers the remembered Target third, *after* the `CLAUDE_PID` match. Taken
 * literally that makes it unreachable in the case it exists for: the entry that
 * started this dev server is the default a developer overrides, and story 31
 * asks that overriding it once be enough. So a remembered Target that is still a
 * Candidate wins, and the numbered chain is what it falls back to.
 */
export function preselect(
  candidates: Candidate[],
  remembered: string | null,
): Candidate | null {
  const lastUsed = candidates.find((candidate) => candidate.sessionId === remembered)
  if (lastUsed) return lastUsed
  const startedThisServer = candidates.find((candidate) => candidate.startedThisServer)
  if (startedThisServer) return startedThisServer
  return candidates.length === 1 ? (candidates[0] ?? null) : null
}

/**
 * The last Target used, by origin (spec §14). `localStorage` is per-origin
 * already; the key says so as well, because the spec names the origin and a key
 * that reads like the rule is one nobody has to check twice.
 *
 * Storage a consumer's page has disabled is not an error the Overlay reports:
 * the chain simply falls through to step 4.
 */
export function rememberedTarget(view: Window): string | null {
  try {
    return view.localStorage.getItem(lastTargetKey(view))
  } catch {
    return null
  }
}

export function rememberTarget(view: Window, sessionId: string): void {
  try {
    view.localStorage.setItem(lastTargetKey(view), sessionId)
  } catch {
    // A page with storage denied chooses its Target once per Pick, and that is
    // the whole cost of it.
  }
}

function lastTargetKey(view: Window): string {
  return `vite-agent-inspect:last-target:${view.location.origin}`
}

/** A replacement is only usable if it carries all three parts of an address. */
function named(value: NamedTarget | undefined): NamedTarget | null {
  if (!value || typeof value.sessionId !== 'string' || typeof value.pid !== 'number') {
    return null
  }
  return {
    sessionId: value.sessionId,
    pid: value.pid,
    name: typeof value.name === 'string' ? value.name : value.sessionId,
  }
}
