import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { advanceClock, createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { updateSession } from '../harness/registry.js'
import { fakeSessions, replyTo } from '../harness/session-socket.js'
import type { FakeSession } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'

// Withdraw (`CONTEXT.md`, spec §20, §21): the developer takes back a submitted
// Pick that went wrong. It undoes what the dev server still holds — the queued
// Pick, its report-back clock, its Screen Capture, its ledger row — and says
// whether a session already has it, because a Pick written to a session cannot
// be recalled. Observed at the HTTP surface, the drain and the disk; every
// path, field, state and sentence is written out (docs/agents/testing.md).

const PICK = '/__agent/pick'
const STATUS = '/__agent/status'
const DRAIN = '/__agent/drain'
const CAPTURE = '/__agent/capture'
const withdrawPath = (pickId: string) => `${PICK}/${encodeURIComponent(pickId)}`
const reportPath = (pickId: string) => `${withdrawPath(pickId)}/report`

const SESSION_NAME = 'the one in the terminal'
const OTHER_NAME = 'a bystander'

const SECOND = 1000
/** Spec §17: sixty seconds of running time is the report-back clock's limit. */
const PAST_THE_REPORT = 61 * SECOND
const PAST_THE_TTL = 31 * 60 * SECOND

interface PickStatus {
  pickId: string
  state: string
  reportBack: { state: string } | null
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

async function startServer(): Promise<{
  app: TempApp
  server: HarnessServer
  env: FixtureEnv
}> {
  const env = createFixtureEnv({ claudePid: 0 })
  fixture = env
  const app = apps.create({ git: true })
  const server = await apps.serve(app, { env: env.env })
  return { app, server, env }
}

function pointerBody(
  note: string,
  session: FakeSession | null,
  capture?: { id: string; keep: boolean },
): Record<string, unknown> {
  return {
    url: 'http://localhost:5173/settings',
    viewport: { width: 1280, height: 800 },
    descriptor: { tag: 'button', id: 'save' },
    geometry: { width: 120, height: 40, x: 24, y: 560 },
    note,
    target: session ? { sessionId: session.sessionId, pid: session.pid } : null,
    ...(capture ? { capture } : {}),
  }
}

async function postPick(
  server: HarnessServer,
  body: Record<string, unknown>,
): Promise<{ pickId: string; state: string }> {
  const response = await fetch(server.url + PICK, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { pickId: string; state: string }
}

async function withdraw(
  server: HarnessServer,
  pickId: string,
  { origin = server.url }: { origin?: string | null } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(server.url + withdrawPath(pickId), {
    method: 'DELETE',
    headers: origin ? { origin } : {},
  })
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  }
}

async function rows(server: HarnessServer): Promise<PickStatus[]> {
  const response = await fetch(server.url + STATUS)
  expect(response.status).toBe(200)
  return ((await response.json()) as { picks: PickStatus[] }).picks
}

async function rowOf(server: HarnessServer, pickId: string): Promise<PickStatus> {
  const row = (await rows(server)).find((pick) => pick.pickId === pickId)
  if (!row) throw new Error(`no status row for ${pickId}`)
  return row
}

async function drainOnce(
  server: HarnessServer,
  app: TempApp,
): Promise<{ text: string; drained: number }> {
  const response = await fetch(server.url + DRAIN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cwd: app.checkout,
      secret: discoverySecret(server),
      event: 'UserPromptSubmit',
      budget: 9000,
    }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { text: string; drained: number }
}

/** The secret, read the way the CLI reads it: off the entry the posture block names. */
function discoverySecret(server: HarnessServer): string {
  const found = /discovery entry\s+(\S+\.json)/.exec(server.log())
  if (!found?.[1]) throw new Error(`no discovery entry line in:\n${server.log()}`)
  return (JSON.parse(readFileSync(found[1], 'utf8')) as { secret: string }).secret
}

/** The Pick's own ack or done URL, off the body the session received. */
function actionUrl(session: FakeSession, pickId: string, action: 'ack' | 'done'): string {
  const frame = session
    .frames()
    .find((line) => line.type === 'user' && line.msg_id === pickId)
  const content = (frame?.message as { content: string } | undefined)?.content ?? ''
  const found = new RegExp(`^\\s*${action}\\s+(\\S+)$`, 'm').exec(content)
  if (!found?.[1]) throw new Error(`pick ${pickId} printed no ${action} url`)
  return found[1]
}

/** A Pick written to a session this test can flip. */
async function writtenPick(): Promise<{
  app: TempApp
  server: HarnessServer
  env: FixtureEnv
  session: FakeSession
  pickId: string
}> {
  const { app, server, env } = await startServer()
  const session = await sessions.open(env, {
    cwd: app.checkout,
    name: SESSION_NAME,
    status: 'idle',
  })
  const { pickId, state } = await postPick(server, pointerBody('make this red', session))
  expect(state).toBe('sent-awaiting-ack')
  await session.awaitLines(3)
  return { app, server, env, session, pickId }
}

describe('withdrawing a Pick nobody has yet', () => {
  it('takes it out of the queue, so a following drain carries nothing', async () => {
    const { app, server } = await startServer()
    const { pickId, state } = await postPick(server, pointerBody('never mind', null))
    expect(state).toBe('queued-unaddressed')

    const answer = await withdraw(server, pickId)
    expect(answer.status).toBe(200)
    expect(answer.json).toEqual({ pickId, alreadyWritten: false, targetName: null })

    const drained = await drainOnce(server, app)
    expect(drained.drained).toBe(0)
    expect(drained.text).toBe('')
    expect((await rows(server)).map((row) => row.pickId)).not.toContain(pickId)
  })
})

/** The directory the posture block says this server writes its captures to. */
function captureDirectory(server: HarnessServer): string {
  const found = /\S*vite-agent-inspect-captures[/\\]\S+/.exec(server.log())
  if (!found) throw new Error('the posture block named no capture directory')
  return found[0]
}

/** The absolute PNG path the Pointer's one screen capture line names. */
function capturePath(session: FakeSession, pickId: string): string {
  const frame = session
    .frames()
    .find((line) => line.type === 'user' && line.msg_id === pickId)
  const content = (frame?.message as { content: string } | undefined)?.content ?? ''
  const line = content.split('\n').find((row) => row.includes('screen capture')) ?? ''
  const found = /(\/\S+\.png)/.exec(line)
  if (!found?.[1]) throw new Error(`pick ${pickId} carried no capture path`)
  return found[1]
}

async function startCapture(server: HarnessServer): Promise<string> {
  const response = await fetch(server.url + CAPTURE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({
      rect: { x: 100, y: 200, width: 300, height: 150 },
      screenX: 50,
      screenY: 60,
      chromeWidth: 0,
      chromeHeight: 80,
      screen: { width: 1920, height: 1080 },
    }),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { captureId: string }).captureId
}

describe('withdrawing a Pick a session already has', () => {
  it('says it was already written, names the Target, and forgets the rest', async () => {
    const { app, server, env } = await startServer()
    const session = await sessions.open(env, {
      cwd: app.checkout,
      name: SESSION_NAME,
      status: 'idle',
    })
    const captureId = await startCapture(server)
    const { pickId } = await postPick(
      server,
      pointerBody('make this red', session, { id: captureId, keep: true }),
    )
    await session.awaitLines(3)
    const kept = capturePath(session, pickId)
    expect(kept.startsWith(captureDirectory(server))).toBe(true)
    expect(existsSync(kept)).toBe(true)

    // Busy with no ack for a minute is spec §17's `unknown`.
    updateSession(env, session.pid, { status: 'busy' })
    await rowOf(server, pickId)
    advanceClock(PAST_THE_REPORT)
    expect((await rowOf(server, pickId)).state).toBe('unknown')

    const answer = await withdraw(server, pickId)
    expect(answer.status).toBe(200)
    expect(answer.json).toEqual({
      pickId,
      alreadyWritten: true,
      targetName: SESSION_NAME,
    })

    expect((await rows(server)).map((row) => row.pickId)).not.toContain(pickId)
    expect(existsSync(kept)).toBe(false)
    expect(server.log()).toContain(
      `pick ${pickId} was withdrawn. It had already been written to ${SESSION_NAME}, ` +
        'which may still act on it: a write cannot be recalled.',
    )
  })

  it('takes an offered Pick back, and its offer can no longer be resolved', async () => {
    const { server, pickId } = await writtenPick()
    advanceClock(PAST_THE_REPORT)
    const offered = await rowOf(server, pickId)
    expect(offered.state).toBe('sent')
    expect(offered.reportBack?.state).toBe('offered')

    const answer = await withdraw(server, pickId)
    expect(answer.status).toBe(200)
    expect(answer.json).toEqual({
      pickId,
      alreadyWritten: true,
      targetName: SESSION_NAME,
    })

    // The clock stopped with it: nothing is left to requeue.
    const report = await fetch(server.url + reportPath(pickId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ resolve: 'requeue' }),
    })
    expect(report.status).toBe(404)
  })

  it('says a session has it even once it has been requeued for the next prompt', async () => {
    // Spec §21: withdrawing never implies recall. The Pick was written to a
    // socket, offered back and left for the floor; the write still happened.
    const { app, server, pickId } = await writtenPick()
    advanceClock(PAST_THE_REPORT)
    const requeue = await fetch(server.url + reportPath(pickId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({ resolve: 'requeue' }),
    })
    expect(requeue.status).toBe(200)
    expect((await rowOf(server, pickId)).state).toBe('queued-unaddressed')

    const answer = await withdraw(server, pickId)
    expect(answer.json).toEqual({
      pickId,
      alreadyWritten: true,
      targetName: SESSION_NAME,
    })
    expect((await drainOnce(server, app)).drained).toBe(0)
  })

  it('still names the first Target when a retarget of it reached nobody', async () => {
    // Spec §21 again: a retarget is a new Pick with a new id, but the first
    // write happened, and withdrawing the new one must not read as recall.
    const { app, server, env, pickId } = await writtenPick()
    const other = await sessions.open(env, { cwd: app.checkout, name: OTHER_NAME })
    // Still a Candidate — its socket path is on disk — but nothing listens there.
    await other.close()
    writeFileSync(other.socketPath, '')
    advanceClock(PAST_THE_REPORT)
    expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')

    const retarget = await fetch(server.url + reportPath(pickId), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({
        resolve: 'retarget',
        target: { sessionId: other.sessionId, pid: other.pid },
      }),
    })
    const moved = (await retarget.json()) as { pickId: string; state: string }
    expect(moved.state).toBe('queued-unaddressed')

    const answer = await withdraw(server, moved.pickId)
    expect(answer.json).toEqual({
      pickId: moved.pickId,
      alreadyWritten: true,
      targetName: SESSION_NAME,
    })
  })

  it('says a prompt has it when the hook floor carried it, naming no session', async () => {
    const { app, server, env } = await startServer()
    // Two Candidates, so nothing is preselected and the Pick waits for the floor.
    await sessions.open(env, { cwd: app.checkout, name: SESSION_NAME })
    await sessions.open(env, { cwd: app.checkout, name: OTHER_NAME })
    const { pickId } = await postPick(server, pointerBody('for later', null))
    expect((await drainOnce(server, app)).drained).toBe(1)

    // Drained, it runs no report-back clock, so no offer is coming either.
    const early = await withdraw(server, pickId)
    expect(early.status).toBe(409)
    expect(early.json.reason).toBe(`refused to withdraw pick ${pickId}: it is sent.`)

    // Drained and never acknowledged: out of time, and withdrawable.
    advanceClock(PAST_THE_TTL)
    expect((await rowOf(server, pickId)).state).toBe('failed')

    const answer = await withdraw(server, pickId)
    expect(answer.json).toEqual({ pickId, alreadyWritten: true, targetName: null })
    expect(server.log()).toContain(
      `pick ${pickId} was withdrawn. It had already been written to a prompt in this repo`,
    )
  })

  it('says nobody has it when a Receipt said the harness would not deliver it', async () => {
    const { server, session, pickId } = await writtenPick()
    const reply = await replyTo(session.replyAddress())
    try {
      await reply.send({
        type: 'control',
        action: 'peer_message_status',
        status: 'refused',
        orig_msg_id: pickId,
        msgV: 1,
        msg_id: 'receipt-refused',
      })
      const deadline = Date.now() + 4000
      while ((await rowOf(server, pickId)).state !== 'failed') {
        if (Date.now() > deadline) throw new Error('the Receipt never failed the pick')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } finally {
      await reply.close()
    }

    const answer = await withdraw(server, pickId)
    expect(answer.status).toBe(200)
    expect(answer.json).toEqual({ pickId, alreadyWritten: false, targetName: null })
    expect(server.log()).toContain(`pick ${pickId} was withdrawn. No session had it.`)
  })
})

