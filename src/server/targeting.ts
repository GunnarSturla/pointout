import type { Refusal } from './guard.js'
import type { Target } from './pick.js'
import type { Candidate } from './registry.js'

// The server half of targeting (spec §14). Steps 1 and 2 of the preselect chain
// are here because they are answered from the registry the server already read;
// steps 3 and 4 — the last Target used from this origin, and nothing with Send
// disabled — are the browser's and belong to ticket 10.

/**
 * Whether a registry entry or Candidate is the session a Target names. Both
 * halves of the identity are compared: a pid can be reused by another session,
 * and that is the misdelivery this check is here to catch (spec §15).
 */
export function addresses(
  session: { sessionId: string; pid: number },
  target: Target,
): boolean {
  return session.sessionId === target.sessionId && Number(session.pid) === target.pid
}

export type TargetChoice =
  /** The Candidate to write to, or null: the entry stays queued-unaddressed. */
  { ok: true; target: Candidate | null } | { ok: false; refusal: Refusal }

/**
 * A named Target is re-checked, never silently exchanged for another
 * (`CONTEXT.md`). Ticket 10 upgrades this refusal to a 409 naming the
 * replacement the chain now yields; the rule it enforces does not change.
 */
export function resolveTarget(
  named: Target | null,
  candidates: Candidate[],
): TargetChoice {
  if (named) {
    const stillACandidate = candidates.find((candidate) => addresses(candidate, named))
    if (stillACandidate) return { ok: true, target: stillACandidate }
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: 'target-gone',
          reason:
            `refused a Pick addressed to session ${named.sessionId} (pid ${named.pid}): ` +
            'it is no longer a session running in this checkout. A Pick is never ' +
            'retargeted without being asked.',
        },
      },
    }
  }

  const startedThisServer = candidates.find((candidate) => candidate.startedThisServer)
  if (startedThisServer) return { ok: true, target: startedThisServer }

  if (candidates.length === 1) return { ok: true, target: candidates[0] ?? null }

  return { ok: true, target: null }
}
