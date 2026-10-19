// Seam 2's dev server: the same one seam 1 boots, on a fixed port, held open for
// the browser suite. Playwright's `globalSetup` rather than its `webServer`,
// because Playwright compiles this file's TypeScript and `node` on this repo's
// Node floor does not (see docs/agents/testing.md).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startExampleServer } from './dev-server.js'
import { repoRoot } from './paths.js'
import { clearDrainLock } from './drain-lock.js'
import { clearHotUpdateLock } from './hot-update-lock.js'
import { takeSeam2Lock } from './seam2-lock.js'
import { listeningSession } from './session-socket.js'
import { NEXT_URL_ENV } from './hosts.js'

export const SEAM2_PORT = Number(process.env.SEAM2_PORT ?? 5178)

/**
 * The fake session seam 2 addresses by default. Its pid is the `CLAUDE_PID` the
 * server is given, so it is the started-this-server preselect and the Overlay
 * needs no Target row to find it — and it is far above any pid this machine
 * hands out, so it can never collide with the dev server's own reply socket.
 */
const SESSION_PID = 400_001
const SESSION_NAME = 'seam 2 fake session'

/**
 * Three more sessions, so the Target row has something to choose between
 * (ticket 10): a second Candidate whose status went stale three days ago, one
 * blocked on a permission prompt, and one working in another checkout — which
 * is never a Candidate and must never appear in the Panel.
 */
const SECOND_PID = 400_002
const SECOND_NAME = 'seam 2 second session'
const WAITING_PID = 400_003
const WAITING_NAME = 'seam 2 waiting session'
const OTHER_REPO_PID = 400_004
const OTHER_REPO_NAME = 'seam 2 other repo session'

/**
 * A session only the report-back journeys address (ticket 14). An idle notice
 * from a Target offers back every Pick outstanding to it, and seam 2 runs its
 * specs in parallel against one server, so the journeys that end a turn on
 * purpose do it where no other spec has a Pick waiting.
 */
const REPORT_BACK_PID = 400_005
const REPORT_BACK_NAME = 'seam 2 report-back session'

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Where the frames land, one file per session a spec may address. A spec runs in
 * a worker process and the sockets are bound here, so a file is what the two
 * share; the paths are handed over in the environment, which workers inherit
 * when Playwright spawns them.
 */
const FRAMES_LOG_ENV = 'SEAM2_FRAMES_LOG'
const SECOND_FRAMES_LOG_ENV = 'SEAM2_SECOND_FRAMES_LOG'
const REPORT_BACK_FRAMES_LOG_ENV = 'SEAM2_REPORT_BACK_FRAMES_LOG'

/**
 * The hook discovery entry the posture block names, whose secret is the
 * drain's credential: a spec that drains reads it the way the CLI does.
 */
const DISCOVERY_ENTRY_ENV = 'SEAM2_DISCOVERY_ENTRY'

export default async function serveForSeam2(): Promise<() => Promise<void>> {
  // Before anything is booted: a second full seam 2 on this machine waits for
  // the first, whatever port it was given (seam2-lock.ts).
  const releaseLock = await takeSeam2Lock()
  // Held now, so nothing else can be using it: only a killed run's leftover.
  clearHotUpdateLock()
  clearDrainLock()

  let server
  try {
    server = await startExampleServer({ port: SEAM2_PORT, claudePid: SESSION_PID })
  } catch (error) {
    releaseLock()
    // The port is bound with `strictPort`, so a leftover dev server is a hard
    // failure rather than a silent attach to whatever is already there.
    throw new Error(
      `seam 2 could not bind 127.0.0.1:${SEAM2_PORT}. Something is already on ` +
        'that port — a dev server from an interrupted run, or a second seam-2 ' +
        'run. Close it, or set SEAM2_PORT to another port.',
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
      claudePid: SESSION_PID,
      env: server.fixture.env,
    })
  } catch (error) {
    await server.close()
    releaseLock()
    throw new Error('seam 2 could not start examples/next-app under next dev', {
      cause: error,
    })
  }
  process.env[NEXT_URL_ENV] = next.url

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
    `seam 2 dev server listening on ${server.url}, and next dev on ${next.url}\n`,
  )

  return async function stopServingSeam2() {
    try {
      for (const session of sessions) await session.close()
      await Promise.all([server.close(), next.close()])
    } finally {
      releaseLock()
    }
  }
}
