import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { exampleAppRoot, repoRoot } from '../harness/paths.js'

describe('the CommonJS entry', () => {
  it('refuses, and names the workaround', () => {
    const require = createRequire(import.meta.url)
    let message = ''
    try {
      require('pointout')
      throw new Error('require() of the package was expected to throw')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/ESM-only/)
    expect(message).toContain('defineConfig(async () =>')
    expect(message).toContain('await import("pointout")')
  })
})

describe('the built package', () => {
  // `npm run build` is a `pre` step of this command, so `dist` is what the
  // emit just produced. Ticket 23: one file in, one file out, no bundler.
  const srcModules = modulesUnder('src').filter((path) => /\.tsx?$/.test(path))

  it('found source modules to account for', () => {
    expect(srcModules.length).toBeGreaterThan(5)
  })

  it.each(srcModules)('emits %s as ESM with types and a source map', (module) => {
    const emitted = module.replace(/^src\//, 'dist/').replace(/\.tsx?$/, '.js')

    expect(existsSync(join(repoRoot, emitted))).toBe(true)
    expect(existsSync(join(repoRoot, emitted + '.map'))).toBe(true)
    expect(existsSync(join(repoRoot, emitted.replace(/\.js$/, '.d.ts')))).toBe(true)
  })

  it('emits the CommonJS stub as CommonJS', () => {
    expect(existsSync(join(repoRoot, 'dist/cjs-entry.cjs'))).toBe(true)
  })

  it('emits no TypeScript source into dist', () => {
    // Declarations are the emit and belong here; `.ts` source does not.
    const emitted = modulesUnder('dist').filter(
      (path) => !/\.d\.(ts|cts|mts)(\.map)?$/.test(path),
    )

    expect(emitted.filter((path) => /\.(ts|tsx|cts|mts)$/.test(path))).toEqual([])
  })

  it('keeps the compiler incremental state inside dist, where clean reaches it', () => {
    // The state lives with the emit on purpose: delete one and the other goes
    // too, so `tsc` can never believe it already emitted what is not there.
    expect(existsSync(join(repoRoot, 'dist/.tsbuildinfo'))).toBe(true)
  })

  it('leaves the module graph in separate files, rather than bundling it', () => {
    const entry = readFileSync(join(repoRoot, 'dist/index.js'), 'utf8')

    for (const specifier of ['./server/http.js', './server/index.js']) {
      expect(entry).toContain(specifier)
      expect(existsSync(join(repoRoot, 'dist', specifier))).toBe(true)
    }
    // The Overlay is a separate module the plugin resolves at runtime, not
    // something inlined into the entry.
    expect(entry).not.toContain('__pointout')
  })

  it('packs dist and nothing else of ours', () => {
    const packed: Array<{ path: string }> = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
    )[0].files

    const ours = packed
      .map((file) => file.path)
      .filter(
        (path) =>
          !['package.json', 'README.md', 'LICENSE', 'LICENSE-THIRDPARTY'].includes(path),
      )

    expect(ours.length).toBeGreaterThan(0)
    expect(ours.filter((path) => !path.startsWith('dist/'))).toEqual([])
    // Inside `dist`, but excluded by a negation in `files`.
    expect(ours.filter((path) => path.endsWith('.tsbuildinfo'))).toEqual([])
  })
})

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

describe('the production build', () => {
  const outDir = join(exampleAppRoot, 'dist')
  let output = ''

  beforeAll(async () => {
    rmSync(outDir, { recursive: true, force: true })
    await build({
      root: exampleAppRoot,
      configFile: join(exampleAppRoot, 'vite.config.ts'),
      logLevel: 'warn',
    })
    output = readAll(outDir)
  })

  it('emitted something to read', () => {
    expect(output.length).toBeGreaterThan(0)
    expect(output).toContain('Nested owner chain')
  })

  it('carries no Overlay code', () => {
    expect(output).not.toContain('virtual:pointout/overlay')
    expect(output).not.toContain('__pointout')
  })

  it('carries no /__agent string', () => {
    expect(output).not.toContain('/__agent')
  })
})

function readAll(dir: string): string {
  let text = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) text += readAll(full)
    else text += readFileSync(full, 'utf8')
  }
  return text
}
