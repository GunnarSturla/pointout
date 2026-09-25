// What the Overlay says about a Target and about a Pick (spec §7, §17), in one
// module because one of these sentences belongs to three surfaces: the Target
// row, a `held` Pick's minimized Panel and the paused report-back clock. One
// phrase, three surfaces — so it is written once and imported, not retyped.
//
// The words a minimized Panel says at the foot of this file are §17's table:
// `sent`, `held`, `working`, `done`, `failed` and `unknown`, and the traffic
// light's own word for each (overlay-polish ticket 08).

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

/**
 * How a Candidate is doing, in the Overlay's words rather than the harness's
 * (`idle`, `busy`, `waiting`). Each has a colour too, and never only a colour:
 * the word is always drawn beside its dot.
 */
export type Health = 'ready' | 'working' | 'needs'

const HEALTH: Record<string, Health> = {
  idle: 'ready',
  busy: 'working',
  waiting: 'needs',
}

const SAID: Record<Health, string> = {
  ready: 'Ready',
  working: 'Working',
  needs: 'Needs you',
}

/**
 * A status the harness reports that the Overlay has no word for is shown as the
 * harness spelled it, with no health, rather than dressed up as one it is not.
 */
export function healthOf(status: string): Health | null {
  return HEALTH[status] ?? null
}

export function statusWord(status: string): string {
  const health = healthOf(status)
  return health ? SAID[health] : status
}

/** Said beside the Candidate whose pid is `CLAUDE_PID` (spec §7). */
export const STARTED_THIS_SERVER = 'started this server'

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

/** How long a Ready session has been idle: short on the row, whole in its title. */
export interface IdleAge {
  /** `3d`: set in tabular figures, so the ages line up down the Session list. */
  short: string
  /** `Idle for 3 days`. */
  title: string
}

/**
 * From `statusUpdatedAt` and never from `updatedAt`, which is not a heartbeat
 * (spec §14). Null below a day: a session that answered this morning is not
 * idle in the sense this label means.
 */
export function idleAge(statusUpdatedAt: string | null, now: number): IdleAge | null {
  if (!statusUpdatedAt) return null
  const since = Date.parse(statusUpdatedAt)
  if (Number.isNaN(since)) return null
  const days = Math.floor((now - since) / 86_400_000)
  if (days < 1) return null
  return { short: `${days}d`, title: `Idle for ${days} ${days === 1 ? 'day' : 'days'}` }
}

/**
 * The colour of a submitted Pick's traffic light: a session's three, and a
 * steady red for a Pick that is over or stuck and asks for something to be
 * done (`failed`, `unknown`, never picked up). Null is grey, for a Pick that
 * is only sent.
 */
export type Light = Health | 'failed'

/** Spec §17's `sent`: the socket write succeeded, and nothing more is claimed. */
export const SENT = 'Sent'

/**
 * What each traffic light says in words, in its `title`: colour is never the
 * only signal (docs/overlay-design.md). `SENT` and `NO_ACK_YET` are the other
 * two.
 */
export const WAITING_FOR_PROMPT = 'Waiting for the next prompt'
export const WORKING = 'Working'
export const DONE = 'Done'
export const NEEDS_APPROVAL = 'Needs your approval'
export const FAILED = 'Failed'
export const NEVER_PICKED_UP = 'Never picked up'

/** The camera beside a minimized Panel's Note: a Screen Capture went with the Pick. */
export const CAPTURE_SENT = 'Sent with a Screen Capture'

/**
 * Spec §7's two labels for the Panel's primary button. A Pick with no Note
 * asks the agent to find the element and stand by, and a minimized Panel with
 * no Note says so in place of its first line.
 */
export const SEND = 'Send'
export const STAND_BY = 'Locate & stand by'

/** The third: the button the re-resolve question relabels in place (spec §14). */
export const CONFIRM = 'Confirm'

/**
 * The sub-line under **Sent** for a Pick nobody is addressed to — requeued
 * unaddressed, or queued because the registry could not be read. The Pick is
 * real and the route is the hook floor's, so its Panel says when it will arrive
 * rather than implying it already has (spec §17, §18).
 */
export const NEXT_PROMPT = 'arrives when you next prompt Claude in this repo'

/**
 * The foot of a submitted Panel opened above the Stack: where its Pick went.
 * A Pick nobody is addressed to says when it will arrive instead, in the
 * words its minimized Panel uses.
 */
export function sentTo(name: string): string {
  if (name) return `To ${name}`
  return NEXT_PROMPT.charAt(0).toUpperCase() + NEXT_PROMPT.slice(1)
}

/** The next action a `failed` Pick names: both halves of it, in one line. */
export const SEND_AGAIN = 'send it again, or pick another session'

/**
 * A `failed` Pick says the sentence the server wrote for it — §17 writes
 * every one of them. This stands in only when a refusal arrived with no words
 * at all, so that the Panel still fails closed out loud (spec §21).
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
 * Spec §17's `unknown`: written, and a minute has passed with no ack and nothing
 * else to go on. It claims nothing either way, and says where to look.
 */
export const NO_ACK_YET = 'No acknowledgement yet'

/** The next action an `unknown` Pick names. */
export const CHECK_TERMINAL = 'check your terminal'

/**
 * The report-back offer (spec §17, story 46): the minimized Panel expands in
 * place with this, the question under it, and the two answers to it as buttons.
 */
export function neverPickedUp(name: string): string {
  return `${name} never picked this up.`
}

export const SEND_OR_LEAVE =
  'Send it to another session, or leave it for whoever you prompt next?'

/** The offer's first answer: the in-Stack list of sessions opens. */
export const SEND_ELSEWHERE = 'Send it to another session'

/** The offer's second answer, and what happens when its countdown runs out. */
export const LEAVE_FOR_NEXT = 'Leave it for whoever you prompt next'

/**
 * The Stack's footer while a Pick's report-back clock is paused: the Target is
 * blocked on a permission prompt, and the ack is waiting behind it (spec §17).
 * The imperative under it is `APPROVE_IN_TERMINAL`, the Target row's own.
 */
export function pausedFor(name: string): string {
  return `${blockedOnPermission(name)}, so its pick is waiting`
}

/**
 * The Stack's summary line (spec §17, story 49). It counts the Picks that are
 * still only *sent* and attributes nothing to any one of them: session status
 * never reaches a Pick's Panel, and silence is never promoted to *delivered*.
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
