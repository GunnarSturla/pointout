import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { startNextServer } from '../harness/next-server.js'
import type { NextHarnessServer } from '../harness/next-server.js'
import { repoRoot } from '../harness/paths.js'
import { fakeSessions } from '../harness/session-socket.js'
import type { FakeSession } from '../harness/session-socket.js'

// Next.js Connector ticket 04: `withPointout()` serves the Guard's endpoints on
// Next's own server (ADR-0006). Read the way every seam-1 test reads a server:
// over HTTP, off its log, at a fake session's socket, and off the disk. The
// guard suite runs against both Hosts in guard.test.ts; this file holds what
// only Next has, and the posture, ingest and status journeys on it.
//
// Every string is written out, not imported (docs/agents/testing.md).

const STATUS = '/__agent/status'
const PICK = '/__agent/pick'
const BLOCK_HEADING = 'pointout — startup posture'
const NEXT_TIMEOUT = 120_000

/** Test-only: the harness version the canaries last passed against. */
const VERIFIED_HARNESS_ENV = 'POINTOUT_VERIFIED_HARNESS'
/**
 * Loaded into Next's dev worker through `NODE_OPTIONS`, before the config is
 * read: it makes the listening server's `emit` one that nobody can replace,
 * so pointout's reach into Next's server (ADR-0006) does not take, as it would
 * not on a Next that stopped reading its config after `listen`. Only the
 * worker, which `NEXT_PRIVATE_WORKER` marks, and only an HTTP server.
 */
const UNREACHABLE_SERVER_PRELOAD = `import { Server } from 'node:http'
const listen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  if (process.env.NEXT_PRIVATE_WORKER === '1') {
    const emit = this.emit
    Object.defineProperty(this, 'emit', { configurable: true, get: () => emit, set: () => {} })
  }
  return listen.apply(this, args)
}
`

/** Where every dev server on this machine publishes its discovery entry (spec §18). */
const DISCOVERY_DIR = join(tmpdir(), `pointout-servers-${userInfo().uid}`)
const CAPTURE_ROOT = join(tmpdir(), 'pointout-captures')

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

/** The block alone: from its heading to the blank line it ends with. */
function blockOf(log: string): string {
  const start = log.lastIndexOf(BLOCK_HEADING)
  if (start === -1) throw new Error(`no posture block in:\n${log}`)
  const rest = log.slice(start)
  const end = rest.indexOf('\n\n')
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\n+$/, '')
}

/** The block with what differs from run to run in angle brackets. */
function normalised(server: NextHarnessServer): string {
  return blockOf(server.log())
    .split(server.fixture.dir)
    .join('<fixture>')
    .split(repoRoot.replace(/\/$/, ''))
    .join('<repo>')
    .split(CAPTURE_ROOT)
    .join('<captures>')
    .split(DISCOVERY_DIR)
    .join('<servers>')
    .split(String(server.port))
    .join('<port>')
    .replace(/\/\d+\.sock\b/g, '/<pid>.sock')
    .replace(/\/\d+-[0-9a-f]{6}\b/g, '/<pid>-<hex>')
    .replace(/\/[0-9a-f]{16}-\d+-[0-9a-f]{6}\.json/g, '/<hash>-<pid>-<hex>.json')
    .replace(/[,;] \d+ left by dead dev servers swept/g, '')
}

const block = (...lines: string[]) => [BLOCK_HEADING, ...lines].join('\n')

const ROOT = '  root             <repo> (git rev-parse --show-toplevel)'
const GUARD =
  '  guard            loopback only; Origin required on Pick ingress, and absent means refused'
const REGISTRY_NONE = '  registry         readable — 0 sessions in this checkout'
const NO_VERSION =
  '  harness version  no readable registry entry reports a version; the canaries ' +
  'last passed against 2.1.280 (2026-09-01)'
const REPLY = '  reply socket     bound at <fixture>/sockets/<pid>.sock'
const CAPTURE = '  screen capture   available'
const TEMP =
  '  temp directory   <captures>/<pid>-<hex> (user-only; removed at shutdown, and ' +
  'what dead dev servers left beside it is swept at startup)'
const DISCOVERY =
  '  discovery entry  <servers>/<hash>-<pid>-<hex>.json (user-only; removed at shutdown)'
const SELF_CHECK =
  '  self-check       pointout answered GET http://127.0.0.1:<port>/__agent/status'

/** The level the block was printed at: stderr is `warn`, stdout `info`. */
function levelOf(server: NextHarnessServer): string {
  const entry = server.logEntries().find(({ message }) => message.includes(BLOCK_HEADING))
  if (!entry) throw new Error('no posture block was printed')
  return entry.level
}

