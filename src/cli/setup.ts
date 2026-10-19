import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { normalizeToWorktreeRoot } from '../server/paths.js'
import type { HostSetup } from './hosts.js'

// `init` (spec §18): the setup half of the second-harness seam. The delivery
// half is `DeliveryRoute` in `server/delivery.ts`; this is its twin for what a
// project needs installed before that route's floor can work. Everything a
// particular harness means by "set up" — which settings file, which hook
// events, where its skills live — sits behind `HarnessSetup` in a directory
// named for it (`claude/`), so a second harness is a second implementation of
// both interfaces rather than a redesign of either.
//
// The part every harness shares is here, and it is the part that keeps the
// promise user story 87 makes: **plan everything, then write, then say exactly
// what happened.** A plan that cannot be made — a settings file that is not
// JSON, a project without the package installed — throws before one byte is
// written, so a refusal never leaves a half-set-up project behind it.

/** The package's own name, as a consumer's `node_modules` spells it. */
const PACKAGE_NAME = 'pointout'

/**
 * How every installed drain CLI's path ends, wherever the package landed. A
 * harness recognises a hook this package wrote by it, whatever path came first.
 */
export const INSTALLED_DRAIN_BIN = `${PACKAGE_NAME}/dist/cli/main.js`

/** What `init` did about one item, in the words it prints. */
export type SetupAction = 'wrote' | 'updated' | 'already present'

/** One line of the report: an item, the file it lives in, and what was done. */
export interface SetupItem {
  what: string
  path: string
  action: SetupAction
}

/** A whole file's new content. Only files whose content changes are listed. */
export interface SetupWrite {
  path: string
  content: string
}

export interface SetupPlan {
  items: SetupItem[]
  writes: SetupWrite[]
}

/** The project `init` was run in, as a harness needs to know it. */
export interface Project {
  /** The worktree root of the directory `init` ran in (spec §2). */
  root: string
  /**
   * The drain CLI's path relative to `root`, slash-separated, as the installed
   * package lays it out — so a hook entry can name it from the project
   * directory whichever `node_modules` the package landed in.
   */
  drainBin: string
  /** The Host the project's dev server is, which the setup skill names. */
  host: HostSetup
}

export interface HarnessSetup {
  /** The harness's name, for the report's heading. */
  name: string
  /**
   * What this project needs, read against what is already there, with nothing
   * written. Throws, naming the file, when what is there cannot be read.
   */
  plan(project: Project): SetupPlan
}

/**
 * Run `init` for one harness in `cwd`, and print what it did. The Host is
 * chosen after the package is found and before anything is planned, so a
 * refusal of either writes nothing.
 */
export async function runSetup(
  harness: HarnessSetup,
  cwd: string,
  chooseHost: (cwd: string) => Promise<HostSetup>,
): Promise<void> {
  const root = normalizeToWorktreeRoot(cwd)
  const drainBin = drainBinFrom(cwd, root)
  const host = await chooseHost(cwd)
  const plan = harness.plan({ root, drainBin, host })

  // A write can still fail after the plan was made — a read-only directory, a
  // full disk. The files already written are named in the refusal, so a
  // half-set-up project is never one nobody was told about (spec §21).
  const written: string[] = []
  for (const { path, content } of plan.writes) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    } catch (error) {
      const already = written.length
        ? `Already written: ${written.join(', ')}.`
        : 'Nothing was written.'
      throw new Error(
        `could not write ${path}: ${(error as Error).message}. ${already}`,
        {
          cause: error,
        },
      )
    }
    written.push(path)
  }

  const width = Math.max(...plan.items.map(({ action }) => action.length))
  const lines = [
    `pointout init: ${harness.name}, in ${root}`,
    ...plan.items.map(
      ({ what, path, action }) => `  ${action.padEnd(width)}  ${what} — ${path}`,
    ),
    // What the Host's own files need is said here and never done.
    ...host.instructions(cwd),
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

/**
 * Where the installed package's drain CLI is, relative to `root`. Found the way
 * Node would find the package from where `init` ran — the nearest
 * `node_modules` at or above `cwd`, so a workspace package that alone depends
 * on it is found too — and never from where this process happens to be
 * running, which under `npx` may be a cache the project cannot see.
 */
function drainBinFrom(cwd: string, root: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const installed = join(dir, 'node_modules', PACKAGE_NAME)
    if (isThisPackage(installed)) {
      const path = relative(root, join(dir, 'node_modules', INSTALLED_DRAIN_BIN))
      return path.split(sep).join('/')
    }
    if (dirname(dir) === dir) break
  }
  throw new Error(
    `${PACKAGE_NAME} is not installed in ${cwd} or any directory above it, so ` +
      'there is no drain CLI for a hook to run. Install it as a dev dependency ' +
      'of this project, then run init again. Nothing was written.',
  )
}

function isThisPackage(dir: string): boolean {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return false
  try {
    const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
    return name === PACKAGE_NAME
  } catch {
    return false
  }
}
