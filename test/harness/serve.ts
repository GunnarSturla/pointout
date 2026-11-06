// The browser suite's dev server: the same one the server suite boots, on a fixed port,
// held open for the run. Playwright's `globalSetup` rather than its `webServer`,
// because Playwright compiles this file's TypeScript and `node` on this repo's
// Node floor does not (see docs/agents/testing.md).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startExampleServer } from './dev-server.js'
import { repoRoot } from './paths.js'
import { clearDrainLock } from './drain-lock.js'
import { clearHotUpdateLock } from './hot-update-lock.js'
import { takeBrowserLock } from './browser-lock.js'
import { listeningSession } from './session-socket.js'
import { NEXT_URL_ENV, BROWSER_NEXT_PORT, BROWSER_PORT } from './hosts.js'

export { BROWSER_PORT }

/**
 * The fake session the browser suite addresses by default. Its pid is the `CLAUDE_PID` the
 * server is given, so it is the started-this-server preselect and the Overlay
 * needs no Target row to find it — and it is far above any pid this machine
 * hands out, so it can never collide with the dev server's own reply socket.
 */
const SESSION_PID = 400_001
const SESSION_NAME = 'the browser suite fake session'

/**
 * Three more sessions, so the Target row has something to choose between
 * (ticket 10): a second Candidate whose status went stale three days ago, one
 * blocked on a permission prompt, and one working in another checkout — which
 * is never a Candidate and must never appear in the Panel.
 */
const SECOND_PID = 400_002
const SECOND_NAME = 'the browser suite second session'
const WAITING_PID = 400_003
const WAITING_NAME = 'the browser suite waiting session'
const OTHER_REPO_PID = 400_004
const OTHER_REPO_NAME = 'the browser suite other repo session'

/**
 * A session only the report-back journeys address (ticket 14). An idle notice
 * from a Target offers back every Pick outstanding to it, and the browser suite runs its
 * specs in parallel against one server, so the journeys that end a turn on
 * purpose do it where no other spec has a Pick waiting.
 */
const REPORT_BACK_PID = 400_005
const REPORT_BACK_NAME = 'browser-suite report-back session'

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Where the frames land, one file per session a spec may address. A spec runs in
 * a worker process and the sockets are bound here, so a file is what the two
 * share; the paths are handed over in the environment, which workers inherit
 * when Playwright spawns them.
 */
const FRAMES_LOG_ENV = 'BROWSER_FRAMES_LOG'
const SECOND_FRAMES_LOG_ENV = 'BROWSER_SECOND_FRAMES_LOG'
const REPORT_BACK_FRAMES_LOG_ENV = 'BROWSER_REPORT_BACK_FRAMES_LOG'

/**
 * The hook discovery entry the posture block names, whose secret is the
 * drain's credential: a spec that drains reads it the way the CLI does.
 */
const DISCOVERY_ENTRY_ENV = 'BROWSER_DISCOVERY_ENTRY'
/** The same, for the Next.js test bed's server, whose secret is its own. */
const NEXT_DISCOVERY_ENTRY_ENV = 'BROWSER_NEXT_DISCOVERY_ENTRY'

