import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { advanceClock, createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { fakeSessions } from '../harness/session-socket.js'
import type { FakeSession } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'

// Every string here is written out rather than imported: the three endpoint
// paths, the nonce parameter, the five Pick states, the field names and the TTL
// sentence are the contract, and a test that still passes after the server
// renames its internals is the test we want (docs/agents/testing.md).

const PICK = '/__agent/pick'
const STATUS = '/__agent/status'

/** Spec §17: the sentence a Pick nobody drained within its TTL is reported with. */
const TTL_SENTENCE =
  'Not delivered — nobody prompted Claude in this repo within 30 minutes.'

/** Past the 30 minutes of spec §15, by enough that no rounding matters. */
const PAST_THE_TTL = 31 * 60 * 1000

/** One row of `GET /__agent/status`. Written out, like every other shape here. */
interface PickStatus {
  pickId: string
  state: string
  reason: string | null
  queued: boolean
  createdAt: number
  expiresAt: number
  history: Array<{ state: string; at: number; reason: string | null }>
  target: {
    sessionId: string
    pid: number
    name: string | null
    status: string | null
    waitingFor: string | null
    idleAt: number | null
  } | null
}

const apps = tempApps()
const sessions = fakeSessions()
let fixture: FixtureEnv | undefined

afterEach(async () => {
  advanceClock(0)
  await apps.cleanup()
  await sessions.closeAll()
  fixture?.cleanup()
  fixture = undefined
})

/** A dev server whose registry and socket directories this test owns. */
async function startPickServer(host?: string): Promise<{
  app: TempApp
  server: HarnessServer
  env: FixtureEnv
}> {
  const env = createFixtureEnv({ claudePid: 0 })
  fixture = env
  const app = apps.create({ git: true })
  const server = await apps.serve(app, { env: env.env, ...(host ? { host } : {}) })
  return { app, server, env }
}

/** The Pointer inputs the Overlay sends, in the shape ticket 04 will send them. */
function pointerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'http://localhost:5173/settings',
    viewport: { width: 1280, height: 800 },
    descriptor: { tag: 'button', id: 'save' },
    geometry: { width: 120, height: 40, x: 24, y: 560 },
    ...overrides,
  }
}

async function postPick(
  server: HarnessServer,
  body: Record<string, unknown>,
): Promise<{ status: number; pickId: string; state: string }> {
  const response = await fetch(server.url + PICK, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify(body),
  })
  const json = (await response.json()) as { pickId: string; state: string }
  return { status: response.status, ...json }
}

async function getStatus(server: HarnessServer): Promise<PickStatus[]> {
  const response = await fetch(server.url + STATUS)
  expect(response.status).toBe(200)
  const json = (await response.json()) as { picks: PickStatus[] }
  return json.picks
}

/** The one row for a Pick, or a failure naming what was there instead. */
function rowFor(picks: PickStatus[], pickId: string): PickStatus {
  const row = picks.find((pick) => pick.pickId === pickId)
  if (!row) throw new Error(`no status row for ${pickId}; saw ${picks.length} picks`)
  return row
}

/** The rendered content of the one `user` frame this session received. */
function renderedBody(session: FakeSession): string {
  const user = session.frames().find((frame) => frame.type === 'user')
  return ((user?.message as { content?: string } | undefined)?.content ?? '').trim()
}

/**
 * The URL the agent is told to POST, read off the preamble it was handed —
 * which is the only place the agent's shell ever learns the nonce.
 */
function actionUrl(session: FakeSession, action: 'ack' | 'done'): string {
  const found = new RegExp(`^\\s*${action}\\s+(\\S+)$`, 'm').exec(renderedBody(session))
  if (!found?.[1]) throw new Error(`the preamble printed no ${action} url`)
  return found[1]
}

async function post(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, { method: 'POST', headers })
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  }
}

/** One delivered Pick, and everything a test needs to talk about it. */
async function deliveredPick(host?: string): Promise<{
  server: HarnessServer
  session: FakeSession
  pickId: string
}> {
  const { app, server, env } = await startPickServer(host)
  const session = await sessions.open(env, {
    cwd: app.checkout,
    name: 'the one in the terminal',
    status: 'idle',
  })
  const { pickId } = await postPick(
    server,
    pointerBody({
      note: 'make this red',
      target: { sessionId: session.sessionId, pid: session.pid },
    }),
  )
  await session.awaitLines(3)
  return { server, session, pickId }
}

