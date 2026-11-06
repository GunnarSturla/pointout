import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

const run = promisify(execFile)
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

describe('the test commands', () => {
  it('runs the server and browser suites by default, and not the Claude suite', () => {
    expect(packageJson.scripts.test).toContain('test:server')
    expect(packageJson.scripts.test).toContain('test:browser')
    expect(packageJson.scripts.test).not.toContain('claude')
  })

  it('keeps the Claude suite on a command and a config of its own', () => {
    expect(packageJson.scripts['test:claude']).toContain('vitest.claude.config.ts')
    expect(packageJson.scripts['test:server']).not.toContain('claude')
  })

  // A whole `vitest list`, beside the rest of the server suite.
  it('leaves the Claude suite out of the default run', async () => {
    const { stdout } = await run('npx', ['vitest', 'list'], { cwd: repoRoot })
    expect(stdout).toContain('test/server/')
    expect(stdout).not.toContain('test/claude/')
  }, 60_000)

  // A build and two full tsc passes, beside every other server-suite file running at
  // once: longer than the 30 s the rest of the server suite is held to.
  it('type-checks the package, the tests and the example app', async () => {
    // Ticket 23. A passing typecheck says nothing, so the silence is what is
    // asserted: tsc prints its diagnostics on stdout, and there are none.
    const { stdout } = await run('npm', ['run', '--silent', 'typecheck'], {
      cwd: repoRoot,
    })

    expect(stdout.trim()).toBe('')
  }, 180_000)

  it('builds before each suite, so no suite runs against a stale dist', () => {
    expect(packageJson.scripts['pretest:server']).toContain('build')
    expect(packageJson.scripts['pretest:browser']).toContain('build')
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

  // A build and a whole Claude-suite run, if a skipped one: held to its own timeout,
  // like the typecheck.
  it('skips the Claude suite cleanly, saying why, when the claude CLI is not on PATH', async () => {
    // Ticket 20. Run with every PATH entry that holds a `claude` taken out, so
    // this never starts a real session: the Claude suite itself does that, on its own
    // command, and the server suite only checks that it knows when it cannot. `node` and
    // `npm` are linked back in from any entry that shared a directory with it.
    const bin = mkdtempSync(join(tmpdir(), 'pointout-no-claude-'))
    const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    const holdsClaude = (entry: string) => existsSync(join(entry, 'claude'))
    for (const shared of entries.filter(holdsClaude)) {
      for (const tool of ['node', 'npm', 'npx']) {
        const source = join(shared, tool)
        if (existsSync(source) && !existsSync(join(bin, tool))) {
          symlinkSync(source, join(bin, tool))
        }
      }
    }
    const path = [bin, ...entries.filter((entry) => !holdsClaude(entry))].join(delimiter)
    const { stdout, stderr } = await run('npm', ['run', '--silent', 'test:claude'], {
      cwd: repoRoot,
      env: { ...process.env, PATH: path },
    })
    rmSync(bin, { recursive: true, force: true })
    expect(stdout + stderr).toContain('SKIPPED: the `claude` CLI is not on PATH')
  }, 120_000)
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
