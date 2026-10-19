import { afterEach, describe, expect, it } from 'vitest'
import { createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import type { HarnessServer } from '../harness/dev-server.js'
import { fakeSessions } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'

// Spec §21, "at the point of refusal: every 4xx reason … logged". One journey
// per kind of refusal the HTTP surface makes, each checked for its own reason
// in the dev server's log, word for word — not for a word the posture block
// happens to contain as well (ticket 19's audit). The Overlay half, the reason
// shown inline, is seam 2's.
//
// Every path, field and header is written out, as everywhere in seam 1.

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

  async function start(): Promise<{
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

  interface Asked {
    method: string
    path: string
    body?: unknown
    /** Defaults to this server's own origin. `null` sends none. */
    origin?: string | null
  }

  async function ask(
    server: HarnessServer,
    { method, path, body, origin }: Asked,
  ): Promise<{ status: number; error: string; reason: string }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (origin !== null) headers.origin = origin ?? server.url
    const response = await fetch(server.url + path, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
    const json = (await response.json()) as { error: string; reason: string }
    return { status: response.status, ...json }
  }

  /** The Pointer inputs ingest requires; a test changes one to be refused on it. */
  const pickBody = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    url: 'http://localhost:5173/settings',
    viewport: { width: 1280, height: 800 },
    descriptor: { tag: 'button' },
    geometry: { width: 120, height: 40, x: 24, y: 560 },
    note: 'this one',
    ...overrides,
  })

  describe('every refusal is logged with its reason', () => {
    it('logs each kind of 4xx the HTTP surface answers, in its own words', async () => {
      const { app, server, env } = await start()
      const session = await sessions.open(env, { cwd: app.checkout, pid: 500_301 })
      const target = { sessionId: session.sessionId, pid: session.pid }

      const refusals: Array<[string, Asked]> = [
        ['an unknown endpoint', { method: 'GET', path: '/__agent/nope' }],
        ['the wrong method', { method: 'GET', path: '/__agent/pick' }],
        [
          'a foreign Origin',
          {
            method: 'POST',
            path: '/__agent/pick',
            body: pickBody(),
            origin: 'http://evil.example',
          },
        ],
        [
          'no Origin on ingress',
          { method: 'POST', path: '/__agent/pick', body: pickBody(), origin: null },
        ],
        [
          'a body that is not JSON',
          { method: 'POST', path: '/__agent/pick', body: '{not json' },
        ],
        [
          'a Pick missing a part',
          { method: 'POST', path: '/__agent/pick', body: pickBody({ url: undefined }) },
        ],
        [
          'a Target that is not a Candidate',
          {
            method: 'POST',
            path: '/__agent/pick',
            body: pickBody({ target: { sessionId: 'gone', pid: 999_999 } }),
          },
        ],
        [
          'a Pick over the payload cap',
          {
            method: 'POST',
            path: '/__agent/pick',
            body: pickBody({
              url: `http://localhost:5173/${'u'.repeat(40_000)}`,
              target,
            }),
          },
        ],
        [
          'capture coordinates it cannot place',
          { method: 'POST', path: '/__agent/capture', body: { rect: null } },
        ],
        [
          'a capture it does not hold',
          { method: 'DELETE', path: '/__agent/capture/not-ours' },
        ],
        [
          'an ack for a Pick it never accepted',
          { method: 'POST', path: '/__agent/pick/not-ours/ack?nonce=x', origin: null },
        ],
        [
          'a report for a Pick it never accepted',
          {
            method: 'POST',
            path: '/__agent/pick/not-ours/report',
            body: { resolve: 'requeue' },
          },
        ],
        [
          'a drain with the wrong secret',
          {
            method: 'POST',
            path: '/__agent/drain',
            body: {
              cwd: app.checkout,
              secret: 'f'.repeat(48),
              event: 'UserPromptSubmit',
            },
            origin: null,
          },
        ],
      ]

      const answered: Array<{ what: string; status: number; reason: string }> = []
      for (const [what, asked] of refusals) {
        const { status, reason } = await ask(server, asked)
        answered.push({ what, status, reason })
      }

      // Each one a 4xx with a reason, and that reason in the log word for word.
      const unsaid = answered.filter(
        ({ status, reason }) =>
          status < 400 || status >= 500 || !reason || !server.log().includes(reason),
      )
      expect(unsaid).toEqual([])
      // The table reaches every 4xx this surface uses.
      const statuses = [...new Set(answered.map(({ status }) => status))]
      expect(statuses.toSorted()).toEqual([400, 403, 404, 405, 409, 413])
      // None of it reached the session.
      expect(session.frames()).toEqual([])
    })
  })
})