describe('what a withdraw refuses', () => {
  it('refuses a Pick the agent is working on, or has finished, naming its state', async () => {
    const { server, session, pickId } = await writtenPick()

    const ack = await fetch(actionUrl(session, pickId, 'ack'), { method: 'POST' })
    expect(ack.status).toBe(200)
    const working = await withdraw(server, pickId)
    expect(working.status).toBe(409)
    expect(working.json.error).toBe('not-withdrawable')
    expect(working.json.state).toBe('working')
    expect(working.json.reason).toBe(`refused to withdraw pick ${pickId}: it is working.`)

    const done = await fetch(actionUrl(session, pickId, 'done'), { method: 'POST' })
    expect(done.status).toBe(200)
    const finished = await withdraw(server, pickId)
    expect(finished.status).toBe(409)
    expect(finished.json.state).toBe('done')
    expect(server.log()).toContain(`refused to withdraw pick ${pickId}: it is done.`)

    // Refused, so nothing moved: the Pick is still there, as it was.
    expect((await rowOf(server, pickId)).state).toBe('done')
  })

  it('refuses a written Pick that has not been offered back', async () => {
    const { server, pickId } = await writtenPick()
    const answer = await withdraw(server, pickId)
    expect(answer.status).toBe(409)
    expect(answer.json.state).toBe('sent')
    expect(answer.json.reason).toBe(
      `refused to withdraw pick ${pickId}: it is sent, and it has not been offered back.`,
    )
    expect((await rowOf(server, pickId)).reportBack?.state).toBe('running')
  })

  it('refuses a caller with no Origin, and moves nothing', async () => {
    const { server } = await startServer()
    const { pickId } = await postPick(server, pointerBody('never mind', null))

    const answer = await withdraw(server, pickId, { origin: null })
    expect(answer.status).toBe(403)
    expect((await rowOf(server, pickId)).state).toBe('queued-unaddressed')
  })

  it('refuses a Pick it is not holding, including one already withdrawn', async () => {
    const { server } = await startServer()
    const { pickId } = await postPick(server, pointerBody('never mind', null))
    expect((await withdraw(server, pickId)).status).toBe(200)

    const again = await withdraw(server, pickId)
    expect(again.status).toBe(404)
    expect(again.json.error).toBe('unknown-pick')
    expect((await withdraw(server, 'no-such-pick')).status).toBe(404)
  })
})