export default async function serveForBrowserSuite(): Promise<() => Promise<void>> {
  // Before anything is booted: a second full browser suite on this machine waits for
  // the first, whatever port it was given (browser-lock.ts).
  const releaseLock = await takeBrowserLock()
  // Held now, so nothing else can be using it: only a killed run's leftover.
  clearHotUpdateLock()
  clearDrainLock()

  let server
  try {
    server = await startExampleServer({ port: BROWSER_PORT, claudePid: SESSION_PID })
  } catch (error) {
    releaseLock()
    // The port is bound with `strictPort`, so a leftover dev server is a hard
    // failure rather than a silent attach to whatever is already there.
    throw new Error(
      `the browser suite could not bind 127.0.0.1:${BROWSER_PORT}. Something is already on ` +
        'that port — a dev server from an interrupted run, or a second browser-suite ' +
        'run. Close it, or set BROWSER_PORT to another port.',
      { cause: error },
    )
  }

  // The Next.js test bed boots after it, in a process of its own, on a port
  // Next chooses; a spec reaches it through `hostURL('next', …)` (hosts.ts). It
  // is handed Vite's fixture environment, so both Hosts read one registry and
  // one socket folder, and every session below is a Candidate on either — a
  // spec parameterized by Host addresses the same sessions on both.
  let next
  try {
    next = await startExampleServer({
      on: 'next',
      port: BROWSER_NEXT_PORT,
      claudePid: SESSION_PID,
      env: server.fixture.env,
    })
    if (next.port !== BROWSER_NEXT_PORT) {
      await next.close()
      throw new Error(`next dev bound ${next.port}, not ${BROWSER_NEXT_PORT}`)
    }
  } catch (error) {
    await server.close()
    releaseLock()
    throw new Error(
      `the browser suite could not start examples/next-app under next dev on ` +
        `127.0.0.1:${BROWSER_NEXT_PORT}. Close what is on that port, or set ` +
        'BROWSER_NEXT_PORT to another port.',
      {
        cause: error,
      },
    )
  }
  process.env[NEXT_URL_ENV] = next.url
  // A run Playwright ends at its `globalTimeout` runs no teardown, and Next is
  // a detached process group of its own, so it would outlive the run and hold
  // `BROWSER_NEXT_PORT` against the next one (measured, ticket 06). The runner's
  // own exit ends the group; after a teardown that closed it, this finds nothing.
  const nextGroup = next.pid
  process.once('exit', () => {
    try {
      process.kill(-nextGroup, 'SIGKILL')
    } catch {
      // Already gone.
    }
  })

  const framesLog = join(server.fixture.dir, 'frames.ndjson')
  const secondFramesLog = join(server.fixture.dir, 'frames-second.ndjson')
  const reportBackFramesLog = join(server.fixture.dir, 'frames-report-back.ndjson')
  for (const log of [framesLog, secondFramesLog, reportBackFramesLog]) {
    writeFileSync(log, '')
  }
  process.env[FRAMES_LOG_ENV] = framesLog
  process.env[SECOND_FRAMES_LOG_ENV] = secondFramesLog
  process.env[REPORT_BACK_FRAMES_LOG_ENV] = reportBackFramesLog
  const discovery = /discovery entry\s+(\S+\.json)/.exec(server.log())?.[1]
  if (!discovery) throw new Error(`no discovery entry line in:\n${server.log()}`)
  process.env[DISCOVERY_ENTRY_ENV] = discovery
  const nextDiscovery = /discovery entry\s+(\S+\.json)/.exec(next.log())?.[1]
  if (!nextDiscovery) throw new Error(`no discovery entry line in:\n${next.log()}`)
  process.env[NEXT_DISCOVERY_ENTRY_ENV] = nextDiscovery

  // Each session's cwd is this checkout, which is the root the example app's dev
  // server discovers, so each is a Candidate — except the last, which works
  // somewhere else and is what proves the Panel never offers another checkout.
  const sessions = await Promise.all([
    listeningSession(server.fixture, {
      cwd: repoRoot,
      pid: SESSION_PID,
      name: SESSION_NAME,
      logFile: framesLog,
    }),
    listeningSession(server.fixture, {
      cwd: repoRoot,
      pid: SECOND_PID,
      name: SECOND_NAME,
      statusUpdatedAt: new Date(Date.now() - THREE_DAYS_MS).toISOString(),
      logFile: secondFramesLog,
    }),
    listeningSession(server.fixture, {
      cwd: repoRoot,
      pid: WAITING_PID,
      name: WAITING_NAME,
      status: 'waiting',
      waitingFor: 'Bash(rm -rf build)',
    }),
    listeningSession(server.fixture, {
      cwd: server.fixture.dir,
      pid: OTHER_REPO_PID,
      name: OTHER_REPO_NAME,
    }),
    listeningSession(server.fixture, {
      cwd: repoRoot,
      pid: REPORT_BACK_PID,
      name: REPORT_BACK_NAME,
      logFile: reportBackFramesLog,
    }),
  ])

  process.stdout.write(
    `the browser suite dev server listening on ${server.url}, and next dev on ${next.url}\n`,
  )

  return async function stopServingBrowserSuite() {
    try {
      for (const session of sessions) await session.close()
      await Promise.all([server.close(), next.close()])
    } finally {
      releaseLock()
    }
  }
}