/** The discovery entries on this machine whose pid is one of `pids`. */
function discoveryEntriesOf(pids: number[]): Array<{ pid: number; port: number }> {
  let names: string[]
  try {
    names = readdirSync(DISCOVERY_DIR)
  } catch {
    return []
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(DISCOVERY_DIR, name), 'utf8'))]
      } catch {
        // Removed between the listing and the read.
        return []
      }
    })
    .filter((entry: { pid: number }) => pids.includes(entry.pid))
}

/** The worker's pid, read off the reply socket the posture block names. */
function workerPid(server: NextHarnessServer): number {
  const found = /reply socket\s+bound at \S+\/(\d+)\.sock/.exec(blockOf(server.log()))
  if (!found?.[1]) throw new Error(`no reply socket in:\n${server.log()}`)
  return Number(found[1])
}

describe('withPointout() under next dev, with Turbopack', () => {
  let server!: NextHarnessServer

  beforeAll(async () => {
    server = await startNextServer({
      env: { [VERIFIED_HARNESS_ENV]: '2.1.280@2026-09-01' },
    })
  }, NEXT_TIMEOUT)

  afterAll(async () => {
    await server?.close()
  })

  it('answers GET /__agent/status on Next’s own origin', async () => {
    const response = await fetch(server.url + STATUS)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    expect(await response.json()).toEqual({ picks: [] })
  })

  it('prints the posture block once, as on Vite, ending in its self-check', () => {
    expect(occurrences(server.log(), BLOCK_HEADING)).toBe(1)
    expect(normalised(server)).toBe(
      block(
        ROOT,
        GUARD,
        REGISTRY_NONE,
        NO_VERSION,
        REPLY,
        CAPTURE,
        TEMP,
        DISCOVERY,
        SELF_CHECK,
      ),
    )
    expect(levelOf(server)).toBe('info')
  })

  it('publishes a discovery entry naming the port Next is bound to', () => {
    const entries = discoveryEntriesOf([workerPid(server)])

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ host: '127.0.0.1', port: server.port })
  })

  it('leaves a path that merely begins like pointout’s to Next', async () => {
    const response = await fetch(server.url + '/__agentx')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toMatch(/text\/html/)
  }, 60_000)

  it('answers an unknown /__agent path itself, with a reason', async () => {
    const response = await fetch(server.url + '/__agent/nope')

    expect(response.status).toBe(404)
    expect(typeof (await response.json()).reason).toBe('string')
  })
})

describe('the posture block on Next, degraded', () => {
  let server: NextHarnessServer | undefined
  const cleanups: Array<() => void> = []
  afterEach(async () => {
    await server?.close()
    server = undefined
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it(
    'says loudly when pointout did not answer its own self-check',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pointout-unreachable-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const preload = join(dir, 'preload.mjs')
      writeFileSync(preload, UNREACHABLE_SERVER_PRELOAD)
      server = await startNextServer({
        env: {
          [VERIFIED_HARNESS_ENV]: '2.1.280@2026-09-01',
          NODE_OPTIONS: `--import ${preload}`,
        },
      })

      expect(normalised(server)).toBe(
        block(
          ROOT,
          GUARD,
          REGISTRY_NONE,
          NO_VERSION,
          REPLY,
          CAPTURE,
          TEMP,
          DISCOVERY,
          '  self-check       pointout did not answer GET ' +
            'http://127.0.0.1:<port>/__agent/status (Next answered 404) — the Overlay ' +
            'cannot reach this server, and no Pick will',
        ),
      )
      expect(levelOf(server)).toBe('warn')
    },
    NEXT_TIMEOUT,
  )

  it(
    'warns that LAN Picks will be refused when Next is bound beyond loopback',
    async () => {
      // Next's own default is every interface.
      server = await startNextServer({
        host: '::',
        env: { [VERIFIED_HARNESS_ENV]: '2.1.280@2026-09-01' },
      })

      expect(normalised(server)).toBe(
        block(
          ROOT,
          GUARD,
          REGISTRY_NONE,
          NO_VERSION,
          REPLY,
          CAPTURE,
          TEMP,
          DISCOVERY,
          '  self-check       pointout answered GET http://[::1]:<port>/__agent/status',
          '  host             Next.js is bound to :: — Picks arriving from the LAN will be ' +
            'refused',
        ),
      )
      expect(levelOf(server)).toBe('warn')
    },
    NEXT_TIMEOUT,
  )
})

/** The Pointer inputs the Overlay sends. */
function pointerBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'http://localhost:3000/',
    viewport: { width: 1280, height: 800 },
    descriptor: { tag: 'button', id: 'save' },
    geometry: { width: 120, height: 40, x: 24, y: 560 },
    ...overrides,
  }
}

