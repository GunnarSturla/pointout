// The Overlay's half of the HTTP surface (spec §20). Same-origin requests only:
// every path is relative to the page, so a consumer with `connect-src 'self'`
// never has to widen anything.
//
// Every refusal this reads is shown at the point it happens (spec §21); nothing
// here swallows one.

import { API_BASE, PICK_PATH, SESSIONS_PATH, STATUS_PATH } from '../api.js'
import type { Descriptor, Excerpt } from './describe.js'
import type { OwnerChainLink } from './fiber.js'

/** The one Candidate a Pick is addressed to, as the body names it. */
export interface TargetRef {
  sessionId: string
  pid: number
}

/** A Target the Overlay can put in front of a developer: it has a name. */
export interface NamedTarget extends TargetRef {
  name: string
}

/** A live agent session a Pick could be addressed to, as `/sessions` sends it. */
export interface Candidate extends NamedTarget {
  status: string
  waitingFor: string | null
  /** Where *idle for Nd* comes from. Never `updatedAt`, which is not a heartbeat. */
  statusUpdatedAt: string | null
  startedThisServer: boolean
}

export interface PickBody {
  url: string
  viewport: { width: number; height: number }
  descriptor: Descriptor
  geometry: { width: number; height: number; x: number; y: number }
  /** The Owner chain, innermost first, whole and uncapped (spec §6). */
  ownerChain: OwnerChainLink[]
  /** How many DOM levels were walked up to find a fiber at all (spec §4). */
  walkUp: number
  /** Content lifted from the page as evidence (`CONTEXT.md`, spec §13). */
  excerpts: Excerpt[]
  /** Which redaction rules fired; the server writes the sentence (spec §13). */
  redactions: string[]
  note: string | null
  target: TargetRef | null
}

/**
 * What the registry turned out to be, and who is in it. `hookFloor` is the
 * server's own word for a registry it could not read: the Candidates are empty
 * for a reason that is not "nobody is running", and the Panel says so
 * differently (spec §7's two zero states).
 */
export interface Sessions {
  candidates: Candidate[]
  hookFloor: boolean
}

/** Accepted, with whatever the server wants said about it; or refused, with why. */
export type Sent =
  /**
   * `trimmed` is the server's own sentence about Excerpts that did not fit
   * inside the 32 KiB payload cap. Information, not a refusal: the Pick was
   * accepted and the Note travelled whole (spec §7, §13).
   */
  | { ok: true; pickId: string; state: string; reason?: string; trimmed?: string }
  /**
   * Refused. `replacement` is the 409's own: the named Target has left and this
   * is what the chain yields instead — offered, never taken (spec §14, §21).
   */
  | { ok: false; reason: string; replacement?: NamedTarget }

/**
 * The Candidates, read on demand (spec §14: at pick time, then on the Overlay's
 * one tick while something is watching — never on a background timer).
 */
export async function readSessions(): Promise<
  { ok: true; sessions: Sessions } | { ok: false; reason: string }
> {
  try {
    const response = await fetch(API_BASE + SESSIONS_PATH, {
      headers: { accept: 'application/json' },
    })
    const body = (await response.json()) as {
      registry?: { hookFloor?: boolean }
      candidates?: Candidate[]
      reason?: string
    }
    if (!response.ok) {
      return { ok: false, reason: body.reason ?? answered(response.status) }
    }
    return {
      ok: true,
      sessions: {
        candidates: body.candidates ?? [],
        hookFloor: body.registry?.hookFloor === true,
      },
    }
  } catch (error) {
    return { ok: false, reason: unreachable(error) }
  }
}

/**
 * What became of one Pick, as `/status` answers it. The state words are §17's
 * Pick states and the queue's `queued-unaddressed`, which the Stack tells apart
 * by its sub-line; an unknown word is carried through rather than guessed at.
 *
 * The Target is here for its **name** only. Its live status is session-level
 * evidence, and §17's rule is that session-level evidence never moves a chip —
 * so the Stack has no way to read it, by construction.
 */
export interface PickStatus {
  pickId: string
  state: string
  /** The sentence the server wrote for a refusal. Null when it has none. */
  reason: string | null
  target: { name: string | null } | null
}

/**
 * Every Pick this dev server accepted, polled on the Overlay's one tick while
 * something is outstanding (spec §14, §20) — and never otherwise.
 */
export async function readStatus(): Promise<
  { ok: true; picks: PickStatus[] } | { ok: false; reason: string }
> {
  try {
    const response = await fetch(API_BASE + STATUS_PATH, {
      headers: { accept: 'application/json' },
    })
    const body = (await response.json()) as { picks?: PickStatus[]; reason?: string }
    if (!response.ok) {
      return { ok: false, reason: body.reason ?? answered(response.status) }
    }
    return { ok: true, picks: body.picks ?? [] }
  } catch (error) {
    return { ok: false, reason: unreachable(error) }
  }
}

/** Ingest one Pick. A 4xx's reason is handed straight back to the Panel. */
export async function sendPick(body: PickBody): Promise<Sent> {
  try {
    const response = await fetch(API_BASE + PICK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const answer = (await response.json()) as {
      pickId?: string
      state?: string
      reason?: string
      trimmed?: string
      replacement?: NamedTarget
    }
    if (!response.ok) {
      const replacement = named(answer.replacement)
      return {
        ok: false,
        reason: answer.reason ?? answered(response.status),
        ...(replacement ? { replacement } : {}),
      }
    }
    return {
      ok: true,
      pickId: answer.pickId ?? '',
      state: answer.state ?? '',
      ...(answer.reason ? { reason: answer.reason } : {}),
      ...(answer.trimmed ? { trimmed: answer.trimmed } : {}),
    }
  } catch (error) {
    return { ok: false, reason: unreachable(error) }
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

function answered(status: number): string {
  return `the dev server answered ${status} and said nothing about why.`
}

function unreachable(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error)
  return `could not reach the dev server: ${said}`
}
