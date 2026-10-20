import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { hostName } from '../server/host-name.js'
import type { HostName } from '../server/host-name.js'
import { isRecord } from '../server/parse.js'

// Which Host `init` is setting up for (Next.js Connector ticket 09). It is read
// off the `package.json` in the directory `init` runs in — `next` there means
// Next.js, `vite` means Vite — and `--connector` always wins over that. When
// the manifest names both, a person at a terminal is asked; a scripted run is
// refused rather than guessed for. Every refusal is made before a plan is, so
// it writes nothing.
//
// What `init` does about a Host is said, never done: it prints the changes a
// Host's own files need and leaves those files exactly as they were.

/**
 * A Connector's name, as `--connector` spells it. Its Host's name, as a person
 * calls it, is the `HostName` beside it in `HostSetup`.
 */
export type ConnectorName = 'next' | 'vite'

const CONNECTORS: readonly ConnectorName[] = ['next', 'vite']

/** How `--connector` is spelled in every refusal that names it. */
const FLAG = `--connector ${CONNECTORS.join('|')}`

/** The Next.js config file names Next itself looks for, in its own order. */
const NEXT_CONFIGS = ['next.config.ts', 'next.config.mjs', 'next.config.js']

export interface HostSetup {
  connector: ConnectorName
  /** The Host's name, as a person calls it. */
  name: HostName
  /**
   * What the dev server must have for Picks to come from it, as the setup
   * skill says it: a fact about how the floor fails, never an instruction.
   */
  skillSetup: string
  /** The changes `init` prints and does not make, one line each, or none. */
  instructions(appDir: string): string[]
}

const VITE: HostSetup = {
  connector: 'vite',
  name: hostName('Vite'),
  skillSetup:
    'Picks come from a Vite dev server whose config has the `pointout()` plugin,\n' +
    'from `pointout/vite`, in its `plugins`.',
  instructions: () => [],
}

const NEXT: HostSetup = {
  connector: 'next',
  name: hostName('Next.js'),
  skillSetup:
    'Picks come from a Next.js dev server whose `next.config` is wrapped in\n' +
    '`withPointout()` from `pointout/next`, started with `next dev -H localhost`.',
  instructions(appDir) {
    const config = NEXT_CONFIGS.map((name) => join(appDir, name)).find((path) =>
      existsSync(path),
    )
    return [
      '',
      'Two changes are yours to make; init has not edited either file:',
      `  1. In ${config ?? 'your next.config'}, wrap the exported config in ` +
        "withPointout() from pointout/next: `import { withPointout } from 'pointout/next'`, " +
        'then `export default withPointout(nextConfig)`.',
      '  2. Run the dev server as `next dev -H localhost`, so it listens on this ' +
        'machine only (your package.json "dev" script, say).',
    ]
  },
}

const HOSTS: Record<ConnectorName, HostSetup> = { next: NEXT, vite: VITE }

/** `init`'s own arguments: `--connector <name>` or `--connector=<name>`. */
export function connectorFlag(args: readonly string[]): string | null {
  let connector: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--connector') {
      const value = args[++i]
      if (value === undefined) throw new Error(`--connector needs a value: ${FLAG}.`)
      connector = value
    } else if (arg.startsWith('--connector=')) {
      connector = arg.slice('--connector='.length)
    } else {
      throw new Error(
        `init does not take ${JSON.stringify(arg)}; it takes only ${FLAG}. ` +
          'Nothing was written.',
      )
    }
  }
  return connector
}

/** The Host to set up for, from the flag or else the manifest in `cwd`. */
export async function chooseHost(cwd: string, flag: string | null): Promise<HostSetup> {
  if (flag !== null) return hostNamed(flag)

  const manifest = join(cwd, 'package.json')
  const found = dependsOn(manifest)
  if (found.length === 1) return HOSTS[found[0]!]
  if (found.length === 0) {
    const missing = existsSync(manifest) ? '' : 'does not exist, so it '
    throw new Error(
      `${manifest} ${missing}depends on neither vite nor next, so init cannot ` +
        `tell which Host this is. Run it in the app's own directory, ` +
        `or name the Host with ${FLAG}. Nothing was written.`,
    )
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${manifest} depends on both vite and next, and there is no terminal to ask ` +
        `which to set up. Name it with ${FLAG}. Nothing was written.`,
    )
  }
  return hostNamed(await ask(manifest))
}

function hostNamed(name: string): HostSetup {
  if ((CONNECTORS as readonly string[]).includes(name))
    return HOSTS[name as ConnectorName]
  throw new Error(
    `there is no Connector ${JSON.stringify(name)}; use ${FLAG}. Nothing was written.`,
  )
}

/** Which Connectors' Hosts the manifest names, in any dependency field. */
function dependsOn(manifest: string): ConnectorName[] {
  if (!existsSync(manifest)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch (error) {
    throw new Error(
      `${manifest} is not JSON (${(error as Error).message}), so init cannot tell ` +
        `which Host this is. Fix it, or name the Host with ${FLAG}. Nothing was written.`,
      { cause: error },
    )
  }
  if (!isRecord(parsed)) return []
  const fields = ['dependencies', 'devDependencies', 'peerDependencies']
  const names = new Set(
    fields.flatMap((field) => {
      const deps = parsed[field]
      return isRecord(deps) ? Object.keys(deps) : []
    }),
  )
  return CONNECTORS.filter((connector) => names.has(connector))
}

async function ask(manifest: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(
      `${manifest} depends on both vite and next. Which Connector should init set up? ` +
        `[${CONNECTORS.join('/')}] `,
    )
    return answer.trim().toLowerCase()
  } finally {
    prompt.close()
  }
}
