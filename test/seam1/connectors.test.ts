import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

// ADR-0005: one package, a Connector per Host, over a core that belongs to no
// Host. Read off the emitted `dist/`, which is what a consumer installs.

/** The directory the Vite Connector is emitted into, repo-relative. */
const VITE_CONNECTOR = 'dist/vite/'
/** The directory the Next.js Connector is emitted into, repo-relative. */
const NEXT_CONNECTOR = 'dist/next/'

describe('the core belongs to no Host', () => {
  const emitted = modulesUnder('dist').filter((path) => path.endsWith('.js'))

  it('found emitted modules to read', () => {
    expect(emitted.length).toBeGreaterThan(5)
    expect(emitted).toContain('dist/vite/index.js')
  })

  it('imports vite only from inside the Vite Connector', () => {
    const offenders = emitted.filter(
      (path) =>
        !path.startsWith(VITE_CONNECTOR) &&
        specifiers(path).some((specifier) => isPackage(specifier, 'vite')),
    )
    expect(offenders).toEqual([])
  })

  it('imports next only from inside the Next.js Connector', () => {
    const offenders = emitted.filter(
      (path) =>
        !path.startsWith(NEXT_CONNECTOR) &&
        specifiers(path).some((specifier) => isPackage(specifier, 'next')),
    )
    expect(offenders).toEqual([])
  })

  it('keeps each Connector out of the other’s Host', () => {
    const crossed = emitted.filter(
      (path) =>
        (path.startsWith(NEXT_CONNECTOR) &&
          specifiers(path).some((specifier) => isPackage(specifier, 'vite'))) ||
        (path.startsWith(VITE_CONNECTOR) &&
          specifiers(path).some((specifier) => isPackage(specifier, 'next'))),
    )
    expect(emitted).toContain('dist/next/index.js')
    expect(crossed).toEqual([])
  })

  it('reads its imports the way the check above needs', () => {
    // The check is only as good as the reader: the Vite Connector really does
    // import vite, and the reader has to see it.
    expect(specifiers('dist/vite/index.js').some((s) => isPackage(s, 'vite'))).toBe(true)
  })
})

describe('the entry points', () => {
  it('gives the Vite plugin at pointout/vite', () => {
    const answer = importFromRepo(
      "const m = await import('pointout/vite');" +
        'console.log(JSON.stringify({ named: typeof m.pointout, same: m.default === m.pointout, name: m.pointout().name }))',
    )
    expect(JSON.parse(answer)).toEqual({
      named: 'function',
      same: true,
      name: 'pointout',
    })
  })

  it('has no root entry, so bare pointout fails', () => {
    const answer = importFromRepo(
      "try { await import('pointout'); console.log('imported') }" +
        ' catch (error) { console.log(error.code) }',
    )
    expect(answer).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
  })

  it('lists vite as an optional peer', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.peerDependencies.vite).toBeDefined()
    expect(pkg.peerDependenciesMeta?.vite).toEqual({ optional: true })
  })

  it('gives withPointout at pointout/next, to an ESM config', () => {
    const answer = importFromRepo(
      "const m = await import('pointout/next');" +
        'const config = { reactStrictMode: true };' +
        'console.log(JSON.stringify({ named: typeof m.withPointout, same: m.default === m.withPointout, untouched: m.withPointout(config) === config }))',
    )
    // Outside Next's dev worker, the config comes back as it went in.
    expect(JSON.parse(answer)).toEqual({ named: 'function', same: true, untouched: true })
  })

  it('gives withPointout to a CommonJS next.config.js too', () => {
    const answer = execFileSync(
      process.execPath,
      [
        '-e',
        "const { withPointout } = require('pointout/next');" +
          'const config = { reactStrictMode: true };' +
          'console.log(JSON.stringify({ named: typeof withPointout, untouched: withPointout(config) === config }))',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim()
    expect(JSON.parse(answer)).toEqual({ named: 'function', untouched: true })
  })

  it('lists next as an optional peer, 16.3 and later in 16', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.peerDependencies.next).toBe('>=16.3 <17')
    expect(pkg.peerDependenciesMeta?.next).toEqual({ optional: true })
  })
})

/** Runs a module script with Node from the repo root, as a consumer's code would. */
function importFromRepo(script: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
}

/** Every module specifier a built file names: static, side-effect and dynamic. */
function specifiers(path: string): string[] {
  const text = readFileSync(join(repoRoot, path), 'utf8')
  const found: string[] = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1]!)
  }
  return found
}

function isPackage(specifier: string, name: string): boolean {
  return specifier === name || specifier.startsWith(name + '/')
}

/** Every file under `dir`, repo-relative and slash-separated. */
function modulesUnder(dir: string): string[] {
  const found: string[] = []
  const walk = (absolute: string) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const full = join(absolute, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push(relative(repoRoot, full).split(sep).join('/'))
    }
  }
  walk(join(repoRoot, dir))
  return found.toSorted()
}