/** The rendered content of the one `user` frame a session received. */
function renderedBody(session: FakeSession): string {
  const user = session.frames().find((frame) => frame.type === 'user')
  return ((user?.message as { content?: string } | undefined)?.content ?? '').trim()
}

/** The ack or done URL, read off the preamble the agent was handed. */
function actionUrl(session: FakeSession, action: 'ack' | 'done'): string {
  const found = new RegExp(`^\\s*${action}\\s+(\\S+)$`, 'm').exec(renderedBody(session))
  if (!found?.[1]) throw new Error(`the preamble printed no ${action} url`)
  return found[1]
}

describe('a Pick on Next', () => {
  const sessions = fakeSessions()
  let server!: NextHarnessServer

  beforeAll(async () => {
    server = await startNextServer({ claudePid: 0 })
  }, NEXT_TIMEOUT)

  afterEach(async () => {
    await sessions.closeAll()
  })

  afterAll(async () => {
    await server?.close()
  })

  async function postPick(
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: { pickId: string; state: string } }> {
    const response = await fetch(server.url + PICK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() }
  }

  async function picksNow(): Promise<Array<{ pickId: string; state: string }>> {
    const response = await fetch(server.url + STATUS)
    expect(response.status).toBe(200)
    return (
      (await response.json()) as { picks: Array<{ pickId: string; state: string }> }
    ).picks
  }

  it('is written to its Target as three frames, auth, user and control', async () => {
    const session = await sessions.open(server.fixture, { cwd: repoRoot, pid: 504_001 })

    const { status, json } = await postPick(
      pointerBody({
        note: 'make this red',
        target: { sessionId: session.sessionId, pid: session.pid },
      }),
    )

    expect(status).toBe(200)
    expect(json.state).toBe('sent-awaiting-ack')
    await session.awaitLines(3)
    expect(session.frames().map((frame) => frame.type)).toEqual([
      'auth',
      'user',
      'control',
    ])
    expect(session.frames()[1]?.msg_id).toBe(json.pickId)
  })

  it('moves through sent, working and done on the ack and done it carries', async () => {
    const session = await sessions.open(server.fixture, { cwd: repoRoot, pid: 504_002 })
    const { json } = await postPick(
      pointerBody({ target: { sessionId: session.sessionId, pid: session.pid } }),
    )
    await session.awaitLines(3)
    const state = async () =>
      (await picksNow()).find((pick) => pick.pickId === json.pickId)?.state

    expect(await state()).toBe('sent')
    expect(actionUrl(session, 'ack').startsWith(`http://127.0.0.1:${server.port}/`)).toBe(
      true,
    )
    expect((await fetch(actionUrl(session, 'ack'), { method: 'POST' })).status).toBe(200)
    expect(await state()).toBe('working')
    expect((await fetch(actionUrl(session, 'done'), { method: 'POST' })).status).toBe(200)
    expect(await state()).toBe('done')
  })

  it('names a link in a chunk Next does not serve as absent, and says so', async () => {
    const session = await sessions.open(server.fixture, { cwd: repoRoot, pid: 504_003 })
    const chunk = `http://127.0.0.1:${server.port}/_next/static/chunks`
    const stack = [
      'Error: react-stack-top-frame',
      `    at exports.jsxDEV (${chunk}/react.js:197:25)`,
      `    at ClientLeaf (${chunk}/not-a-chunk._.js:1:200)`,
      `    at Object.react_stack_bottom_frame (${chunk}/react-dom.js:14142:12)`,
    ].join('\n')

    await postPick(
      pointerBody({
        ownerChain: [{ name: 'ClientLeaf', stack }],
        target: { sessionId: session.sessionId, pid: session.pid },
      }),
    )
    await session.awaitLines(3)

    expect(renderedBody(session)).toContain(
      'ClientLeaf — no location (absent: module-not-in-graph — ',
    )
    expect(renderedBody(session)).toContain(
      'this dev server serves no chunk at /_next/static/chunks/not-a-chunk._.js',
    )
  })
})

