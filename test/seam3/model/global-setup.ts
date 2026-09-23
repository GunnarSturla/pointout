import { preflight } from '../../harness/claude-session.js'

// Printed whenever the model tier runs, so that what it spends, and where, is
// the first thing it says.
export default function announce() {
  const harness = preflight()
  process.stdout.write(
    [
      '',
      'seam 3 — Claude Code contract canaries, MODEL TIER (ticket 21).',
      '',
      'THIS SPENDS TOKENS on your Claude Code account: a handful of turns on',
      'haiku, the cheapest model, across two throwaway sessions. A third session',
      'takes one turn that is pointed at a local blackhole and spends nothing.',
      '',
      'Each session runs under a pty in a scratch git repository, with every',
      'CLAUDE* variable scrubbed and your user-level settings not loaded',
      "(--setting-sources project,local). `init` writes the scratch project's",
      'own .claude/ and nothing else. One session is handed a fixture allowlist',
      '(a PreToolUse hook allowing one curl shape, at the ack and done URLs)',
      'with --settings, from a temporary file. It is a test fixture: it ships',
      'nowhere and is never configuration to copy.',
      '',
      'On success the Claude Code version is recorded in',
      'src/server/claude/verified-harness.ts, for the posture block (ticket 19).',
      '',
      harness.runnable
        ? `Running against ${harness.version}.`
        : `SKIPPED: ${harness.reason}.`,
      '',
    ].join('\n'),
  )
}
