import { afterEach, describe, expect, it } from 'vitest'
import { tempApps } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'
import { writeSession } from '../harness/registry.js'

// The endpoint the Overlay asks who it could send to. Written out rather than
// imported: no test imports a server module (docs/agents/testing.md).
const SESSIONS = '/__agent/sessions'

const apps = tempApps()
afterEach(apps.cleanup)

// Only the name is read here, and it is written out rather than imported: the
// payload is the contract (docs/agents/testing.md).
const candidates = async (server: HarnessServer): Promise<Array<{ name: string }>> =>
  (await (await fetch(server.url + SESSIONS)).json()).candidates

describe('repo root discovery', () => {
  // The root is not in the sessions payload — the posture block is where the
  // server says where it is and how it found out (spec §2).
  const rootLine = (log: string) =>
    log.split('\n').find((line) => line.trim().startsWith('root'))

  it('resolves a Vite root nested inside a git repo to the git toplevel', async () => {
    const { app, server } = await apps.start({ app: { git: true } })

    expect(rootLine(server.log())).toContain(app.checkout)
    expect(rootLine(server.log())).toContain('git rev-parse --show-toplevel')
  })

  it('falls back to the Vite root outside a git repository', async () => {
    const { app, server } = await apps.start({ app: { git: false } })

    expect(rootLine(server.log())).toContain(app.appDir)
    expect(rootLine(server.log())).toMatch(/not inside a git repository/i)
  })

  it('lets the root option override both', async () => {
    const app = apps.create({ git: true })
    // The option is set in the consumer's config, which is the only place it is
    // ever set. Point it somewhere the git toplevel demonstrably is not.
    app.writeConfig({ root: app.playground })
    const server = await apps.serve(app)

    expect(rootLine(server.log())).toContain(app.playground)
    expect(rootLine(server.log())).toMatch(/root option/i)

    // And the override is a working root, not just a printed one: a session
    // there is a Candidate, and one in the git checkout below it is not.
    writeSession(server.fixture, { cwd: app.playground, name: 'at the override' })
    writeSession(server.fixture, { cwd: app.checkout, name: 'in the checkout' })

    expect((await candidates(server)).map((c) => c.name)).toEqual(['at the override'])
  })
})

describe('worktree normalization', () => {
  it('normalizes a subdirectory, the worktree root and a linked worktree apart', async () => {
    const app = apps.create({ git: true })
    const worktree = app.addWorktree('other-worktree')
    const sibling = app.addSiblingRepo('sibling')
    const server = await apps.serve(app)

    // The checkout root itself, and a subdirectory of it, are the same checkout.
    writeSession(server.fixture, { cwd: app.checkout, name: 'at the root' })
    writeSession(server.fixture, { cwd: app.appDir, name: 'in a subdirectory' })
    // Everything else is somewhere else.
    writeSession(server.fixture, { cwd: worktree, name: 'in a linked worktree' })
    writeSession(server.fixture, { cwd: sibling, name: 'in a sibling repo' })
    writeSession(server.fixture, { cwd: app.playground, name: 'in the parent directory' })

    const names = (await candidates(server)).map((candidate) => candidate.name).toSorted()

    expect(names).toEqual(['at the root', 'in a subdirectory'])
  })

  it('normalizes each distinct path once', async () => {
    const app = apps.create({ git: true })
    const server = await apps.serve(app, { gitShim: true })

    for (let i = 0; i < 3; i++) {
      writeSession(server.fixture, { cwd: app.checkout, name: `session ${i}` })
    }

    await fetch(server.url + SESSIONS)
    await fetch(server.url + SESSIONS)

    // `-C <path> rev-parse --show-toplevel`, one line per subprocess. Match the
    // path argument exactly, so the server's own root discovery — run from the
    // Vite root, a subdirectory of the checkout — is not counted here.
    const forTheCheckout = server.fixture
      .gitCalls()
      .filter((line) => /^-C (\S+) rev-parse/.exec(line)?.[1] === app.checkout)

    // Three entries, two requests, one subprocess: the cache is doing its job.
    expect(forTheCheckout).toHaveLength(1)
  })
})