describe('a page and the HMR socket, with and without withPointout()', () => {
  let bare!: NextHarnessServer
  let wrapped!: NextHarnessServer

  beforeAll(async () => {
    ;[bare, wrapped] = await Promise.all([
      startNextServer({ pointout: false }),
      startNextServer(),
    ])
  }, NEXT_TIMEOUT)

  afterAll(async () => {
    await Promise.all([bare?.close(), wrapped?.close()])
  })

  /** The fixture markers a page renders, which is what makes it this page. */
  async function fixturesOn(server: NextHarnessServer, path: string) {
    const response = await fetch(server.url + path)
    const html = await response.text()
    return {
      status: response.status,
      fixtures: [...html.matchAll(/data-fixture="([^"]+)"/g)].map((m) => m[1]).toSorted(),
    }
  }

  it('serves both routers the same', async () => {
    for (const path of ['/', '/pages-router']) {
      const [without, withIt] = [
        await fixturesOn(bare, path),
        await fixturesOn(wrapped, path),
      ]
      expect(without.status).toBe(200)
      expect(withIt).toEqual(without)
    }
  }, 60_000)

  it('answers /__agent only with it', async () => {
    expect((await fetch(bare.url + STATUS)).status).toBe(404)
    expect((await fetch(wrapped.url + STATUS)).status).toBe(200)
  }, 60_000)

  it('opens the HMR websocket and hears from it either way', async () => {
    // Measured on 16.4.2: a client that connects to `/_next/hmr` is told the
    // ISR manifest, that Turbopack is connected, and then a `sync`. The types
    // of what it hears up to the `sync` are compared, not their payloads,
    // which carry a session id.
    const upToSync = (server: NextHarnessServer) =>
      new Promise<string[]>((resolve, reject) => {
        const socket = new WebSocket(server.url.replace('http:', 'ws:') + '/_next/hmr')
        const heard: string[] = []
        const timer = setTimeout(
          () => reject(new Error(`no HMR sync in 20 s; heard ${heard.join(', ')}`)),
          20_000,
        )
        socket.addEventListener('message', (event) => {
          const type = String((JSON.parse(String(event.data)) as { type?: unknown }).type)
          heard.push(type)
          if (type !== 'sync') return
          clearTimeout(timer)
          socket.close()
          resolve(heard)
        })
        socket.addEventListener('error', () => reject(new Error('HMR socket failed')))
      })

    // A `building` or `built` may come in between, depending on whether a
    // compile the page requests started is still running: that is timing, not
    // pointout, so it is left out of the comparison.
    const settled = (types: string[]) =>
      types.filter((type) => type !== 'building' && type !== 'built')
    const [without, withIt] = await Promise.all([upToSync(bare), upToSync(wrapped)])
    expect(without).toContain('turbopack-connected')
    expect(settled(withIt)).toEqual(settled(without))
  }, 60_000)
})

describe('next dev --webpack', () => {
  let server!: NextHarnessServer

  beforeAll(async () => {
    server = await startNextServer({ webpack: true })
  }, NEXT_TIMEOUT)

  afterAll(async () => {
    await server?.close()
  })

  it('warns that pointout supports Turbopack only, and serves no /__agent', async () => {
    const response = await fetch(server.url + STATUS)
    expect(response.headers.get('content-type') ?? '').not.toMatch(/json/)
    expect(response.status).not.toBe(200)

    await vi.waitFor(() =>
      expect(server.log()).toContain(
        'pointout: this dev server is not running Turbopack, and pointout supports ' +
          'Turbopack only for now, so it serves nothing here. Run `next dev` without ' +
          '`--webpack` to use it.',
      ),
    )
    expect(server.log()).not.toContain(BLOCK_HEADING)
    expect(occurrences(server.log(), 'pointout supports Turbopack only for now')).toBe(1)
  }, 60_000)
})

describe('editing next.config while next dev runs', () => {
  let server!: NextHarnessServer

  beforeAll(async () => {
    server = await startNextServer({ copy: true })
  }, NEXT_TIMEOUT)

  afterAll(async () => {
    await server?.close()
  })

  it(
    'leaves one discovery entry and one reply socket, both the new worker’s',
    async () => {
      const before = workerPid(server)
      expect(discoveryEntriesOf([before])).toHaveLength(1)

      appendFileSync(join(server.appRoot, 'next.config.ts'), '\n// edited by a test\n')
      await vi.waitFor(() => expect(occurrences(server.log(), BLOCK_HEADING)).toBe(2), {
        timeout: 60_000,
        interval: 100,
      })
      const after = workerPid(server)

      expect(after).not.toBe(before)
      expect(discoveryEntriesOf([before, after]).map((entry) => entry.pid)).toEqual([
        after,
      ])
      expect(
        readdirSync(join(server.fixture.socketDir)).filter((name) =>
          name.endsWith('.sock'),
        ),
      ).toEqual([`${after}.sock`])
      expect((await fetch(server.url + STATUS)).status).toBe(200)
    },
    NEXT_TIMEOUT,
  )
})
