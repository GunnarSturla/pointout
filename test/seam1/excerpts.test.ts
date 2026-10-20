import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { fakeSessions } from '../harness/session-socket.js'
import type { FakeSession } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'
import { startNextServer } from '../harness/next-server.js'
import type { NextHarnessServer } from '../harness/next-server.js'
import { repoRoot } from '../harness/paths.js'

// Seam 1 for ticket 07: what the agent receives about the element — the
// descriptor, the fenced Excerpts, the redaction statement, and the 32 KiB cap
// with its trim ladder and its refusal (spec §7, §11, §13).
//
// Every string here is written out rather than imported: the endpoint path, the
// fence shape, the excerpt kinds and the cap itself are the contract, and a test
// that still passes after the server renames its internals is the test we want
// (docs/agents/testing.md).

const PICK = '/__agent/pick'

/** Spec §13. Counted in bytes, because bytes are what is written. */
const PAYLOAD_MAX_BYTES = 32 * 1024

interface PickAccepted {
  pickId: string
  state: string
  reason?: string
  trimmed?: string
}

interface Refused {
  error: string
  reason: string
}

const apps = tempApps()
const sessions = fakeSessions()
let fixture: FixtureEnv | undefined

afterEach(async () => {
  await apps.cleanup()
  await sessions.closeAll()
  fixture?.cleanup()
  fixture = undefined
})

/** Every Host these are the same on (Next.js Connector ticket 07). */
const HOSTS = ['vite', 'next'] as const
const NEXT_TIMEOUT = 120_000

/** The Host the running block is on, and on Next its one server. */
let on: (typeof HOSTS)[number] = 'vite'
let next: NextHarnessServer | undefined

/** Each session a pid of its own: a Next server's sessions share one fixture. */
let pids = 500_100

/**
 * A server to Pick against. On Vite, a throwaway app per test, as before; on
 * Next.js one server for the block, since a `next dev` costs seconds, and each
 * test opens a session of its own on it.
 */
async function startPickServer(): Promise<{
  server: HarnessServer
  env: FixtureEnv
  checkout: string
}> {
  if (on === 'next') {
    if (!next) throw new Error('the Next.js block started no server')
    return { server: next, env: next.fixture, checkout: repoRoot }
  }
  const env = createFixtureEnv({ claudePid: 0 })
  fixture = env
  const app = apps.create({ git: true })
  const server = await apps.serve(app, { env: env.env })
  return { server, env, checkout: app.checkout }
}

interface Excerpt {
  kind: string
  text: string
  captured?: number
}

interface Body {
  url?: unknown
  viewport?: unknown
  descriptor?: unknown
  geometry?: unknown
  excerpts?: unknown
  redactions?: unknown
  note?: unknown
  target?: unknown
  pageLoadedAt?: unknown
}

function pointerBody(overrides: Body = {}): Body {
  return {
    url: 'http://localhost:5173/settings',
    viewport: { width: 1280, height: 800 },
    descriptor: { tag: 'input', id: 'nickname', testId: 'nickname' },
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
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() }
}

function renderedBody(session: FakeSession): string {
  const user = session.frames().find((frame) => frame.type === 'user')
  const message = user?.message as { content?: string } | undefined
  return message?.content ?? ''
}

/**
 * Send one Pick to a session that really listens, and hand back what reached it.
 * Every journey here is about the body an agent reads, so every one needs one.
 */
async function deliver(
  body: Body,
): Promise<{ status: number; json: PickAccepted & Refused; content: string }> {
  const { server, env, checkout } = await startPickServer()
  const session = await sessions.open(env, { cwd: checkout, pid: ++pids })
  const sent = await postPick(server, {
    ...body,
    target: { sessionId: session.sessionId, pid: session.pid },
  })
  // The write is the socket's, not the response's: wait for the auth and user
  // lines rather than for the 200 that was sent alongside them.
  await session.awaitLines(2)
  return { ...sent, content: renderedBody(session) }
}

