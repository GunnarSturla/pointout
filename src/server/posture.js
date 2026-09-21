// One block, printed once, at startup. Every "fail closed, say so out loud"
// line in spec §21 that belongs to startup lands here; nothing logs a scattered
// posture line of its own. Later tickets append: the reply socket (03), the
// discovery entry (15), Screen Capture (17), the harness version (19).

import { DIRECTORY_MISSING, SHAPE_UNRECOGNISED } from './registry.js'

const HEADING = 'vite-agent-inspect — startup posture'

/** A list of label/text pairs that renders as one block. */
export function createPosture() {
  const lines = []

  return {
    add(label, text) {
      lines.push([label, text])
      return this
    },
    render() {
      const width = Math.max(...lines.map(([label]) => label.length))
      const body = lines.map(([label, text]) => `  ${label.padEnd(width)}  ${text}`)
      return [HEADING, ...body].join('\n')
    },
  }
}

export function rootLine(root, method) {
  const how = {
    git: 'git rev-parse --show-toplevel',
    'vite-root': 'the Vite root; not inside a git repository',
    option: 'the root option',
  }[method]
  return `${root} (${how})`
}

export const GUARD_LINE =
  'loopback only; Origin required on Pick ingress, and absent means refused'

export function registryLine(registry, candidateCount) {
  const floor = 'targeting falls back to the hook floor'
  switch (registry.state) {
    case DIRECTORY_MISSING:
      return `directory missing (${registry.directory}) — ${floor}`
    case SHAPE_UNRECOGNISED:
      return `entries in an unrecognised shape (${registry.directory}) — ${floor}`
    default:
      // A rejected entry is named rather than dropped quietly (spec §21).
      return (
        `readable — ${count(candidateCount, 'session')} in this checkout` +
        (registry.rejected > 0
          ? `, and ${count(registry.rejected, 'entry', 'entries')} ` +
            'in an unrecognised shape, ignored'
          : '')
      )
  }
}

function count(n, singular, plural = singular + 's') {
  return `${n} ${n === 1 ? singular : plural}`
}

export function lanLine(address) {
  return `Vite is bound to ${address} — Picks arriving from the LAN will be refused`
}

/** Loopback for the purpose of the LAN warning: anything else is reachable. */
export function isLoopbackHost(address) {
  return address === '::1' || address === 'localhost' || address.startsWith('127.')
}
