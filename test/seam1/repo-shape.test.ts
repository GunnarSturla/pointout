import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

const SPIKES = [
  'spike-06-delivery',
  'spike-07-envelopes',
  'spike-14-inbox-socket',
  'spike-16-receipts',
  'spike-17-overlay-shape',
]

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

describe('the first commit', () => {
  const firstCommit = git('rev-list', '--max-parents=0', 'HEAD')
  const tracked = git('ls-tree', '-r', '--name-only', firstCommit).split('\n')

  it('carries the .scratch tracker', () => {
    expect(tracked.some((path) => path.startsWith('.scratch/'))).toBe(true)
  })

  it.each(SPIKES)('carries %s', (spike) => {
    expect(tracked.some((path) => path.startsWith(spike + '/'))).toBe(true)
  })
})

describe('the spikes are labelled dead ends', () => {
  it.each(SPIKES)('%s says so in the first lines of its README', (spike) => {
    const readme = readFileSync(join(repoRoot, spike, 'README.md'), 'utf8')
    const opening = readme.split('\n').slice(0, 6).join('\n')
    expect(opening).toMatch(/dead end/i)
    expect(opening).toMatch(/v0/)
  })
})

/** Installed or generated, never written here: `.next` is Next's build output. */
const SKIPPED = new Set(['node_modules', 'dist', '.next'])

describe('nothing imports a spike', () => {
  const selfPath = fileURLToPath(import.meta.url)
  const roots = [
    'src',
    'examples/react-app/src',
    'examples/shared',
    'examples/next-app',
    'test',
  ]
  // Named rather than globbed, and every one of them has to be there: a config
  // that is silently skipped because it was renamed is a check that passes
  // while checking nothing.
  const configs = [
    'vitest.config.ts',
    'vitest.seam3.config.ts',
    'playwright.config.ts',
    'examples/react-app/vite.config.ts',
    'examples/next-app/next.config.ts',
  ]

  function* sourceFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* sourceFiles(full)
      else if (/\.(js|jsx|mjs|cjs|ts|tsx|cts|mts)$/.test(entry.name)) yield full
    }
  }

  const files: string[] = []
  for (const root of roots) files.push(...sourceFiles(join(repoRoot, root)))
  for (const config of configs) files.push(join(repoRoot, config))

  it.each(configs)('%s is a config this repo still has', (config) => {
    expect(existsSync(join(repoRoot, config))).toBe(true)
  })

  // An import or require whose specifier points into one of the spike
  // directories, at any depth and by any relative prefix.
  const spikeSpecifier = /(?:from|import|require)\s*\(?\s*['"][^'"]*spike-\d\d[^'"]*['"]/

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(
    files
      .filter((file) => file !== selfPath)
      .map((file) => relative(repoRoot, file).split(sep).join('/')),
  )('%s', (relativePath) => {
    const source = readFileSync(join(repoRoot, relativePath), 'utf8')
    expect(source).not.toMatch(spikeSpecifier)
  })
})

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
    expect(parsed.ignorePatterns).toContain('spike-*/**')
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
