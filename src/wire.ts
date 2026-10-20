// What travels over HTTP between the Overlay and the dev server, and between the
// drain CLI and the dev server, written once (spec §20). `api.ts` names the
// paths; this names what goes on them. Both halves of the package import from
// here, which is what keeps a shape from being spelled two ways by hand.
//
// Nothing here is a server type: a `Pick` as the server holds it, a ledger
// record, a registry entry are all beside the module that owns them. This is
// only the surface the two halves have to agree on.

// ---------------------------------------------------------------------------
// Pick ingress: POST /__agent/pick
// ---------------------------------------------------------------------------

/**
 * Spec §11's Note cap, counted in **code points** on both sides
 * (`[...value].length`): an emoji is one character to the developer who typed it
 * however many UTF-16 units it takes, and two halves counting differently would
 * disagree at the boundary. The server refuses *above* it; the Panel turns Send
 * off *at* it, which is §7's rule and one character stricter, so a Note the
 * Overlay let through is never one the server rejects.
 */
export const NOTE_MAX_CHARACTERS = 4000

/**
 * The kinds of Excerpt v0 lifts. The set is closed because the kind is written
 * into the Fence, and a kind the page chose would be a Fence whose shape the
 * page chose (`GLOSSARY.md`, spec §13).
 */
export const EXCERPT_KINDS = [
  'rendered-text',
  'input-value',
  'textarea',
  'select',
  'contenteditable',
  'attributes',
] as const

export type ExcerptKind = (typeof EXCERPT_KINDS)[number]

/** The two redaction rules the page may report having applied (spec §13, §21). */
export const REDACTION_REASONS = ['password', 'hidden'] as const

export type RedactionReason = (typeof REDACTION_REASONS)[number]

/** Content lifted from the page and carried as evidence (`GLOSSARY.md`). */
export interface Excerpt {
  kind: ExcerptKind
  text: string
  /**
   * How many characters were on the page, when more were captured than are
   * carried. Absent when nothing was trimmed: a trim is annotated, never silent.
   */
  captured?: number
}

/**
 * What the Overlay says about the picked element itself. Everything but `tag`
 * is optional, so a descriptor that grows never breaks an older Overlay — and
 * nothing here is a selector path, a computed style or a source snippet, which
 * §13 says it must never be.
 */
export interface ElementDescriptor {
  tag: string
  id?: string
  testId?: string
  role?: string
  aria?: Record<string, string>
  classes?: string[]
}

export interface Viewport {
  width: number
  height: number
}

export interface Geometry {
  width: number
  height: number
  x: number
  y: number
}

/**
 * One link of the Owner chain, as the Overlay sends it (spec §6): the owning
 * component's name and the raw `_debugStack` string, in whatever grammar the
 * engine wrote. The Overlay ships no stack parser; the server remaps it.
 */
export interface OwnerChainLink {
  name: string | null
  stack: string
}

/** The one Candidate a Pick is addressed to, as the body names it (spec §14). */
export interface Target {
  sessionId: string
  pid: number
}

/** A Target the Overlay can put in front of a developer: it has a name. */
export interface NamedTarget extends Target {
  name: string
}

/**
 * The Screen Capture a Pick asks to carry: the id the Overlay was given when it
 * started the capture, and the camera toggle as it stood at Send (spec §10).
 */
export interface CaptureRequest {
  id: string
  keep: boolean
}

/** The whole POST body, as the Overlay builds it and the server checks it. */
export interface PickBody {
  url: string
  viewport: Viewport
  descriptor: ElementDescriptor
  geometry: Geometry
  /** Innermost first, whole and uncapped (spec §6). */
  ownerChain: OwnerChainLink[]
  /** How many DOM levels were walked up to find a fiber at all (spec §4). */
  walkUp: number
  excerpts: Excerpt[]
  /** Which redaction rules fired; the server writes the sentence (spec §13). */
  redactions: RedactionReason[]
  /** Null is no Note at all, which is meaningful (`GLOSSARY.md`). */
  note: string | null
  target: Target | null
  /** Absent is the ordinary case: most Picks carry no Screen Capture. */
  capture?: CaptureRequest | null
  /**
   * When the page the Pick was made in began to load, in epoch milliseconds:
   * the top document's `performance.timeOrigin`, rounded down. A Connector
   * whose frames carry no version of the code they ran in, as a Turbopack
   * chunk's do not, judges a frame's file against it. Null or absent is not
   * known, and such a frame is judged against when the server started.
   */
  pageLoadedAt?: number | null
}

