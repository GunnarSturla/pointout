import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  ENV_CLOCK_SKEW,
  ENV_CLOCK_SKEW_FILE,
  clockSkewFile,
  createFixtureEnv,
} from './fixture-env.js'
import type { FixtureEnv } from './fixture-env.js'
import type { LogEntry } from './logger.js'
import { nextAppRoot } from './paths.js'

// The Next.js half of the harness: `examples/next-app` under `next dev`, as a
// process of its own.
//
// It is never started in the test's own process. Next runs the app in a worker
// child it forks itself, and only that child carries `NEXT_PRIVATE_WORKER`, so
// a server started in-process would be the one shape pointout must refuse to
// act in (ticket 04). That changes how a test reaches it:
//
// - the fixture environment goes in through the child's environment, not by
//   patching `process.env`;
// - the port comes from the lock file Next writes, `<distDir>/dev/lock`;
// - the log is the child's stdout and stderr;
// - the clock moves through a file the server re-reads (`advanceClock`);
// - closing it ends its whole process group, and leaves nothing behind.
//
// Next allows one `next dev` per output folder, so each server gets its own,
// below the app's `.next/`. Like every harness module, this one imports Next
// (by resolving its bin), never `src/`.

export interface StartNextOptions {
  /** What Next binds to; loopback by default, as the Vite harness does. */
  host?: string
  /**
   * The port to bind; by default Next chooses one. Seam 2 names its own, so a
   * Playwright project can carry the Next page's origin as its `baseURL`.
   */
  port?: number
  /** Extra overrides for this server. */
  env?: Record<string, string>
  /** The pid the preselect should match. */
  claudePid?: number
  /** Record the subprocesses the server spawns. */
  gitShim?: boolean
  /**
   * Whether the app's config is wrapped in `withPointout()`, which it is by
   * default. False exports the bare config, to compare a page with and without.
   */
  pointout?: boolean
  /** Run `next dev --webpack` instead of Turbopack. */
  webpack?: boolean
  /**
   * Serve a copy of the app, beside it in `examples/`, so a test can edit the
   * copy's `next.config.ts` without restarting every other file's server.
   */
  copy?: boolean
  /**
   * Serve this app directory instead of `examples/next-app`: a throwaway
   * consumer written by temp-app.ts, whose config reads
   * `POINTOUT_EXAMPLE_DIST_DIR` the way the example's does. It has no
   * TypeScript, so no tsconfig is written for it.
   */
  app?: string
  /**
   * Leave Next's telemetry on, so that stopping the server spawns its detached
   * flush, which reads the config again. Off by default. A test that turns it
   * on must keep the flush off the network itself (next-lifecycle.test.ts).
   */
  telemetry?: boolean
}

/** A running `next dev`, read the way a test reads a Vite one. */
export interface NextHarnessServer {
  url: string
  port: number
  fixture: FixtureEnv
  /** Everything it printed, stdout and stderr, colour codes removed. */
  log(): string
  /**
   * The same, one entry per line. A line from stdout is `info` and one from
   * stderr is `warn`: Next's streams do not tell a warning from an error.
   */
  logEntries(): LogEntry[]
  /** The pid of `next dev`, which leads the process group `close()` ends. */
  pid: number
  /** Its output folder, relative to the app. */
  distDir: string
  /** The app it serves: `examples/next-app`, or the copy `copy` asked for. */
  appRoot: string
  close(): Promise<void>
}

const require = createRequire(import.meta.url)
const NEXT_BIN = require.resolve('next/dist/bin/next')

/** A cold `next dev` is ready in about a second; this bounds a stall. */
const BOOT_DEADLINE_MS = 60_000
/** SIGTERM runs Next's cleanup; after this, the group is killed outright. */
const TERM_GRACE_MS = 10_000
/** How long the group may take to be gone once it was killed. */
const KILL_DEADLINE_MS = 5_000

let started = 0

