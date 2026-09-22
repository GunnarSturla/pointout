// The Overlay's half of the HTTP surface (spec §20). Same-origin requests only:
// every path is relative to the page, so a consumer with `connect-src 'self'`
// never has to widen anything.
//
// Every refusal this reads is shown at the point it happens (spec §21); nothing
// here swallows one.

import { API_BASE, PICK_PATH, SESSIONS_PATH } from '../api.js'

/** The one Candidate a Pick is addressed to, as the body names it. */
export interface TargetRef {
  sessionId: string
  pid: number
}

/** A live agent session a Pick could be addressed to, as `/sessions` sends it. */
export interface Candidate extends TargetRef {
  name: string
  startedThisServer: boolean
}

export interface PickBody {
  url: string
  viewport: { width: number; height: number }
  descriptor: { tag: string; id?: string; testId?: string }
  geometry: { width: number; height: number; x: number; y: number }
  note: string | null
  target: TargetRef | null
}

/** Accepted, with whatever the server wants said about it; or refused, with why. */
export type Sent =
  | { ok: true; pickId: string; state: string; reason?: string }
  | { ok: false; reason: string }

/**
 * The Candidates, read at pick time (spec §14: on demand, never on a timer).
 * A registry this server cannot read is a refusal like any other — ticket 10
 * owns the two zero states and the in-Panel picker.
 */
export async function readCandidates(): Promise<
  { ok: true; candidates: Candidate[] } | { ok: false; reason: string }
> {
  try {
    const response = await fetch(API_BASE + SESSIONS_PATH, {
      headers: { accept: 'application/json' },
    })
    const body = (await response.json()) as {
      candidates?: Candidate[]
      reason?: string
    }
    if (!response.ok) {
      return { ok: false, reason: body.reason ?? answered(response.status) }
    }
    return { ok: true, candidates: body.candidates ?? [] }
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
    }
    if (!response.ok) {
      return { ok: false, reason: answer.reason ?? answered(response.status) }
    }
    return {
      ok: true,
      pickId: answer.pickId ?? '',
      state: answer.state ?? '',
      ...(answer.reason ? { reason: answer.reason } : {}),
    }
  } catch (error) {
    return { ok: false, reason: unreachable(error) }
  }
}

/**
 * Steps 1 and 2 of §14's preselect chain, which is all ticket 04 needs: the
 * entry that started this dev server, else the sole Candidate. Step 3 (the last
 * Target used from this origin) and step 4 (nothing, Send disabled) are
 * ticket 10's, along with the row that shows the choice.
 */
export function preselect(candidates: Candidate[]): Candidate | null {
  return (
    candidates.find((candidate) => candidate.startedThisServer) ??
    (candidates.length === 1 ? (candidates[0] ?? null) : null)
  )
}

function answered(status: number): string {
  return `the dev server answered ${status} and said nothing about why.`
}

function unreachable(error: unknown): string {
  const said = error instanceof Error ? error.message : String(error)
  return `could not reach the dev server: ${said}`
}