/**
 * The ingest answer's word for a Pick that was written to a session's socket.
 * `/status` reports the same Pick as `sent`; this is the only place the longer
 * spelling appears, and it is kept because the Overlay reads it.
 */
export const SENT_AWAITING_ACK = 'sent-awaiting-ack'

/** What a 200 from Pick ingress carries (spec §21: never silent about a Pick that went nowhere). */
export interface PickAccepted {
  pickId: string
  state: typeof SENT_AWAITING_ACK | typeof QUEUED_UNADDRESSED
  /** Why a write did not happen, when one was attempted. */
  reason?: string
  /** What the 32 KiB cap took out of the Excerpts. Information, not a refusal. */
  trimmed?: string
}

/**
 * Every refusal this server sends names its part and says why. One that has
 * something further the Overlay must act on — the replacement a re-resolved
 * Target yields (spec §14) — carries it beside the two.
 */
export interface RefusalBody {
  error: string
  reason: string
  replacement?: NamedTarget
  [detail: string]: unknown
}

// ---------------------------------------------------------------------------
// Sessions: GET /__agent/sessions
// ---------------------------------------------------------------------------

/** The three states a registry read can end in; two of them fall to the hook floor. */
export const READABLE = 'readable'
export const DIRECTORY_MISSING = 'directory-missing'
export const SHAPE_UNRECOGNISED = 'shape-unrecognised'

export type RegistryState =
  | typeof READABLE
  | typeof DIRECTORY_MISSING
  | typeof SHAPE_UNRECOGNISED

/**
 * A live agent session a Pick could be addressed to (`GLOSSARY.md`: Candidate).
 * Candidacy is existence, not readiness.
 */
export interface Candidate {
  name: string
  status: string
  waitingFor: string | null
  /** Where the idle age (*3d*) comes from. Never `updatedAt`, which is not a heartbeat. */
  statusUpdatedAt: string | null
  pid: number
  sessionId: string
  startedThisServer: boolean
}

export interface SessionsResponse {
  registry: {
    state: RegistryState
    /** True when the registry could not be read and targeting falls to the hook floor. */
    hookFloor: boolean
    /** Files that were there and could not be used. Carried rather than swallowed. */
    rejected: number
    directory: string
  }
  candidates: Candidate[]
}

// ---------------------------------------------------------------------------
// Status: GET /__agent/status, and the ack and done answers
// ---------------------------------------------------------------------------

/**
 * Spec §17's states for a Pick, plus the queue's own word for one nobody is
 * addressed to.
 */
export const QUEUED_UNADDRESSED = 'queued-unaddressed'
export const SENT = 'sent'
/** A Receipt said the Target is holding it until a developer approves it. */
export const HELD = 'held'
export const WORKING = 'working'
export const DONE = 'done'
export const FAILED = 'failed'
/**
 * Written, and sixty seconds of the report-back clock have passed with no ack
 * and nothing else to go on: the Target stayed busy, or the registry went
 * blind (spec §17). Still in the claim-once queue, so the TTL still governs it.
 */
export const UNKNOWN = 'unknown'

export type PickState =
  | typeof QUEUED_UNADDRESSED
  | typeof SENT
  | typeof HELD
  | typeof WORKING
  | typeof DONE
  | typeof FAILED
  | typeof UNKNOWN

/** One state change, with the moment it happened. */
export interface Transition {
  state: PickState
  at: number
  /** Why, when the state has a reason. Null rather than absent. */
  reason: string | null
}

