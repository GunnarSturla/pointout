import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CHAIN_FIXTURE, originalOf, startCallSiteBed } from '../harness/call-sites.js'
import type { CallSiteBed, Frame } from '../harness/call-sites.js'
import type { HarnessServer } from '../harness/dev-server.js'
import { createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { startNextServer } from '../harness/next-server.js'
import type { NextHarnessServer } from '../harness/next-server.js'
import { repoRoot } from '../harness/paths.js'
import { fakeSessions } from '../harness/session-socket.js'
import type { FakeSession } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'

// Confidence, one row of spec §12's table at a time (spec §12, §13, §21; user
// story 91). A Pick degrades by annotation and never by refusal, so every test
// here sends a Pick the server cannot place exactly and reads the sentence it
// travelled with at a fake session's inbox.
//
// Every string is written out rather than imported — the endpoint, the mode
// names, the row labels, the grammar of a stack frame. Those are the contract
// (docs/agents/testing.md), and nothing here imports a server module.
//
// The stacks are built, because seam 1 has no browser. Their *shapes* are not
// invented: each was measured in a real engine and the measurement is named
// above the builder that reproduces it. Seam 2 is where a real engine makes
// them.
//
// What reads a frame alone is the same on both Hosts and runs on each. What a
// Host's own modules make of a frame — a transform's timestamp, a prebundled
// package, a Turbopack chunk's map — runs on that Host only, below.

const PICK = '/__agent/pick'

const HOSTS = ['vite', 'next'] as const
const NEXT_TIMEOUT = 120_000

interface PickBody {
  url: string
  viewport: { width: number; height: number }
  descriptor: { tag: string }
  geometry: { width: number; height: number; x: number; y: number }
  ownerChain?: unknown
  walkUp?: unknown
  note?: string | null
  target?: { sessionId: string; pid: number } | null
}

function bodyFor(
  target: { sessionId: string; pid: number },
  overrides: Partial<PickBody> = {},
): PickBody {
  return {
    url: 'http://127.0.0.1:5173/',
    viewport: { width: 1280, height: 800 },
    descriptor: { tag: 'span' },
    geometry: { width: 120, height: 20, x: 10, y: 20 },
    target,
    ...overrides,
  }
}

/** POST one Pick and read the content of the `user` frame it became. */
async function send(to: HarnessServer, at: FakeSession, sent: PickBody): Promise<string> {
  const before = at.frames().filter((frame) => frame.type === 'user').length
  const response = await fetch(to.url + PICK, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: to.url },
    body: JSON.stringify(sent),
  })
  expect(response.status).toBe(200)

  // auth, user, control per Pick, so one more user frame is three more lines.
  await at.awaitLines((before + 1) * 3)
  const users = at
    .frames()
    .filter((frame) => frame.type === 'user')
    .map((frame) => (frame.message as { content?: string } | undefined)?.content ?? '')
  return users[users.length - 1] ?? ''
}

const at = ({ url, line, column }: Frame) => `${url}:${line}:${column}`

/**
 * A V8 owner stack with an app frame: React's own top frame, the app frame, the
 * sentinel, React's internals.
 */
function v8Stack(
  name: string,
  frame: Frame,
  runtime: { jsx: Frame; reactDom: Frame },
): string {
  return [
    'Error: react-stack-top-frame',
    `    at exports.jsxDEV (${at(runtime.jsx)})`,
    `    at ${name} (${at(frame)})`,
    `    at Object.react_stack_bottom_frame (${at(runtime.reactDom)})`,
    `    at renderWithHooksAgain (${at(runtime.reactDom)})`,
  ].join('\n')
}

/** One server per Host, a session listening, and a Pick against it. */
function onBed(on: (typeof HOSTS)[number], pid: number) {
  const sessions = fakeSessions()
  const state = {} as { bed: CallSiteBed; session: FakeSession }

  beforeAll(async () => {
    state.bed = await startCallSiteBed(on, { claudePid: pid })
    state.session = await sessions.open(state.bed.server.fixture, { cwd: repoRoot, pid })
  }, NEXT_TIMEOUT)

  afterAll(async () => {
    await sessions.closeAll()
    await state.bed?.server.close()
  })

  return {
    get bed() {
      return state.bed
    },
    stack: (name: string, frame: Frame) => v8Stack(name, frame, state.bed.runtime),
    pick: (overrides: Partial<PickBody> = {}) =>
      send(
        state.bed.server,
        state.session,
        bodyFor(
          { sessionId: state.session.sessionId, pid: state.session.pid },
          overrides,
        ),
      ),
  }
}

