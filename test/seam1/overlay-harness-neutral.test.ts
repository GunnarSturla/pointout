import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

// The second-harness seam (spec §18), read off what a consumer's browser is
// served: the built Overlay entry and every module of this package it imports,
// followed through the emit's own relative imports. Nothing Claude Code
// specific — its home directory, its hook machinery, its session registry, its
// socket namespace, the frames spoken into it — may appear in any of them, so
// that a second harness never has to touch the Overlay.
//
// What is checked is code, not prose: comments are taken out first. A comment
// citing `CLAUDE_PID` from the spec is not a dependency on it, and the emit
// keeps every comment the source wrote.
//
// What is *not* checked, deliberately, is the product word. The Overlay tells
// the developer "No Claude session is running in this folder" because that is
// the true sentence (spec §17); the seam is about mechanism, not about naming
// the agent the developer is working with.

const ENTRY = join(repoRoot, 'dist', 'overlay', 'index.js')

/** Each Claude Code mechanism, and a string that would mean it had leaked. */
const MECHANISMS: Array<[string, string]> = [
  ['the Claude home directory', '.claude'],
  ['the inherited session pid', 'CLAUDE_PID'],
  ['the project directory hooks run in', 'CLAUDE_PROJECT_DIR'],
  ['the settings file hooks are installed in', 'settings.json'],
  ['the hook event a Pick is drained on at the prompt', 'UserPromptSubmit'],
  ['the hook input', 'hook_event_name'],
  ['the hook output envelope', 'hookSpecificOutput'],
  ['the hook output field', 'additionalContext'],
  ['the registry entry field for the inbox', 'messagingSocketPath'],
  ['the registry key file token', 'peerToken'],
  ['the registry directory override', 'VITE_AGENT_INSPECT_REGISTRY_DIR'],
  ['the socket directory', 'cc-socks'],
  ['the socket directory override', 'VITE_AGENT_INSPECT_SOCKET_DIR'],
  ['the reply address scheme', 'uds:'],
  ['the idle subscription frame', 'notify_when_idle'],
  ['the Receipt frame', 'peer_message_status'],
  ['the idle notice frame', 'peer_idle_notice'],
  ['the setup skill', 'SKILL.md'],
]

/** Relative specifiers in an emitted module: static imports and re-exports. */
const RELATIVE_IMPORT = /(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/g

/** The Overlay's module graph inside this package, as files on disk. */
function servedModules(): Map<string, string> {
  const seen = new Map<string, string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    const source = readFileSync(file, 'utf8')
    seen.set(file, source)
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      const next = resolve(dirname(file), specifier!)
      if (!existsSync(next)) throw new Error(`${file} imports ${specifier}, not on disk`)
      visit(next)
    }
  }
  visit(ENTRY)
  return seen
}

function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^[^\S\n]*\/\/.*$/gm, '')
}

describe('the Overlay served to the browser', () => {
  it('reaches beyond its own folder only for the shared HTTP surface', () => {
    const outside = [...servedModules().keys()]
      .map((file) => relative(join(repoRoot, 'dist'), file))
      .filter((file) => !file.startsWith('overlay/'))
    // `api.js` names the paths and `wire.js` the shapes; neither is a harness.
    expect(outside.toSorted()).toEqual(['api.js', 'wire.js'])
  })

  it.each(MECHANISMS)('names nothing of %s', (_what, token) => {
    const leaks = [...servedModules()]
      .filter(([, source]) => withoutComments(source).includes(token))
      .map(([file]) => relative(repoRoot, file))
    expect(leaks).toEqual([])
  })
})
