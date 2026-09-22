import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

const run = promisify(execFile)
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

describe('the test commands', () => {
  it('runs seams 1 and 2 by default, and not seam 3', () => {
    expect(packageJson.scripts.test).toContain('test:seam1')
    expect(packageJson.scripts.test).toContain('test:seam2')
    expect(packageJson.scripts.test).not.toContain('seam3')
  })

  it('keeps seam 3 on a command and a config of its own', () => {
    expect(packageJson.scripts['test:seam3']).toContain('vitest.seam3.config.ts')
    expect(packageJson.scripts['test:seam1']).not.toContain('seam3')
  })

  it('leaves seam 3 out of the default run', async () => {
    const { stdout } = await run('npx', ['vitest', 'list'], { cwd: repoRoot })
    expect(stdout).toContain('test/seam1/')
    expect(stdout).not.toContain('test/seam3/')
  })

  it('type-checks the package, the tests and the example app', async () => {
    // Ticket 23. A passing typecheck says nothing, so the silence is what is
    // asserted: tsc prints its diagnostics on stdout, and there are none.
    const { stdout } = await run('npm', ['run', '--silent', 'typecheck'], {
      cwd: repoRoot,
    })

    expect(stdout.trim()).toBe('')
  })

  it('builds before each seam, so no seam runs against a stale dist', () => {
    expect(packageJson.scripts['pretest:seam1']).toContain('build')
    expect(packageJson.scripts['pretest:seam2']).toContain('build')
    expect(packageJson.scripts.build).toContain('tsconfig.build.json')
  })

  it('lints and formats through commands, so a hook and a person run the same thing', () => {
    // Ticket 24.
    expect(packageJson.scripts.lint).toContain('oxlint')
    expect(packageJson.scripts.lint).toContain('--deny-warnings')
    expect(packageJson.scripts.format).toContain('oxfmt')
    expect(packageJson.scripts['format:check']).toContain('--check')
    // The formatter runs first: oxlint's fixes are not formatted, and the two
    // would otherwise take turns rewriting the same line.
    expect(packageJson.scripts['lint:fix'].indexOf('format')).toBeLessThan(
      packageJson.scripts['lint:fix'].indexOf('oxlint'),
    )
  })

  it('builds before the typecheck, which the example app resolves through dist', () => {
    expect(packageJson.scripts.pretypecheck).toContain('build')
  })

  it('reports seam 3 as not implemented', async () => {
    const { stdout, stderr } = await run('npm', ['run', '--silent', 'test:seam3'], {
      cwd: repoRoot,
    })
    expect(stdout + stderr).toMatch(/not implemented/i)
  })
})

describe('the Node floor', () => {
  it('is one range at 22, with no 20 branch', () => {
    // Ticket 24: Node 20 is out of maintenance. 22.12 is the lowest 22 both
    // Vite and Vitest accept.
    expect(packageJson.engines.node).toBe('>=22.12.0')
  })

  it('is the floor the types are pinned to as well', () => {
    // Types ahead of the runtime floor are a floor enforced nowhere: the check
    // goes green on an API the oldest supported runtime does not have.
    const floor = /(\d+)/.exec(packageJson.engines.node)?.[1]
    const types = /(\d+)/.exec(packageJson.devDependencies['@types/node'])?.[1]

    expect(floor).toBe('22')
    expect(types).toBe(floor)
  })
})
