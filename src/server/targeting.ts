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
 * (`CONTEXT.md`). A Target that has left and has a successor is a 409 naming it,
 * which the Overlay asks about in place; one with no successor is a plain
 * refusal, because there is nothing to offer instead.
 */
export function resolveTarget(
  named: Target | null,
  candidates: Candidate[],
): TargetChoice {
  if (!named) return { ok: true, target: preselected(candidates) }

  const stillACandidate = candidates.find((candidate) => addresses(candidate, named))
  if (stillACandidate) return { ok: true, target: stillACandidate }

  const left =
    `refused a Pick addressed to session ${named.sessionId} (pid ${named.pid}): ` +
    'it is no longer a session running in this checkout. '
  const replacement = preselected(candidates)
  if (!replacement) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: 'target-gone',
          reason: left + 'A Pick is never retargeted without being asked.',
        },
      },
    }
  }

  return {
    ok: false,
    refusal: {
      status: 409,
      body: {
        error: 'target-replaced',
        reason:
          left +
          `${replacement.name} would take it instead. A Pick is never retargeted ` +
          'without being asked.',
        // Named, not written to: the replacement is what the Overlay puts the
        // question in front of the developer with.
        replacement: {
          sessionId: replacement.sessionId,
          pid: replacement.pid,
          name: replacement.name,
        },
      },
    },
  }
}

/** Steps 1 and 2 of §14's chain, which is as far as the server can see. */
function preselected(candidates: Candidate[]): Candidate | null {
  const startedThisServer = candidates.find((candidate) => candidate.startedThisServer)
  if (startedThisServer) return startedThisServer
  if (candidates.length === 1) return candidates[0] ?? null
  return null
}
