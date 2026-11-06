import { readFileSync, renameSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { advanceClock, createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { updateSession } from '../harness/registry.js'
import { fakeSessions, replyTo } from '../harness/session-socket.js'
import type { FakeSession, ReplyConnection } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'

// The report-back clock (spec §17) and the endpoint that resolves its offer
// (spec §20), observed at the HTTP surface. The clock runs on the server's own
// time, which the server suite moves with `advanceClock`; the Target's status is what the
// fake registry says, rewritten in place; idle notices arrive at the real reply
// address. Every path, state, field and sentence is written out: they are the
// contract the Overlay reads (docs/agents/testing.md).

const PICK = '/__agent/pick'
const STATUS = '/__agent/status'
const DRAIN = '/__agent/drain'
const report = (pickId: string) => `${PICK}/${encodeURIComponent(pickId)}/report`

const SESSION_NAME = 'the one in the terminal'
const OTHER_NAME = 'the other terminal'

const SECOND = 1000
const MINUTE = 60 * SECOND
/** Spec §17: a Target still idle at 60 s never picked it up. */
const PAST_THE_REPORT = 61 * SECOND
const PAST_THE_TTL = 31 * MINUTE

/** Spec §17's TTL sentences, one per way a Pick can still be outstanding. */
const UNADDRESSED_TTL =
  'Not delivered — nobody prompted Claude in this repo within 30 minutes.'
const WRITTEN_TTL = `${SESSION_NAME} never acknowledged it within 30 minutes.`
const HELD_TTL = `Not delivered — nobody approved it in ${SESSION_NAME} within 30 minutes.`
const DRAINED_TTL =
  'It went out with your next prompt, and nothing acknowledged it within 30 minutes.'

/** One row of `GET /__agent/status`, as far as this file reads it. */
interface PickStatus {
  pickId: string
  state: string
  reason: string | null
  queued: boolean
  createdAt: number
  expiresAt: number
  reportBack: { state: string; at: number } | null
  target: { sessionId: string; pid: number; name: string | null } | null
}

/** Every Host this suite is the same on (Next.js Connector ticket 05). */
const HOSTS = ['vite', 'next'] as const

describe.each(HOSTS)('on %s', (on) => {
  const apps = tempApps(on)
  const sessions = fakeSessions()
  let fixture: FixtureEnv | undefined
  const connections: ReplyConnection[] = []

  afterEach(async () => {
    advanceClock(0)
    while (connections.length) await connections.pop()!.close()
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
  ): Record<string, unknown> {
    return {
      url: 'http://localhost:5173/settings',
      viewport: { width: 1280, height: 800 },
      descriptor: { tag: 'button', id: 'save' },
      geometry: { width: 120, height: 40, x: 24, y: 560 },
      note,
      target: session ? { sessionId: session.sessionId, pid: session.pid } : null,
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

  async function rowOf(server: HarnessServer, pickId: string): Promise<PickStatus> {
    const response = await fetch(server.url + STATUS)
    expect(response.status).toBe(200)
    const { picks } = (await response.json()) as { picks: PickStatus[] }
    const row = picks.find((pick) => pick.pickId === pickId)
    if (!row) throw new Error(`no status row for ${pickId}; saw ${picks.length} picks`)
    return row
  }

  async function allRows(server: HarnessServer): Promise<PickStatus[]> {
    const response = await fetch(server.url + STATUS)
    return ((await response.json()) as { picks: PickStatus[] }).picks
  }

  /** Poll, because an idle notice is a fresh connection that lands after the POST. */
  async function rowSettles(
    server: HarnessServer,
    pickId: string,
    want: (row: PickStatus) => boolean,
    what: string,
  ): Promise<PickStatus> {
    const deadline = Date.now() + 4000
    let row = await rowOf(server, pickId)
    while (!want(row)) {
      if (Date.now() > deadline) {
        throw new Error(`pick ${pickId} never ${what}: ${JSON.stringify(row)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      row = await rowOf(server, pickId)
    }
    return row
  }

  async function postReport(
    server: HarnessServer,
    pickId: string,
    body: unknown,
    { origin = server.url }: { origin?: string | null } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(server.url + report(pickId), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    })
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    }
  }

  /** A written Pick, to a session this test can flip, with its idle subscription. */
  async function writtenPick(
    status = 'idle',
    note = 'make this red',
  ): Promise<{
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
      status,
    })
    const { pickId, state } = await postPick(server, pointerBody(note, session))
    expect(state).toBe('sent-awaiting-ack')
    await session.awaitLines(3)
    return { app, server, env, session, pickId }
  }

  function subscriptionFor(session: FakeSession, pickId: string): string {
    const frames = session.frames()
    const at = frames.findIndex(
      (frame) => frame.type === 'user' && frame.msg_id === pickId,
    )
    const subscription = frames
      .slice(at)
      .find((frame) => frame.type === 'control' && frame.action === 'notify_when_idle')
    if (!subscription) throw new Error(`no idle subscription followed pick ${pickId}`)
    return String(subscription.msg_id)
  }

  function idleFrame(subscription: string, finishedAt: number): unknown {
    return {
      type: 'control',
      action: 'peer_idle_notice',
      orig_msg_id: subscription,
      state: 'idle',
      finished_at: finishedAt,
      from_mode: 'prompting',
      msgV: 1,
      msg_id: `idle-${Math.random().toString(16).slice(2)}`,
    }
  }

  async function replyFrom(session: FakeSession): Promise<ReplyConnection> {
    const reply = await replyTo(session.replyAddress())
    connections.push(reply)
    return reply
  }

  /** The Pick's own ack URL, off the body the session received. */
  function ackUrl(session: FakeSession, pickId: string): string {
    const frame = session
      .frames()
      .find((line) => line.type === 'user' && line.msg_id === pickId)
    const content = (frame?.message as { content: string } | undefined)?.content ?? ''
    const found = /^\s*ack\s+(\S+)$/m.exec(content)
    if (!found?.[1]) throw new Error(`pick ${pickId} printed no ack url`)
    return found[1]
  }

  describe('the report-back clock', () => {
    it('offers the Pick back when the Target is still idle at 60 s', async () => {
      const { server, pickId } = await writtenPick('idle')
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('running')

      advanceClock(59 * SECOND)
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('running')

      advanceClock(PAST_THE_REPORT)
      const row = await rowOf(server, pickId)
      expect(row.reportBack?.state).toBe('offered')
      // The offer is the server's own clock speaking; the Pick is still only sent.
      expect(row.state).toBe('sent')
      expect(server.log()).toContain(`${SESSION_NAME} never picked up pick ${pickId}`)
    })

    it('makes no offer when the Target went busy after the write', async () => {
      const { server, env, session, pickId } = await writtenPick('idle')
      updateSession(env, session.pid, { status: 'busy' })
      await rowOf(server, pickId)

      advanceClock(PAST_THE_REPORT)
      const row = await rowOf(server, pickId)
      expect(row.reportBack?.state).not.toBe('offered')
      // Busy, no ack and nothing else at 60 s is spec §17's `unknown`.
      expect(row.state).toBe('unknown')
      expect(row.queued).toBe(true)
    })

    it('offers it at once when the Target went busy and back to idle with no ack', async () => {
      const { server, env, session, pickId } = await writtenPick('idle')
      updateSession(env, session.pid, { status: 'busy' })
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('running')

      updateSession(env, session.pid, { status: 'idle' })
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')
    })

    it('offers it at once when an idle notice says the turn ended with no ack', async () => {
      const { server, session, pickId } = await writtenPick('idle')
      const reply = await replyFrom(session)

      await reply.send(idleFrame(subscriptionFor(session, pickId), Date.now() + 1000))
      const row = await rowSettles(
        server,
        pickId,
        (seen) => seen.reportBack?.state === 'offered',
        'was offered back',
      )
      expect(row.state).toBe('sent')
    })

    it('pauses while the Target waits on a permission prompt, and resumes after', async () => {
      const { server, env, session, pickId } = await writtenPick('idle')
      updateSession(env, session.pid, {
        status: 'waiting',
        waitingFor: 'Bash(rm -rf build)',
      })
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('paused')

      advanceClock(PAST_THE_REPORT)
      const paused = await rowOf(server, pickId)
      expect(paused.reportBack?.state).toBe('paused')
      expect(paused.state).toBe('sent')

      updateSession(env, session.pid, { status: 'busy', waitingFor: null })
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('running')

      // Sixty seconds of running time, not of wall time: the pause did not count.
      advanceClock(PAST_THE_REPORT + 30 * SECOND)
      expect((await rowOf(server, pickId)).state).toBe('sent')
      advanceClock(PAST_THE_REPORT + PAST_THE_REPORT)
      expect((await rowOf(server, pickId)).state).toBe('unknown')
    })

    it('makes no offer on a registry it can no longer read, and leaves it to the TTL', async () => {
      const { server, env, pickId } = await writtenPick('idle')
      renameSync(env.registryDir, env.registryDir + '-gone')

      advanceClock(PAST_THE_REPORT)
      const blind = await rowOf(server, pickId)
      expect(blind.reportBack?.state).not.toBe('offered')
      expect(blind.state).toBe('unknown')

      advanceClock(PAST_THE_TTL)
      const expired = await rowOf(server, pickId)
      expect(expired.state).toBe('failed')
      expect(expired.reason).toBe(WRITTEN_TTL)
      expect(expired.queued).toBe(false)
      expect(server.log()).toContain(WRITTEN_TTL)
    })

    it('does not count the end of a turn that was already running at the write', async () => {
      const { server, env, session, pickId } = await writtenPick('busy')
      const reply = await replyFrom(session)

      // The turn in progress when the Pick arrived ends. The Pick is taken in the
      // next one in the ordinary course, so this says nothing against it.
      await reply.send(idleFrame(subscriptionFor(session, pickId), Date.now() + 1000))
      await rowSettles(
        server,
        pickId,
        (row) => row.target !== null && server.log().includes('finished a turn'),
        'heard the idle notice',
      )
      updateSession(env, session.pid, { status: 'idle' })
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('running')

      // A turn that starts after the write and ends with no ack is the one.
      updateSession(env, session.pid, { status: 'busy' })
      await rowOf(server, pickId)
      updateSession(env, session.pid, { status: 'idle' })
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')
    })

    it('withdraws an offer the harness then held, and starts again on release', async () => {
      const { server, session, pickId } = await writtenPick('idle')
      advanceClock(PAST_THE_REPORT)
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')

      const reply = await replyFrom(session)
      await reply.send(receiptFrame(pickId, 'held'))
      const held = await rowSettles(
        server,
        pickId,
        (row) => row.state === 'held',
        'was held',
      )
      expect(held.reportBack?.state).toBe('paused')

      await reply.send(receiptFrame(pickId, 'delivered'))
      const released = await rowSettles(
        server,
        pickId,
        (row) => row.state === 'sent',
        'was released',
      )
      // Released only now: a fresh minute, not the offer from before the hold.
      expect(released.reportBack?.state).toBe('running')
    })

    it('stops for a Pick the agent acknowledged', async () => {
      const { server, session, pickId } = await writtenPick('idle')
      expect((await fetch(ackUrl(session, pickId), { method: 'POST' })).status).toBe(200)

      advanceClock(PAST_THE_REPORT)
      const row = await rowOf(server, pickId)
      expect(row.state).toBe('working')
      expect(row.reportBack).toBeNull()
    })

    it('offers every Pick outstanding to a Target that went idle', async () => {
      const { app, server, env } = await startServer()
      const session = await sessions.open(env, {
        cwd: app.checkout,
        name: SESSION_NAME,
        status: 'idle',
      })
      const first = await postPick(server, pointerBody('the first', session))
      const second = await postPick(server, pointerBody('the second', session))
      await session.awaitLines(6)

      // One turn ended after both were written, and neither was acked.
      const reply = await replyFrom(session)
      await reply.send(
        idleFrame(subscriptionFor(session, first.pickId), Date.now() + 1000),
      )
      for (const pickId of [first.pickId, second.pickId]) {
        const row = await rowSettles(
          server,
          pickId,
          (seen) => seen.reportBack?.state === 'offered',
          'was offered back',
        )
        expect(row.state).toBe('sent')
      }
    })

    it('runs no clock for a Pick nobody was addressed to', async () => {
      const { server } = await startServer()
      const { pickId, state } = await postPick(server, pointerBody('for later', null))
      expect(state).toBe('queued-unaddressed')
      advanceClock(PAST_THE_REPORT)
      expect((await rowOf(server, pickId)).reportBack).toBeNull()
    })
  })

  describe('POST /__agent/pick/<id>/report', () => {
    it('requeues an offered Pick unaddressed, with a fresh TTL, for the next prompt', async () => {
      const { app, server, pickId } = await writtenPick('idle')
      advanceClock(PAST_THE_REPORT)
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')

      const answer = await postReport(server, pickId, { resolve: 'requeue' })
      expect(answer.status).toBe(200)
      expect(answer.json).toEqual({ pickId, state: 'queued-unaddressed' })

      const row = await rowOf(server, pickId)
      expect(row.state).toBe('queued-unaddressed')
      expect(row.queued).toBe(true)
      expect(row.reportBack).toBeNull()
      // Fresh: thirty minutes from the requeue, not from the Pick's creation.
      expect(row.expiresAt - row.createdAt).toBeGreaterThanOrEqual(
        30 * MINUTE + PAST_THE_REPORT,
      )

      // And it is the hook floor's now: the next prompt drains it.
      const drained = await drainOnce(server, app)
      expect(drained.drained).toBe(1)
      expect(drained.text).toContain('make this red')
    })

    it('retargets an offered Pick with a fresh body, and forgets the old one', async () => {
      const { app, server, env, session, pickId } = await writtenPick('idle')
      const other = await sessions.open(env, {
        cwd: app.checkout,
        name: OTHER_NAME,
        status: 'idle',
      })
      advanceClock(PAST_THE_REPORT)
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')

      const answer = await postReport(server, pickId, {
        resolve: 'retarget',
        target: { sessionId: other.sessionId, pid: other.pid },
      })
      expect(answer.status).toBe(200)
      expect(answer.json.state).toBe('sent')
      expect(answer.json.replaces).toBe(pickId)
      const newId = String(answer.json.pickId)
      expect(newId).not.toBe(pickId)

      const [frame] = (await other.awaitLines(3))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === 'user')
      expect(frame?.msg_id).toBe(newId)
      expect(frame?.session_id).toBe(other.sessionId)
      const fresh = contentOf(frame)
      const stale = contentOf(session.frames().find((line) => line.type === 'user'))
      expect(fresh).toContain('make this red')
      expect(nonceOf(fresh)).not.toBe(nonceOf(stale))

      const rows = await allRows(server)
      expect(rows.map((row) => row.pickId)).toEqual([newId])
      expect(rows[0]?.target?.name).toBe(OTHER_NAME)
      expect(rows[0]?.reportBack?.state).toBe('running')
    })

    it('refuses to resolve a Pick that was never offered back', async () => {
      const { server, pickId } = await writtenPick('idle')
      const answer = await postReport(server, pickId, { resolve: 'requeue' })
      expect(answer.status).toBe(409)
      expect(answer.json.error).toBe('no-offer')
      expect((await rowOf(server, pickId)).state).toBe('sent')
    })

    it('resolves an offer once, however many ask at the same moment', async () => {
      const { app, server, env, pickId } = await writtenPick('idle')
      const other = await sessions.open(env, {
        cwd: app.checkout,
        name: OTHER_NAME,
        status: 'idle',
      })
      advanceClock(PAST_THE_REPORT)
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')

      // The countdown ran out just as the developer chose another session.
      const answers = await Promise.all([
        postReport(server, pickId, {
          resolve: 'retarget',
          target: { sessionId: other.sessionId, pid: other.pid },
        }),
        postReport(server, pickId, { resolve: 'requeue' }),
        postReport(server, pickId, {
          resolve: 'retarget',
          target: { sessionId: other.sessionId, pid: other.pid },
        }),
      ])
      // One wins; the others find the offer taken — gone with the old id, or
      // no longer offered — and are refused, whichever came second.
      const statuses = answers.map((answer) => answer.status)
      expect(statuses.filter((status) => status === 200)).toHaveLength(1)
      expect(statuses.filter((status) => status >= 400 && status < 500)).toHaveLength(2)
      expect(await allRows(server)).toHaveLength(1)
    })

    it('refuses once the agent acknowledged it, however late', async () => {
      const { server, session, pickId } = await writtenPick('idle')
      advanceClock(PAST_THE_REPORT)
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')
      await fetch(ackUrl(session, pickId), { method: 'POST' })

      const answer = await postReport(server, pickId, { resolve: 'requeue' })
      expect(answer.status).toBe(409)
      expect((await rowOf(server, pickId)).state).toBe('working')
    })

    it('refuses a body it cannot read, an unknown Pick, and a caller with no Origin', async () => {
      const { server, pickId } = await writtenPick('idle')
      advanceClock(PAST_THE_REPORT)

      expect((await postReport(server, pickId, { resolve: 'shrug' })).status).toBe(400)
      expect(
        (await postReport(server, 'no-such-pick', { resolve: 'requeue' })).status,
      ).toBe(404)
      const bare = await postReport(
        server,
        pickId,
        { resolve: 'requeue' },
        { origin: null },
      )
      expect(bare.status).toBeGreaterThanOrEqual(400)
      expect((await rowOf(server, pickId)).reportBack?.state).toBe('offered')
    })
  })

  describe('the TTL sentence says what actually happened', () => {
    it('for a Pick nobody was addressed to', async () => {
      const { server } = await startServer()
      const { pickId } = await postPick(server, pointerBody('for later', null))
      advanceClock(PAST_THE_TTL)
      expect((await rowOf(server, pickId)).reason).toBe(UNADDRESSED_TTL)
    })

    it('for a Pick written to a session that never acknowledged it', async () => {
      const { server, env, session, pickId } = await writtenPick('idle')
      updateSession(env, session.pid, { status: 'busy' })
      await rowOf(server, pickId)
      advanceClock(PAST_THE_TTL)
      const row = await rowOf(server, pickId)
      expect(row.state).toBe('failed')
      expect(row.reason).toBe(WRITTEN_TTL)
    })

    it('for a Pick held for an approval nobody gave', async () => {
      const { server, session, pickId } = await writtenPick('idle')
      const reply = await replyFrom(session)
      await reply.send({
        type: 'control',
        action: 'peer_message_status',
        status: 'held',
        orig_msg_id: pickId,
        msgV: 1,
        msg_id: 'receipt-held',
      })
      await rowSettles(server, pickId, (row) => row.state === 'held', 'was held')

      advanceClock(PAST_THE_TTL)
      const row = await rowOf(server, pickId)
      expect(row.state).toBe('failed')
      expect(row.reason).toBe(HELD_TTL)
    })

    it('for a Pick the hook floor handed to a prompt', async () => {
      const { app, server } = await startServer()
      const { pickId } = await postPick(server, pointerBody('for later', null))
      expect((await drainOnce(server, app)).drained).toBe(1)
      advanceClock(PAST_THE_TTL)
      const row = await rowOf(server, pickId)
      expect(row.state).toBe('failed')
      expect(row.reason).toBe(DRAINED_TTL)
    })
  })

  /** A Receipt about one Pick, in the shape spike 16 measured. */
  function receiptFrame(pickId: string, status: string): unknown {
    return {
      type: 'control',
      action: 'peer_message_status',
      status,
      orig_msg_id: pickId,
      msgV: 1,
      msg_id: `receipt-${Math.random().toString(16).slice(2)}`,
    }
  }

  /** The rendered body a `user` frame carries. */
  function contentOf(frame: Record<string, unknown> | undefined): string {
    const message = frame?.message as { content?: string } | undefined
    if (typeof message?.content !== 'string') throw new Error('no user frame with a body')
    return message.content
  }

  /** The Fence nonce a rendered body carries in its ack URL. */
  function nonceOf(content: string): string {
    const found = /[?&]n=([0-9a-f]+)/.exec(content)
    if (!found?.[1]) throw new Error('the body carried no nonce')
    return found[1]
  }

  /** One drain, as the CLI would ask for it, with the secret off the discovery entry. */
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
})