describe('GET /__agent/status, and the ack and done a Pick carries', () => {
  it('shows a written Pick as sent, then working on ack, then done on done', async () => {
    const { server, session, pickId } = await deliveredPick()

    expect(rowFor(await getStatus(server), pickId).state).toBe('sent')

    const acked = await post(actionUrl(session, 'ack'))
    expect(acked.status).toBe(200)
    expect(rowFor(await getStatus(server), pickId).state).toBe('working')

    const finished = await post(actionUrl(session, 'done'))
    expect(finished.status).toBe(200)
    expect(rowFor(await getStatus(server), pickId).state).toBe('done')
  })

  it('prints ack and done at the address the server is bound to', async () => {
    // Vite's default host is `localhost`, and on a machine whose resolver puts
    // `::1` first the server listens there and nowhere else. The preamble's URLs
    // are followed exactly as printed, the way an agent's shell follows them.
    const { server, session, pickId } = await deliveredPick('::1')

    expect(actionUrl(session, 'ack').startsWith('http://[::1]:')).toBe(true)
    expect((await post(actionUrl(session, 'ack'))).status).toBe(200)
    expect((await post(actionUrl(session, 'done'))).status).toBe(200)
    expect(rowFor(await getStatus(server), pickId).state).toBe('done')
  })

  it('keeps a done Pick readable, so the Overlay decides when to stop', async () => {
    const { server, session, pickId } = await deliveredPick()
    await post(actionUrl(session, 'ack'))
    await post(actionUrl(session, 'done'))

    // Read twice: status is polled, and a row that vanished on the second poll
    // would take the chip with it.
    expect(rowFor(await getStatus(server), pickId).state).toBe('done')
    const again = rowFor(await getStatus(server), pickId)
    expect(again.state).toBe('done')
    expect(again.queued).toBe(false)
  })

  it('takes an acked entry out of the queue', async () => {
    const { server, session, pickId } = await deliveredPick()

    // Written to the socket and awaiting an ack: still in the queue, which is
    // what keeps the hook floor from handing the same Pick over a second time.
    expect(rowFor(await getStatus(server), pickId).queued).toBe(true)

    await post(actionUrl(session, 'ack'))
    expect(rowFor(await getStatus(server), pickId).queued).toBe(false)
  })

  it('refuses a wrong nonce and leaves the state where it was', async () => {
    const { server, session, pickId } = await deliveredPick()

    const wrong = actionUrl(session, 'ack').replace(/n=.*$/, 'n=deadbeef1234')
    const refused = await post(wrong)
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.status).toBeLessThan(500)
    expect(String(refused.json.reason)).toMatch(/nonce/i)
    expect(rowFor(await getStatus(server), pickId).state).toBe('sent')
  })

  it('refuses an ack with no nonce at all, saying so', async () => {
    const { server, session, pickId } = await deliveredPick()

    const refused = await post(actionUrl(session, 'ack').replace(/\?n=.*$/, ''))
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.status).toBeLessThan(500)
    expect(String(refused.json.reason)).toMatch(/nonce/i)
    expect(rowFor(await getStatus(server), pickId).state).toBe('sent')
  })

  it('refuses an unknown Pick id and changes nothing', async () => {
    const { server, session, pickId } = await deliveredPick()

    const url = actionUrl(session, 'ack')
    const elsewhere = url.replace(`/${pickId}/`, '/00000000-no-such-pick/')
    const refused = await post(elsewhere)
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.status).toBeLessThan(500)

    const picks = await getStatus(server)
    expect(picks).toHaveLength(1)
    expect(rowFor(picks, pickId).state).toBe('sent')
  })
})

describe('the Origin policy on ack and done', () => {
  it('accepts an ack with no Origin, because the agent shell sends none', async () => {
    const { server, session, pickId } = await deliveredPick()

    const acked = await post(actionUrl(session, 'ack'))
    expect(acked.status).toBe(200)
    expect(rowFor(await getStatus(server), pickId).state).toBe('working')
  })

  it('refuses an ack or a done whose Origin is present and foreign', async () => {
    const { server, session, pickId } = await deliveredPick()

    for (const action of ['ack', 'done'] as const) {
      const refused = await post(actionUrl(session, action), {
        origin: 'http://elsewhere.example',
      })
      expect(refused.status).toBe(403)
      expect(String(refused.json.reason)).toContain('elsewhere.example')
      expect(rowFor(await getStatus(server), pickId).state).toBe('sent')
    }
  })

  it('accepts an ack whose Origin is this dev server', async () => {
    const { server, session, pickId } = await deliveredPick()

    const acked = await post(actionUrl(session, 'ack'), { origin: server.url })
    expect(acked.status).toBe(200)
    expect(rowFor(await getStatus(server), pickId).state).toBe('working')
  })
})