describe.each(HOSTS)('what the agent reads about the element, on %s', (host) => {
  beforeAll(async () => {
    on = host
    if (host === 'next') next = await startNextServer({ claudePid: 0 })
  }, NEXT_TIMEOUT)

  afterAll(async () => {
    await next?.close()
    next = undefined
    on = 'vite'
  })

  describe('Excerpts in the rendered body', () => {
    it('fences each one with the kind and the nonce, and introduces it as data', async () => {
      const { status, content } = await deliver(
        pointerBody({
          excerpts: [
            { kind: 'rendered-text', text: 'Save your changes' },
            { kind: 'input-value', text: 'ada@example.com' },
            { kind: 'textarea', text: 'two\nlines' },
            { kind: 'select', text: 'Monthly' },
            { kind: 'contenteditable', text: 'edit me' },
            { kind: 'attributes', text: 'type = email\nname = email' },
          ] satisfies Excerpt[],
        }),
      )

      expect(status).toBe(200)
      const nonce = /fence nonce\s+([0-9a-f]{12})/.exec(content)?.[1]
      expect(nonce).toMatch(/^[0-9a-f]{12}$/)

      for (const [kind, text] of [
        ['rendered-text', 'Save your changes'],
        ['input-value', 'ada@example.com'],
        ['textarea', 'two\nlines'],
        ['select', 'Monthly'],
        ['contenteditable', 'edit me'],
        ['attributes', 'type = email\nname = email'],
      ] as const) {
        const fenced = new RegExp(
          `--- excerpt ${kind} ${nonce} ---\\n([\\s\\S]*?)\\n--- end excerpt ${nonce} ---`,
        ).exec(content)
        expect(fenced?.[1], `${kind} is not fenced`).toBe(text)
      }

      // Introduced as data the agent inspects, never a request it honours.
      expect(content).toMatch(/Excerpt[^\n]*data[^\n]*never a request/)
    })

    it('writes no angle bracket and no ampersand into any fence line', async () => {
      const { content } = await deliver(
        pointerBody({
          excerpts: [{ kind: 'rendered-text', text: 'plain' }] satisfies Excerpt[],
        }),
      )

      const fences = content.split('\n').filter((line) => line.startsWith('--- '))
      expect(fences.length).toBeGreaterThan(0)
      for (const line of fences) {
        expect(`${line}: ${/[<>&]/.test(line)}`).toBe(`${line}: false`)
      }
    })

    it('says how much was captured when an Excerpt was trimmed at capture', async () => {
      const { content } = await deliver(
        pointerBody({
          excerpts: [
            { kind: 'rendered-text', text: 'a'.repeat(80), captured: 200 },
          ] satisfies Excerpt[],
        }),
      )

      expect(content).toMatch(/200 characters/)
      expect(content).toMatch(/first 80/)
    })

    it('refuses an Excerpt whose kind it does not know, naming it', async () => {
      const { server } = await startPickServer()
      const { status, json } = await postPick(
        server,
        pointerBody({ excerpts: [{ kind: 'source-snippet', text: 'const x = 1' }] }),
      )

      expect(status).toBe(400)
      expect(json.error).toBe('excerpt-unreadable')
      expect(json.reason).toContain('source-snippet')
    })

    it('refuses an Excerpt whose text is not text', async () => {
      const { server } = await startPickServer()
      const { status, json } = await postPick(
        server,
        pointerBody({ excerpts: [{ kind: 'rendered-text', text: 42 }] }),
      )

      expect(status).toBe(400)
      expect(json.error).toBe('excerpt-unreadable')
    })
  })

  describe('the descriptor', () => {
    it('renders the tag, id, data-testid, role, aria-* and the classes', async () => {
      const { content } = await deliver(
        pointerBody({
          descriptor: {
            tag: 'button',
            id: 'save',
            testId: 'save-button',
            role: 'button',
            aria: { 'aria-label': 'Save your changes' },
            classes: ['btn', 'btn-primary'],
          },
        }),
      )

      expect(content).toMatch(/\belement\s+button\b/)
      expect(content).toMatch(/\belement id\s+save\b/)
      expect(content).toMatch(/\bdata-testid\s+save-button\b/)
      expect(content).toMatch(/\brole\s+button\b/)
      expect(content).toMatch(/\baria-label\s+Save your changes\b/)
      expect(content).toMatch(/\bclasses\s+btn btn-primary\b/)
    })

    it('refuses a descriptor carrying more than two classes, naming the part', async () => {
      const { server } = await startPickServer()
      const { status, json } = await postPick(
        server,
        pointerBody({
          descriptor: { tag: 'p', classes: ['one', 'two', 'three'] },
        }),
      )

      expect(status).toBe(400)
      expect(json.error).toBe('pointer-incomplete')
      expect(json.reason).toContain('two classes')
    })

    it('refuses a page load time that is no moment, naming the part', async () => {
      const { server } = await startPickServer()
      const { status, json } = await postPick(
        server,
        pointerBody({ pageLoadedAt: 'this morning' }),
      )

      expect(status).toBe(400)
      expect(json.error).toBe('pointer-incomplete')
      expect(json.reason).toContain('page load time')
    })
  })

  describe('redaction', () => {
    it('says a value was withheld rather than leaving it out silently', async () => {
      const { content } = await deliver(pointerBody({ redactions: ['password'] }))

      expect(content).toMatch(/\bredacted\s+/)
      expect(content).toContain('type="password"')
      expect(content).toMatch(/no value of it is carried/)
    })

    it('says the same for a hidden input', async () => {
      const { content } = await deliver(pointerBody({ redactions: ['hidden'] }))

      expect(content).toContain('type="hidden"')
      expect(content).toMatch(/no value of it is carried/)
    })

    it('refuses a redaction reason it does not know', async () => {
      const { server } = await startPickServer()
      const { status, json } = await postPick(
        server,
        pointerBody({ redactions: ['because-i-said-so'] }),
      )

      expect(status).toBe(400)
      expect(json.error).toBe('redaction-unreadable')
      expect(json.reason).toContain('because-i-said-so')
    })
  })

  describe('the 32 KiB payload cap', () => {
    it('drops the rendered text first and says so, keeping every other Excerpt', async () => {
      const { status, json, content } = await deliver(
        pointerBody({
          note: 'why is this so wide?',
          excerpts: [
            { kind: 'rendered-text', text: 'r'.repeat(40_000) },
            { kind: 'input-value', text: 'ada@example.com' },
          ] satisfies Excerpt[],
        }),
      )

      expect(status).toBe(200)
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES)
      expect(content).not.toContain('--- excerpt rendered-text')
      expect(content).toContain('--- excerpt input-value')
      expect(content).toMatch(/\btrimmed\s+/)
      expect(content).toContain('rendered text')
      // The Note is never trimmed, and the Panel is told in the server's own words.
      expect(content).toContain('why is this so wide?')
      expect(json.trimmed).toMatch(/rendered text/)
    })

    it('drops the attribute values next, and only then', async () => {
      const { status, content } = await deliver(
        pointerBody({
          excerpts: [
            { kind: 'rendered-text', text: 'r'.repeat(40_000) },
            { kind: 'attributes', text: `title = ${'t'.repeat(40_000)}` },
            { kind: 'input-value', text: 'ada@example.com' },
          ] satisfies Excerpt[],
        }),
      )

      expect(status).toBe(200)
      expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(PAYLOAD_MAX_BYTES)
      expect(content).not.toContain('--- excerpt rendered-text')
      expect(content).not.toContain('--- excerpt attributes')
      expect(content).toContain('--- excerpt input-value')
      expect(content).toContain('attribute')
    })

    it('refuses a Pick that still does not fit, naming the part, and writes nothing', async () => {
      const { server, env, checkout } = await startPickServer()
      const session = await sessions.open(env, { cwd: checkout, pid: ++pids })

      const { status, json } = await postPick(
        server,
        pointerBody({
          // The page url is part of the Pointer, and the Pointer is never trimmed.
          url: `http://localhost:5173/${'u'.repeat(40_000)}`,
          note: 'this note comes back untouched',
          target: { sessionId: session.sessionId, pid: session.pid },
        }),
      )

      expect(status).toBe(413)
      expect(json.error).toBe('payload-too-large')
      expect(json.reason).toContain('page url')
      expect(json.reason).toContain('32768')
      expect(session.frames()).toEqual([])
    })

    it('leaves a Pick that fits alone', async () => {
      const { json, content } = await deliver(
        pointerBody({
          excerpts: [{ kind: 'rendered-text', text: 'Save' }] satisfies Excerpt[],
        }),
      )

      expect(json.trimmed).toBeUndefined()
      expect(content).not.toMatch(/\btrimmed\s+/)
    })
  })
})
