import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'
import { FIXTURE_MARKER, writeFixtureHook } from './model/fixture-allowlist.js'

// The model tier's allowlist is a test fixture (spec, *Further Notes*), and
// the one way it could ever become configuration is by reaching a file a
// consumer receives. This reads every one of them — the packed files, which
// include the setup skill `init` writes out of `dist/`, and `src/`, which they
// are built from — and finds it in none. Free, and run by both seam-3 tiers.

/** Every file `npm pack` would put in the package, as repository paths. */
function packedFiles(): string[] {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }),
  ) as Array<{ files: Array<{ path: string }> }>
  return packed[0]?.files.map((file) => file.path) ?? []
}

function* filesUnder(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* filesUnder(full)
    else yield relative(repoRoot, full)
  }
}

/**
 * What the fixture writes that nothing shipped may say: its own marker, and
 * the hook's allow decision, which is the whole of what it adds to a session.
 */
const FIXTURE_WORDS = [FIXTURE_MARKER, 'permissionDecision']

describe('seam 3 — the fixture allowlist ships nowhere', () => {
  it('searches for words the fixture really writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vite-agent-inspect-seam3-hook-'))
    try {
      writeFixtureHook(dir, 'http://127.0.0.1:1', { allow: true })
      const script = readFileSync(join(dir, 'pre-tool-use.mjs'), 'utf8')
      for (const word of FIXTURE_WORDS) expect(script).toContain(word)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('no packed file, and nothing in src/, carries them', () => {
    const files = [...new Set([...packedFiles(), ...filesUnder(join(repoRoot, 'src'))])]
    // A package that has files in it, the setup skill among them.
    expect(files).toContain('dist/cli/claude/skill.js')
    const found = files.filter((path) => {
      const text = readFileSync(join(repoRoot, path), 'utf8')
      return FIXTURE_WORDS.some((word) => text.includes(word))
    })
    expect(found).toEqual([])
  })
})
