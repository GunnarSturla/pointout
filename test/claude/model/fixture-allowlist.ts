import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// THE TEST FIXTURE ALLOWLIST. It ships nowhere and is never to be recommended
// to a consumer: spec §19 forbids any configuration whose purpose is to raise
// what a Pick may cause to happen, and a permission allowlist for the ack is
// the first thing on that list.
//
// It exists for one reason: so the model tier's ack canary can run unattended
// (spec, *Further Notes*: "the one allowlist it writes lives in the throwaway
// session's own settings"). Its purpose is to test the harness, not to raise a
// Pick's authority. It is handed to one throwaway session alone, as a settings
// file in a temporary directory passed with `--settings`; it is never written
// into the scratch repository, and `init` never writes anything like it.
// `test/claude/shipped.test.ts` proves no file in the package carries it.
//
// It is a `PreToolUse` hook rather than a `permissions.allow` rule, because a
// rule can only glob: `Bash(curl *<route>*)` would also allow a `curl` that
// uploads a file somewhere else and mentions the route on the way. The hook
// allows exactly one command shape — `isPickRouteCurl` below — and nothing
// else: every other command falls through to the ordinary permission prompt,
// which the suite refuses. The same hook, told to allow nothing, is how the
// manual-mode session's pending commands are read exactly: a tool call reaches
// the transcript only once it has run, and the terminal garbles the dialog.

/** Written into the hook script; the shipped-file check searches for it. */
export const FIXTURE_MARKER = 'pointout the Claude suite fixture allowlist'

/**
 * One `curl` at one of this dev server's Pick routes and nothing more: flags that
 * take no argument, an optional `-X POST` or `-X GET`, one ack or done URL,
 * quoted or not, and at most a `2>/dev/null`. No second URL, no file, no
 * output path. The model writes its own flags and quotes (it
 * rarely copies the skill's `-sS -X POST '…'`), so those are what varies.
 */
export function pickRoutePattern(devServerUrl: string): RegExp {
  const origin = new URL(devServerUrl).origin.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const flag = String.raw`(?: -X (?:POST|GET)| -{1,2}[A-Za-z][A-Za-z-]*)`
  const url = String.raw`${origin}\/__agent\/pick\/[0-9a-f-]{36}\/(?:ack|done)\?n=[0-9a-f]+`
  return new RegExp(String.raw`^curl${flag}* (["']?)${url}\1${flag}*(?: 2>\/dev\/null)?$`)
}

/** An `echo` of one quoted literal: nothing expanded, nothing on a second line. */
const ECHO_PATTERN = /^echo (?:"[^"$`\\\n]*"|'[^'\n]*')$/

/** How a command is cut into the steps `&&` and `;` chain. */
const CHAIN = /\s*(?:&&|;)\s*/

/**
 * The one command shape this suite allows: one or more Pick-route `curl`s,
 * chained with `&&` or `;`, with an `echo` of a quoted literal between them if
 * the model likes (measured: it chains ack and done, and sometimes echoes).
 * A chain cut inside a quoted literal leaves a step with an unclosed quote, which
 * matches neither pattern, so smuggling a command inside an echo fails closed.
 */
export function isPickRouteCurl(command: string, devServerUrl: string): boolean {
  const curl = pickRoutePattern(devServerUrl)
  const steps = command.split(CHAIN)
  return (
    steps.some((step) => curl.test(step)) &&
    steps.every((step) => curl.test(step) || ECHO_PATTERN.test(step))
  )
}

/** One `PreToolUse` call the hook saw, as it logs it. */
export interface LoggedToolCall {
  id: string
  tool: string
  command: string | null
}

export interface FixtureHook {
  /** The settings file to hand the session with `--settings`. */
  settingsFile: string
  /** Every Bash call the session has asked to make, oldest first. */
  calls(): LoggedToolCall[]
}

/**
 * Write the hook and its settings into `dir`, a temporary directory the caller
 * owns. With `allow`, it allows `isPickRouteCurl` commands; without, it only
 * logs, and the permission prompt decides as it would have.
 */
export function writeFixtureHook(
  dir: string,
  devServerUrl: string,
  { allow }: { allow: boolean },
): FixtureHook {
  const log = join(dir, 'tool-calls.ndjson')
  const script = join(dir, 'pre-tool-use.mjs')
  writeFileSync(log, '')
  writeFileSync(
    script,
    [
      `// ${FIXTURE_MARKER}. A test fixture: never configuration.`,
      "import { appendFileSync, readFileSync } from 'node:fs'",
      "const input = JSON.parse(readFileSync(0, 'utf8'))",
      'const command = input.tool_input?.command ?? null',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id: input.tool_use_id, tool: input.tool_name, command }) + '\\n')`,
      // `isPickRouteCurl`, written out: the hook runs under plain `node`, which
      // cannot import this TypeScript module. The free fixture test runs this
      // script against the same commands it holds `isPickRouteCurl` to.
      `const curl = ${pickRoutePattern(devServerUrl).toString()}`,
      `const echo = ${ECHO_PATTERN.toString()}`,
      `const steps = String(command).split(${CHAIN.toString()})`,
      'const allowed = steps.some((s) => curl.test(s)) &&',
      '  steps.every((s) => curl.test(s) || echo.test(s))',
      `if (${allow} && input.tool_name === 'Bash' && allowed) {`,
      '  process.stdout.write(JSON.stringify({ hookSpecificOutput: {',
      "    hookEventName: 'PreToolUse', permissionDecision: 'allow',",
      "    permissionDecisionReason: 'the Claude suite fixture: the ack or done curl' } }))",
      '}',
      '',
    ].join('\n'),
  )
  const settingsFile = join(dir, 'settings.json')
  writeFileSync(
    settingsFile,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
              },
            ],
          },
        ],
      },
    }),
  )
  return {
    settingsFile,
    calls() {
      const lines: LoggedToolCall[] = []
      for (const line of readFileSyncSafe(log).split('\n')) {
        if (line.trim() === '') continue
        try {
          lines.push(JSON.parse(line) as LoggedToolCall)
        } catch {
          // Half-written as it is read; the next read has it.
        }
      }
      return lines
    },
  }
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
