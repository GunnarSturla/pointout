import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { fakeSessions } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'

// The server half of §14's re-resolve at Send: a Target named in the body is
// re-checked, and a Target that has left is reported with the replacement the
// chain now yields — never silently exchanged for it (`GLOSSARY.md`, spec §21).
//
// Every string here is written out rather than imported: the endpoint path, the
// refusal's field names and the registry's file naming are the contract
// (docs/agents/testing.md). Nothing imports a server module.

const PICK = '/__agent/pick'

/** What a refusal carries. `replacement` rides along on the 409 and only there. */
interface Refused {
  error: string
  reason: string
  replacement?: { sessionId: string; pid: number; name: string }
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

  async function startPickServer(
    options: { claudePid?: number } = {},
  ): Promise<{ checkout: string; server: HarnessServer; env: FixtureEnv }> {
    const env = createFixtureEnv({ claudePid: options.claudePid ?? 0 })
    fixture = env
    const app = apps.create({ git: true })
    const server = await apps.serve(app, { env: env.env })
    return { checkout: app.checkout, server, env }
  }

  /** The Pointer inputs, as the Overlay sends them. */
  function pointerBody(target: { sessionId: string; pid: number } | null): unknown {
    return {
      url: 'http://localhost:5173/settings',
      viewport: { width: 1280, height: 800 },
      descriptor: { tag: 'button', id: 'save' },
      geometry: { width: 120, height: 40, x: 24, y: 560 },
      note: 'about this button',
      target,
    }
  }

  async function postPick(
    server: HarnessServer,
    body: unknown,
    origin = server.url,
  ): Promise<{ status: number; json: Refused & { pickId?: string } }> {
    const response = await fetch(server.url + PICK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() }
  }

  /** A session leaves the registry the way a session that exits leaves it. */
  function leaveRegistry(env: FixtureEnv, pid: number): void {
    rmSync(join(env.registryDir, `${pid}.json`))
  }

  describe('a named Target that has left, re-resolved at Send', () => {
    it('answers 409 naming the replacement the chain now yields', async () => {
      const { checkout, server, env } = await startPickServer({ claudePid: 500_101 })
      const started = await sessions.open(env, {
        cwd: checkout,
        pid: 500_101,
        name: 'the one that started this dev server',
      })
      const named = await sessions.open(env, {
        cwd: checkout,
        pid: 500_102,
        name: 'the one that was chosen',
      })

      leaveRegistry(env, named.pid)
      const { status, json } = await postPick(
        server,
        pointerBody({ sessionId: named.sessionId, pid: named.pid }),
      )

      expect(status).toBe(409)
      expect(json.replacement).toEqual({
        sessionId: started.sessionId,
        pid: started.pid,
        name: 'the one that started this dev server',
      })
      expect(json.reason).toContain('the one that started this dev server')

      // The heart of it: the replacement is named, not written to.
      expect(started.lines()).toHaveLength(0)
      expect(named.lines()).toHaveLength(0)
    })

    it('sends to the replacement once the Pick names it', async () => {
      const { checkout, server, env } = await startPickServer({ claudePid: 500_103 })
      const started = await sessions.open(env, {
        cwd: checkout,
        pid: 500_103,
        name: 'the replacement',
      })
      const named = await sessions.open(env, { cwd: checkout, pid: 500_104 })

      leaveRegistry(env, named.pid)
      const refused = await postPick(
        server,
        pointerBody({ sessionId: named.sessionId, pid: named.pid }),
      )
      const replacement = refused.json.replacement

      const { status } = await postPick(
        server,
        pointerBody({
          sessionId: replacement?.sessionId ?? '',
          pid: replacement?.pid ?? 0,
        }),
      )

      expect(status).toBe(200)
      const frames = await started.awaitLines(3)
      expect(frames).toHaveLength(3)
    })

    it('refuses without a replacement when the chain now yields nothing', async () => {
      const { checkout, server, env } = await startPickServer()
      const named = await sessions.open(env, { cwd: checkout, pid: 500_105 })

      leaveRegistry(env, named.pid)
      const { status, json } = await postPick(
        server,
        pointerBody({ sessionId: named.sessionId, pid: named.pid }),
      )

      expect(status).toBe(400)
      expect(json.replacement).toBeUndefined()
      expect(json.reason).toMatch(/no longer a session running in this checkout/)
      expect(named.lines()).toHaveLength(0)
    })

    it('is refused at the Origin check before any replacement is named', async () => {
      const { checkout, server, env } = await startPickServer({ claudePid: 500_106 })
      await sessions.open(env, { cwd: checkout, pid: 500_106, name: 'the replacement' })
      const named = await sessions.open(env, { cwd: checkout, pid: 500_107 })

      leaveRegistry(env, named.pid)
      const { status, json } = await postPick(
        server,
        pointerBody({ sessionId: named.sessionId, pid: named.pid }),
        'http://not-this-dev-server.example',
      )

      expect(status).toBe(403)
      expect(json.error).toBe('origin-mismatch')
      expect(json.replacement).toBeUndefined()
    })
  })
})