describe.each(HOSTS)('Confidence read off the frame alone, on %s', (on) => {
  const host = onBed(on, on === 'vite' ? 500_601 : 500_602)

  const runtime = () => host.bed.runtime
  const leafSource = () => originalOf('span')

  /**
   * The tail-deleted shape: React's top frame, and the sentinel directly under
   * it with nothing in between. Measured in WebKit against a component whose
   * body is a bare `return <tag>` — JavaScriptCore's proper tail calls delete
   * that frame.
   */
  const elidedStack = () =>
    [
      `exports.jsxDEV@${at(runtime().jsx)}`,
      `react_stack_bottom_frame@${at(runtime().reactDom)}`,
      `renderWithHooksAgain@${at(runtime().reactDom)}`,
      '',
    ].join('\n')

  /** No sentinel at all: React's ten-frame cap, or an element created outside render. */
  const noBoundaryStack = () =>
    [
      'Error: react-stack-top-frame',
      `    at exports.jsxDEV (${at(runtime().jsx)})`,
      `    at ${host.bed.server.url}/src/main.tsx:9:89`,
    ].join('\n')

  /**
   * React's shared placeholder owner stack, handed out above roughly 10,000
   * elements a second. Measured in Chromium against React 19.3.0 by pushing
   * `jsxDEV` past its own counter: the top frame is React's `UnknownOwner` and
   * the sentinel sits directly under it.
   */
  const placeholderStack = () => {
    const jsx = runtime().jsx.url
    return [
      'Error: react-stack-top-frame',
      `    at UnknownOwner (${jsx}:80:11)`,
      `    at Object.react_stack_bottom_frame (${jsx}:184:11)`,
      `    at ${jsx}:188:88`,
      `    at ${jsx}:202:4`,
    ].join('\n')
  }

  /** The same placeholder as Firefox writes it, measured in the same run. */
  const geckoPlaceholderStack = () => {
    const jsx = runtime().jsx.url
    return [
      `UnknownOwner@${jsx}:80:11`,
      `react_stack_bottom_frame@${jsx}:184:11`,
      `require_react_jsx_dev_runtime_development</<@${jsx}:188:88`,
      '',
    ].join('\n')
  }

  /** A frame in a module this Host has never served. */
  const ghost = (): Frame => ({
    url: host.bed.server.url + '/src/fixtures/NotAFile.tsx',
    line: 3,
    column: 5,
  })

  describe('a frame an engine deleted', () => {
    it('keeps the name and states call-site-frame-elided-by-engine', async () => {
      const content = await host.pick({
        ownerChain: [{ name: 'CardHeading', stack: elidedStack() }],
      })

      expect(content).toContain(
        'CardHeading — no location (absent: call-site-frame-elided-by-engine — ',
      )
      // User story 91: the component is still named, which is the whole point.
      expect(content).toMatch(/owner chain\s+CardHeading — /)
    })

    it('leaves the rest of the chain exact', async () => {
      const content = await host.pick({
        ownerChain: [
          { name: 'CardHeading', stack: elidedStack() },
          {
            name: 'ChainMiddle',
            stack: host.stack('ChainMiddle', host.bed.frame('span')),
          },
        ],
      })

      expect(content).toContain('CardHeading — no location (absent:')
      expect(content).toContain(`ChainMiddle — ${CHAIN_FIXTURE}:${leafSource()} (exact)`)
    })
  })

  describe('a stack that never reached app code', () => {
    it('states no-react-boundary', async () => {
      const content = await host.pick({
        ownerChain: [{ name: 'App', stack: noBoundaryStack() }],
      })

      expect(content).toContain('App — no location (absent: no-react-boundary — ')
    })
  })

  describe("React's shared placeholder owner stack", () => {
    it('is recognised by its UnknownOwner frame and stated as such', async () => {
      const content = await host.pick({
        ownerChain: [{ name: 'Row', stack: placeholderStack() }],
      })

      expect(content).toContain('Row — no location (absent: unknown-owner-placeholder — ')
      // Not the tail-call reason: the two shapes are identical below the top
      // frame, and only the name tells them apart.
      expect(content).not.toContain('call-site-frame-elided-by-engine')
    })

    it('is recognised in the Gecko grammar too', async () => {
      const content = await host.pick({
        ownerChain: [{ name: 'Row', stack: geckoPlaceholderStack() }],
      })

      expect(content).toContain('Row — no location (absent: unknown-owner-placeholder — ')
    })
  })

  describe('a frame the server cannot read or find', () => {
    it('states unreadable-frame for a frame that names no url at all', async () => {
      const content = await host.pick({
        ownerChain: [
          {
            name: 'Odd',
            stack: [
              'Error: react-stack-top-frame',
              `    at exports.jsxDEV (${at(runtime().jsx)})`,
              '    at Odd (not-a-url:3:5)',
              `    at Object.react_stack_bottom_frame (${at(runtime().reactDom)})`,
            ].join('\n'),
          },
        ],
      })

      expect(content).toContain('Odd — no location (absent: unreadable-frame — ')
      expect(content).not.toContain('not-a-url')
    })

    it('states module-not-in-graph, naming the path, for a module it never served', async () => {
      const content = await host.pick({
        ownerChain: [{ name: 'Ghost', stack: host.stack('Ghost', ghost()) }],
      })

      expect(content).toContain('Ghost — no location (absent: module-not-in-graph — ')
      expect(content).toContain('/src/fixtures/NotAFile.tsx')
    })
  })

  describe('the developer own source', () => {
    it('is not flagged dependency', async () => {
      const content = await host.pick({
        ownerChain: [
          { name: 'ChainLeaf', stack: host.stack('ChainLeaf', host.bed.frame('span')) },
        ],
      })

      expect(content).toContain(`ChainLeaf — ${CHAIN_FIXTURE}:${leafSource()} (exact)`)
      expect(content).not.toContain('dependency')
    })
  })

  describe('a chain that is exact in places and not in others', () => {
    it('states each link own Confidence, and none for the Pick', async () => {
      const content = await host.pick({
        ownerChain: [
          { name: 'CardHeading', stack: elidedStack() },
          { name: 'Ghost', stack: host.stack('Ghost', ghost()) },
          {
            name: 'ChainMiddle',
            stack: host.stack('ChainMiddle', host.bed.frame('span')),
          },
        ],
      })

      expect(content).toContain('CardHeading — no location (absent: ')
      expect(content).toContain('Ghost — no location (absent: module-not-in-graph — ')
      expect(content).toContain(`ChainMiddle — ${CHAIN_FIXTURE}:${leafSource()} (exact)`)

      // One label over three links, and no Confidence stated anywhere but on a
      // link: a Pick has none (`GLOSSARY.md`).
      expect(content.match(/owner chain/g)).toHaveLength(1)
      expect(content).not.toMatch(/^\s*confidence\s/m)
      const stated = content.match(/\((?:dependency, )?(?:exact\)|approximate:|absent:)/g)
      expect(stated).toHaveLength(3)
    })
  })

  describe('a Pick React claimed no ownership of', () => {
    it('says so and says how far the page walked looking', async () => {
      const content = await host.pick({ ownerChain: [], walkUp: 4 })

      expect(content).toMatch(
        /owner chain\s+none — React named no owner for this element; the page walked up 4 DOM levels from the picked element looking for a React fiber/,
      )
    })

    it('states the distance even when it is zero', async () => {
      const content = await host.pick({ ownerChain: [] })

      expect(content).toMatch(/owner chain\s+none — .*walked up 0 DOM levels/)
    })
  })
})

