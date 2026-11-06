import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Reporter, TestModule, TestRunEndReason } from 'vitest/node'
import { preflight } from '../../harness/claude-session.js'
import { repoRoot } from '../../harness/paths.js'

// On success the model tier records the Claude Code version it passed against,
// in the repo (spec, *Testing Decisions*, the Claude suite; ticket 21). Success is the
// whole run: every test passed and none was skipped, so a run that skipped for
// want of a login, or that was cut short, records nothing.
//
// The record is the TypeScript module ticket 19's posture block is to read. The
// line it rewrites is written out here, not imported: the file is the contract.

/** Where the record lives, relative to the repository root. */
export const RECORD_PATH = 'src/server/claude/verified-harness.ts'

/** The record's value: `null`, or the object as the formatter lays it out. */
const RECORD_LINE =
  /^export const VERIFIED_HARNESS: VerifiedHarness \| null = (?:null|\{[^}]*\})$/m

export default class RecordVersion implements Reporter {
  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    errors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): void {
    const tests = modules.flatMap((module) => [...module.children.allTests()])
    const passed =
      reason === 'passed' &&
      errors.length === 0 &&
      tests.length > 0 &&
      tests.every((test) => test.result().state === 'passed')
    if (!passed) {
      say(`not every test ran and passed, so ${RECORD_PATH} is left as it was.`)
      return
    }
    const harness = preflight()
    const version = harness.runnable
      ? /^(\d+\.\d+\.\d+)/.exec(harness.version)?.[1]
      : undefined
    if (!version) {
      say(
        `every test passed, but the CLI's version could not be read again, so ` +
          `${RECORD_PATH} is left as it was.`,
      )
      return
    }
    const path = join(repoRoot, RECORD_PATH)
    const source = readFileSync(path, 'utf8')
    if (!RECORD_LINE.test(source)) {
      throw new Error(`${RECORD_PATH} no longer has the line this reporter rewrites`)
    }
    const verifiedAt = new Date().toISOString().slice(0, 10)
    writeFileSync(
      path,
      source.replace(
        RECORD_LINE,
        [
          'export const VERIFIED_HARNESS: VerifiedHarness | null = {',
          `  version: '${version}',`,
          `  verifiedAt: '${verifiedAt}',`,
          '}',
        ].join('\n'),
      ),
    )
    say(`passed against Claude Code ${version}; recorded in ${RECORD_PATH}.`)
  }
}

function say(text: string): void {
  process.stdout.write(`\nClaude-suite model tier: ${text}\n`)
}
