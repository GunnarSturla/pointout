// What the Overlay says about a Target (spec §7, §17), in one module because
// one of these sentences belongs to three surfaces: the Target row here, the
// `held` chip (ticket 13) and the paused report-back clock (ticket 14). One
// phrase, three tickets — so it is written once and imported, not retyped.

/** Zero Candidates. The Note input is replaced by this, and there is no Target. */
export const NO_SESSION = 'No Claude session is running in this folder'

/** The registry could not be read. The input stays; delivery is ticket 15's floor. */
export const CANT_SEE_SESSIONS = "Can't see your sessions — sending the slower way"

/** The one action that unblocks a session waiting on a permission prompt. */
export const APPROVE_IN_TERMINAL = 'approve it in your terminal'

/** Step 4 of §14's chain: nothing preselected, and the footer says why Send is off. */
export const CHOOSE_A_SESSION = 'Choose which session this goes to'

/** The separator between a Target's name and its status. */
const DOT = ' · '

/** `<name> · <status>`, with what it is waiting for inline when there is any. */
export function targetLine(name: string, status: string, waitingFor?: string): string {
  return waitingFor ? name + DOT + status + DOT + waitingFor : name + DOT + status
}

/** A Target blocked on a permission prompt is named, not merely coloured. */
export function blockedOnPermission(name: string): string {
  return `${name} is blocked on a permission prompt`
}

/**
 * The re-resolve question (spec §14), asked in place of the Send row. A Target
 * is never silently exchanged for another, so the one that left is named beside
 * the one that would take it.
 */
export function goneAskingFor(gone: string, replacement: string): string {
  return `${gone} is gone. Send to ${replacement}?`
}

/**
 * *idle for Nd*, from `statusUpdatedAt` and never from `updatedAt`, which is not
 * a heartbeat (spec §14). Null below a day: a session that answered this morning
 * is not idle in the sense this phrase means.
 */
export function idleFor(statusUpdatedAt: string | null, now: number): string | null {
  if (!statusUpdatedAt) return null
  const since = Date.parse(statusUpdatedAt)
  if (Number.isNaN(since)) return null
  const days = Math.floor((now - since) / 86_400_000)
  return days >= 1 ? `idle for ${days}d` : null
}
