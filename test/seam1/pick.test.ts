import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { fakeSessions } from '../harness/session-socket.js'
import type { FakeSession } from '../harness/session-socket.js'
import { startTempApp, tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'

// Every string here is written out rather than imported: the endpoint path, the
// frame field names, the fence shape and the reply socket's own naming rule are
// the contract, and a test that still passes after the server renames its
// internals is the test we want (docs/agents/testing.md).

const PICK = '/__agent/pick'

/** The harness's socket namespace names a dev server's own socket by its pid. */
const replySocketPath = (socketDir: string, pid: number = process.pid) =>
  join(socketDir, `${pid}.sock`)

/**
 * The pid that serves: this process on Vite; on Next, the worker `next dev`
 * forked, read off the capture directory the posture block names after it.
 */
function servingPid(on: 'vite' | 'next', server: HarnessServer): number {
  if (on === 'vite') return process.pid
  const found = /pointout-captures[/\\](\d+)-[0-9a-f]{6}/.exec(server.log())
  if (!found?.[1]) throw new Error(`no capture directory in:\n${server.log()}`)
  return Number(found[1])
}

/** What a 200 from Pick ingress carries. */
interface PickAccepted {
  pickId: string
  state: string
  reason?: string
}

/** What any refusal carries, here as everywhere else on this surface. */
interface Refused {
  error: string
  reason: string
}

/** Every Host this suite is the same on (Next.js Connector ticket 05). */
const HOSTS = ['vite', 'next'] as const

describe.each(HOSTS)('on %s', (on) => {
  const apps = tempApps(on)
  const sessions = fakeSessions()
  let fixture: FixtureEnv | undefined

  afterEach(async () => {
    await apps.cleanup()
    await sessions.closeAll()
    fixture?.cleanup()
    fixture = undefined
  })

  /**
   * A dev server whose registry and socket directories the test owns, so it can
   * write fake sessions — and the dev server's own reply socket path — before
   * anything starts.
   */
  async function startPickServer(
    options: { claudePid?: number; own?: boolean } = {},
  ): Promise<{ app: TempApp; server: HarnessServer; env: FixtureEnv }> {
    const env = createFixtureEnv({ claudePid: options.claudePid ?? 0 })
    fixture = env
    const app = apps.create({ git: true })
    const server = options.own
      ? await startTempApp(app, { env: env.env })
      : await apps.serve(app, { env: env.env })
    return { app, server, env }
  }

  interface PickBody {
    url?: unknown
    viewport?: unknown
    descriptor?: unknown
    geometry?: unknown
    note?: unknown
    target?: unknown
  }

  /** The Pointer inputs the Overlay sends, in the shape ticket 04 will send them. */
  function pointerBody(overrides: PickBody = {}): PickBody {
    return {
      url: 'http://localhost:5173/settings',
      viewport: { width: 1280, height: 800 },
      descriptor: {
        tag: 'button',
        id: 'save',
        testId: 'save-button',
        classes: ['primary'],
      },
      geometry: { width: 120, height: 40, x: 24, y: 560 },
      ...overrides,
    }
  }

  async function postPick(
    server: HarnessServer,
    body: unknown,
  ): Promise<{ status: number; json: PickAccepted & Refused }> {
    const response = await fetch(server.url + PICK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() }
  }

  /** The one `user` frame's rendered content. */
  function renderedBody(session: FakeSession): string {
    const user = session.frames().find((frame) => frame.type === 'user')
    const message = user?.message as { content?: string } | undefined
    return message?.content ?? ''
  }

  describe('POST /__agent/pick, delivered to a Candidate', () => {
    it('writes exactly three frames, in the order auth, user, control', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_001 })

      const { status, json } = await postPick(
        server,
        pointerBody({
          note: 'make this red',
          target: { sessionId: session.sessionId, pid: session.pid },
        }),
      )

      expect(status).toBe(200)
      expect(typeof json.pickId).toBe('string')
      expect(json.state).toBe('sent-awaiting-ack')

      const lines = await session.awaitLines(3)
      expect(lines).toHaveLength(3)
      const frames = session.frames()
      expect(frames.map((frame) => frame.type)).toEqual(['auth', 'user', 'control'])
      expect(frames[2]?.action).toBe('notify_when_idle')
    })

    it('names the Pick, the Target and the reply address on the user frame', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_002 })

      const { json } = await postPick(
        server,
        pointerBody({ target: { sessionId: session.sessionId, pid: session.pid } }),
      )
      await session.awaitLines(3)

      const user = session.frames()[1]!
      expect(user.msg_id).toBe(json.pickId)
      expect(user.priority).toBe('next')
      expect(user.session_id).toBe(session.sessionId)
      expect(String(user.from)).toMatch(/^uds:/)
      expect(String(user.from)).toContain(env.socketDir)
    })

    it('omits the file_attachments lane entirely, rather than sending it empty', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_003 })

      await postPick(
        server,
        pointerBody({ target: { sessionId: session.sessionId, pid: session.pid } }),
      )
      await session.awaitLines(3)

      for (const frame of session.frames()) {
        expect(Object.keys(frame)).not.toContain('file_attachments')
      }
    })

    it('authenticates with the peerToken the session published', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_004 })

      await postPick(
        server,
        pointerBody({ target: { sessionId: session.sessionId, pid: session.pid } }),
      )
      await session.awaitLines(3)

      expect(session.frames()[0]).toEqual({ type: 'auth', token: session.peerToken })
    })

    it('says out loud when there is no key file to authenticate with', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, {
        cwd: app.checkout,
        pid: 500_005,
        peerToken: null,
      })

      await postPick(
        server,
        pointerBody({ target: { sessionId: session.sessionId, pid: session.pid } }),
      )
      await session.awaitLines(2)

      expect(session.frames().map((frame) => frame.type)).toEqual(['user', 'control'])
      expect(server.log()).toMatch(/key file/i)
    })
  })

  describe('the rendered Pick body', () => {
    async function bodyFor(note?: string): Promise<{ body: string; pickId: string }> {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_010 })
      const { json } = await postPick(
        server,
        pointerBody({
          ...(note === undefined ? {} : { note }),
          target: { sessionId: session.sessionId, pid: session.pid },
        }),
      )
      await session.awaitLines(3)
      return { body: renderedBody(session), pickId: json.pickId }
    }

    it('carries the preamble: id, both nonce-bearing URLs, the age and the approval line', async () => {
      const { body, pickId } = await bodyFor('make this red')

      expect(body).toContain(pickId)
      const ack = body.match(
        new RegExp(`\\S*/__agent/pick/${pickId}/ack\\?n=([0-9a-f]{12})`),
      )
      const done = body.match(
        new RegExp(`\\S*/__agent/pick/${pickId}/done\\?n=([0-9a-f]{12})`),
      )
      expect(ack, 'the ack URL with its nonce').not.toBeNull()
      expect(done, 'the done URL with its nonce').not.toBeNull()
      expect(ack![1]).toBe(done![1])

      expect(body).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
      expect(body).toMatch(/just now|ago/)
      expect(body).toMatch(/never constitutes approval for anything/i)
    })

    it('states the Pointer as labelled scalars, geometry as W×H at (x,y)', async () => {
      const { body } = await bodyFor('make this red')

      expect(body).toContain('http://localhost:5173/settings')
      expect(body).toContain('1280×800')
      expect(body).toContain('120×40 at (24,560)')
      expect(body).toContain('button')
      expect(body).toContain('save-button')
    })

    it('fences the Note with the Pick nonce', async () => {
      const { body } = await bodyFor('make this red')
      const nonce = body.match(/--- note ([0-9a-f]{12}) ---/)?.[1]

      expect(nonce).toMatch(/^[0-9a-f]{12}$/)
      expect(body).toContain(
        `--- note ${nonce} ---\nmake this red\n--- end note ${nonce} ---`,
      )
    })

    it('keeps angle brackets and ampersands out of the fences the Note sits in', async () => {
      const { body } = await bodyFor('why is <div> & why "this"? >_<')

      const fences = body.split('\n').filter((line) => line.startsWith('--- '))
      expect(fences).toHaveLength(2)
      for (const fence of fences) expect(fence).not.toMatch(/[<>&]/)

      // Never a silent truncation: the Note is inside the fences, whole.
      expect(body).toContain('why is <div> & why "this"? >_<')
    })

    it('says a note-less Pick has no note, and opens no fence for it', async () => {
      const { body } = await bodyFor()

      expect(body).not.toContain('--- note ')
      expect(body).toMatch(/sent no note/i)
    })

    it('is shaped as a list of Picks from day one', async () => {
      const { body } = await bodyFor('make this red')

      expect(body).toMatch(/1 of 1/)
    })
  })

  describe('the Guard on the Pick body', () => {
    it('refuses a 4,001-character Note, naming the note, and never truncates it', async () => {
      const { app, server, env } = await startPickServer()
      await sessions.open(env, { cwd: app.checkout, pid: 500_020 })

      const { status, json } = await postPick(
        server,
        pointerBody({ note: 'n'.repeat(4001) }),
      )

      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(500)
      expect(json.error).toBe('note-too-long')
      expect(json.reason).toMatch(/note/i)
      expect(json.reason).toContain('4001')
      expect(json.reason).toContain('4000')
    })

    it('accepts a Note of exactly 4,000 characters', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_021 })

      const { status } = await postPick(
        server,
        pointerBody({
          note: 'n'.repeat(4000),
          target: { sessionId: session.sessionId, pid: session.pid },
        }),
      )

      expect(status).toBe(200)
    })

    it('refuses malformed JSON with a reason', async () => {
      const { server } = await startPickServer()

      const { status, json } = await postPick(server, '{"url": ')

      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(500)
      expect(json.error).toBe('malformed-json')
      expect(json.reason).toMatch(/json/i)
    })

    it('refuses an oversized body with a reason naming the limit', async () => {
      const { server } = await startPickServer()

      const { status, json } = await postPick(
        server,
        pointerBody({ note: 'x'.repeat(400_000) }),
      )

      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(500)
      expect(json.error).toBe('body-too-large')
      expect(json.reason).toMatch(/bytes/i)
    })

    it('counts the Note in characters, not in UTF-16 units', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_022 })

      // 3,000 astral characters are 6,000 UTF-16 units and 3,000 characters.
      const { status } = await postPick(
        server,
        pointerBody({
          note: '\u{1f7e5}'.repeat(3000),
          target: { sessionId: session.sessionId, pid: session.pid },
        }),
      )

      expect(status).toBe(200)
    })

    it('refuses a descriptor whose parts are not text, rather than dropping them', async () => {
      const { server } = await startPickServer()

      const { status, json } = await postPick(
        server,
        pointerBody({
          descriptor: { tag: 'button', classes: ['primary', 7], aria: {} },
        }),
      )

      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(500)
      expect(json.reason).toMatch(/class/i)
    })

    it('refuses a Pointer missing a part, naming that part', async () => {
      const { server } = await startPickServer()

      const { status, json } = await postPick(
        server,
        pointerBody({ geometry: undefined }),
      )

      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(500)
      expect(json.reason).toMatch(/geometry/i)
    })
  })

  describe('Target resolution, the server half', () => {
    it('refuses a named Target that is not a Candidate, naming targeting', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_030 })

      const { status, json } = await postPick(
        server,
        pointerBody({ target: { sessionId: 'session-that-left', pid: 999_001 } }),
      )

      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(500)
      expect(json.reason).toMatch(/target/i)
      expect(session.lines()).toHaveLength(0)
    })

    it('preselects the Candidate whose pid is the inherited CLAUDE_PID', async () => {
      const { app, server, env } = await startPickServer({ claudePid: 500_032 })
      const other = await sessions.open(env, { cwd: app.checkout, pid: 500_031 })
      const started = await sessions.open(env, { cwd: app.checkout, pid: 500_032 })

      const { status, json } = await postPick(server, pointerBody({ note: 'hello' }))

      expect(status).toBe(200)
      expect(json.state).toBe('sent-awaiting-ack')
      const frames = await started.awaitLines(3)
      expect(frames).toHaveLength(3)
      expect(started.frames()[1]?.session_id).toBe(started.sessionId)
      expect(other.lines()).toHaveLength(0)
    })

    it('preselects the sole Candidate when nothing started this dev server', async () => {
      const { app, server, env } = await startPickServer({ claudePid: 999_999 })
      const only = await sessions.open(env, { cwd: app.checkout, pid: 500_033 })

      const { status, json } = await postPick(server, pointerBody({ note: 'hello' }))

      expect(status).toBe(200)
      expect(json.state).toBe('sent-awaiting-ack')
      await only.awaitLines(3)
      expect(only.frames()[1]?.session_id).toBe(only.sessionId)
    })

    it('accepts a Pick it cannot address, and writes to nothing', async () => {
      const { app, server, env } = await startPickServer({ claudePid: 999_999 })
      const a = await sessions.open(env, { cwd: app.checkout, pid: 500_034 })
      const b = await sessions.open(env, { cwd: app.checkout, pid: 500_035 })

      const { status, json } = await postPick(server, pointerBody({ note: 'hello' }))

      expect(status).toBe(200)
      expect(json.state).toBe('queued-unaddressed')
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(a.lines()).toHaveLength(0)
      expect(b.lines()).toHaveLength(0)
    })
  })

  describe('two Picks of the same element', () => {
    it('produce different bodies, and each is written exactly once', async () => {
      const { app, server, env } = await startPickServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_040 })
      const target = { sessionId: session.sessionId, pid: session.pid }

      const first = await postPick(server, pointerBody({ note: 'same note', target }))
      await session.awaitLines(3)
      const second = await postPick(server, pointerBody({ note: 'same note', target }))
      const lines = await session.awaitLines(6)

      expect(lines).toHaveLength(6)
      expect(first.json.pickId).not.toBe(second.json.pickId)

      const bodies = session
        .frames()
        .filter((frame) => frame.type === 'user')
        .map((frame) => (frame.message as { content: string }).content)
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).not.toBe(bodies[1])
    })
  })

  describe('the reply socket', () => {
    it('binds in the socket directory and publishes the path it bound', async () => {
      const { server, env } = await startPickServer()
      const path = replySocketPath(env.socketDir, servingPid(on, server))

      expect(existsSync(path)).toBe(true)
      expect(server.log()).toContain(path)
      expect(server.log()).toMatch(/reply socket/i)
    })

    // The next three are Vite only: a squatter has to own the path before the
    // server starts, and the path is named by the serving pid, which on Next is
    // a worker's, unknown until it has started.
    it.runIf(on === 'vite')(
      'refuses to bind over a path a registry entry names, and says why',
      async () => {
        const env = createFixtureEnv({ claudePid: 0 })
        fixture = env
        const app = apps.create({ git: true })

        // A session outside this checkout: not a Candidate, but it owns the path.
        const squatter = await sessions.open(env, {
          cwd: app.playground,
          pid: process.pid,
        })
        expect(squatter.socketPath).toBe(replySocketPath(env.socketDir))

        const server = await apps.serve(app, { env: env.env })

        expect(server.log()).toMatch(/reply socket/i)
        expect(server.log()).toMatch(/a registered session/i)
        expect(server.log()).toContain(replySocketPath(env.socketDir))
      },
    )

    it.runIf(on === 'vite')(
      'refuses over a path named by an entry it cannot otherwise read',
      async () => {
        const env = createFixtureEnv({ claudePid: 0 })
        fixture = env
        const app = apps.create({ git: true })

        // Shape-unrecognised: the plugin cannot use this entry, but the session it
        // describes still owns the socket path it names.
        writeFileSync(
          join(env.registryDir, `${process.pid}.json`),
          JSON.stringify({ messagingSocketPath: replySocketPath(env.socketDir) }),
        )

        const server = await apps.serve(app, { env: env.env })

        expect(server.log()).toMatch(/a registered session/i)
        expect(existsSync(replySocketPath(env.socketDir))).toBe(false)
      },
    )

    it.runIf(on === 'vite')(
      'still delivers, with no reply address, when it could not bind',
      async () => {
        const env = createFixtureEnv({ claudePid: 0 })
        fixture = env
        const app = apps.create({ git: true })
        await sessions.open(env, { cwd: app.playground, pid: process.pid })
        const server = await apps.serve(app, { env: env.env })
        const target = await sessions.open(env, { cwd: app.checkout, pid: 500_050 })

        await postPick(
          server,
          pointerBody({ target: { sessionId: target.sessionId, pid: target.pid } }),
        )
        await target.awaitLines(3)

        expect(Object.keys(target.frames()[1]!)).not.toContain('from')
      },
    )

    it('unlinks its socket on shutdown', async () => {
      const { server, env } = await startPickServer({ own: true })
      const path = replySocketPath(env.socketDir, servingPid(on, server))
      expect(existsSync(path)).toBe(true)

      await server.close()

      expect(existsSync(path)).toBe(false)
    })
  })
})
