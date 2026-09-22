#!/usr/bin/env node
import { claudeSetup } from './claude/setup.js'
import { runDrain } from './drain.js'
import { runSetup } from './setup.js'

// The package's one binary, `vite-agent-inspect`, with a subcommand per job
// (spec §18). One bin rather than two because the spec names `npx
// vite-agent-inspect init`, and a second executable for the hook would be a
// second thing for a consumer to have installed correctly.
//
// `drain` is the hook floor's wrapper and must never exit 2 or throw; `init`
// is a person at a terminal, where a refusal is worth a non-zero exit.

/** Every command, and whether a failure inside it may be reported by exiting. */
const COMMANDS: Record<string, { run: () => Promise<void>; failsQuietly: boolean }> = {
  // A hook, so: never non-zero, whatever went wrong (spec §18).
  drain: { run: runDrain, failsQuietly: true },
  // A person at a terminal: a refusal names the file and exits non-zero. The
  // harness is chosen here and nowhere else (the second-harness seam, §18).
  init: { run: async () => runSetup(claudeSetup, process.cwd()), failsQuietly: false },
}

const name = process.argv[2] ?? ''
const command = COMMANDS[name]

if (!command) {
  process.stderr.write(
    `vite-agent-inspect: no command ${JSON.stringify(name)}. ` +
      `Commands: ${Object.keys(COMMANDS).join(', ')}.\n`,
  )
  process.exitCode = 1
} else {
  try {
    await command.run()
  } catch (error) {
    process.stderr.write(
      `vite-agent-inspect: ${name} failed: ${(error as Error).message}\n`,
    )
    if (!command.failsQuietly) process.exitCode = 1
  }
}
