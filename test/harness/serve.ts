// Seam 2's dev server: the same one seam 1 boots, on a fixed port, held open for
// the browser suite. Playwright's `globalSetup` rather than its `webServer`,
// because Playwright compiles this file's TypeScript and `node` on this repo's
// Node floor does not (see docs/agents/testing.md).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startExampleServer } from './dev-server.js'
import { repoRoot } from './paths.js'
import { listeningSession } from './session-socket.js'

export const SEAM2_PORT = Number(process.env.SEAM2_PORT ?? 5178)

/**
 * The one fake session seam 2 addresses. Its pid is the `CLAUDE_PID` the server
 * is given, so it is the started-this-server preselect and the Overlay needs no
 * Target picker to find it — and it is far above any pid this machine hands out,
 * so it can never collide with the dev server's own reply socket.
 */
const SESSION_PID = 400_001
const SESSION_NAME = 'seam 2 fake session'

/**
 * Where the frames land. A spec runs in a worker process and the socket is bound
 * here, so the file is what the two share; its path is handed over in the
 * environment, which workers inherit when Playwright spawns them.
 */
const FRAMES_LOG_ENV = 'SEAM2_FRAMES_LOG'

export default async function serveForSeam2(): Promise<() => Promise<void>> {
  let server
  try {
    server = await startExampleServer({ port: SEAM2_PORT, claudePid: SESSION_PID })
  } catch (error) {
    // The port is bound with `strictPort`, so a leftover dev server is a hard
    // failure rather than a silent attach to whatever is already there.
    throw new Error(
      `seam 2 could not bind 127.0.0.1:${SEAM2_PORT}. Something is already on ` +
        'that port — a dev server from an interrupted run, or a second seam-2 ' +
        'run. Close it, or set SEAM2_PORT to another port.',
      { cause: error },
    )
  }

  const framesLog = join(server.fixture.dir, 'frames.ndjson')
  writeFileSync(framesLog, '')
  process.env[FRAMES_LOG_ENV] = framesLog

  // The session's cwd is this checkout, which is the root the example app's dev
  // server discovers, so it is a Candidate.
  const session = await listeningSession(server.fixture, {
    cwd: repoRoot,
    pid: SESSION_PID,
    name: SESSION_NAME,
    logFile: framesLog,
  })

  process.stdout.write(`seam 2 dev server listening on ${server.url}\n`)

  return async function stopServingSeam2() {
    await session.close()
    await server.close()
  }
}