/** Start `examples/next-app` under `next dev`, with the harness faked. */
export async function startNextServer({
  host = '127.0.0.1',
  port: askedPort = 0,
  env = {},
  claudePid,
  gitShim = false,
  pointout = true,
  webpack = false,
  copy = false,
  app,
  telemetry = false,
}: StartNextOptions = {}): Promise<NextHarnessServer> {
  if (app !== undefined && copy) throw new Error('`app` and `copy` are exclusive')
  const fixture = createFixtureEnv({ claudePid, gitShim })
  const name = `harness-${process.pid}-${++started}`

  // A copy sits beside the app, at the same depth, so its imports of
  // `../shared` and the repository's `node_modules` resolve as the app's do.
  const appRoot =
    app ?? (copy ? join(nextAppRoot, '..', `.harness-next-${name}`) : nextAppRoot)
  if (copy) {
    cpSync(nextAppRoot, appRoot, {
      recursive: true,
      filter: (source) => !/[/\\](\.next|\.harness|next-env\.d\.ts)$/.test(source),
    })
  }

  const distDir = `.next/${name}`
  const distPath = join(appRoot, distDir)
  const lockFile = join(distPath, 'dev', 'lock')

  // Next rewrites the tsconfig it is handed to include this folder's types, so
  // each server gets one of its own (see next.config.ts). It must exist before
  // Next starts, because Turbopack reads it before Next would write it, and it
  // must sit outside `.next/`, where Turbopack does not find it.
  const tsconfigDir = join(appRoot, '.harness', name)
  const tsconfig = `.harness/${name}/tsconfig.json`
  rmSync(distPath, { recursive: true, force: true })
  if (app === undefined) {
    mkdirSync(tsconfigDir, { recursive: true })
    writeFileSync(
      join(appRoot, tsconfig),
      JSON.stringify({ extends: '../../tsconfig.json' }, null, 2) + '\n',
    )
  }

  // A skew file a dead process with this pid left behind is not this test's.
  if (process.env[ENV_CLOCK_SKEW] === undefined) rmSync(clockSkewFile, { force: true })

  const childEnv: Record<string, string> = {
    ...stringEntries(process.env),
    ...fixture.env,
    // This process's skew file, unless the test names a file of its own.
    [ENV_CLOCK_SKEW_FILE]: clockSkewFile,
    ...env,
    POINTOUT_EXAMPLE_DIST_DIR: distDir,
    ...(app === undefined && { POINTOUT_EXAMPLE_TSCONFIG: tsconfig }),
    // No detached telemetry flush outlives the server, and no test run reports
    // to Vercel, unless the test asked for the flush.
    ...(telemetry ? {} : { NEXT_TELEMETRY_DISABLED: '1' }),
    ...(pointout ? {} : { POINTOUT_EXAMPLE_WITHOUT_POINTOUT: '1' }),
  }
  // Vitest sets `test`; `next dev` warns about any value but its own.
  delete childEnv.NODE_ENV

  const args = [
    NEXT_BIN,
    'dev',
    '-H',
    host,
    '-p',
    String(askedPort),
    ...(webpack ? ['--webpack'] : []),
  ]
  const child = spawn(process.execPath, args, {
    cwd: appRoot,
    env: childEnv,
    // Its own process group, so `close()` reaches Next's worker and
    // Turbopack's pool along with it.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const pid = child.pid
  if (pid === undefined) {
    fixture.cleanup()
    throw new Error('next dev did not start: spawn returned no pid')
  }

  const lines: LogEntry[] = []
  record(child, 'stdout', 'info', lines)
  record(child, 'stderr', 'warn', lines)
  const log = () => lines.map((line) => line.message).join('\n')

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  let hasExited = false
  void exited.then(() => (hasExited = true))

  const cleanup = async () => {
    await endGroup(pid, exited, () => hasExited)
    killStragglers(distPath)
    rmSync(distPath, { recursive: true, force: true })
    rmSync(tsconfigDir, { recursive: true, force: true })
    if (copy) rmSync(appRoot, { recursive: true, force: true })
    fixture.cleanup()
  }

  let port: number
  try {
    port = await portFromLock(lockFile, () => hasExited, log)
    // Next writes its lock before it reads the config, and pointout starts
    // serving only once the config is read. Its posture block is the sign it
    // has, as `listen()` resolving is on Vite.
    if (pointout && !webpack) await untilLogged(POSTURE_HEADING, () => hasExited, log)
  } catch (error) {
    await cleanup()
    throw error
  }

  return {
    // The address it was told to bind, spelled for a URL; every interface is
    // dialled on loopback, in the family it was bound in.
    url: `http://${dialled(host)}:${port}`,
    port,
    fixture,
    log,
    logEntries: () => [...lines],
    pid,
    distDir,
    appRoot,
    close: cleanup,
  }
}

/** The line pointout's startup posture block opens with. */
const POSTURE_HEADING = 'pointout — startup posture'

/** Wait until the server has printed `text`, or fail with what it did print. */
async function untilLogged(
  text: string,
  hasExited: () => boolean,
  log: () => string,
): Promise<void> {
  const deadline = Date.now() + BOOT_DEADLINE_MS
  while (!log().includes(text)) {
    if (hasExited()) throw new Error(`next dev exited before printing ${text}:\n${log()}`)
    if (Date.now() > deadline) {
      throw new Error(
        `next dev printed no ${text} within ${BOOT_DEADLINE_MS / 1000} s:\n${log()}`,
      )
    }
    await sleep(50)
  }
}

function dialled(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '[::1]'
  return host.includes(':') ? `[${host}]` : host
}

/** Read the port out of Next's lock file, once Next has written it. */
async function portFromLock(
  lockFile: string,
  hasExited: () => boolean,
  log: () => string,
): Promise<number> {
  const deadline = Date.now() + BOOT_DEADLINE_MS
  while (Date.now() < deadline) {
    if (hasExited()) throw new Error(`next dev exited before it was ready:\n${log()}`)
    if (existsSync(lockFile)) {
      try {
        const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as { port?: unknown }
        if (typeof lock.port === 'number' && lock.port > 0) return lock.port
      } catch {
        // Read while it was being written; read it again.
      }
    }
    await sleep(100)
  }
  throw new Error(
    `next dev wrote no port to ${lockFile} within ${BOOT_DEADLINE_MS / 1000} s:\n${log()}`,
  )
}

/**
 * End the process group `pid` leads: SIGTERM first, which runs Next's own
 * cleanup, then SIGKILL for anything still in the group. It returns only once
 * nothing is left in it, or throws naming what is.
 */
async function endGroup(
  pid: number,
  exited: Promise<void>,
  hasExited: () => boolean,
): Promise<void> {
  signalGroup(pid, 'SIGTERM')
  await Promise.race([exited, sleep(TERM_GRACE_MS)])
  if (!hasExited() || groupMembers(pid).length > 0) signalGroup(pid, 'SIGKILL')

  const deadline = Date.now() + KILL_DEADLINE_MS
  while (groupMembers(pid).length > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `next dev's process group ${pid} still holds ${groupMembers(pid).join(', ')} ` +
          `${KILL_DEADLINE_MS / 1000} s after SIGKILL`,
      )
    }
    await sleep(50)
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone.
  }
}

