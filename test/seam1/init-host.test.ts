import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'

// `pointout init` choosing its Host (Next.js Connector ticket 09), observed as
// `init.test.ts` observes the Vite case: through the text the CLI prints, the
// code it exits with, and the files on disk. The Host is read off the
// `package.json` in the directory `init` runs in, and `--connector` overrides
// it. Every path and sentence is written out rather than imported.

const SETTINGS = '.claude/settings.json'
const SKILL = '.claude/skills/pointout/SKILL.md'
const NEXT_CONFIG = `import { withPointout } from 'pointout/next'\n\nexport default {}\n`

const apps = tempApps()
const homes: string[] = []

afterEach(async () => {
  await apps.cleanup()
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true })
})

interface CliRun {
  code: number | null
  stdout: string
  stderr: string
}

/** The installed bin, run with no TTY: stdin and stdout are both pipes. */
function runInit(app: TempApp, ...args: string[]): Promise<CliRun> {
  const home = mkdtempSync(join(tmpdir(), 'pointout-home-'))
  homes.push(home)
  const bin = join(app.playground, 'node_modules/pointout/dist/cli/main.js')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'init', ...args], {
      cwd: app.appDir,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end()
  })
}

/** Rewrite the app's own manifest with these dependencies. */
function dependOn(app: TempApp, dependencies: Record<string, string>): string {
  const manifest =
    JSON.stringify({ name: 'temp-app', private: true, dependencies }, null, 2) + '\n'
  writeFileSync(join(app.appDir, 'package.json'), manifest)
  return manifest
}

/** A temp app that is a Next.js app and nothing else. */
function nextApp(): { app: TempApp; manifest: string } {
  const app = apps.create({ git: true })
  rmSync(app.configFile)
  writeFileSync(join(app.appDir, 'next.config.ts'), NEXT_CONFIG)
  const manifest = dependOn(app, { next: '16.4.2', react: '^19.3.0' })
  return { app, manifest }
}

function expectOk(run: CliRun): void {
  expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: '' })
}

function flat(text: string): string {
  return text.replace(/\s+/g, ' ')
}

describe('init on a Next.js app', () => {
  it('writes the hooks and the skill, prints the two Next.js changes, and edits neither file', async () => {
    const { app, manifest } = nextApp()

    const run = await runInit(app)

    expectOk(run)
    expect(run.stdout).toMatch(/wrote\s+UserPromptSubmit hook/)
    expect(run.stdout).toMatch(/wrote\s+Stop hook/)
    expect(run.stdout).toMatch(/wrote\s+setup skill/)
    expect(existsSync(join(app.checkout, SETTINGS))).toBe(true)
    expect(existsSync(join(app.checkout, SKILL))).toBe(true)

    const said = flat(run.stdout)
    expect(said).toContain('withPointout()')
    expect(said).toContain('pointout/next')
    expect(said).toContain(join(app.appDir, 'next.config.ts'))
    expect(said).toContain('next dev -H localhost')

    expect(readFileSync(join(app.appDir, 'next.config.ts'), 'utf8')).toBe(NEXT_CONFIG)
    expect(readFileSync(join(app.appDir, 'package.json'), 'utf8')).toBe(manifest)
  })

  it("writes a skill that names Next.js's setup, not Vite's", async () => {
    const { app } = nextApp()
    expectOk(await runInit(app))

    const skill = flat(readFileSync(join(app.checkout, SKILL), 'utf8'))
    expect(skill).toContain('withPointout()')
    expect(skill).toContain('pointout/next')
    expect(skill).toContain('next dev -H localhost')
    expect(skill).not.toContain('pointout/vite')
  })
})

describe('init on an app that depends on both vite and next', () => {
  function bothApp(): TempApp {
    const app = apps.create({ git: true })
    writeFileSync(join(app.appDir, 'next.config.ts'), NEXT_CONFIG)
    dependOn(app, { next: '16.4.2', vite: '^8.0.0' })
    return app
  }

  it('refuses without a TTY, naming --connector, and writes nothing', async () => {
    const app = bothApp()

    const run = await runInit(app)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('--connector next|vite')
    expect(run.stdout).toBe('')
    expect(existsSync(join(app.checkout, '.claude'))).toBe(false)
  })

  it('with --connector vite, gives the Vite output and a skill naming Vite', async () => {
    const app = bothApp()

    const run = await runInit(app, '--connector', 'vite')

    expectOk(run)
    expect(run.stdout).toMatch(/wrote\s+setup skill/)
    expect(run.stdout).not.toContain('withPointout')
    expect(run.stdout).not.toContain('next dev')
    const skill = flat(readFileSync(join(app.checkout, SKILL), 'utf8'))
    expect(skill).toContain('pointout/vite')
    expect(skill).not.toContain('pointout/next')
  })

  it('with --connector=next, takes Next.js', async () => {
    const app = bothApp()

    const run = await runInit(app, '--connector=next')

    expectOk(run)
    expect(flat(run.stdout)).toContain('next dev -H localhost')
  })
})

describe('choosing the Host', () => {
  it('refuses an app that depends on neither, saying why, and writes nothing', async () => {
    const app = apps.create({ git: true })
    dependOn(app, { react: '^19.3.0' })

    const run = await runInit(app)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain(join(app.appDir, 'package.json'))
    expect(run.stderr).toMatch(/neither vite nor next/)
    expect(existsSync(join(app.checkout, '.claude'))).toBe(false)
  })

  it('lets --connector win over what the package.json says', async () => {
    const { app } = nextApp()

    const run = await runInit(app, '--connector', 'vite')

    expectOk(run)
    expect(run.stdout).not.toContain('withPointout')
  })

  it('refuses a --connector it does not know, and writes nothing', async () => {
    const { app } = nextApp()

    const run = await runInit(app, '--connector', 'remix')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('--connector next|vite')
    expect(existsSync(join(app.checkout, '.claude'))).toBe(false)
  })
})
