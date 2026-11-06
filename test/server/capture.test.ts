import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { fakeSessions } from '../harness/session-socket.js'
import type { FakeSession } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'

// Screen Capture, server side (spec §10, §20). Every string here is written out
// rather than imported: the endpoint paths, the coordinate field names, the
// capture directory's own naming rule and the words the posture block and the
// payload line use are the contract (docs/agents/testing.md).
//
// No real screen is involved. The fake `screencapture` on `PATH` is what makes
// the success path, the empty capture, the failure and the hang observable, and
// `POINTOUT_PLATFORM` is what makes "not macOS" observable from a mac.

const CAPTURE = '/__agent/capture'
const PICK = '/__agent/pick'

/** The capture directory this dev server owns lives under the OS temp root. */
const CAPTURE_ROOT = join(tmpdir(), 'pointout-captures')

/** The fixed margin §10 puts around the element, on every side. */
const MARGIN = 24

/** Every Host this suite is the same on (Next.js Connector ticket 05). */
const HOSTS = ['vite', 'next'] as const

describe.each(HOSTS)('on %s', (on) => {
  const apps = tempApps(on)
  const sessions = fakeSessions()
  let fixture: FixtureEnv | undefined
  /** The mode the fake starts the server in, for the startup probe. */
  const MODE = 'FAKE_SCREENCAPTURE_MODE'

  afterEach(async () => {
    await apps.cleanup()
    await sessions.closeAll()
    fixture?.cleanup()
    fixture = undefined
  })

  /**
   * The fake reads its mode at call time, so a test can change its mind. It is
   * read from a file the fixture owns, which a `next dev` in a process of its
   * own sees as well as a Vite in this one.
   */
  function fakeBecomes(mode: 'png' | 'empty' | 'sleep' | 'fail', seconds?: number): void {
    if (!fixture) throw new Error('start the capture server before changing the fake')
    fixture.captureBecomes(mode, seconds)
  }

  async function startCaptureServer(
    env: Record<string, string> = {},
  ): Promise<{ app: TempApp; server: HarnessServer; env: FixtureEnv }> {
    const created = createFixtureEnv({ claudePid: 0 })
    fixture = created
    const app = apps.create({ git: true })
    const server = await apps.serve(app, { env: { ...created.env, ...env } })
    return { app, server, env: created }
  }

  /** The directory the posture block says this server writes its captures to. */
  function captureDirectory(server: HarnessServer): string {
    const found = /\S*pointout-captures[/\\]\S+/.exec(server.log())
    if (!found) throw new Error('the posture block named no capture directory')
    return found[0]
  }

  /** What is in this dev server's capture directory right now. */
  const filesIn = (directory: string) =>
    existsSync(directory) ? readdirSync(directory) : []

  interface CaptureCoordinates {
    rect?: unknown
    screenX?: unknown
    screenY?: unknown
    chromeWidth?: unknown
    chromeHeight?: unknown
    screen?: unknown
  }

  /** What the Overlay ships at pick time: coordinates only, never pixels. */
  function coordinates(overrides: CaptureCoordinates = {}): CaptureCoordinates {
    return {
      rect: { x: 100, y: 200, width: 300, height: 150 },
      screenX: 50,
      screenY: 60,
      chromeWidth: 0,
      chromeHeight: 80,
      screen: { width: 1920, height: 1080 },
      ...overrides,
    }
  }

  interface CaptureStarted {
    captureId: string
    error?: string
    reason?: string
  }

  async function postCapture(
    server: HarnessServer,
    body: unknown = coordinates(),
  ): Promise<{ status: number; json: CaptureStarted }> {
    const response = await fetch(server.url + CAPTURE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify(body),
    })
    return { status: response.status, json: (await response.json()) as CaptureStarted }
  }

  async function deleteCapture(
    server: HarnessServer,
    id: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${server.url}${CAPTURE}/${id}`, {
      method: 'DELETE',
      headers: { origin: server.url },
    })
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    }
  }

  /** The Pointer inputs ingest already requires, with the capture ones beside them. */
  function pickBody(capture: unknown, target: unknown): Record<string, unknown> {
    return {
      url: 'http://localhost:5173/settings',
      viewport: { width: 1280, height: 800 },
      descriptor: { tag: 'button' },
      geometry: { width: 120, height: 40, x: 24, y: 560 },
      note: 'this one',
      capture,
      target,
    }
  }

  async function postPick(
    server: HarnessServer,
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(server.url + PICK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify(body),
    })
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    }
  }

  /** The one `user` frame's rendered content. */
  function renderedBody(session: FakeSession): string {
    const user = session.frames().find((frame) => frame.type === 'user')
    const message = user?.message as { content?: string } | undefined
    return message?.content ?? ''
  }

  async function until(predicate: () => boolean, what: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out waiting for ${what}`)
  }

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  describe('POST /__agent/capture', () => {
    it('answers a capture id and captures the element plus the margin', async () => {
      const { server, env } = await startCaptureServer()

      const { status, json } = await postCapture(server)
      expect(status).toBe(200)
      expect(json.captureId).toBeTruthy()

      const directory = captureDirectory(server)
      await until(() => filesIn(directory).length === 1, 'the capture to land')
      expect(filesIn(directory)[0]).toContain(json.captureId)

      // screenX + rect.x - margin, (screenY + chrome on top) + rect.y - margin,
      // and the element's own size with a margin on each side.
      const call = env.captureCalls().find((line) => line.includes(json.captureId))
      expect(call).toMatch(/(^| )-x( |$)/)
      expect(call).toContain(`-R ${50 + 100 - MARGIN},${60 + 80 + 200 - MARGIN},348,198`)
    })

    it('clamps the capture to the screen it was told about', async () => {
      const { server, env } = await startCaptureServer()

      const { json } = await postCapture(
        server,
        coordinates({
          rect: { x: 0, y: 0, width: 380, height: 100 },
          screenX: 0,
          screenY: 0,
          chromeHeight: 0,
          screen: { width: 400, height: 300 },
        }),
      )

      const directory = captureDirectory(server)
      await until(() => filesIn(directory).length === 1, 'the capture to land')

      // The margin would put it at -24 and 428 wide; neither is on the screen.
      const call = env.captureCalls().find((line) => line.includes(json.captureId))
      expect(call).toContain('-R 0,0,400,124')
    })

    it('refuses coordinates it cannot place on a screen, naming the part', async () => {
      const { server } = await startCaptureServer()

      const { status, json } = await postCapture(server, coordinates({ screen: null }))

      expect(status).toBe(400)
      expect(json.error).toBe('capture-coordinates-incomplete')
      expect(json.reason).toMatch(/screen/)
    })
  })

  describe('DELETE /__agent/capture/<id>', () => {
    it('kills a capture still running and leaves nothing behind', async () => {
      const { server, env } = await startCaptureServer()
      fakeBecomes('sleep', 30)

      const { json } = await postCapture(server)
      await until(() => env.capturePids().length === 2, 'the capture process to start')
      const capturePid = env.capturePids()[1] as number

      const deleted = await deleteCapture(server, json.captureId)
      expect(deleted.status).toBe(200)

      await until(() => !alive(capturePid), 'the capture process to be killed')
      expect(filesIn(captureDirectory(server))).toEqual([])
    })

    it('refuses an id this server never minted', async () => {
      const { server } = await startCaptureServer()

      const { status, json } = await deleteCapture(server, 'not-a-capture-of-ours')

      expect(status).toBe(404)
      expect(json.error).toBe('unknown-capture')
    })
  })

  describe('a Pick that carries a Screen Capture', () => {
    it('carries one line with the absolute path when the toggle is on', async () => {
      const { app, server, env } = await startCaptureServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_101 })

      const { json } = await postCapture(server)
      const sent = await postPick(
        server,
        pickBody(
          { id: json.captureId, keep: true },
          { sessionId: session.sessionId, pid: session.pid },
        ),
      )
      expect(sent.status).toBe(200)
      await session.awaitLines(2)

      const directory = captureDirectory(server)
      const path = join(directory, filesIn(directory)[0] as string)
      expect(path).toMatch(/\.png$/)

      const body = renderedBody(session)
      const capture = body.split('\n').filter((line) => line.includes('screen capture'))
      expect(capture).toHaveLength(1)
      expect(capture[0]).toContain(path)
      expect(body).not.toMatch(/may be offset/)
    })

    // The Overlay names this id when its toggle was on and it holds no capture to
    // name (ticket 18). Written out, like every string a test shares with `src/`.
    const NO_CAPTURE = 'none'

    it('says a capture was intended when the toggle was on and none was started', async () => {
      const { app, server, env } = await startCaptureServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_107 })

      const sent = await postPick(
        server,
        pickBody(
          { id: NO_CAPTURE, keep: true },
          { sessionId: session.sessionId, pid: session.pid },
        ),
      )
      expect(sent.status).toBe(200)
      await session.awaitLines(2)

      const line = renderedBody(session)
        .split('\n')
        .filter((text) => text.includes('screen capture'))
      expect(line).toHaveLength(1)
      expect(line[0]).toContain('a capture was intended, and failed')
      expect(line[0]).toContain('none was started')
    })

    it('says why when the toggle was on and this server cannot capture', async () => {
      const { app, server, env } = await startCaptureServer({
        POINTOUT_PLATFORM: 'linux',
      })
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_108 })

      await postPick(
        server,
        pickBody(
          { id: NO_CAPTURE, keep: true },
          { sessionId: session.sessionId, pid: session.pid },
        ),
      )
      await session.awaitLines(2)

      const body = renderedBody(session)
      expect(body).toMatch(/screen capture\s+a capture was intended, and failed: .*macOS/)
    })

    it('carries no line, and deletes the file, when the toggle is off', async () => {
      const { app, server, env } = await startCaptureServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_102 })

      const { json } = await postCapture(server)
      await postPick(
        server,
        pickBody(
          { id: json.captureId, keep: false },
          { sessionId: session.sessionId, pid: session.pid },
        ),
      )
      await session.awaitLines(2)

      expect(renderedBody(session)).not.toMatch(/screen capture/)
      expect(filesIn(captureDirectory(server))).toEqual([])
    })

    it('says it may be offset when the window is wider than its viewport', async () => {
      const { app, server, env } = await startCaptureServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_103 })

      const { json } = await postCapture(server, coordinates({ chromeWidth: 220 }))
      await postPick(
        server,
        pickBody(
          { id: json.captureId, keep: true },
          { sessionId: session.sessionId, pid: session.pid },
        ),
      )
      await session.awaitLines(2)

      const body = renderedBody(session)
      expect(body).toMatch(/may be offset/)
      expect(body).toContain('220')
    })

    it('still sends, saying a capture was intended and why it failed', async () => {
      const { app, server, env } = await startCaptureServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_104 })
      fakeBecomes('fail')

      const { json } = await postCapture(server)
      const sent = await postPick(
        server,
        pickBody(
          { id: json.captureId, keep: true },
          { sessionId: session.sessionId, pid: session.pid },
        ),
      )
      expect(sent.status).toBe(200)
      await session.awaitLines(2)

      const body = renderedBody(session)
      expect(body).toMatch(/screen capture/)
      expect(body).toMatch(/intended/)
      expect(body).toMatch(/failed/)
      expect(filesIn(captureDirectory(server))).toEqual([])
    })

    // A refusal is the developer's to fix and send again, and the capture the page
    // still holds is part of what they send again (spec §21: a refused Pick has
    // had nothing done to it). Before ticket 19 the capture was resolved before
    // the cap was checked, so the resend was told it held no capture.
    it('keeps the capture for the resend when the Pick is refused as too large', async () => {
      const { app, server, env } = await startCaptureServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_109 })
      const target = { sessionId: session.sessionId, pid: session.pid }

      const { json } = await postCapture(server)
      const directory = captureDirectory(server)
      await until(() => filesIn(directory).length === 1, 'the capture to land')

      const tooLarge = await postPick(server, {
        ...pickBody({ id: json.captureId, keep: true }, target),
        url: `http://localhost:5173/${'u'.repeat(40_000)}`,
      })
      expect(tooLarge.status).toBe(413)
      expect(filesIn(directory)).toHaveLength(1)

      const resent = await postPick(
        server,
        pickBody({ id: json.captureId, keep: true }, target),
      )
      expect(resent.status).toBe(200)
      await session.awaitLines(2)

      const body = renderedBody(session)
      expect(body).not.toMatch(/holds no capture/)
      expect(body).toContain(join(directory, filesIn(directory)[0] as string))
    })

    it('leaves the file to the resend when a Pick with the toggle off is refused', async () => {
      const { app, server, env } = await startCaptureServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_110 })
      const target = { sessionId: session.sessionId, pid: session.pid }

      const { json } = await postCapture(server)
      const directory = captureDirectory(server)
      await until(() => filesIn(directory).length === 1, 'the capture to land')

      const tooLarge = await postPick(server, {
        ...pickBody({ id: json.captureId, keep: false }, target),
        url: `http://localhost:5173/${'u'.repeat(40_000)}`,
      })
      expect(tooLarge.status).toBe(413)
      expect(filesIn(directory)).toHaveLength(1)

      // The page can still let go of it, which it could not if it were gone.
      expect((await deleteCapture(server, json.captureId)).status).toBe(200)
      await until(() => filesIn(directory).length === 0, 'the capture to be deleted')
    })

    it('gives up on a capture that hangs, and says that in the payload', async () => {
      const { app, server, env } = await startCaptureServer()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_105 })
      fakeBecomes('sleep', 60)

      const { json } = await postCapture(server)
      await postPick(
        server,
        pickBody(
          { id: json.captureId, keep: true },
          { sessionId: session.sessionId, pid: session.pid },
        ),
      )
      await session.awaitLines(2)

      const body = renderedBody(session)
      expect(body).toMatch(/intended/)
      expect(body).toMatch(/too long|timed out/)
    })
  })

  describe('the startup probe', () => {
    it('disables capture when the tool writes an empty file, and says why', async () => {
      const { server } = await startCaptureServer({ [MODE]: 'empty' })

      const log = server.log()
      expect(log).toMatch(/screen capture\s+disabled/)
      expect(log).toMatch(/Screen Recording/)

      const { status, json } = await postCapture(server)
      expect(status).toBe(409)
      expect(json.error).toBe('capture-disabled')
      expect(json.reason).toMatch(/Screen Recording/)
    })

    it('disables capture off macOS, with the platform named', async () => {
      const { server } = await startCaptureServer({
        POINTOUT_PLATFORM: 'linux',
      })

      const log = server.log()
      expect(log).toMatch(/screen capture\s+disabled/)
      expect(log).toMatch(/macOS/)
      expect(log).toContain('linux')

      const { status, json } = await postCapture(server)
      expect(status).toBe(409)
      expect(json.reason).toMatch(/macOS/)
    })

    it('refuses off macOS with exactly the answer the Overlay is written against', async () => {
      // `test/browser/capture.spec.ts` answers the Overlay's capture request with
      // this body, because the browser suite's one dev server can capture. This is where that
      // body is held to what a real one sends (ticket 18).
      const { server } = await startCaptureServer({
        POINTOUT_PLATFORM: 'linux',
      })

      const { status, json } = await postCapture(server)
      expect(status).toBe(409)
      expect(json).toEqual({
        error: 'capture-disabled',
        reason:
          "this dev server is not running on macOS (platform: linux), and v0 takes a Screen Capture with macOS's own screencapture tool",
      })
    })

    it('takes no capture at all once it is disabled', async () => {
      const { server, env } = await startCaptureServer({
        POINTOUT_PLATFORM: 'linux',
      })

      await postCapture(server)

      expect(env.captureCalls()).toEqual([])
    })
  })

  describe('the capture directory', () => {
    it('is swept clean of what earlier dev servers left behind', async () => {
      const dead = spawnSync('true').pid as number
      const leftovers = [join(CAPTURE_ROOT, `${dead}-abcdef`), CAPTURE_ROOT]
      mkdirSync(leftovers[0] as string, { recursive: true })
      for (const directory of leftovers) {
        writeFileSync(join(directory, 'stale-capture.png'), 'not really a png')
      }

      try {
        const { server } = await startCaptureServer()

        expect(existsSync(leftovers[0] as string)).toBe(false)
        expect(existsSync(join(CAPTURE_ROOT, 'stale-capture.png'))).toBe(false)
        expect(server.log()).toMatch(/swept/)
      } finally {
        rmSync(leftovers[0] as string, { recursive: true, force: true })
        rmSync(join(CAPTURE_ROOT, 'stale-capture.png'), { force: true })
      }
    })

    it('takes its captures with it when the dev server shuts down', async () => {
      const { server } = await startCaptureServer()
      const directory = captureDirectory(server)

      await postCapture(server)
      await until(() => filesIn(directory).length === 1, 'the capture to land')

      await server.close()

      expect(existsSync(directory)).toBe(false)
    })
  })
})
