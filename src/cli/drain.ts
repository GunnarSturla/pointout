import { readFileSync } from 'node:fs'
import { API_BASE, DRAIN_PATH, HOOK_OUTPUT_LIMIT, encodedLength } from '../api.js'
import { readDiscoveryEntries } from '../server/discovery.js'
import type { DiscoveryEntry } from '../server/discovery.js'
import { text } from '../server/parse.js'
import { normalizeToWorktreeRoot } from '../server/paths.js'

// The drain CLI (spec §18): one binary that runs as both hooks. It reads the
// hook's stdin JSON, normalizes its cwd, finds every dev server serving that
// checkout, and prints what they hand back as `additionalContext` under the
// event name it was invoked for.
//
// **It carries no rendering logic.** The server renders; this is a
// pass-through wrapper, and the one thing it decides is how much room its own
// envelope leaves (see `budget` below). If a drained Pick reads wrong, the fix
// is in the server's renderer.
//
// Three rules it never breaks:
//
//   1. **It never exits 2.** On `UserPromptSubmit` that blocks the prompt *and
//      erases it*, which would cost the developer what they typed in order to
//      report that a dev server was unreachable.
//   2. **No dev server running is the normal case**: exit 0, no output, no
//      noise. That is what every prompt in every repo without this plugin does.
//   3. **Everything it has to say goes to stderr**, which on exit 0 reaches the
//      debug log and never the model — so a refusal is stated without being
//      injected into the conversation as if it were a Pick.

/** A wedged dev server must never stall a prompt; it is dropped instead. */
const REQUEST_TIMEOUT_MS = 2_000

/** Run the drain hook. Resolves; it does not throw and it does not exit non-zero. */
export async function runDrain(): Promise<void> {
  const input = readHookInput()

  // Stated, never guessed: a Pick is delivered under the event it rides in on,
  // and claiming entries we could not then label would lose them.
  const event = text(input.hook_event_name)
  if (!event) {
    warn('read no hook_event_name on stdin, so nothing was drained.')
    return
  }

  // `cwd` follows Claude — it is the worktree root after Claude enters one, and
  // the new directory after a `cd` — so it is normalized rather than compared
  // raw, by the same function the dev server normalizes its own root with.
  const root = normalizeToWorktreeRoot(text(input.cwd) ?? process.cwd())
  const servers = readDiscoveryEntries(root)
  if (servers.length === 0) return

  // What is left of the 10,000 characters once this hook's own JSON envelope is
  // paid for, counted the way the server counts: escaped, as it will be printed.
  let budget = HOOK_OUTPUT_LIMIT - envelope(event, '').length
  const chunks: string[] = []

  for (const server of servers) {
    if (budget <= 0) break
    const chunk = await drainOne(server, root, event, budget)
    if (!chunk) continue
    chunks.push(chunk)
    // The separator between two servers' texts is paid for here as well.
    budget -= encodedLength(chunk) + encodedLength('\n')
  }

  if (chunks.length === 0) return
  process.stdout.write(envelope(event, chunks.join('\n')))
}

/** One dev server's share of the drain. Returns '' when it gave nothing. */
async function drainOne(
  server: DiscoveryEntry,
  root: string,
  event: string,
  budget: number,
): Promise<string> {
  const url = `http://${server.host}:${server.port}${API_BASE}${DRAIN_PATH}`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: root, secret: server.secret, event, budget }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { reason?: string }
      warn(
        `the dev server on port ${server.port} refused the drain ` +
          `(${response.status}): ${body.reason ?? 'no reason given'}`,
      )
      return ''
    }
    const answer = (await response.json()) as { text?: unknown }
    return typeof answer.text === 'string' ? answer.text : ''
  } catch {
    // A dev server that has gone, or one that did not answer in time. Its entry
    // is swept by the next dev server that starts; nothing is said here,
    // because a stale entry is the ordinary aftermath of a Ctrl-C.
    return ''
  }
}

/** The hook's stdin JSON, or an empty object when there is none to read. */
function readHookInput(): Record<string, unknown> {
  try {
    if (process.stdin.isTTY) return {}
    const parsed: unknown = JSON.parse(readFileSync(0, 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    // Not run as a hook, or run by a harness whose input shape has moved.
    return {}
  }
}

/** Exactly the shape the harness reads context off (`additionalContext`, §18). */
function envelope(event: string, context: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context },
  })
}

function warn(message: string): void {
  process.stderr.write(`pointout: ${message}\n`)
}