describe('the 30-minute TTL', () => {
  it('reports an unaddressed Pick past its TTL as failed, with the sentence', async () => {
    const { server } = await startPickServer()

    // No Candidate in this checkout, so the Pick is queued for the hook floor.
    const { pickId, state } = await postPick(server, pointerBody({ note: 'later' }))
    expect(state).toBe('queued-unaddressed')
    expect(rowFor(await getStatus(server), pickId).state).toBe('queued-unaddressed')

    advanceClock(PAST_THE_TTL)

    const expired = rowFor(await getStatus(server), pickId)
    expect(expired.state).toBe('failed')
    expect(expired.reason).toBe(TTL_SENTENCE)
    expect(expired.queued).toBe(false)
    expect(server.log()).toContain(TTL_SENTENCE)
  })

  it('passes for a server that reads its clock from a skew file', async () => {
    // A Next.js dev server runs in a process of its own, which `process.env`
    // here never reaches, so the harness moves its clock through a file the
    // server re-reads on every call. Written out: `POINTOUT_CLOCK_SKEW_FILE`.
    const env = createFixtureEnv({ claudePid: 0 })
    fixture = env
    const skewFile = join(env.dir, 'clock-skew')
    writeFileSync(skewFile, '0')
    const app = apps.create({ git: true })
    const server = await apps.serve(app, {
      env: { ...env.env, POINTOUT_CLOCK_SKEW_FILE: skewFile },
    })

    const { pickId } = await postPick(server, pointerBody({ note: 'later' }))
    expect(rowFor(await getStatus(server), pickId).state).toBe('queued-unaddressed')

    writeFileSync(skewFile, String(PAST_THE_TTL))

    const expired = rowFor(await getStatus(server), pickId)
    expect(expired.state).toBe('failed')
    expect(expired.reason).toBe(TTL_SENTENCE)
  })

  it('never writes an expired Pick to a session that appears afterwards', async () => {
    const { app, server, env } = await startPickServer()

    const { pickId } = await postPick(server, pointerBody({ note: 'later' }))
    advanceClock(PAST_THE_TTL)
    expect(rowFor(await getStatus(server), pickId).state).toBe('failed')

    const latecomer = await sessions.open(env, { cwd: app.checkout })
    // Ask the server twice more, so anything that drains on a request has run.
    await getStatus(server)
    await getStatus(server)
    expect(latecomer.lines()).toEqual([])
    expect(rowFor(await getStatus(server), pickId).state).toBe('failed')
  })

  it('states the deadline it will be judged against from the moment it is queued', async () => {
    const { server } = await startPickServer()
    const { pickId } = await postPick(server, pointerBody())

    const row = rowFor(await getStatus(server), pickId)
    expect(row.expiresAt - row.createdAt).toBe(30 * 60 * 1000)
  })
})

describe('what a status row carries', () => {
  it('names the Target row fields for each Pick', async () => {
    const { app, server, env } = await startPickServer()
    const session = await sessions.open(env, {
      cwd: app.checkout,
      name: 'the one in the terminal',
      status: 'waiting',
      waitingFor: 'permission',
    })

    const { pickId } = await postPick(
      server,
      pointerBody({ target: { sessionId: session.sessionId, pid: session.pid } }),
    )
    await session.awaitLines(3)

    const row = rowFor(await getStatus(server), pickId)
    expect(row.target).toEqual({
      sessionId: session.sessionId,
      pid: session.pid,
      name: 'the one in the terminal',
      status: 'waiting',
      waitingFor: 'permission',
      // No idle notice has come back for this Target, and a row never invents
      // one: null says the Target has not been heard from, not that it is busy.
      idleAt: null,
    })
  })

  it('lets the Target row go quiet without moving the Pick', async () => {
    const { app, server, env } = await startPickServer()
    const session = await sessions.open(env, { cwd: app.checkout })
    const { pickId } = await postPick(
      server,
      pointerBody({ target: { sessionId: session.sessionId, pid: session.pid } }),
    )
    await session.awaitLines(3)

    // The session leaves the registry: session-level evidence, which colours
    // the Target row and never moves a Pick's state.
    rmSync(join(env.registryDir, `${session.pid}.json`))

    const row = rowFor(await getStatus(server), pickId)
    expect(row.state).toBe('sent')
    expect(row.target).toEqual({
      sessionId: session.sessionId,
      pid: session.pid,
      name: null,
      status: null,
      waitingFor: null,
      idleAt: null,
    })
  })

  it('says a Pick was addressed to nobody rather than inventing a Target', async () => {
    const { server } = await startPickServer()
    const { pickId } = await postPick(server, pointerBody())
    expect(rowFor(await getStatus(server), pickId).target).toBeNull()
  })

  it('timestamps every transition, oldest first', async () => {
    const { server, session, pickId } = await deliveredPick()
    await post(actionUrl(session, 'ack'))
    await post(actionUrl(session, 'done'))

    const row = rowFor(await getStatus(server), pickId)
    expect(row.history.map((step) => step.state)).toEqual(['sent', 'working', 'done'])
    for (const step of row.history) expect(typeof step.at).toBe('number')
    expect(row.history[0]?.at).toBeLessThanOrEqual(row.history[2]?.at ?? 0)
  })

  it('lists only the Picks this dev server accepted', async () => {
    const { app, server, env } = await startPickServer()
    const { pickId } = await postPick(server, pointerBody({ note: 'mine' }))
    const other = await apps.serve(app, { env: env.env })

    expect((await getStatus(server)).map((pick) => pick.pickId)).toEqual([pickId])
    expect(await getStatus(other)).toEqual([])
  })
})
