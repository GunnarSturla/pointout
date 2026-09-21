import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.mjs'

const SPIKES = [
  'spike-06-delivery',
  'spike-07-envelopes',
  'spike-14-inbox-socket',
  'spike-16-receipts',
  'spike-17-overlay-shape',
]

function git(...args) {
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

describe('nothing imports a spike', () => {
  const selfPath = fileURLToPath(import.meta.url)
  const roots = ['src', 'examples/react-app/src', 'test']
  const configs = [
    'vite.config.js',
    'vitest.config.js',
    'vitest.seam3.config.js',
    'playwright.config.js',
    'examples/react-app/vite.config.js',
  ]

  function* sourceFiles(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) yield* sourceFiles(full)
      else if (/\.(js|jsx|mjs|cjs|ts|tsx)$/.test(entry.name)) yield full
    }
  }

  const files = []
  for (const root of roots) files.push(...sourceFiles(join(repoRoot, root)))
  for (const config of configs) {
    const full = join(repoRoot, config)
    try {
      if (statSync(full).isFile()) files.push(full)
    } catch {
      // A config this scaffold does not have yet.
    }
  }

  // An import or require whose specifier points into one of the spike
  // directories, at any depth and by any relative prefix.
  const spikeSpecifier = /(?:from|import|require)\s*\(?\s*['"][^'"]*spike-\d\d[^'"]*['"]/

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(files.filter((file) => file !== selfPath).map((file) => relative(repoRoot, file).split(sep).join('/')))(
    '%s',
    (relativePath) => {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8')
      expect(source).not.toMatch(spikeSpecifier)
    },
  )
})