describe('Confidence on Vite, from its module graph', () => {
  const host = onBed('vite', 500_603)
  const apps = tempApps()
  const sessions = fakeSessions()
  let fixture: FixtureEnv | undefined

  afterEach(async () => {
    await sessions.closeAll()
    await apps.cleanup()
    fixture?.cleanup()
    fixture = undefined
  })

  /** How Vite serves a package it has pre-bundled, measured against the example app. */
  const PREBUNDLED = '/node_modules/.vite/deps/react-loading-skeleton.js?v=03193178'

  const leafSource = () => originalOf('span')
  const staleLeaf = (): Frame => {
    const frame = host.bed.frame('span')
    // `?t=` is how Vite addresses one transform of a module. This one names a
    // transform the server has never held, which is exactly what a page that
    // loaded before an HMR update carries.
    return { ...frame, url: `${frame.url}?t=1600000000000` }
  }

  it('states stale-transform when the frame names a transform this server no longer has', async () => {
    const content = await host.pick({
      ownerChain: [{ name: 'ChainLeaf', stack: host.stack('ChainLeaf', staleLeaf()) }],
    })

    expect(content).toContain('ChainLeaf — ')
    expect(content).toContain('(approximate: stale-transform — ')
    // The position is kept: an approximate link still points somewhere.
    expect(content).toContain(`${CHAIN_FIXTURE}:${leafSource()} (approximate:`)
    expect(content).not.toContain('(exact)')
  })

  it('states no-transform-timestamp when the module moved and the frame carries no ?t=', async () => {
    // Safari strips the query from a stack url, so a frame can be missing the
    // one field that would settle it. Reproduced against a real transform: the
    // file is edited, Vite's own watcher invalidates it, and the frame the Pick
    // carries has no timestamp at all.
    const env = createFixtureEnv({ claudePid: 500_610 })
    fixture = env
    const app = tempAppServing('export const typed: number = 4\n', 'typed.ts')

    const temp = await apps.serve(app, { env: env.env })
    const listener = await sessions.open(env, { cwd: app.checkout, pid: 500_610 })
    await (await fetch(temp.url + '/src/typed.ts')).text()

    writeFileSync(join(app.appDir, 'src', 'typed.ts'), 'export const typed: number = 5\n')
    await waitFor(async () => {
      const served = await (await fetch(temp.url + '/src/typed.ts')).text()
      return served.includes('= 5')
    })

    const content = await send(
      temp,
      listener,
      bodyFor(
        { sessionId: listener.sessionId, pid: listener.pid },
        {
          ownerChain: [
            {
              name: 'Typed',
              stack: [
                'Error: react-stack-top-frame',
                `    at exports.jsxDEV (${temp.url}/x.js:1:1)`,
                `    at Typed (${temp.url}/src/typed.ts:1:14)`,
                `    at Object.react_stack_bottom_frame (${temp.url}/y.js:2:2)`,
              ].join('\n'),
            },
          ],
        },
      ),
    )

    expect(content).toContain('(approximate: no-transform-timestamp — ')
    expect(content).toContain('src/typed.ts:1:')
  })

  it('keeps the transformed position and states no-sourcemap', async () => {
    // A plain `.js` module: Vite serves it untransformed, so its module in the
    // graph carries no map at all. Measured against Vite 8.
    const env = createFixtureEnv({ claudePid: 500_611 })
    fixture = env
    const app = tempAppServing('export const plain = 2\n', 'plain.js')

    const temp = await apps.serve(app, { env: env.env })
    const listener = await sessions.open(env, { cwd: app.checkout, pid: 500_611 })
    await (await fetch(temp.url + '/src/plain.js')).text()

    const content = await send(
      temp,
      listener,
      bodyFor(
        { sessionId: listener.sessionId, pid: listener.pid },
        {
          ownerChain: [
            {
              name: 'Plain',
              stack: [
                'Error: react-stack-top-frame',
                `    at exports.jsxDEV (${temp.url}/x.js:1:1)`,
                `    at Plain (${temp.url}/src/plain.js:1:14)`,
                `    at Object.react_stack_bottom_frame (${temp.url}/y.js:2:2)`,
              ].join('\n'),
            },
          ],
        },
      ),
    )

    expect(content).toContain('(approximate: no-sourcemap — ')
    // The transformed position is kept, exactly as it was printed.
    expect(content).toMatch(/Plain — \S*src\/plain\.js:1:14 \(approximate: no-sourcemap/)
  })

  it('flags a prebundled package dependency', async () => {
    const content = await host.pick({
      ownerChain: [
        {
          name: 'Skeleton',
          stack: host.stack('Skeleton', {
            url: host.bed.server.url + PREBUNDLED,
            line: 63,
            column: 22,
          }),
        },
      ],
    })

    expect(content).toContain('Skeleton — no location (dependency, absent:')
  })

  it('flags a package served straight from node_modules as well', async () => {
    const content = await host.pick({
      ownerChain: [
        {
          name: 'Widget',
          stack: host.stack('Widget', {
            url: host.bed.server.url + '/node_modules/some-widget/dist/index.js',
            line: 8,
            column: 3,
          }),
        },
      ],
    })

    expect(content).toContain('Widget — no location (dependency, absent:')
  })

  it('states each link own Confidence over a stale link too', async () => {
    const content = await host.pick({
      ownerChain: [
        { name: 'Stale', stack: host.stack('Stale', staleLeaf()) },
        { name: 'ChainMiddle', stack: host.stack('ChainMiddle', host.bed.frame('span')) },
      ],
    })

    expect(content).toContain('Stale — ')
    expect(content).toContain('(approximate: stale-transform — ')
    expect(content).toContain(`ChainMiddle — ${CHAIN_FIXTURE}:${leafSource()} (exact)`)
  })

  /**
   * A throwaway consumer with one source module in it. The written config widens
   * `server.fs.allow` to the app itself: a temp app lives outside the package root
   * this plugin allows, and Vite answers 403 for its own source without it.
   */
  function tempAppServing(source: string, name: string) {
    const app = apps.create({ git: true })
    app.writeConfig(null, { server: { fs: { allow: [app.playground] } } })
    mkdirSync(join(app.appDir, 'src'), { recursive: true })
    writeFileSync(join(app.appDir, 'src', name), source)
    return app
  }
})

describe('Confidence on Next.js, from a Turbopack chunk and its map', () => {
  // A copy of the app, so a test can edit a fixture in it without moving any
  // other file's server: the copy's own fixtures are its own, and its chunks
  // are written to an output folder of its own.
  const sessions = fakeSessions()
  let server!: NextHarnessServer
  let session!: FakeSession
  /** Every client chunk the App Router page loads, as the page loaded it. */
  const chunks = new Map<string, string>()

  const PID = 500_604
  const CLIENT_LEAF = 'fixtures/ClientLeaf.tsx'

  beforeAll(async () => {
    server = await startNextServer({ claudePid: PID, copy: true })
    session = await sessions.open(server.fixture, { cwd: repoRoot, pid: PID })
    await loadPage()
  }, NEXT_TIMEOUT)

  afterAll(async () => {
    await sessions.closeAll()
    await server?.close()
  })

  /** What a browser does on each router's page: the HTML, then every chunk it names. */
  async function loadPage(): Promise<void> {
    for (const route of ['/', '/pages-router']) {
      const html = await (await fetch(server.url + route)).text()
      for (const [path] of html.matchAll(/\/_next\/static\/chunks\/[^"'\s]+?\.js/g)) {
        chunks.set(path, await (await fetch(server.url + path)).text())
      }
    }
  }

  const pick = (overrides: Partial<PickBody> = {}) =>
    send(
      server,
      session,
      bodyFor({ sessionId: session.sessionId, pid: session.pid }, overrides),
    )

  /** The frame an engine prints for the JSX call `needle` opens, in whichever chunk holds it. */
  function frameOf(needle: string, inChunkWith: string): Frame {
    for (const [path, text] of chunks) {
      if (!text.includes(inChunkWith)) continue
      const lines = text.split('\n')
      const index = lines.findIndex((line) => line.includes(needle))
      const line = lines[index]
      // Measured: V8 prints the column of the call's own parenthesis.
      if (line !== undefined) {
        return {
          url: server.url + path,
          line: index + 1,
          column: line.indexOf(needle) + 1,
        }
      }
    }
    throw new Error(`no chunk the page loaded contains ${needle}`)
  }

  /**
   * The first position a section of a chunk's map maps, for the first section
   * whose source `wanted` picks: a real position in the chunk, decoded only as
   * far as one base-64 VLQ field. Its generated column is that field.
   */
  async function firstMapped(wanted: (source: string) => boolean): Promise<Frame> {
    for (const path of chunks.keys()) {
      const response = await fetch(server.url + path + '.map')
      // Not every chunk has a map: Next's own nomodule polyfill has none.
      if (response.status !== 200) continue
      const map = (await response.json()) as {
        sections?: Array<{
          offset: { line: number; column: number }
          map: { sources: string[]; mappings: string }
        }>
      }
      for (const section of map.sections ?? []) {
        if (!section.map.sources.some(wanted)) continue
        const groups = section.map.mappings.split(';')
        const index = groups.findIndex((group) => group !== '')
        if (index === -1) continue
        const column = firstVlq(groups[index] ?? '')
        return {
          url: server.url + path,
          line: section.offset.line + index + 1,
          column: (index === 0 ? section.offset.column : 0) + column + 1,
        }
      }
    }
    throw new Error('no chunk the page loaded has a section like that')
  }

  const runtime = () => {
    const jsx = { url: server.url + '/_next/static/chunks/react.js', line: 1, column: 1 }
    return { jsx, reactDom: jsx }
  }

  it('flags a frame inside node_modules/next as dependency, from the map ignoreList', async () => {
    const frame = await firstMapped((source) => source.includes('/node_modules/next/'))
    const content = await pick({
      ownerChain: [
        { name: 'NextInternal', stack: v8Stack('NextInternal', frame, runtime()) },
      ],
    })

    expect(content).toMatch(
      /NextInternal — node_modules\/next\/\S+ \(dependency, exact\)/,
    )
  })

  it('states source-not-on-disk for a position in Turbopack own runtime', async () => {
    const frame = await firstMapped((source) => source.startsWith('turbopack:///'))
    const content = await pick({
      ownerChain: [{ name: 'Runtime', stack: v8Stack('Runtime', frame, runtime()) }],
    })

    expect(content).toContain(
      'Runtime — no location (dependency, absent: source-not-on-disk — ',
    )
  })

  it('states no-transform-timestamp, keeping the position, once the file has changed under the chunk', async () => {
    const before = frameOf('("button", {', '"client-leaf"')
    const file = join(server.appRoot, CLIENT_LEAF)
    const relative = file.slice(repoRoot.length).replace(/^\//, '')
    const leaf = (name: string) =>
      pick({ ownerChain: [{ name, stack: v8Stack(name, before, runtime()) }] })

    const fresh = await leaf('ClientLeaf')
    expect(fresh).toMatch(
      new RegExp(`ClientLeaf — ${escaped(relative)}:\\d+:\\d+ \\(exact\\)`),
    )
    const exactAt = new RegExp(`ClientLeaf — ${escaped(relative)}:(\\d+:\\d+)`).exec(
      fresh,
    )?.[1]
    expect(exactAt).toBe(originalIn(file, '<button'))

    // An edit that moves every line of the component down, as a developer's
    // would. The page keeps its frame: Turbopack's hot update leaves the url
    // and the line the frame names as they were (measured).
    const source = readFileSync(file, 'utf8')
    writeFileSync(
      file,
      source.replace('export function', '// one\n// two\n// three\nexport function'),
    )
    // With no browser on the HMR socket, Turbopack writes the chunk again when
    // a page next asks for it; a browser's hot update makes it do the same.
    const chunk = before.url.slice(server.url.length)
    await waitFor(async () => {
      await (await fetch(server.url + '/')).text()
      return (await (await fetch(server.url + chunk)).text()) !== chunks.get(chunk)
    })

    const stale = await leaf('Stale')
    expect(stale).toMatch(
      new RegExp(
        `Stale — ${escaped(relative)}:\\d+:\\d+ \\(approximate: no-transform-timestamp — `,
      ),
    )
    expect(stale).not.toContain('(exact)')
  })

  it('states no-sourcemap, with no location, for a chunk Next serves without its map', async () => {
    const frame = frameOf('("button", {', '"client-leaf"')
    const chunk = decodeURIComponent(frame.url.slice(server.url.length)).replace(
      '/_next/static/chunks/',
      '',
    )
    rmSync(
      join(server.appRoot, server.distDir, 'dev', 'static', 'chunks', chunk + '.map'),
    )

    const content = await pick({
      ownerChain: [{ name: 'Unmapped', stack: v8Stack('Unmapped', frame, runtime()) }],
    })

    expect(content).toContain('Unmapped — no location (absent: no-sourcemap — ')
  })

  // A Server Component's frame names a server chunk no page loads, by its path
  // on disk: `about://React/Server/file:///…/dev/server/chunks/ssr/<chunk>.js?<n>`
  // (measured, Chromium and Firefox; the `?<n>` is the page's own counter).
  // Here the frame is built from the chunk the App Router page made Turbopack
  // write, at the JSX call `<ClientLeaf>` in `ServerOwner`.
  const SERVER_OWNER = 'fixtures/ServerOwner.tsx'

  /** The server chunk holding `ServerOwner`, and its frame for `<ClientLeaf>`. */
  function serverOwnerFrame(): { chunk: string; frame: Frame } {
    const dir = join(server.appRoot, server.distDir, 'dev', 'server', 'chunks', 'ssr')
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.js')) continue
      const text = readFileSync(join(dir, name), 'utf8')
      if (!text.includes('"server-owner"')) continue
      const lines = text.split('\n')
      const index = lines.findIndex(
        (line) => line.includes('jsxDEV') && line.includes('ClientLeaf'),
      )
      const line = lines[index] ?? ''
      // Measured: the column of the call's own parenthesis, as on the client.
      const call = line.lastIndexOf('])(', line.indexOf('ClientLeaf')) + 2
      const chunk = join(dir, name)
      return {
        chunk,
        frame: {
          url: `about://React/Server/${pathToFileURL(chunk).href}?3`,
          line: index + 1,
          column: call + 1,
        },
      }
    }
    throw new Error('no server chunk holds ServerOwner; was / loaded?')
  }

  const serverPick = (name: string, frame: Frame) =>
    pick({ ownerChain: [{ name, stack: v8Stack(name, frame, runtime()) }] })

  it('reads a Server Component frame exact until its file changes under the server chunk, then approximate', async () => {
    const file = join(server.appRoot, SERVER_OWNER)
    const relative = file.slice(repoRoot.length).replace(/^\//, '')
    const { frame } = serverOwnerFrame()

    const fresh = await serverPick('Fresh', frame)
    expect(fresh).toContain(
      `Fresh — ${relative}:${originalIn(file, '<ClientLeaf label=')} (exact)`,
    )

    // An edit no page has asked for since: Turbopack has not written the
    // server chunk again, so its map describes the file as it was.
    const source = readFileSync(file, 'utf8')
    writeFileSync(file, source.replace('export function', '// one\nexport function'))

    const stale = await serverPick('Stale', frame)
    expect(stale).toMatch(
      new RegExp(
        `Stale — ${escaped(relative)}:\\d+:\\d+ \\(approximate: no-transform-timestamp — `,
      ),
    )
  })

  it('states no-sourcemap, with no location, for a Server Component frame whose map is gone', async () => {
    const { chunk, frame } = serverOwnerFrame()
    rmSync(chunk + '.map')

    const content = await serverPick('Unmapped', frame)

    expect(content).toContain('Unmapped — no location (absent: no-sourcemap — ')
  })

  it('states the server chunk is gone, with no location, for a Server Component frame into a deleted chunk', async () => {
    const { chunk, frame } = serverOwnerFrame()
    rmSync(chunk)

    const content = await serverPick('Gone', frame)

    expect(content).toContain('Gone — no location (absent: module-not-in-graph — ')
    expect(content).toContain('is no longer on disk')
  })
})

/** Where `marker` first sits in `file`, as `line:col`. */
function originalIn(file: string, marker: string): string {
  const lines = readFileSync(file, 'utf8').split('\n')
  const index = lines.findIndex((line) => line.includes(marker))
  return `${index + 1}:${(lines[index] ?? '').indexOf(marker) + 1}`
}

/** The first base-64 VLQ field of a mappings segment: its generated column. */
function firstVlq(segment: string): number {
  const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = digits.indexOf(char)
    value += (digit & 31) * 2 ** shift
    shift += 5
    if (!(digit & 32)) break
  }
  return value % 2 === 1 ? -(value - 1) / 2 : value / 2
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Poll until the dev server has caught up with a file that changed on disk. */
async function waitFor(ready: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await ready()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('the dev server never picked up the change on disk')
}
