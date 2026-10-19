// One block, printed once, at startup (spec §2, §21). Every "fail closed, say so
// out loud" line that belongs to startup lands here, in the spec's order, and
// nothing logs a posture line of its own anywhere else: a service hands its line
// to the block and says nothing itself. `docs/posture.md` lists every line and
// what it means for the developer; the seam-1 posture test holds the wording.

import { DIRECTORY_MISSING, SHAPE_UNRECOGNISED } from '../wire.js'
import type { RootMethod } from './paths.js'
import type { Registry } from './registry.js'

const HEADING = 'pointout — startup posture'

/**
 * One service's line: what it says, and whether what it says is a degradation
 * the developer should not be able to miss. One such line makes the whole block
 * a warning, so a consumer who runs Vite at `logLevel: 'warn'` still sees it.
 */
export interface PostureLine {
  text: string
  warns: boolean
}

export const says = (text: string): PostureLine => ({ text, warns: false })
export const warns = (text: string): PostureLine => ({ text, warns: true })

/** The block under construction: labelled lines that render as one. */
export interface Posture {
  add(label: string, line: PostureLine): Posture
  /** Whether any line is a warning, which is the level the block is logged at. */
  warns(): boolean
  render(): string
}

export function createPosture(): Posture {
  const lines: Array<[string, PostureLine]> = []

  const posture: Posture = {
    add(label, line) {
      lines.push([label, line])
      return this
    },
    warns() {
      return lines.some(([, line]) => line.warns)
    },
    render() {
      const width = Math.max(...lines.map(([label]) => label.length))
      const body = lines.map(([label, line]) => `  ${label.padEnd(width)}  ${line.text}`)
      return [HEADING, ...body].join('\n')
    },
  }

  return posture
}

/** `host` is how the block names the Host: `Vite`, `Next.js`. */
export function rootLine(root: string, method: RootMethod, host: string): PostureLine {
  const how: Record<RootMethod, string> = {
    git: 'git rev-parse --show-toplevel',
    'host-root': `the ${host} root; not inside a git repository`,
    option: 'the root option',
  }
  return says(`${root} (${how[method]})`)
}

export const GUARD_LINE: PostureLine = says(
  'loopback only; Origin required on Pick ingress, and absent means refused',
)

export function registryLine(registry: Registry, candidateCount: number): PostureLine {
  const floor = 'targeting falls back to the hook floor'
  switch (registry.state) {
    case DIRECTORY_MISSING:
      return warns(`directory missing (${registry.directory}) — ${floor}`)
    case SHAPE_UNRECOGNISED:
      return warns(`entries in an unrecognised shape (${registry.directory}) — ${floor}`)
    default:
      // A rejected entry is named rather than dropped quietly (spec §21).
      return says(
        `readable — ${count(candidateCount, 'session')} in this checkout` +
          (registry.rejected > 0
            ? `, and ${count(registry.rejected, 'entry', 'entries')} ` +
              'in an unrecognised shape, ignored'
            : ''),
      )
  }
}

function count(n: number, singular: string, plural = singular + 's'): string {
  return `${n} ${n === 1 ? singular : plural}`
}

export function lanLine(host: string, address: string): PostureLine {
  return warns(
    `${host} is bound to ${address} — Picks arriving from the LAN will be refused`,
  )
}

/** Loopback for the purpose of the LAN warning: anything else is reachable. */
export function isLoopbackHost(address: string): boolean {
  return address === '::1' || address === 'localhost' || address.startsWith('127.')
}
