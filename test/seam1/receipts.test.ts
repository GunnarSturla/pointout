import { afterEach, describe, expect, it } from 'vitest'
import { advanceClock, createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { fakeSessions, replyTo } from '../harness/session-socket.js'
import type { FakeSession, ReplyConnection } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'

// What the dev server hears back at its reply address, and what it does with it
// (spec §16, §17). Every string here is written out rather than imported — the
// frame field names are the harness's, the states and the sentences are the
// contract the Overlay reads, and a test that still passes after the server
// renames its internals is the test we want (docs/agents/testing.md).
//
// A Receipt reports bad outcomes only. Nothing here asserts that silence means
// arrival, because it does not.

const PICK = '/__agent/pick'
const STATUS = '/__agent/status'

/** The Target's registry name, which three of the sentences below name. */
const SESSION_NAME = 'the one in the terminal'

/**
 * Spec §17's table, as the harness's machine values reach it. Only `duplicate`
 * was measured live (spike 16); the other three drop reasons are the harness's
 * own words for the branches it names beside it, which is why an unrecognised
 * one falls back to its prose rather than to a guess.
 */
const REASON_TABLE: Array<{
  note: string
  receipt: Record<string, unknown>
  sentence: string
}> = [
  {
    note: 'dropped as a duplicate',
    receipt: { status: 'dropped', drop_reason: 'duplicate' },
    sentence: 'Not delivered — an identical pick was just sent.',
  },
  {
    note: 'dropped by a rate limit',
    receipt: { status: 'dropped', drop_reason: 'rate_limit' },
    sentence: 'Not delivered — too many picks too quickly.',
  },
  {
    note: 'dropped against a full queue',
    receipt: { status: 'dropped', drop_reason: 'full_queue' },
    sentence: `Not delivered — ${SESSION_NAME} has too much queued.`,
  },
  {
    note: 'dropped as a relay loop',
    receipt: { status: 'dropped', drop_reason: 'relay_loop' },
    sentence: 'Not delivered — it came back to where it started.',
  },
  {
    note: 'refused by the session',
    receipt: { status: 'refused' },
    sentence: `Not delivered — ${SESSION_NAME} isn't accepting picks.`,
  },
  {
    note: 'denied by the developer',
    receipt: { status: 'denied' },
    sentence: `Not delivered — you declined it in ${SESSION_NAME}.`,
  },
  {
    note: 'expired before approval',
    receipt: { status: 'expired' },
    sentence: "Not delivered — it wasn't approved in time.",
  },
]

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
const connections: ReplyConnection[] = []

afterEach(async () => {
  advanceClock(0)
  while (connections.length) await connections.pop()!.close()
  await apps.cleanup()
  await sessions.closeAll()
  fixture?.cleanup()
  fixture = undefined
})

/** A dev server whose registry and socket directories this test owns. */
async function startPickServer(): Promise<{
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

/** The Pointer inputs the Overlay sends. */
function pointerBody(note: string, session: FakeSession): Record<string, unknown> {
  return {
    url: 'http://localhost:5173/settings',
    viewport: { width: 1280, height: 800 },
    descriptor: { tag: 'button', id: 'save' },
    geometry: { width: 120, height: 40, x: 24, y: 560 },
    note,
    target: { sessionId: session.sessionId, pid: session.pid },
  }
}

async function postPick(
  server: HarnessServer,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(server.url + PICK, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  const json = (await response.json()) as { pickId: string; state: string }
  expect(json.state).toBe('sent-awaiting-ack')
  return json.pickId
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

/**
 * A Receipt is a fresh outbound connection, so it lands after the POST that
 * caused it has already answered. Poll rather than sleep.
 */
async function rowSettles(
  server: HarnessServer,
  pickId: string,
  want: (row: PickStatus) => boolean,
  what: string,
): Promise<PickStatus> {
  const deadline = Date.now() + 4000
  let row = rowFor(await getStatus(server), pickId)
  while (!want(row)) {
    if (Date.now() > deadline) {
      throw new Error(
        `pick ${pickId} never ${what}: it is ${row.state} / ${String(row.reason)}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    row = rowFor(await getStatus(server), pickId)
  }
  return row
}

/** One frame arriving at the reply address, in the shape spike 16 measured. */
function statusFrame(pickId: string, fields: Record<string, unknown>): unknown {
  return {
    type: 'control',
    action: 'peer_message_status',
    orig_msg_id: pickId,
    msgV: 1,
    msg_id: `receipt-${Math.random().toString(16).slice(2)}`,
    ...fields,
  }
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

/** One delivered Pick, the session that got it, and the way back to the server. */
async function deliveredPick(note = 'make this red'): Promise<{
  server: HarnessServer
  session: FakeSession
  pickId: string
  reply: ReplyConnection
}> {
  const { app, server, env } = await startPickServer()
  const session = await sessions.open(env, {
    cwd: app.checkout,
    name: SESSION_NAME,
    status: 'idle',
  })
  const pickId = await postPick(server, pointerBody(note, session))
  await session.awaitLines(3)
  const reply = await replyTo(session.replyAddress())
  connections.push(reply)
  return { server, session, pickId, reply }
}

/** The `msg_id` of the idle subscription the server wrote after the Pick. */
function subscriptionId(session: FakeSession): string {
  const frame = session
    .frames()
    .find((line) => line.action === 'notify_when_idle' && line.type === 'control')
  if (!frame) throw new Error('the server wrote no notify_when_idle frame')
  return String(frame.msg_id)
}

describe('the reason table', () => {
  it('writes v0 sentence for every signal in it', async () => {
    const { app, server, env } = await startPickServer()
    const session = await sessions.open(env, {
      cwd: app.checkout,
      name: SESSION_NAME,
      status: 'idle',
    })

    // One server, one session, one Pick per row: each Pick carries a different
    // Note, because v0 never writes a byte-identical body twice.
    const picked: Array<{ pickId: string; sentence: string }> = []
    for (const row of REASON_TABLE) {
      picked.push({
        pickId: await postPick(server, pointerBody(row.note, session)),
        sentence: row.sentence,
      })
    }
    await session.awaitLines(3 * REASON_TABLE.length)

    const reply = await replyTo(session.replyAddress())
    connections.push(reply)
    for (const [index, row] of REASON_TABLE.entries()) {
      await reply.send(statusFrame(picked[index]!.pickId, row.receipt))
    }

    for (const { pickId, sentence } of picked) {
      const row = await rowSettles(
        server,
        pickId,
        (seen) => seen.state === 'failed',
        'reached failed',
      )
      expect(row.reason).toBe(sentence)
      // A Pick the harness will not deliver is one no route may deliver either.
      expect(row.queued).toBe(false)
      expect(server.log()).toContain(sentence)
    }
  })

  it('falls back to the harness prose verbatim on a drop reason it does not know', async () => {
    const { server, pickId, reply } = await deliveredPick()
    const prose =
      "The recipient's session dropped your message at its inbox (rate limit, " +
      'duplicate, relay loop, or full queue); it was not delivered and will not be.'

    await reply.send(
      statusFrame(pickId, {
        status: 'dropped',
        drop_reason: 'some-branch-v0-has-never-heard-of',
        reason: prose,
      }),
    )

    const row = await rowSettles(
      server,
      pickId,
      (seen) => seen.state === 'failed',
      'reached failed',
    )
    expect(row.reason).toBe(prose)
  })

  it('still fails a Pick when the harness sent no prose to fall back to', async () => {
    const { server, pickId, reply } = await deliveredPick()
    await reply.send(statusFrame(pickId, { status: 'dropped', drop_reason: 'mystery' }))

    const row = await rowSettles(
      server,
      pickId,
      (seen) => seen.state === 'failed',
      'reached failed',
    )
    expect(row.reason).toMatch(/^Not delivered — /)
  })
})

describe('held, and the release that follows it', () => {
  it('moves a held Pick to held and a delivered one back to sent', async () => {
    const { server, pickId, reply } = await deliveredPick()

    await reply.send(statusFrame(pickId, { status: 'held' }))
    await rowSettles(server, pickId, (row) => row.state === 'held', 'reached held')

    await reply.send(statusFrame(pickId, { status: 'delivered' }))
    const released = await rowSettles(
      server,
      pickId,
      (row) => row.state === 'sent',
      'returned to sent',
    )

    // Never the word `delivered`: a released Pick is a Pick that is sent, and
    // nothing else this server knows says it arrived.
    expect(released.history.map((step) => step.state)).toEqual(['sent', 'held', 'sent'])
    expect(released.state).not.toBe('delivered')
  })

  it('leaves a held Pick where a route can still finish it', async () => {
    const { server, session, pickId, reply } = await deliveredPick()
    await reply.send(statusFrame(pickId, { status: 'held' }))
    const held = await rowSettles(
      server,
      pickId,
      (row) => row.state === 'held',
      'reached held',
    )
    expect(held.queued).toBe(true)
    expect(held.target?.name).toBe(session.name)
  })

  it('never reports delivered as a state, whatever the Pick was in', async () => {
    const { server, pickId, reply } = await deliveredPick()

    // A release for a Pick that was never held: evidence about a Pick already
    // sent, which says nothing new and must not invent a word for itself.
    await reply.send(statusFrame(pickId, { status: 'delivered' }))
    await reply.send(statusFrame(pickId, { status: 'held' }))
    const row = await rowSettles(
      server,
      pickId,
      (seen) => seen.state === 'held',
      'reached held',
    )
    expect(row.history.map((step) => step.state)).toEqual(['sent', 'held'])
  })
})

describe('a frame the reply address cannot use', () => {
  it('ignores one naming a Pick this server never sent, and keeps serving', async () => {
    const { server, pickId, reply } = await deliveredPick()

    await reply.send(
      statusFrame('00000000-no-such-pick', {
        status: 'dropped',
        drop_reason: 'duplicate',
      }),
    )
    await reply.send(statusFrame(pickId, { status: 'held' }))

    // The good frame arriving proves the bad one neither moved a Pick nor took
    // the connection down with it.
    await rowSettles(server, pickId, (row) => row.state === 'held', 'reached held')
    expect(server.log()).toContain('00000000-no-such-pick')
  })

  it('ignores one whose msgV is not the version it was pinned to', async () => {
    const { server, pickId, reply } = await deliveredPick()

    await reply.send({
      type: 'control',
      action: 'peer_message_status',
      status: 'dropped',
      drop_reason: 'duplicate',
      orig_msg_id: pickId,
      msgV: 2,
      msg_id: 'from-a-harness-that-moved',
    })
    await reply.send(statusFrame(pickId, { status: 'held' }))

    await rowSettles(server, pickId, (row) => row.state === 'held', 'reached held')
    expect(server.log()).toMatch(/msgV/)
  })

  it('ignores one that is not JSON at all, and keeps serving', async () => {
    const { server, pickId, reply } = await deliveredPick()

    await reply.sendRaw('{"type":"control", this is not json')
    await reply.send(statusFrame(pickId, { status: 'held' }))

    const row = await rowSettles(
      server,
      pickId,
      (seen) => seen.state === 'held',
      'reached held',
    )
    expect(row.reason).toBeNull()
    expect(server.log()).toMatch(/not JSON/i)
  })

  it('ignores an action it does not recognise', async () => {
    const { server, pickId, reply } = await deliveredPick()

    await reply.send({
      type: 'control',
      action: 'peer_something_new',
      orig_msg_id: pickId,
      msgV: 1,
      msg_id: 'a-harness-that-grew',
    })
    await reply.send(statusFrame(pickId, { status: 'held' }))

    await rowSettles(server, pickId, (row) => row.state === 'held', 'reached held')
    expect(server.log()).toContain('peer_something_new')
  })
})

describe('idle notices', () => {
  it('records one that followed the Pick, and ignores one that predates it', async () => {
    const { server, session, pickId, reply } = await deliveredPick()
    const subscription = subscriptionId(session)

    // Fired against an already-idle Target before the Pick landed: it says
    // nothing about this Pick, and it is logged rather than believed.
    await reply.send(idleFrame(subscription, Date.now() - 60 * 60 * 1000))
    await reply.send(statusFrame(pickId, { status: 'held' }))
    const stale = await rowSettles(
      server,
      pickId,
      (row) => row.state === 'held',
      'reached held',
    )
    expect(stale.target?.idleAt).toBeNull()
    expect(server.log()).toContain(`stale idle notice for pick ${pickId}`)

    const finishedAt = Date.now() + 1000
    await reply.send(idleFrame(subscription, finishedAt))
    const recorded = await rowSettles(
      server,
      pickId,
      (row) => row.target?.idleAt !== null,
      'recorded an idle notice',
    )
    expect(recorded.target?.idleAt).toBe(finishedAt)
    // Session-level evidence colours the Target row and never moves a Pick.
    expect(recorded.state).toBe('held')
  })

  it('ignores one naming a subscription this server never made', async () => {
    const { server, pickId, reply } = await deliveredPick()

    await reply.send(idleFrame('no-such-subscription', Date.now() + 1000))
    await reply.send(statusFrame(pickId, { status: 'held' }))
    const row = await rowSettles(
      server,
      pickId,
      (seen) => seen.state === 'held',
      'reached held',
    )
    expect(row.target?.idleAt).toBeNull()
    expect(server.log()).toContain('no-such-subscription')
  })
})

describe('the session_id mismatch drop', () => {
  it('fails the Pick a session dropped because the id was not its own', async () => {
    const { app, server, env } = await startPickServer()
    const session = await sessions.open(env, {
      cwd: app.checkout,
      name: SESSION_NAME,
      status: 'idle',
    })

    const pickId = await postPick(server, pointerBody('for the wrong session', session))
    await session.awaitLines(3)

    // What the harness does when a pid has been reused: the frame names a
    // session that is not the one listening, so it is dropped rather than
    // received. The real measurement is ticket 20's; this is the shape of it.
    const user = session.frames().find((frame) => frame.type === 'user')
    const addressedTo = String(user?.session_id)
    expect(addressedTo).toBe(session.sessionId)
    const mismatch = 'some-other-session-that-reused-this-pid'
    const prose =
      'The recipient session id did not match; the message was not delivered ' +
      'and will not be.'

    const reply = await replyTo(session.replyAddress())
    connections.push(reply)
    if (addressedTo !== mismatch) {
      await reply.send(
        statusFrame(pickId, {
          status: 'dropped',
          drop_reason: 'session_id_mismatch',
          reason: prose,
        }),
      )
    }

    const row = await rowSettles(
      server,
      pickId,
      (seen) => seen.state === 'failed',
      'reached failed',
    )
    expect(row.reason).toBe(prose)
  })
})
