// What the Overlay says about a Target and about a Pick (spec §7, §17), in one
// module because one of these sentences belongs to three surfaces: the Target
// row, the `held` chip and the paused report-back clock. One phrase, three
// surfaces — so it is written once and imported, not retyped.
//
// The chip words at the foot of this file are §17's table as far as the Overlay
// draws it today: `sent`, `held`, `working`, `done` and `failed`. `unknown`
// belongs here beside these when the report-back clock lands.

/** Zero Candidates. The Note input is replaced by this, and there is no Target. */
export const NO_SESSION = 'No Claude session is running in this folder'

/** The registry could not be read. The input stays; delivery is the hook floor's. */
export const CANT_SEE_SESSIONS = "Can't see your sessions — sending the slower way"

/**
 * The one action that unblocks a session waiting on a permission prompt — and a
 * `held` Pick, which is the same prompt seen from the Pick's side (spec §17).
 */
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

/** Spec §17's `sent`: the socket write succeeded, and nothing more is claimed. */
export const SENT = 'Sent'

/**
 * The sub-line under **Sent** for a Pick nobody is addressed to — requeued
 * unaddressed, or queued because the registry could not be read. The Pick is
 * real and the route is the hook floor's, so the chip says when it will arrive
 * rather than implying it already has (spec §17, §18).
 */
export const NEXT_PROMPT = 'arrives when you next prompt Claude in this repo'

/** The next action under a `failed` chip: both halves of it, in one line. */
export const SEND_AGAIN = 'send it again, or pick another session'

/**
 * A `failed` Pick's chip is the sentence the server wrote for it — §17 writes
 * every one of them. This stands in only when a refusal arrived with no words
 * at all, so that the chip still fails closed out loud (spec §21).
 */
export const NOT_DELIVERED = 'Not delivered.'

/**
 * Spec §17's `held`: a Receipt said the Target is holding this Pick until the
 * developer approves it. Its next action is `APPROVE_IN_TERMINAL`, the phrase
 * the Target row uses for a session blocked on a permission prompt.
 */
export function askingToApprove(name: string): string {
  return `${name} is asking you to approve this pick`
}

/** Spec §17's `working`: the Target acked, which is the agent's own signal. */
export function workingOn(name: string): string {
  return `${name} is on it`
}

/** Spec §17's `done`: the agent's claim, attributed, never a verified fact. */
export function doneReportedBy(name: string): string {
  return `Done — reported by ${name}`
}

/**
 * The Stack's summary line (spec §17, story 49). It counts the Picks that are
 * still only *sent* and attributes nothing to any one of them: session status
 * never reaches a chip, and silence is never promoted to *delivered*.
 */
export function noneAcknowledgedYet(sent: number): string {
  return `${sent} sent, none acknowledged yet`
}

/** The camera toggle's name, which is what a screen reader announces (spec §7). */
export const SCREEN_CAPTURE = 'Screen Capture'

/**
 * The toggle, shown disabled rather than hidden, and why (story 73, 74): the
 * dev server's own reason, which names the platform or the permission.
 */
export function captureUnavailable(reason: string): string {
  return `Screen Capture is off: ${reason}`
}

/**
 * The open Pick's capture did not start (spec §21). Said only while the toggle
 * is on, because only then was a capture meant to travel with the Pick.
 */
export function captureFailed(reason: string): string {
  return `No Screen Capture for this pick: ${reason}`
}

/**
 * A capture this page let go of — a move, a discard — that the dev server
 * could not be asked to delete. Said whatever the toggle, because it is the
 * developer's screen on disk; and where it goes next is said too.
 */
export function captureNotDeleted(reason: string): string {
  return `A Screen Capture could not be deleted (${reason}). The dev server removes it when it stops.`
}
