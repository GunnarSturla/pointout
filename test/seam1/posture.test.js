import { afterEach, describe, expect, it } from 'vitest'
import { tempApps } from '../harness/temp-app.mjs'
import { writeSession } from '../harness/registry.mjs'

// The one line that opens the startup posture block. Counted, so that later
// tickets appending to the block cannot turn it into two.
const BLOCK_HEADING = 'vite-agent-inspect — startup posture'

const apps = tempApps()
afterEach(apps.cleanup)

const occurrences = (text, needle) => text.split(needle).length - 1

/**
 * A server whose startup read finds a registry someone else already filled —
 * the posture block is written before the first request, so the entries have to
 * be on disk before it starts.
 */
async function servedOverAPreparedRegistry(app, fill) {
  const probe = await apps.serve(app)
  fill(probe.fixture)
  return apps.serve(app, {
    env: { VITE_AGENT_INSPECT_REGISTRY_DIR: probe.fixture.registryDir },
  })
}

describe('the startup posture block', () => {
  it('is printed exactly once, with root, guard posture and registry state', async () => {
    const { app, server } = await apps.start({ app: { git: true } })
    const log = server.log()

    expect(occurrences(log, BLOCK_HEADING)).toBe(1)
    expect(log).toContain(app.checkout)
    expect(log).toContain('git rev-parse --show-toplevel')
    expect(log).toMatch(/loopback only/i)
    expect(log).toMatch(/origin/i)
    expect(log).toMatch(/registry/i)
    expect(log).toMatch(/readable/i)
  })

  it('says how the root was found when there was no git to find it with', async () => {
    const { app, server } = await apps.start({ app: { git: false } })

    expect(server.log()).toContain(app.appDir)
    expect(server.log()).toMatch(/not inside a git repository/i)
  })

  it('names the hook floor when the registry directory is missing', async () => {
    const app = apps.create({ git: true })
    const server = await apps.serve(app, {
      env: { VITE_AGENT_INSPECT_REGISTRY_DIR: app.playground + '/no-such-registry' },
    })

    expect(server.log()).toMatch(/hook floor/i)
    expect(server.log()).toMatch(/directory missing/i)
    expect(occurrences(server.log(), BLOCK_HEADING)).toBe(1)
  })

  it('names the hook floor when the entries are in an unrecognised shape', async () => {
    const app = apps.create({ git: true })
    const server = await servedOverAPreparedRegistry(app, (fixture) => {
      writeSession(fixture, { cwd: app.checkout, omit: ['messagingSocketPath'] })
    })

    expect(server.log()).toMatch(/hook floor/i)
    expect(server.log()).toMatch(/unrecognised shape/i)
  })

  it('counts the sessions it found in this checkout', async () => {
    const app = apps.create({ git: true })
    const server = await servedOverAPreparedRegistry(app, (fixture) => {
      writeSession(fixture, { cwd: app.checkout, name: 'one' })
      writeSession(fixture, { cwd: app.checkout, name: 'two' })
    })

    expect(server.log()).toMatch(/2 sessions in this checkout/)
  })

  it('names an entry it had to ignore rather than dropping it quietly', async () => {
    const app = apps.create({ git: true })
    const server = await servedOverAPreparedRegistry(app, (fixture) => {
      writeSession(fixture, { cwd: app.checkout, name: 'usable' })
      writeSession(fixture, { cwd: app.checkout, omit: ['status'] })
    })

    expect(server.log()).toMatch(/1 session in this checkout/)
    expect(server.log()).toMatch(/1 entry in an unrecognised shape, ignored/)
  })

  it('warns that LAN Picks will be refused when Vite is bound off loopback', async () => {
    const { server } = await apps.start({ app: { git: true }, host: '0.0.0.0' })

    expect(server.log()).toMatch(/LAN/)
    expect(server.log()).toMatch(/refused/i)
  })

  it('says nothing about the LAN when Vite is bound to loopback', async () => {
    const { server } = await apps.start({ app: { git: true } })

    expect(server.log()).not.toMatch(/LAN/)
  })
})