/** The Target row §17 draws under a Pick, as the server can answer it. */
export interface TargetRow {
  sessionId: string
  pid: number
  /**
   * The three live fields, or null when that session is no longer in the
   * registry. Null says the row cannot be drawn; it never stands in for a value.
   */
  name: string | null
  status: string | null
  waitingFor: string | null
  /**
   * When this Target last finished a turn, as an idle notice reported it. Null
   * until one has arrived. It is the Target's own clock, not the server's.
   */
  idleAt: number | null
}

/** One Pick, as the Overlay polls it. */
export interface PickStatus {
  pickId: string
  state: PickState
  /** Why, when the state has a reason. Null rather than absent. */
  reason: string | null
  /**
   * Still in the claim-once queue, and so still deliverable. False once an ack
   * or an expiry has taken it out — which is how the Overlay, and a test, can
   * see that a second delivery of the same Pick is no longer possible.
   */
  queued: boolean
  createdAt: number
  expiresAt: number
  history: Transition[]
  target: TargetRow | null
  /**
   * The report-back clock for a Pick written to a socket, or null when none
   * runs: nothing was written, or the Pick has left the clock's hands (spec §17).
   */
  reportBack: ReportBack | null
}

export interface StatusResponse {
  picks: PickStatus[]
}

// ---------------------------------------------------------------------------
// The report-back clock, and POST /__agent/pick/<id>/report
// ---------------------------------------------------------------------------

/** Counting towards the 60 s report. */
export const CLOCK_RUNNING = 'running'
/** Stopped while the Target waits on a permission prompt, or the Pick is held. */
export const CLOCK_PAUSED = 'paused'
/** The clock ran out: the Target never picked it up, and the Overlay offers it back. */
export const CLOCK_OFFERED = 'offered'

export type ReportBackState =
  | typeof CLOCK_RUNNING
  | typeof CLOCK_PAUSED
  | typeof CLOCK_OFFERED

/** Where one Pick's report-back clock stands, and since when (this server's clock). */
export interface ReportBack {
  state: ReportBackState
  at: number
}

/** Leave it for whoever the developer prompts next: the hook floor's again. */
export const REQUEUE = 'requeue'
/** Send it to another session, as a new Pick with a fresh body. */
export const RETARGET = 'retarget'

/** How the Overlay resolves an offer. */
export type ReportBody =
  | { resolve: typeof REQUEUE }
  | { resolve: typeof RETARGET; target: Target }

/**
 * What resolving an offer answers. A retarget is a new Pick, so `pickId` is the
 * new one and `replaces` the one it took the place of, which is gone.
 */
export interface ReportAnswer {
  pickId: string
  state: PickState
  replaces?: string
  /** Why the retargeted write did not happen, when it did not (spec §21). */
  reason?: string
}

/**
 * The states an offer stands in: written, and not acknowledged since. Once the
 * agent acks, or a Receipt arrives, the offer is moot, whatever the clock said.
 */
export const OFFERABLE: readonly PickState[] = [SENT, UNKNOWN]

/** What `POST /__agent/pick/<id>/ack` and its twin answer. */
export interface PickActionAnswer {
  pickId: string
  state: PickState
}

// ---------------------------------------------------------------------------
// Withdraw: DELETE /__agent/pick/<id>
// ---------------------------------------------------------------------------

/**
 * The states a Pick can be withdrawn from whatever its clock says: waiting for
 * a prompt, out of time or refused, or written with nothing heard since. A Pick
 * in any other state is withdrawable only while it is offered back (below).
 */
export const WITHDRAWABLE: readonly PickState[] = [QUEUED_UNADDRESSED, FAILED, UNKNOWN]

/**
 * Whether a Pick, as `/status` reports it, can be withdrawn (`GLOSSARY.md`:
 * Withdraw). One rule for both halves: the Overlay offers the action exactly
 * where the server takes it. A Pick an agent acknowledged, finished or is
 * holding for an approval is past the point where taking it back means anything.
 */
