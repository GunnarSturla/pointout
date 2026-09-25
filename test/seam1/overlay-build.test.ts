import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

// Two habits the Overlay keeps, asserted on the built package rather than on the
// source, because the built package is what a consumer's browser runs.
//
// The first is permanent (spec §3): a consumer with
// `require-trusted-types-for 'script'` throws on `innerHTML`, and never writing
// it costs nothing. The second was permanent until ticket 09, which is the
// ticket that got to add motion — so it is now a check on the *shape* of the
// motion rather than on its absence: all of it in one stylesheet, everything
// that moves inside one `prefers-reduced-motion: no-preference` block, and
// nothing anywhere that a developer who asked for less motion has to opt out of
// (spec §9). A fade is not movement: since the review-animations gate, opacity
// may ease outside that block, for everyone, and since overlay-polish ticket 03
// so may a colour.

const overlayDir = join(repoRoot, 'dist', 'overlay')

/** The file the whole stylesheet is emitted into. */
const SHEET = 'styles.js'

/** The one media query motion is allowed to live inside. */
const OPT_IN = '@media (prefers-reduced-motion: no-preference)'

/** What a stylesheet says when it moves. */
const MOVING = ['transition', 'animation', '@keyframes']

/** What may never appear outside the opt-in block, not even as a fade. */
const NEVER_OUTSIDE = ['animation', '@keyframes']

/**
 * What a fade may ease, outside the opt-in block, for every developer: how
 * opaque something is and what colour it is. Nothing here travels or changes
 * size — `outline-width` and the `background` shorthand are not on it.
 */
const FADES = ['opacity', 'color', 'background-color', 'border-color', 'outline-color']

/** A transition value that only fades, or stops one. */
function onlyFades(value: string): boolean {
  if (value === 'none') return true
  return value
    .split(/,(?![^(]*\))/)
    .every((entry) => FADES.includes(entry.trim().split(/\s+/)[0] ?? ''))
}

/**
 * A frame callback is not motion. It is how the Overlay coalesces a burst of
 * re-measurements into one, and it animates nothing — but it is spelled with the
 * word, so it is taken out before the word is looked for.
 */
const FRAME_CALLBACK = /(?:request|cancel)AnimationFrame/g

function builtOverlay(): Array<[string, string]> {
  return readdirSync(overlayDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => [name, readFileSync(join(overlayDir, name), 'utf8')])
}

/**
 * The stylesheet module with its comments taken out. Prose about motion is not
 * motion, and the emit keeps every comment the source wrote — which is the point
 * everywhere else in this file and noise in exactly this one place.
 */
function stylesheet(): string {
  return readFileSync(join(overlayDir, SHEET), 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/^[^\S\n]*\/\/.*$/gm, '')
}

/** Where the opt-in block starts and where its brace closes. */
function optIn(sheet: string): { start: number; end: number } {
  const start = sheet.indexOf(OPT_IN)
  if (start === -1) throw new Error(`${SHEET} declares no ${OPT_IN}`)
  let depth = 0
  for (let at = sheet.indexOf('{', start); at < sheet.length; at++) {
    if (sheet[at] === '{') depth++
    else if (sheet[at] === '}' && --depth === 0) return { start, end: at }
  }
  throw new Error(`${SHEET}'s ${OPT_IN} is never closed`)
}

/** Every index a substring occurs at. */
function positions(text: string, token: string): number[] {
  const found: number[] = []
  for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
    found.push(at)
  }
  return found
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
})

describe('the built Overlay moves only where it said it would', () => {
  it('declares motion in the stylesheet and in no other module', () => {
    // Including in their comments: a module that has to explain the motion it
    // does not declare can say so without naming the property, the same way the
    // markup rule above is kept.
    for (const [name, built] of builtOverlay()) {
      if (name === SHEET) continue
      const source = built.replaceAll(FRAME_CALLBACK, '')
      for (const forbidden of [...MOVING, 'Animation']) {
        expect(`${name}: ${forbidden} ${source.includes(forbidden)}`).toBe(
          `${name}: ${forbidden} false`,
        )
      }
    }
  })

  it('opts into motion rather than opting out of it', () => {
    const sheet = stylesheet()
    expect(sheet).toContain(OPT_IN)
    // `reduce` would be the other way round — motion by default, undone for the
    // developer who asked. Spec §9 is the opposite of that.
    expect(sheet).not.toContain('prefers-reduced-motion: reduce')
  })

  it('keeps everything that moves inside that one block', () => {
    const sheet = stylesheet()
    const block = optIn(sheet)
    const outside = (at: number) => at < block.start || at > block.end

    for (const token of NEVER_OUTSIDE) {
      const found = positions(sheet, token).filter(outside)
      expect(`${token} outside the opt-in: ${found.length}`).toBe(
        `${token} outside the opt-in: 0`,
      )
    }

    // Outside it, a transition may only fade, or stop one.
    const declarations = [...sheet.matchAll(/transition\s*:\s*([^;}]+)/g)]
      .filter((match) => outside(match.index))
      .map((match) => (match[1] ?? '').trim())
    expect(declarations.length).toBeGreaterThan(0)
    for (const value of declarations) {
      expect(`${value}: ${onlyFades(value)}`).toBe(`${value}: true`)
    }
  })

  it('tells a fade from movement', () => {
    // The rule above, held against values rather than against today's sheet,
    // so that it is known to bite: a colour eases for everyone, anything that
    // travels or resizes still fails.
    expect(onlyFades('none')).toBe(true)
    expect(onlyFades('opacity 120ms cubic-bezier(0.23, 1, 0.32, 1)')).toBe(true)
    expect(
      onlyFades(
        'background-color 120ms cubic-bezier(0.23, 1, 0.32, 1), outline-color 120ms linear',
      ),
    ).toBe(true)
    expect(onlyFades('color 120ms ease-out, border-color 90ms')).toBe(true)
    expect(onlyFades('translate 120ms cubic-bezier(0.23, 1, 0.32, 1)')).toBe(false)
    expect(onlyFades('opacity 120ms, translate 120ms')).toBe(false)
    expect(onlyFades('outline-width 120ms')).toBe(false)
    expect(onlyFades('background 120ms')).toBe(false)
    expect(onlyFades('all 120ms')).toBe(false)
  })

  it('moves nothing but a fade for a developer who asked for less motion', () => {
    // Every property the block transitions that is not a fade is movement, and
    // it is declared there and nowhere else.
    const sheet = stylesheet()
    const block = optIn(sheet)
    const inside = sheet.slice(block.start, block.end)
    expect(inside).toMatch(/translate \d+ms/)
    expect(sheet.slice(0, block.start)).not.toMatch(
      /(translate|width|height|transform) \d+ms/,
    )
  })

  it('makes a module that animates in script ask first', () => {
    // Spec §9 allows the Web Animations API beside CSS transitions. A call to it
    // carries no media query of its own, so the file that makes one has to.
    for (const [name, source] of builtOverlay()) {
      if (!source.includes('.animate(')) continue
      expect(`${name}: ${source.includes('prefers-reduced-motion')}`).toBe(
        `${name}: true`,
      )
    }
  })
})
