import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

/** Installed or generated, never written here: `.next` is Next's build output. */
const SKIPPED = new Set(['node_modules', 'dist', '.next'])

describe('the repository is TypeScript', () => {
  // Ticket 23. Asserted rather than assumed, so a later ticket cannot quietly
  // add a JavaScript module back into a source tree.
  const sourceTrees = [
    'src',
    'test',
    'examples/react-app/src',
    'examples/shared',
    'examples/next-app',
  ]
  const javascript = /\.(js|jsx|mjs|cjs)$/

  function* everyFile(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* everyFile(full)
      else yield full
    }
  }

  it.each(sourceTrees)('%s holds no JavaScript', (tree) => {
    const offenders = [...everyFile(join(repoRoot, tree))]
      .filter((file) => javascript.test(file))
      .map((file) => relative(repoRoot, file).split(sep).join('/'))

    expect(offenders).toEqual([])
  })

  it('checks the package under strict TypeScript with verbatim module syntax', () => {
    // The tsconfig is a file on disk, which is the kind of thing these checks
    // read. Comments and all: JSON5 is not parsed, the settings are matched.
    const tsconfig = readFileSync(join(repoRoot, 'tsconfig.json'), 'utf8')

    expect(tsconfig).toMatch(/"strict":\s*true/)
    expect(tsconfig).toMatch(/"verbatimModuleSyntax":\s*true/)
    expect(tsconfig).toMatch(/"module":\s*"nodenext"/i)
  })
})

describe('the lint and format configuration', () => {
  // Ticket 24. Both files are JSONC; the comments are the point, so they are
  // read as text and stripped rather than required to parse as JSON.
  const readJsonc = (path: string) => {
    const raw = readFileSync(join(repoRoot, path), 'utf8')
    const body = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    return { raw, parsed: JSON.parse(body) }
  }

  it('formats to this codebase rather than to the formatter defaults', () => {
    const { parsed } = readJsonc('.oxfmtrc.json')

    expect(parsed.semi).toBe(false)
    expect(parsed.singleQuote).toBe(true)
  })

  it('leaves this repository prose out of the formatter', () => {
    // Markdown here is the spec, the tracker and the resolved research. A
    // formatter run over a closed ticket rewrites the record.
    const { parsed } = readJsonc('.oxfmtrc.json')

    expect(parsed.ignorePatterns).toContain('**/*.md')
    expect(parsed.ignorePatterns).toContain('.scratch/**')
  })

  it('says beside every silenced rule why it is silenced', () => {
    // Nothing is turned off merely because it was noisy. The comment is the
    // reason, and this is what makes leaving one out fail.
    const { raw, parsed } = readJsonc('.oxlintrc.json')
    const lines = raw.split('\n')
    const rules = Object.keys(parsed.rules ?? {})

    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      const at = lines.findIndex((line) => line.trim().startsWith(`"${rule}"`))
      expect(at, `${rule} is not in .oxlintrc.json`).toBeGreaterThan(0)

      let above = at - 1
      while (above >= 0 && lines[above]?.trim() === '') above -= 1

      expect(
        lines[above]?.trim().startsWith('//'),
        `${rule} has no reason above it`,
      ).toBe(true)
    }
  })
})

describe('the two gates', () => {
  // Ticket 24: formatted on save, linted before a task is complete. Both are
  // hooks, because a convention in a document is not a gate.
  const settings = () =>
    JSON.parse(readFileSync(join(repoRoot, '.claude/settings.json'), 'utf8'))

  it('formats what an agent just wrote', () => {
    const hook = settings().hooks.PostToolUse[0]

    expect(hook.matcher).toMatch(/Write/)
    expect(hook.matcher).toMatch(/Edit/)
    expect(hook.hooks[0].command).toContain('format-file.sh')
    expect(existsSync(join(repoRoot, '.claude/hooks/format-file.sh'))).toBe(true)
  })

  it('refuses to end a task with the lint gate red', () => {
    const hook = settings().hooks.Stop[0]

    expect(hook.hooks[0].command).toContain('lint-gate.sh')
    expect(existsSync(join(repoRoot, '.claude/hooks/lint-gate.sh'))).toBe(true)
  })

  it('guards the Stop hook against re-entering itself', () => {
    // A blocking Stop hook re-triggers; the harness says so in the payload.
    const gate = readFileSync(join(repoRoot, '.claude/hooks/lint-gate.sh'), 'utf8')

    expect(gate).toContain('stop_hook_active')
  })

  it('keeps the formatter off prose even when an agent writes prose', () => {
    // oxfmt handles markdown too, so the hook filters by extension rather than
    // trusting the formatter's own ignore list for an explicitly named file.
    const format = readFileSync(join(repoRoot, '.claude/hooks/format-file.sh'), 'utf8')

    expect(format).toMatch(/\*\.tsx?/)
    expect(format).not.toMatch(/\*\.md/)
  })
})
