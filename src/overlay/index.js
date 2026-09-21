// The Overlay — everything vite-agent-inspect draws into the consumer's page:
// Picker, Highlight, Panel and Stack, in one open shadow root (spec §3).
//
// Ticket 01 ships the entry point only: it proves the virtual module is served
// in dev and absent from a production build. Ticket 04 builds the shadow host
// and the tracer bullet through it. Zero motion anywhere (spec §9).

/** Every endpoint the Overlay talks to hangs off this base (spec §20). */
const API_BASE = '/__agent'

/**
 * The marker a seam-2 smoke test reads to know the Overlay module was served,
 * evaluated, and reached the page. Ticket 04 replaces it with the shadow host.
 */
globalThis.__viteAgentInspect = { apiBase: API_BASE, stage: 'scaffold' }
