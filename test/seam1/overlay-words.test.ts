import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

// Two promises about what the Overlay says, read off the built package because
// that is what a consumer's browser runs (spec §17, §21). Seam 2 watches the
// words reach the page; this is the half a browser cannot see — how many times
// the build spells them.

const overlayDir = join(repoRoot, 'dist', 'overlay')

/** §17's one imperative, which three surfaces share. */
const APPROVE = 'approve it in your terminal'

/**
 * The built Overlay with its comments taken out. The emit keeps every comment the
 * source wrote, and prose about a phrase is not a second spelling of it.
 */
function builtCode(): Array<[string, string]> {
  return readdirSync(overlayDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => [
      name,
      readFileSync(join(overlayDir, name), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/^[^\S\n]*\/\/.*$/gm, ''),
    ])
}

describe('the built Overlay', () => {
  it('spells the approve-in-terminal imperative once, for every surface that says it', () => {
    const spelled = builtCode().flatMap(([name, code]) => {
      const times = code.split(APPROVE).length - 1
      return times > 0 ? [`${name} × ${times}`] : []
    })
    expect(spelled).toEqual(['words.js × 1'])
  })

  it('never says delivered except to say a Pick was not', () => {
    // Accept is silent (spec §16), so no word the Overlay could show may claim
    // arrival: every string that says *delivered* says *Not delivered*. Names in
    // code are not words on a page, so only the string literals are read.
    const said = builtCode().flatMap(([name, code]) =>
      [...code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)]
        .map((found) => found[2] ?? '')
        .filter((text) => /delivered/i.test(text))
        .map((text) => `${name}: ${text}`),
    )
    // Not vacuous: the floor sentence for a refusal with no words is in there.
    expect(said).toContain('words.js: Not delivered.')
    // One sentence says delivered and claims no more than was seen: a Pick the
    // hook floor drained, withdrawn afterwards. The drain answered, so a
    // prompt was handed it; that is evidence rather than an accept's silence,
    // and the sentence names no session because the drain cannot. Its words
    // are the developer's (overlay-polish ticket 10, settled 2026-09-25).
    const drained = 'words.js: Already delivered to a session — it may still act on it'
    expect(said).toContain(drained)
    expect(
      said.filter((text) => text !== drained && !/not delivered/i.test(text)),
    ).toEqual([])
  })
})
