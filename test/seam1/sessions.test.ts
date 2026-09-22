import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { tempApps } from '../harness/temp-app.js'
import { writeSession } from '../harness/registry.js'

const SESSIONS = '/__agent/sessions'

/**
 * What `GET /__agent/sessions` answers, written out rather than imported: the
 * payload is the contract, and a test that still passes after the server
 * renames its internals is the test we want (docs/agents/testing.md).
 */
interface SessionsPayload {
  registry: { state: string; hookFloor: boolean; rejected: number; directory: string }
  candidates: Array<{
    name: string
    status: string
    waitingFor: string | null
    statusUpdatedAt: string | null
    pid: number
    sessionId: string
    startedThisServer: boolean
  }>
}

const apps = tempApps()
afterEach(apps.cleanup)

async function start(serverOptions = {}) {
  const { app, server } = await apps.start({ app: { git: true }, ...serverOptions })
  return {
    app,
    server,
    body: (): Promise<SessionsPayload> =>
      fetch(server.url + SESSIONS).then((r) => r.json()),
  }
}

describe('GET /__agent/sessions', () => {
  it('offers a session working in this checkout', async () => {
    const { app, server, body } = await start()
    writeSession(server.fixture, {
      cwd: app.checkout,
      name: 'the one that is here',
      status: 'idle',
      waitingFor: null,
      statusUpdatedAt: '2026-09-21T10:00:00.000Z',
    })

    const payload = await body()

    expect(payload.registry.state).toBe('readable')
    expect(payload.registry.hookFloor).toBe(false)
    expect(payload.candidates).toHaveLength(1)
    expect(payload.candidates[0]).toMatchObject({
      name: 'the one that is here',
      status: 'idle',
      waitingFor: null,
      statusUpdatedAt: '2026-09-21T10:00:00.000Z',
      startedThisServer: false,
    })
    expect(typeof payload.candidates[0]?.sessionId).toBe('string')
    expect(typeof payload.candidates[0]?.pid).toBe('number')
  })

  it('carries only the fields the contract names', async () => {
    const { app, server, body } = await start()
    writeSession(server.fixture, {
      cwd: app.checkout,
      updatedAt: '2026-09-01T00:00:00.000Z',
    })

    // spec §20: name, status, waitingFor, statusUpdatedAt, pid, sessionId and
    // the started-this-server flag. `updatedAt` is read, not published.
    expect(Object.keys((await body()).candidates[0] ?? {}).toSorted()).toEqual([
      'name',
      'pid',
      'sessionId',
      'startedThisServer',
      'status',
      'statusUpdatedAt',
      'waitingFor',
    ])
  })

  it('does not offer a session whose socket is not on disk', async () => {
    const { app, server, body } = await start()
    writeSession(server.fixture, { cwd: app.checkout, name: 'live', socket: true })
    writeSession(server.fixture, { cwd: app.checkout, name: 'gone', socket: false })

    expect((await body()).candidates.map((c) => c.name)).toEqual(['live'])
  })

  it('flags the session that started this dev server', async () => {
    const claudePid = 90_210
    const { app, server, body } = await start({ claudePid })
    writeSession(server.fixture, { cwd: app.checkout, pid: claudePid, name: 'mine' })
    writeSession(server.fixture, {
      cwd: app.checkout,
      pid: 90_211,
      name: 'someone elses',
    })

    const flagged = (await body()).candidates.filter((c) => c.startedThisServer)

    expect(flagged.map((c) => c.name)).toEqual(['mine'])
  })

  it('reports an unreadable registry rather than an empty one', async () => {
    const { server, body } = await start()
    rmSync(server.fixture.registryDir, { recursive: true, force: true })

    const payload = await body()

    expect(payload.registry.state).toBe('directory-missing')
    expect(payload.registry.hookFloor).toBe(true)
    expect(payload.candidates).toEqual([])
  })

  it('reports entries in an unrecognised shape rather than dropping them quietly', async () => {
    const { app, server, body } = await start()
    writeSession(server.fixture, {
      cwd: app.checkout,
      name: 'from a harness that moved',
      omit: ['messagingSocketPath'],
    })

    const payload = await body()

    expect(payload.registry.state).toBe('shape-unrecognised')
    expect(payload.registry.hookFloor).toBe(true)
    expect(payload.candidates).toEqual([])
  })

  it('counts an entry it rejected beside the ones it kept', async () => {
    const { app, server, body } = await start()
    writeSession(server.fixture, { cwd: app.checkout, name: 'usable' })
    writeSession(server.fixture, { cwd: app.checkout, omit: ['sessionId'] })

    const payload = await body()

    // One good entry means the registry has not wholesale moved, so targeting
    // stays off the hook floor — but the entry that was dropped is named.
    expect(payload.registry.state).toBe('readable')
    expect(payload.registry.hookFloor).toBe(false)
    expect(payload.registry.rejected).toBe(1)
    expect(payload.candidates.map((c) => c.name)).toEqual(['usable'])
  })

  it('reads the registry fresh on each request', async () => {
    const { app, server, body } = await start()
    expect((await body()).candidates).toEqual([])

    writeSession(server.fixture, { cwd: app.checkout, name: 'started later' })

    expect((await body()).candidates.map((c) => c.name)).toEqual(['started later'])
  })
})
