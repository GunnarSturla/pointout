// The HTTP surface, in one place, because both halves of the plugin name it:
// the server mounts these paths and the Overlay fetches them (spec §20).

/** Everything the Overlay talks to hangs off this base. */
export const API_BASE = '/__agent'

/** Registry state and the Candidates a Pick could be addressed to. */
export const SESSIONS_PATH = '/sessions'

/** Pick ingress. */
export const PICK_PATH = '/pick'

/** Every outstanding Pick's state, and the Target row beside each (spec §20). */
export const STATUS_PATH = '/status'

/** Screen Capture: POST starts one, DELETE on `<path>/<id>` aborts it (§20). */
export const CAPTURE_PATH = '/capture'

/**
 * The hook floor's drain (spec §18, §20). POST only, and the drain CLI is its
 * one caller: the Overlay never asks for it, but both halves of the package
 * name it, so it is written here beside the rest.
 */
export const DRAIN_PATH = '/drain'

/**
 * The harness caps a hook's output string — `additionalContext` included — at
 * 10,000 characters, and replaces anything longer with a file path and a
 * preview. The drain CLI subtracts the cost of its own JSON envelope from this
 * and sends the rest as the budget; the server fits its rendering inside it
 * (spec §18).
 */
export const HOOK_OUTPUT_LIMIT = 10_000

/**
 * What `text` costs inside the JSON string a hook prints — the unit the drain
 * budget is stated in, because escaping is what a plain character count misses.
 * Written once because both halves count with it: the CLI to say how much room
 * is left, the server to decide what fits.
 */
export function encodedLength(text: string): number {
  return JSON.stringify(text).length - 2
}

/**
 * Which capture a `DELETE ${CAPTURE_PATH}/<id>` names, or null when the path
 * names none. `path` is relative to `API_BASE` and carries no query, like
 * `parsePickAction` below.
 */
export function parseCaptureId(path: string): string | null {
  if (!path.startsWith(`${CAPTURE_PATH}/`)) return null
  const id = path.slice(CAPTURE_PATH.length + 1)
  if (id.length === 0 || id.includes('/')) return null
  try {
    return decodeURIComponent(id)
  } catch {
    // A percent escape that is not one. It names no capture this server started.
    return null
  }
}

/** The query parameter the ack and done URLs carry the Pick's nonce in. */
export const NONCE_PARAM = 'n'

/** The two things an agent can say about a Pick it was handed (spec §17). */
export type PickAction = 'ack' | 'done'

const PICK_ACTIONS: readonly string[] = ['ack', 'done'] satisfies PickAction[]

/**
 * The URL the preamble prints for one Pick action. Built here because both
 * halves name it: the renderer writes it into the body an agent reads, and the
 * server mounts the route that answers it.
 */
export function pickActionUrl(
  origin: string,
  action: PickAction,
  pickId: string,
  nonce: string,
): string {
  const path = `${API_BASE}${PICK_PATH}/${encodeURIComponent(pickId)}/${action}`
  return `${origin}${path}?${NONCE_PARAM}=${encodeURIComponent(nonce)}`
}

/**
 * The inverse of the path half above: which Pick, and which of the two things
 * the agent is saying about it. Null when the path is neither. It lives beside
 * the builder so the shape is written once — two halves of one string that
 * disagreed would print a URL nothing answers.
 *
 * `path` is relative to `API_BASE` and carries no query.
 */
export function parsePickAction(
  path: string,
): { pickId: string; action: PickAction } | null {
  if (!path.startsWith(`${PICK_PATH}/`)) return null
  const parts = path.slice(PICK_PATH.length + 1).split('/')
  if (parts.length !== 2) return null

  const [id, action] = parts
  if (!id || !action || !PICK_ACTIONS.includes(action)) return null
  try {
    return { pickId: decodeURIComponent(id), action: action as PickAction }
  } catch {
    // A percent escape that is not one. It names no Pick this server minted.
    return null
  }
}

/** The last segment of the path the Overlay resolves a report-back offer on. */
const REPORT_SEGMENT = 'report'

/**
 * `/pick/<id>/report`, relative to `API_BASE` (spec §20). Built and parsed here
 * for the same reason the ack URL is: the Overlay asks for it and the server
 * mounts it, and two spellings would be a route nothing answers.
 */
export function reportPath(pickId: string): string {
  return `${PICK_PATH}/${encodeURIComponent(pickId)}/${REPORT_SEGMENT}`
}

/** The Pick a report path names, or null when the path is not one. */
export function parseReportPath(path: string): string | null {
  if (!path.startsWith(`${PICK_PATH}/`)) return null
  const parts = path.slice(PICK_PATH.length + 1).split('/')
  if (parts.length !== 2 || parts[1] !== REPORT_SEGMENT || !parts[0]) return null
  try {
    return decodeURIComponent(parts[0])
  } catch {
    return null
  }
}

/**
 * `/pick/<id>`, relative to `API_BASE`: the path a Withdraw is a DELETE on
 * (spec §20). Built and parsed here, like the report path, so the Overlay and
 * the server cannot spell it two ways.
 */
export function withdrawPath(pickId: string): string {
  return `${PICK_PATH}/${encodeURIComponent(pickId)}`
}

/** The Pick a withdraw path names, or null when the path is not one. */
export function parseWithdrawPath(path: string): string | null {
  if (!path.startsWith(`${PICK_PATH}/`)) return null
  const id = path.slice(PICK_PATH.length + 1)
  if (id.length === 0 || id.includes('/')) return null
  try {
    return decodeURIComponent(id)
  } catch {
    // A percent escape that is not one. It names no Pick this server minted.
    return null
  }
}
