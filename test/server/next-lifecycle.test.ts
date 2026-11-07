import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { buildNextApp } from '../harness/next-build.js'
import type { NextBuild } from '../harness/next-build.js'
import { groupMembers, startNextServer } from '../harness/next-server.js'
import type { NextHarnessServer } from '../harness/next-server.js'
import { createTempApp } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'

// Next.js Connector ticket 05: pointout leaves no trace where it must not be.
// A production build carries none of it, and a `next dev` stopped the way a
// developer stops it, Ctrl-C, leaves nothing of pointout's running or on disk.
// Every string here is written out (docs/agents/testing.md).

/** What only pointout serves, and what only its Overlay contains. */
const AGENT_PATH = '/__agent'
const OVERLAY_TAG = 'pointout-overlay'
const OVERLAY_GLOBAL = '__pointout'

/** Every file below `directory`, as paths relative to it. */
function filesBelow(directory: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out.push(path)
    }
  }
  walk(directory)
  return out.map((path) => relative(directory, path))
}

describe('next build, with withPointout()', () => {
  let build: NextBuild | undefined
  afterEach(() => {
    build?.cleanup()
    build = undefined
  })

  // A whole production build, beside every other server-suite file: longer than the
  // 30 s the rest of the server suite is held to.
  it('contains no Overlay code and no /__agent anywhere in its output', async () => {
    build = await buildNextApp({ deadlineMs: 170_000 })
    // The log rides along, so a failed build says why.
    expect({ code: build.code, log: build.log }).toMatchObject({ code: 0 })

    const files = filesBelow(build.distPath)
    const holding = (needle: string) =>
      files.filter((file) => readFileSync(join(build!.distPath, file)).includes(needle))

    // The control: the grep reads what the build wrote. The test bed's own
    // fixture names are in its pages.
    expect(holding('data-fixture').length).toBeGreaterThan(0)

    expect(holding(AGENT_PATH)).toEqual([])
    expect(holding(OVERLAY_TAG)).toEqual([])
    expect(holding(OVERLAY_GLOBAL)).toEqual([])
  }, 180_000)
})

/**
 * Loaded into every Node process `next dev` starts, through `NODE_OPTIONS`, and
 * so into the detached telemetry flush it spawns on shutdown: it writes down
 * which process it is in, and blackholes the flush's one request, to Vercel.
 */
const PRELOAD = `import { appendFileSync } from 'node:fs'
const log = process.env.POINTOUT_TEST_PROCESS_LOG
appendFileSync(log, process.pid + ' ' + process.argv.slice(1).join(' ') + '\\n')
const fetchFor = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.startsWith('https://telemetry.nextjs.org/')) {
    appendFileSync(log, process.pid + ' telemetry blackholed\\n')
    return Promise.reject(new Error('telemetry blackholed by the test'))
  }
  return fetchFor(input, init)
}
`

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(done: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms / 1000} s for ${what}`)
    await sleep(50)
  }
}

describe('next dev, stopped with SIGINT', () => {
  let app: TempApp | undefined
  let server: NextHarnessServer | undefined
  let flushPid: number | undefined
  afterEach(async () => {
    // Only what this test started: the server's group, then the flush.
    await server?.close()
    if (flushPid !== undefined && alive(flushPid)) process.kill(flushPid, 'SIGKILL')
    app?.cleanup()
    server = app = flushPid = undefined
  })

  it('leaves no process, socket, discovery entry or capture of pointout behind', async () => {
    // A throwaway app, so the flush names a directory no other server uses.
    app = createTempApp({ git: true }, 'next')
    const preload = join(app.playground, 'preload.mjs')
    const processLog = join(app.playground, 'processes.log')
    writeFileSync(preload, PRELOAD)
    writeFileSync(processLog, '')

    server = await startNextServer({
      app: app.appDir,
      // Telemetry on, so that Ctrl-C spawns Next's detached flush, which reads
      // the config again. `CI` keeps Next's telemetry settings in the output
      // folder rather than the developer's own preferences.
      telemetry: true,
      env: {
        CI: '1',
        NODE_OPTIONS: `--import ${preload}`,
        POINTOUT_TEST_PROCESS_LOG: processLog,
      },
    })
    const log = () => server!.log()

    // A Screen Capture, so there is a capture on disk to be removed.
    const captured = await fetch(server.url + '/__agent/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.url },
      body: JSON.stringify({
        rect: { x: 100, y: 200, width: 300, height: 150 },
        screenX: 50,
        screenY: 60,
        chromeWidth: 0,
        chromeHeight: 80,
        screen: { width: 1920, height: 1080 },
      }),
    })
    // The body too: a refusal says why, and a failure should show it.
    expect({
      status: captured.status,
      body: await captured.clone().text(),
    }).toMatchObject({
      status: 200,
    })

    const socket = /reply socket\s+bound at (\S+\.sock)/.exec(log())?.[1]
    const entry = /discovery entry\s+(\S+\.json)/.exec(log())?.[1]
    const captures = /temp directory\s+(\S+)/.exec(log())?.[1]
    expect({ socket, entry, captures, log: log() }).toMatchObject({
      socket: expect.any(String),
      entry: expect.any(String),
      captures: expect.any(String),
    })
    await until(() => readdirSync(captures!).length === 1, 'the capture to land')
    expect(existsSync(socket!)).toBe(true)
    expect(existsSync(entry!)).toBe(true)

    // Ctrl-C reaches the whole foreground process group.
    process.kill(-server.pid, 'SIGINT')
    await until(() => groupMembers(server!.pid).length === 0, 'the group to exit')

    // The flush left the group on purpose. It is found by what it wrote down,
    // and has to finish on its own: a pointout started inside it would hold it
    // open with its socket, and outlive the server.
    await until(
      () => /^(\d+) \S*detached-flush/m.test(readFileSync(processLog, 'utf8')),
      'the telemetry flush to start',
    )
    flushPid = Number(
      /^(\d+) \S*detached-flush/m.exec(readFileSync(processLog, 'utf8'))?.[1],
    )
    await until(() => !alive(flushPid!), 'the telemetry flush to exit')

    expect(existsSync(socket!)).toBe(false)
    expect(existsSync(entry!)).toBe(false)
    expect(existsSync(captures!)).toBe(false)
    // Nothing pointout serves from was left in the fixture's socket directory,
    // by the server or by the flush.
    expect(
      readdirSync(server.fixture.socketDir).filter((f) => f.endsWith('.sock')),
    ).toEqual([])
    expect(statSync(processLog).size).toBeGreaterThan(0)
  }, 60_000)
})
