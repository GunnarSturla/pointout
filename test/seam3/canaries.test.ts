import { describe, it } from 'vitest'

// Seam 3: contract canaries against a real Claude Code harness. Tickets 20 (the
// free, no-model tier) and 21 (the model tier and version pinning) build them.
//
// This suite fakes nothing: it spawns a throwaway Claude Code session under a
// pty with every CLAUDE_* variable scrubbed, in a temporary git repository, and
// asserts on harness artefacts — registry files, frames at the dev server's
// reply socket, the transcript on disk — never on what the model says.
//
// It needs the `claude` CLI and a logged-in account, costs tokens in its model
// tier, and never runs in CI. Hence its own command and its own config.

describe('seam 3 — Claude Code contract canaries', () => {
  it.skip('no-model tier: registry shape, key file, socket, idle notice (ticket 20) — not implemented', () => {})
  it.skip('model tier: a Pick through the full pipeline, and the version pin (ticket 21) — not implemented', () => {})
})
