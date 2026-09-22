import { preflight } from '../harness/claude-session.js'

// Printed whenever the seam-3 command runs, so the answer to "what does this
// command do today, and will it run here" is the first thing it says.
export default function announce() {
  const harness = preflight()
  process.stdout.write(
    [
      '',
      'seam 3 — Claude Code contract canaries, no-model tier (ticket 20).',
      '',
      'Spawns one throwaway Claude Code session under a pty, in a scratch git',
      'repository, with every CLAUDE* variable scrubbed. It appears in the real',
      'registry (~/.claude/sessions/) and socket directory (/tmp/cc-socks/) for',
      'the length of the run, and is killed and checked gone at the end. Its one',
      'turn is pointed at a local blackhole, so no model is reached and nothing',
      'is spent. The model tier is ticket 21 and is not built yet.',
      '',
      harness.runnable
        ? `Running against ${harness.version}.`
        : `SKIPPED: ${harness.reason}.`,
      '',
    ].join('\n'),
  )
}
