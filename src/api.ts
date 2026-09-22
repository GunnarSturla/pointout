// The HTTP surface, in one place, because both halves of the plugin name it:
// the server mounts these paths and the Overlay fetches them (spec §20).

/** Everything the Overlay talks to hangs off this base. */
export const API_BASE = '/__agent'

/** Registry state and the Candidates a Pick could be addressed to. */
export const SESSIONS_PATH = '/sessions'

/** Pick ingress. Ticket 03 gives it a body; the Guard already covers it. */
export const PICK_PATH = '/pick'

/** The query parameter the ack and done URLs carry the Pick's nonce in. */
export const NONCE_PARAM = 'n'

/** The two things an agent can say about a Pick it was handed (ticket 11). */
export type PickAction = 'ack' | 'done'

/**
 * The URL the preamble prints for one Pick action. Built here because both
 * halves name it: the renderer writes it into the body an agent reads, and
 * ticket 11 mounts the route that answers it.
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
