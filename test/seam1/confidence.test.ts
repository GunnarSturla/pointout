import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startExampleServer } from '../harness/dev-server.js'
import type { HarnessServer } from '../harness/dev-server.js'
import { createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
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

const PICK = '/__agent/pick'

/** The fixture module, as the browser asks for it and as the repo holds it. */
const MODULE_URL = '/src/fixtures/OwnerChainDepth.tsx'
const MODULE_PATH = 'examples/react-app/src/fixtures/OwnerChainDepth.tsx'

/** How Vite serves a package it has pre-bundled, measured against the example app. */
const PREBUNDLED = '/node_modules/.vite/deps/react-loading-skeleton.js?v=03193178'
const REACT_DOM = '/node_modules/.vite/deps/react-dom_client.js?v=abcd1234'
const JSX_RUNTIME = '/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=abcd1234'

const SESSION_PID = 500_601

const sessions = fakeSessions()
const apps = tempApps()
let server!: HarnessServer
let session!: FakeSession
let transformed!: string
let fixture: FixtureEnv | undefined

beforeAll(async () => {
  server = await startExampleServer({ claudePid: SESSION_PID })
  session = await sessions.open(server.fixture, { cwd: repoRoot, pid: SESSION_PID })
  // The request that puts the fixture in the module graph with its transform and
  // its map, which is what a browser would have done.
  transformed = await (await fetch(server.url + MODULE_URL)).text()
})

afterEach(async () => {
  await apps.cleanup()
  fixture?.cleanup()
  fixture = undefined
})

afterAll(async () => {
  await sessions.closeAll()
  await server?.close()
})

/** Where a JSX call site sits in the fixture's own source, as `line:col`. */
function original(marker: string): string {
  const lines = readFileSync(join(repoRoot, MODULE_PATH), 'utf8').split('\n')
  const index = lines.findIndex((line) => line.includes(marker))
  const line = lines[index]
  if (index === -1 || line === undefined) {
    throw new Error(`the fixture no longer contains ${marker}`)
  }
  return `${index + 1}:${line.indexOf(marker) + 1}`
}

/** Where the same call site sits in what the dev server actually served. */
function inTransform(callee: string): { line: number; column: number } {
  const lines = transformed.split('\n')
  const index = lines.findIndex((line) => line.includes(callee))
  const line = lines[index]
  if (index === -1 || line === undefined) {
    throw new Error(`the served module no longer calls ${callee}`)
  }
  return { line: index + 1, column: line.indexOf(callee) + 1 }
}

interface At {
  line: number
  column: number
}

/**
 * A V8 owner stack with an app frame: React's own top frame, the app frame, the
 * sentinel, React's internals. `at` is where the app frame points.
 */
function v8Stack(
  name: string,
  at: At,
  url = server.url + MODULE_URL,
  top = server.url + JSX_RUNTIME,
): string {
  return [
    'Error: react-stack-top-frame',
    `    at exports.jsxDEV (${top}:197:25)`,
    `    at ${name} (${url}:${at.line}:${at.column})`,
    `    at Object.react_stack_bottom_frame (${server.url + REACT_DOM}:14142:12)`,
    `    at renderWithHooksAgain (${server.url + REACT_DOM}:4457:16)`,
  ].join('\n')
}

/**
 * The tail-deleted shape: React's top frame, and the sentinel directly under it
 * with nothing in between. Measured in WebKit against a component whose body is
 * a bare `return <tag>` — JavaScriptCore's proper tail calls delete that frame.
 */
function elidedStack(): string {
  return [
    `exports.jsxDEV@${server.url + JSX_RUNTIME}:197:30`,
    `react_stack_bottom_frame@${server.url + REACT_DOM}:14142:12`,
    `renderWithHooksAgain@${server.url + REACT_DOM}:4457:16`,
    '',
  ].join('\n')
}

/** No sentinel at all: React's ten-frame cap, or an element created outside render. */
function noBoundaryStack(): string {
  return [
    'Error: react-stack-top-frame',
    `    at exports.jsxDEV (${server.url + JSX_RUNTIME}:197:25)`,
    `    at ${server.url}/src/main.tsx:9:89`,
  ].join('\n')
}

/**
 * React's shared placeholder owner stack, handed out above roughly 10,000
 * elements a second. Measured in Chromium against React 19.3.0 by pushing
 * `jsxDEV` past its own counter: the top frame is React's `UnknownOwner` and
 * the sentinel sits directly under it.
 */
function placeholderStack(): string {
  return [
    'Error: react-stack-top-frame',
    `    at UnknownOwner (${server.url + JSX_RUNTIME}:80:11)`,
    `    at Object.react_stack_bottom_frame (${server.url + JSX_RUNTIME}:184:11)`,
    `    at ${server.url + JSX_RUNTIME}:188:88`,
    `    at ${server.url + JSX_RUNTIME}:202:4`,
  ].join('\n')
}

/** The same placeholder as Firefox writes it, measured in the same run. */
function geckoPlaceholderStack(): string {
  return [
    `UnknownOwner@${server.url + JSX_RUNTIME}:80:11`,
    `react_stack_bottom_frame@${server.url + JSX_RUNTIME}:184:11`,
    `require_react_jsx_dev_runtime_development</<@${server.url + JSX_RUNTIME}:188:88`,
    '',
  ].join('\n')
}

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

/** One Pick against the example app, with whatever chain the test built. */
function pick(overrides: Partial<PickBody> = {}): Promise<string> {
  return send(
    server,
    session,
    bodyFor({ sessionId: session.sessionId, pid: session.pid }, overrides),
  )
}

const leafAt = () => inTransform('_jsxDEV("span"')
const leafSource = () => original('<span data-fixture="chain-leaf">')

describe('a frame whose transform has moved under it', () => {
  it('states stale-transform when the frame names a transform this server no longer has', async () => {
    // `?t=` is how Vite addresses one transform of a module. This one names a
    // transform the server has never held, which is exactly what a page that
    // loaded before an HMR update carries.
    const stale = `${server.url + MODULE_URL}?t=1600000000000`
    const content = await pick({
      ownerChain: [{ name: 'ChainLeaf', stack: v8Stack('ChainLeaf', leafAt(), stale) }],
    })

    expect(content).toContain('ChainLeaf — ')
    expect(content).toContain('(approximate: stale-transform — ')
    // The position is kept: an approximate link still points somewhere.
    expect(content).toContain(`${MODULE_PATH}:${leafSource()} (approximate:`)
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
})

describe('a frame an engine deleted', () => {
  it('keeps the name and states call-site-frame-elided-by-engine', async () => {
    const content = await pick({
      ownerChain: [{ name: 'CardHeading', stack: elidedStack() }],
    })

    expect(content).toContain(
      'CardHeading — no location (absent: call-site-frame-elided-by-engine — ',
    )
    // User story 91: the component is still named, which is the whole point.
    expect(content).toMatch(/owner chain\s+CardHeading — /)
  })

  it('leaves the rest of the chain exact', async () => {
    const content = await pick({
      ownerChain: [
        { name: 'CardHeading', stack: elidedStack() },
        { name: 'ChainMiddle', stack: v8Stack('ChainMiddle', leafAt()) },
      ],
    })

    expect(content).toContain('CardHeading — no location (absent:')
    expect(content).toContain(`ChainMiddle — ${MODULE_PATH}:${leafSource()} (exact)`)
  })
})

describe('a stack that never reached app code', () => {
  it('states no-react-boundary', async () => {
    const content = await pick({
      ownerChain: [{ name: 'App', stack: noBoundaryStack() }],
    })

    expect(content).toContain('App — no location (absent: no-react-boundary — ')
  })
})

describe("React's shared placeholder owner stack", () => {
  it('is recognised by its UnknownOwner frame and stated as such', async () => {
    const content = await pick({
      ownerChain: [{ name: 'Row', stack: placeholderStack() }],
    })

    expect(content).toContain('Row — no location (absent: unknown-owner-placeholder — ')
    // Not the tail-call reason: the two shapes are identical below the top
    // frame, and only the name tells them apart.
    expect(content).not.toContain('call-site-frame-elided-by-engine')
  })

  it('is recognised in the Gecko grammar too', async () => {
    const content = await pick({
      ownerChain: [{ name: 'Row', stack: geckoPlaceholderStack() }],
    })

    expect(content).toContain('Row — no location (absent: unknown-owner-placeholder — ')
  })
})

describe('a module the server cannot map', () => {
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

  it('states the graph reason for a frame in a module it does not hold', async () => {
    const content = await pick({
      ownerChain: [
        {
          name: 'Ghost',
          stack: v8Stack(
            'Ghost',
            { line: 3, column: 5 },
            server.url + '/src/fixtures/NotAFile.tsx',
          ),
        },
      ],
    })

    expect(content).toContain('Ghost — no location (absent: module-not-in-graph — ')
    expect(content).toContain('/src/fixtures/NotAFile.tsx')
  })

  it('states unreadable-frame for a frame that names no url at all', async () => {
    const content = await pick({
      ownerChain: [
        {
          name: 'Odd',
          stack: [
            'Error: react-stack-top-frame',
            `    at exports.jsxDEV (${server.url + JSX_RUNTIME}:197:25)`,
            '    at Odd (not-a-url:3:5)',
            `    at Object.react_stack_bottom_frame (${server.url + REACT_DOM}:14142:12)`,
          ].join('\n'),
        },
      ],
    })

    expect(content).toContain('Odd — no location (absent: unreadable-frame — ')
    expect(content).not.toContain('not-a-url')
  })
})

describe('a frame inside a package', () => {
  it('flags the link dependency', async () => {
    const content = await pick({
      ownerChain: [
        {
          name: 'Skeleton',
          stack: v8Stack('Skeleton', { line: 63, column: 22 }, server.url + PREBUNDLED),
        },
      ],
    })

    expect(content).toContain('Skeleton — no location (dependency, absent:')
  })

  it('flags a package served straight from node_modules as well', async () => {
    const content = await pick({
      ownerChain: [
        {
          name: 'Widget',
          stack: v8Stack(
            'Widget',
            { line: 8, column: 3 },
            server.url + '/node_modules/some-widget/dist/index.js',
          ),
        },
      ],
    })

    expect(content).toContain('Widget — no location (dependency, absent:')
  })

  it('does not flag the developer own source', async () => {
    const content = await pick({
      ownerChain: [{ name: 'ChainLeaf', stack: v8Stack('ChainLeaf', leafAt()) }],
    })

    expect(content).not.toContain('dependency')
  })
})

describe('a chain that is exact in places and not in others', () => {
  it('states each link own Confidence, and none for the Pick', async () => {
    const content = await pick({
      ownerChain: [
        { name: 'CardHeading', stack: elidedStack() },
        {
          name: 'Stale',
          stack: v8Stack('Stale', leafAt(), `${server.url + MODULE_URL}?t=1600000000000`),
        },
        { name: 'ChainMiddle', stack: v8Stack('ChainMiddle', leafAt()) },
      ],
    })

    expect(content).toContain('CardHeading — no location (absent: ')
    expect(content).toContain('Stale — ')
    expect(content).toContain('(approximate: stale-transform — ')
    expect(content).toContain(`ChainMiddle — ${MODULE_PATH}:${leafSource()} (exact)`)

    // One label over three links, and no Confidence stated anywhere but on a
    // link: a Pick has none (`CONTEXT.md`).
    expect(content.match(/owner chain/g)).toHaveLength(1)
    expect(content).not.toMatch(/^\s*confidence\s/m)
    const stated = content.match(/\((?:dependency, )?(?:exact\)|approximate:|absent:)/g)
    expect(stated).toHaveLength(3)
  })
})

describe('a Pick React claimed no ownership of', () => {
  it('says so and says how far the page walked looking', async () => {
    const content = await pick({ ownerChain: [], walkUp: 4 })

    expect(content).toMatch(
      /owner chain\s+none — React named no owner for this element; the page walked up 4 DOM levels from the picked element looking for a React fiber/,
    )
  })

  it('states the distance even when it is zero', async () => {
    const content = await pick({ ownerChain: [] })

    expect(content).toMatch(/owner chain\s+none — .*walked up 0 DOM levels/)
  })
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

/** Poll until the dev server has caught up with a file that changed on disk. */
async function waitFor(ready: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await ready()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('the dev server never picked up the change on disk')
}