/** The pids still in process group `pgid`. */
export function groupMembers(pgid: number): number[] {
  return processTable()
    .filter((row) => row.pgid === pgid)
    .map((row) => row.pid)
}

/** The pids of every process whose command line names `text`. */
export function processesNaming(text: string): number[] {
  return processTable()
    .filter((row) => row.command.includes(text))
    .map((row) => row.pid)
}

/**
 * Anything that left the group and still names this server's output folder,
 * as a detached telemetry flush would, is this server's and is killed.
 * Telemetry is off, so this is a backstop, and the folder's name is unique to
 * this server, so nothing else on the machine is touched.
 */
function killStragglers(distPath: string): void {
  for (const pid of processesNaming(distPath)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone between the listing and the kill.
    }
  }
}

function processTable(): { pid: number; pgid: number; command: string }[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,command='], {
    encoding: 'utf8',
  })
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, pid, pgid, command]) => ({
      pid: Number(pid),
      pgid: Number(pgid),
      command: command ?? '',
    }))
}

/** Record a stream line by line, colour codes stripped. */
function record(
  child: ChildProcess,
  stream: 'stdout' | 'stderr',
  level: LogEntry['level'],
  lines: LogEntry[],
): void {
  let partial = ''
  child[stream]?.setEncoding('utf8')
  child[stream]?.on('data', (chunk: string) => {
    const text = partial + chunk
    const complete = text.split('\n')
    partial = complete.pop() ?? ''
    for (const line of complete) lines.push({ level, message: plain(line) })
  })
  child[stream]?.on('end', () => {
    if (partial) lines.push({ level, message: plain(partial) })
    partial = ''
  })
}

// The ANSI sequences Next colours its log with.
const ANSI = new RegExp(String.raw`\u001b\[[0-9;?]*[A-Za-z]`, 'g')

function plain(line: string): string {
  return line.replace(ANSI, '')
}

function stringEntries(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env))
    if (value !== undefined) out[key] = value
  return out
}
