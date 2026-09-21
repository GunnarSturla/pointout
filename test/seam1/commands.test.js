import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.mjs'

const run = promisify(execFile)
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

describe('the test commands', () => {
  it('runs seams 1 and 2 by default, and not seam 3', () => {
    expect(packageJson.scripts.test).toContain('test:seam1')
    expect(packageJson.scripts.test).toContain('test:seam2')
    expect(packageJson.scripts.test).not.toContain('seam3')
  })

  it('keeps seam 3 on a command and a config of its own', () => {
    expect(packageJson.scripts['test:seam3']).toContain('vitest.seam3.config.js')
    expect(packageJson.scripts['test:seam1']).not.toContain('seam3')
  })

  it('leaves seam 3 out of the default run', async () => {
    const { stdout } = await run('npx', ['vitest', 'list'], { cwd: repoRoot })
    expect(stdout).toContain('test/seam1/')
    expect(stdout).not.toContain('test/seam3/')
  })

  it('reports seam 3 as not implemented', async () => {
    const { stdout, stderr } = await run(
      'npm',
      ['run', '--silent', 'test:seam3'],
      { cwd: repoRoot },
    )
    expect(stdout + stderr).toMatch(/not implemented/i)
  })
})
