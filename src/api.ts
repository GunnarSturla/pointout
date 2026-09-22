// The HTTP surface, in one place, because both halves of the plugin name it:
// the server mounts these paths and the Overlay fetches them (spec §20).

/** Everything the Overlay talks to hangs off this base. */
export const API_BASE = '/__agent'

/** Registry state and the Candidates a Pick could be addressed to. */
export const SESSIONS_PATH = '/sessions'

/** Pick ingress. Ticket 03 gives it a body; the Guard already covers it. */
export const PICK_PATH = '/pick'

/** Every outstanding Pick's state, and the Target row beside each (spec §20). */
export const STATUS_PATH = '/status'

/** The query parameter the ack and done URLs carry the Pick's nonce in. */
export const NONCE_PARAM = 'n'

/** The two things an agent can say about a Pick it was handed (ticket 11). */
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
