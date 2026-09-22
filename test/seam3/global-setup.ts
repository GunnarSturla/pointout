// Printed whenever the seam-3 command runs, so the answer to "what does this
// command do today" is the first thing it says.
export default function announce() {
  process.stdout.write(
    [
      '',
      'seam 3 — Claude Code contract canaries: NOT IMPLEMENTED.',
      '',
      'Tickets 20 (no-model tier) and 21 (model tier, version pinning) build this',
      'suite. It fakes nothing: it spawns a throwaway Claude Code session against',
      'the real registry, needs the `claude` CLI and a login, costs tokens in its',
      'model tier, and never runs in CI — which is why it has its own command.',
      '',
    ].join('\n'),
  )
}
