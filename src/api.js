// The HTTP surface, in one place, because both halves of the plugin name it:
// the server mounts these paths and the Overlay fetches them (spec §20).

/** Everything the Overlay talks to hangs off this base. */
export const API_BASE = '/__agent'

/** Registry state and the Candidates a Pick could be addressed to. */
export const SESSIONS_PATH = '/sessions'

/** Pick ingress. Ticket 03 gives it a body; the Guard already covers it. */
export const PICK_PATH = '/pick'