export function isWithdrawable(state: PickState, reportBack: ReportBack | null): boolean {
  if (WITHDRAWABLE.includes(state)) return true
  return reportBack?.state === CLOCK_OFFERED && OFFERABLE.includes(state)
}

/**
 * What a withdraw answers. The Pick is gone from this server — out of the
 * queue, its clock stopped, its Screen Capture deleted, and no longer in
 * `/status`. What it cannot undo is a write: `alreadyWritten` says a session
 * has it, or may, and nothing can take it back from there (spec §21).
 */
export interface WithdrawAnswer {
  pickId: string
  /**
   * True when the Pick was written to a session's socket or drained into a
   * prompt, unless a Receipt said the harness would not deliver it.
   */
  alreadyWritten: boolean
  /**
   * The Target it was written to, as it was named then. Null when nothing was
   * written, and when only the hook floor carried it: the drain does not know
   * which session was prompted.
   */
  targetName: string | null
}

/**
 * The `error` a Pick's own routes refuse with for a Pick this server is not
 * holding: withdrawn already, or never accepted here. The Overlay reads it on
 * a withdraw as the Pick being gone, which is what was asked.
 */
export const UNKNOWN_PICK = 'unknown-pick'

/** The `error` a withdraw refuses with for a Pick past taking back. */
export const NOT_WITHDRAWABLE = 'not-withdrawable'

/** The 409 a withdraw answers for a Pick past taking back, naming its state. */
export interface NotWithdrawableBody extends RefusalBody {
  error: typeof NOT_WITHDRAWABLE
  state: PickState
}

// ---------------------------------------------------------------------------
// Screen Capture: POST /__agent/capture, DELETE /__agent/capture/<id>
// ---------------------------------------------------------------------------

export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

/** What the page measured at the moment of the pick. It cannot see the display. */
export interface CaptureCoordinates {
  /** The element's rectangle in the viewport. */
  rect: Rectangle
  /** `window.screenX` and `window.screenY`. */
  screenX: number
  screenY: number
  /** `outerWidth − innerWidth` and `outerHeight − innerHeight`. */
  chromeWidth: number
  chromeHeight: number
  screen: { width: number; height: number }
}

export interface CaptureStarted {
  captureId: string
}

/** What a DELETE answers for a capture this server was holding: aborted, and gone. */
export interface CaptureDeleted {
  captureId: string
  deleted: true
}

/**
 * The `error` a capture endpoint that cannot capture refuses with, beside the
 * reason why (spec §10, §21). The Overlay reads it as the camera toggle's
 * standing state rather than as one capture that failed: the reason is shown on
 * the toggle, and the page stops asking.
 */
export const CAPTURE_DISABLED = 'capture-disabled'

/**
 * The id a Pick names when its camera toggle was on and it holds no capture —
 * this dev server cannot capture, or the one the page asked for did not start.
 * Sent with \`keep: true\`, it is how the agent is told a capture was intended
 * and failed rather than finding nothing where one should be (spec §10, §21).
 * No capture this server mints is ever called this.
 */
export const NO_CAPTURE = 'none'

/** The \`error\` a DELETE refuses with for a capture this server is not holding. */
export const UNKNOWN_CAPTURE = 'unknown-capture'

// ---------------------------------------------------------------------------
// The hook floor's drain: POST /__agent/drain
// ---------------------------------------------------------------------------

/** What a hook's wrapper sends. Every field is required but the budget. */
export interface DrainRequest {
  /** The hook's own cwd, which the server normalizes again before comparing. */
  cwd: string
  /** The per-server secret, read out of the discovery entry (spec §11). */
  secret: string
  /** Which hook is asking — `UserPromptSubmit` or `Stop`. Stated, not guessed. */
  event: string
  /**
   * How many characters of *JSON-encoded* text the caller can still carry, as
   * `JSON.stringify(text).length - 2`. The caller knows the cost of its own
   * envelope and nothing else; what fits inside the budget is decided by the
   * server.
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
