import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

// Two habits the Overlay keeps, asserted on the built package rather than on the
// source, because the built package is what a consumer's browser runs.
//
// They are cheap and they are permanent (spec §3, §9), so they are checked here
// rather than left as prose: a consumer with `require-trusted-types-for 'script'`
// throws on `innerHTML`, and ticket 09 is the ticket that gets to add motion —
// under `prefers-reduced-motion: no-preference` and not before.

const overlayDir = join(repoRoot, 'dist', 'overlay')

function builtOverlay(): Array<[string, string]> {
  return readdirSync(overlayDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => [name, readFileSync(join(overlayDir, name), 'utf8')])
}

describe('the built Overlay', () => {
  it('is emitted as one file per module beside the plugin', () => {
    const names = builtOverlay().map(([name]) => name)
    expect(names).toContain('index.js')
    expect(names.length).toBeGreaterThan(1)
  })

  // The emit keeps its comments, so this reads the Overlay's own prose too. That
  // is on purpose: a file that has to explain why it does not do this can say so
  // without naming the API, and the rule stays one plain substring search.
  it('builds no DOM from markup', () => {
    for (const [name, source] of builtOverlay()) {
      for (const forbidden of [
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
        'createContextualFragment',
      ]) {
        expect(`${name}: ${source.includes(forbidden)}`).toBe(`${name}: false`)
      }
    }
  })

  it('declares no motion at all', () => {
    for (const [name, source] of builtOverlay()) {
      for (const forbidden of ['transition', 'animation', '@keyframes', 'Animation']) {
        expect(`${name}: ${source.includes(forbidden)}`).toBe(`${name}: false`)
      }
    }
  })
})
