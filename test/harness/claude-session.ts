import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createNetServer, connect } from 'node:net'
import type { Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import { createRecordingLogger } from './logger.js'
import { exampleAppRoot, repoRoot } from './paths.js'

// Seam 3's fixture code: a real, throwaway Claude Code session, and the real
// dev server beside it. Nothing here is faked — the registry is the user's own
// `~/.claude/sessions/`, the sockets are the harness's own `/tmp/cc-socks/`.
//
// The pty launcher follows spike 07's `launch.py` (the reference; nothing is
// imported from any spike directory): `claude` refuses to run interactively
// without a terminal, and Node has none to give it, so a few lines of Python's
// standard `pty` module hold one open. It is a string here, not a file, because
// everything in this repository is TypeScript; `python3 -c` runs it.
//
// The safety rules (spec, *Testing Decisions*, seam 3) live in this file, each
// where it bites:
//
// - the environment is scrubbed of every `CLAUDE*` variable, so the session
//   registers as a peer rather than as a silent child (`scrubbedEnv`);
// - only the pid this file spawned is ever read, written to or signalled — and
//   it is signalled through its own launcher, which is this process's child and
//   so cannot have been reused; only if the launcher itself had to be killed is
//   the session signalled directly, and only while it is still alive, which is
//   while its pid is still its own (`ThrowawaySession.stop`);
// - a probe socket never binds over a path the registry names (`bindProbe`);
// - the peer token is read only to be written to the session's own socket, and
//   never returned, logged or put in a message; a session with no token is not
//   written to at all (`ThrowawaySession.send`);
// - the session is killed on exit and its registry entry, key file and socket
//   are checked gone (`ThrowawaySession.stop`);
// - the temporary directory is never a real repository's worktree root
//   (`refuseRealWorktree`).
//
// And one rule of its own: the throwaway session is pointed at a loopback port
// this file holds and that answers nothing (`ANTHROPIC_BASE_URL`), so a turn it
// is made to take in the no-model tier reaches no model and spends nothing.
// Only the model tier (ticket 21) launches without it, and it has to pass its
// own flags (`modelTierArgs`) to do so: a safe-mode launch refuses to start
// unpointed.

/** Where the harness keeps its session entries and key files. */
export const REGISTRY_DIR = join(homedir(), '.claude', 'sessions')
/** Where the harness keeps its inbox sockets. */
export const SOCKET_DIR = '/tmp/cc-socks'
/** Where the harness keeps transcripts, one directory per cwd. */
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

const SCRATCH_PREFIX = 'vite-agent-inspect-seam3-'

// ---------------------------------------------------------------------------
// Can this machine run seam 3 at all?
// ---------------------------------------------------------------------------

export type Preflight =
  | { runnable: true; version: string }
  | { runnable: false; reason: string }

/**
 * Whether the `claude` CLI is on `PATH` and logged in. `claude auth status`
 * answers JSON that names the account; only its `loggedIn` is read, and none
 * of it is ever printed.
 */
export function preflight(): Preflight {
  const env = scrubbedEnv()
  let version: string
  try {
    version = execFileSync('claude', ['--version'], { env, encoding: 'utf8' }).trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { runnable: false, reason: 'the `claude` CLI is not on PATH' }
    }
    return { runnable: false, reason: '`claude --version` failed' }
  }

  let status: string
  try {
    status = execFileSync('claude', ['auth', 'status'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    // It exits non-zero when nobody is logged in.
    return {
      runnable: false,
      reason: 'no Claude Code login (`claude auth status` failed)',
    }
  }
  let loggedIn = false
  try {
    loggedIn = (JSON.parse(status) as { loggedIn?: unknown }).loggedIn === true
  } catch {
    return {
      runnable: false,
      reason: '`claude auth status` did not answer JSON, so a login cannot be told',
    }
  }
  if (!loggedIn) {
    return { runnable: false, reason: 'no Claude Code login (`claude auth status`)' }
  }
  return { runnable: true, version }
}

// ---------------------------------------------------------------------------
// The environment
// ---------------------------------------------------------------------------

/**
 * This process's environment with every `CLAUDE*` variable removed —
 * `CLAUDE_CODE_CHILD_SESSION` above all, which makes a session never register —
 * and every `VITE_AGENT_INSPECT_*` override too, since seam 3 fakes nothing.
 * `extra` is applied last: it is how a canary deliberately puts one back.
 */
export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isScrubbed(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

/** A variable seam 3 never hands on: the harness's own, and this plugin's overrides. */
function isScrubbed(name: string): boolean {
  return name.startsWith('CLAUDE') || name.startsWith('VITE_AGENT_INSPECT_')
}

/** Whether a pid is still a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The scratch repository
// ---------------------------------------------------------------------------

/**
 * Refuse a directory that is, or sits inside, a real git worktree. The scratch
 * repository is `git init`ed and a Claude session is started in it; neither
 * may ever happen in somebody's checkout.
 */
export function refuseRealWorktree(dir: string): void {
  const resolved = realpathSync(dir)
  let top: string
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolved,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return // Not inside any repository, which is the ordinary case.
  }
  const root = realpathSync(top)
  if (root === resolved) {
    throw new Error(
      `seam 3 refuses to start: its temporary directory ${resolved} is the root of a ` +
        'real worktree, and the suite would start a Claude session and a dev server in it',
    )
  }
  throw new Error(
    `seam 3 refuses to start: its temporary directory ${resolved} lies inside the real ` +
      `worktree ${root}`,
  )
}

export interface ScratchRepo {
  /** The repository root, resolved: the session's cwd and the dev server's root. */
  dir: string
  cleanup(): void
}

/**
 * A temporary git repository holding a copy of the example app, with the
 * repository's own `node_modules` linked in so Vite can resolve the plugin and
 * React the way the example app does.
 */
export function createScratchRepo(): ScratchRepo {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), SCRATCH_PREFIX)))
  refuseRealWorktree(dir)

  cpSync(exampleAppRoot, dir, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|dist)$/.test(source),
  })
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'dir')
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n')

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=seam 3', '-c', 'user.email=seam3@localhost', ...args],
      { cwd: dir, stdio: 'ignore' },
    )
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'seam 3 scratch copy of the example app')

  return {
    dir,
    cleanup() {
      // Only ever the directory made above.
      if (basename(dir).startsWith(SCRATCH_PREFIX)) {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// The model blackhole
// ---------------------------------------------------------------------------

export interface Blackhole {
  /** `http://127.0.0.1:<port>`, for `ANTHROPIC_BASE_URL`. */
  url: string
  /** How many connections it has refused to answer. */
  connections(): number
  close(): Promise<void>
}

/**
 * A loopback port that accepts a connection and drops it unread. Whatever the
 * session sends there — a request for a model turn included — goes nowhere,
 * and the count is how a canary sees that it went there rather than to a real
 * endpoint. Nothing that arrives is read, so no credential is ever held.
 */
export async function openBlackhole(): Promise<Blackhole> {
  let count = 0
  const server: Server = createNetServer((socket) => {
    count += 1
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address !== 'object')
    throw new Error('the blackhole has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    connections: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// ---------------------------------------------------------------------------
// The throwaway session
// ---------------------------------------------------------------------------

/**
 * Spike 07's launcher, re-written: `claude` on a pty, its output to stdout
 * after one line naming its pid, stdin forwarded to the terminal. On SIGTERM,
 * or when its stdin closes because the caller has gone, it stops the session it
 * started — gently, then not — and exits, so the caller only ever signals its
 * own child.
 */
const PTY_LAUNCHER = String.raw`
import os, sys, pty, select, signal, subprocess, fcntl, termios, struct, time
cwd, args = sys.argv[1], sys.argv[2:]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
p = subprocess.Popen(["claude"] + args, cwd=cwd, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
sys.stdout.buffer.write(("%d\n" % p.pid).encode()); sys.stdout.flush()
stopping = []
signal.signal(signal.SIGTERM, lambda *_: stopping.append(time.time()))
fds = [master, 0]
terminated = None
while p.poll() is None:
    # Asked to stop: terminate once, then keep draining the terminal so the
    # session can write its goodbye and unregister, and kill it only if it has
    # not gone within ten seconds.
    if stopping and terminated is None:
        p.terminate()
        terminated = time.time()
    if terminated is not None and time.time() - terminated > 10:
        p.kill()
    try:
        r, _, _ = select.select(fds, [], [], 0.2)
    except (OSError, InterruptedError):
        continue
    if master in r:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data:
            sys.stdout.buffer.write(data); sys.stdout.flush()
        else:
            fds = [f for f in fds if f != master]
    if 0 in r:
        data = os.read(0, 65536)
        if data:
            os.write(master, data)
        else:
            # The caller has gone. The session goes with it, never orphaned.
            fds = [f for f in fds if f != 0]
            stopping.append(time.time())
p.wait()
sys.stderr.write("claude exited %s\n" % p.returncode)
`

export interface LaunchOptions {
  cwd: string
  /**
   * Where a model turn would go: the blackhole's url. Omitted only by the model
   * tier, which is the one place a turn is meant to reach a real model; the
   * harness then uses its own endpoint, and nothing here names it.
   */
  modelUrl?: string
  /**
   * The flags `claude` runs with. The no-model tier's (`NO_MODEL_ARGS`) switch
   * every customization off; the model tier needs hooks, the skill and a shell,
   * so it passes its own.
   */
  args?: string[]
  /** Put back variables the scrub removed — only to prove what the scrub is for. */
  env?: Record<string, string>
}

/**
 * The no-model tier's flags. Everything that is not the harness itself is
 * switched off: no hooks, plugins, MCP servers, CLAUDE.md or tools, and the
 * cheapest model in case a turn ever did get past the blackhole.
 */
export const NO_MODEL_ARGS = [
  '--safe-mode',
  '--strict-mcp-config',
  '--tools',
  '',
  '--model',
  'haiku',
]

/**
 * The model tier's flags (ticket 21), with `extra` after them. Hooks, the
 * project's skill and a shell have to be on, which is what `--safe-mode` and
 * `--tools ""` switch off, so both are gone. What is kept off instead: every
 * MCP server; the user's own settings — their hooks, plugins, permissions and
 * default permission mode — so only the scratch project's `.claude/` and what
 * `extra` hands over apply; and every tool but the three a Pick needs. The
 * permission mode is stated: `manual` is what 2.1.280 calls the mode the spec
 * calls *default*. And the model is the cheapest.
 */
export function modelTierArgs(...extra: string[]): string[] {
  return [
    '--strict-mcp-config',
    '--setting-sources',
    'project,local',
    '--permission-mode',
    'manual',
    '--model',
    'haiku',
    '--tools',
    'Bash,Read,Skill',
    ...extra,
  ]
}

/** A registry entry, as the harness writes it. Fields are read, not typed away. */
export type RegistryEntry = Record<string, unknown>

/** What one of the session's key files holds, with the token itself withheld. */
export interface KeyFileShape {
  name: string
  hasPeerToken: boolean
}

export interface Leftovers {
  entry: boolean
  keyFile: boolean
  socket: boolean
}

export interface ThrowawaySession {
  pid: number
  /** Every environment variable name the session was started with. */
  envNames: string[]
  /** The terminal's output so far, escapes stripped and whitespace removed. */
  screen(): string
  /** The end of the terminal, readable, for a failure message or a measurement. */
  lastShown(chars?: number): string
  /** Type into the terminal. */
  press(keys: string): void
  /** This session's registry entry, or null while there is none. */
  entry(): RegistryEntry | null
  keyFile(): KeyFileShape | null
  socketExists(): boolean
  /**
   * Wait until the session is past its first-run prompts and up, answering the
   * folder-trust prompt with *Yes* on the way. Up is the safe-mode banner when
   * the session runs in safe mode, and otherwise a registry entry carrying its
   * `status`, which the harness writes only once the folder is trusted.
   */
  ready(timeoutMs?: number): Promise<void>
  /**
   * Every line of this session's transcript on disk, parsed, oldest first. An
   * empty list while there is none.
   */
  transcript(): Array<Record<string, unknown>>
  /**
   * Write frames to this session's own socket, the auth line first. The token
   * is read here and goes nowhere else.
   */
  send(frames: Array<Record<string, unknown>>): Promise<void>
  /** Whether `text` contains this session's peer token. For the no-leak check. */
  leaksToken(text: string): boolean
  /**
   * Stop the session through its launcher, wait, and report what the harness
   * left behind for this pid. Anything left is then removed — only this pid's —
   * so a failed run does not litter the real registry.
   */
  stop(): Promise<Leftovers>
}

/** What `--safe-mode` prints once the session is up, whitespace removed. */
const READY_BANNER = 'Safemode:allcustomizationsaredisabled'

/**
 * Where the folder-trust prompt's cursor is in the latest render, or null when
 * the prompt is not showing. The screen is read with whitespace removed.
 */
function trustCursor(shown: string): 'yes' | 'no' | null {
  const yes = shown.lastIndexOf('❯Yes,Itrustthisfolder')
  const no = shown.lastIndexOf('❯No,exit')
  if (yes === -1 && no === -1) return null
  return yes > no ? 'yes' : 'no'
}

/**
 * A terminal's escape sequences: OSC (titles, links), CSI (cursor, colour) and
 * the short ones. Built from its two control characters by name, because the
 * lint gate refuses them in a regex literal and matching them is the point here.
 */
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const ESCAPES = new RegExp(
  [
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`,
    `${ESC}[()][0-9A-Za-z]`,
    `${ESC}[=>78]`,
  ].join('|'),
  'g',
)

export async function launchSession({
  cwd,
  modelUrl,
  args = NO_MODEL_ARGS,
  env = {},
}: LaunchOptions): Promise<ThrowawaySession> {
  const sessionEnv = scrubbedEnv({
    ...(modelUrl === undefined ? {} : { ANTHROPIC_BASE_URL: modelUrl }),
    ...env,
  })
  // A turn meant for the blackhole may not run without one: a safe-mode launch
  // — the no-model tier's — with no blackhole would be a no-model tier that
  // spends.
  const safeMode = args.includes('--safe-mode')
  if (safeMode && modelUrl === undefined) {
    throw new Error('a safe-mode session launches only with a blackhole to point at')
  }
  // Transcripts live in a directory named for a cwd, but not always this one:
  // a session started in a subdirectory of a repository may file its
  // transcript under the root's. So the directories there now are noted, and
  // the transcript is found by this session's id wherever it lands.
  const transcriptDir = join(PROJECTS_DIR, mangle(cwd))
  const projectDirsBefore = new Set(
    existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR) : [],
  )

  const launcher: ChildProcessWithoutNullStreams = spawn(
    'python3',
    ['-c', PTY_LAUNCHER, cwd, ...args],
    { env: sessionEnv, stdio: ['pipe', 'pipe', 'pipe'] },
  )

  let raw = ''
  let exited = false
  const exit = new Promise<void>((resolve) =>
    launcher.once('exit', () => {
      exited = true
      resolve()
    }),
  )
  const pid = await new Promise<number>((resolve, reject) => {
    let head = ''
    const onData = (chunk: Buffer) => {
      head += chunk.toString('utf8')
      const newline = head.indexOf('\n')
      if (newline === -1) return
      launcher.stdout.off('data', onData)
      raw += head.slice(newline + 1)
      launcher.stdout.on('data', (more: Buffer) => (raw += more.toString('utf8')))
      resolve(Number(head.slice(0, newline)))
    }
    launcher.stdout.on('data', onData)
    launcher.once('error', (error) =>
      reject(new Error(`the pty launcher could not start (python3): ${error.message}`)),
    )
    launcher.once('exit', (code) =>
      reject(new Error(`the pty launcher exited (${code}) before naming a pid`)),
    )
  })
  let launcherErr = ''
  launcher.stderr.on('data', (chunk: Buffer) => (launcherErr += chunk.toString('utf8')))

  const entryPath = join(REGISTRY_DIR, `${pid}.json`)
  const socketPath = join(SOCKET_DIR, `${pid}.sock`)
  const keyName = () =>
    readdirSync(REGISTRY_DIR).find((f) => f.startsWith(`${pid}.`) && f.endsWith('.key'))
  const readKey = (): Record<string, unknown> | null => {
    const name = keyName()
    if (!name) return null
    try {
      return JSON.parse(readFileSync(join(REGISTRY_DIR, name), 'utf8')) as Record<
        string,
        unknown
      >
    } catch {
      return null
    }
  }
  const screen = () => raw.replace(ESCAPES, '').replace(/\s+/g, '')
  /** Kept once seen, so the transcript can still be read after the entry has gone. */
  let knownSessionId: unknown

  const session: ThrowawaySession = {
    pid,
    envNames: Object.keys(sessionEnv),
    screen,
    lastShown: (chars) => lastShown(chars),
    press(keys) {
      if (!exited) launcher.stdin.write(keys)
    },

    entry() {
      try {
        const entry = JSON.parse(readFileSync(entryPath, 'utf8')) as RegistryEntry
        if (typeof entry.sessionId === 'string') knownSessionId = entry.sessionId
        return entry
      } catch {
        return null
      }
    },

    keyFile() {
      const name = keyName()
      const key = readKey()
      if (!name || !key) return null
      return {
        name,
        hasPeerToken: typeof key.peerToken === 'string' && key.peerToken.length > 0,
      }
    },

    socketExists: () => existsSync(socketPath),

    transcript() {
      // The entry names the transcript; once it has gone, the last id it named.
      const sessionId = session.entry()?.sessionId ?? knownSessionId
      if (typeof sessionId !== 'string') return []
      const path = transcriptPath(sessionId)
      if (path === null) return []
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        return []
      }
      const lines: Array<Record<string, unknown>> = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // The last line, half-written as it is read. The next read has it.
        }
      }
      return lines
    },

    async ready(timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs
      // The trust prompt opens on *No, exit*, and Enter on that ends the
      // session. It can also redraw itself back onto *No* while it settles, so
      // the cursor is read off the latest render each time round, Down is
      // pressed while it is on *No*, and Enter only once it has sat on *Yes*
      // for a moment. A directory already trusted skips the prompt entirely.
      let promptSince: number | null = null
      let yesSince: number | null = null
      let lastDown = 0
      let entered = false
      while (Date.now() < deadline) {
        if (exited) {
          throw new Error(
            `the throwaway session exited before it was ready (${launcherErr.trim()}); ` +
              `its terminal last showed: ${lastShown()}`,
          )
        }
        const shown = screen()
        // Out of safe mode the entry is the marker, and only a whole one: the
        // harness writes it first without `status`, and fills that in after.
        if (safeMode ? shown.includes(READY_BANNER) : hasStatus(session.entry())) return
        const cursor = trustCursor(shown)
        const now = Date.now()
        if (cursor !== null && !entered) {
          promptSince ??= now
          if (cursor === 'no') {
            yesSince = null
            if (now - promptSince > 1000 && now - lastDown > 500) {
              session.press('\x1b[B')
              lastDown = now
            }
          } else {
            yesSince ??= now
            if (now - yesSince > 400) {
              session.press('\r')
              entered = true
            }
          }
        }
        await sleep(100)
      }
      throw new Error(
        `the throwaway session did not come up within ${timeoutMs}ms: either the ` +
          'folder-trust prompt no longer reads "Yes, I trust this folder", or ' +
          (safeMode
            ? 'the safe-mode banner no longer reads "Safe mode: all customizations are disabled"; '
            : 'the trusted session never wrote a registry entry carrying `status`; ') +
          `its terminal last showed: ${lastShown()}`,
      )
    },

    async send(frames) {
      const entry = session.entry()
      const path = entry?.messagingSocketPath
      if (typeof path !== 'string') {
        throw new Error(`pid ${pid} has no messagingSocketPath to write to`)
      }
      // Only this pid's socket, and only while its entry still names our cwd.
      if (entry?.pid !== pid || entry?.cwd !== cwd || path !== socketPath) {
        throw new Error(
          `refusing to write: the entry for pid ${pid} is not this session's, or ` +
            `names a socket other than ${socketPath}`,
        )
      }
      const token = readKey()?.peerToken
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error(`refusing to write: pid ${pid} has no readable peerToken`)
      }
      const lines = [{ type: 'auth', token }, ...frames].map(
        (frame) => JSON.stringify(frame) + '\n',
      )
      await new Promise<void>((resolve, reject) => {
        const socket = connect(path)
        socket.setTimeout(2000, () => {
          socket.destroy()
          reject(new Error(`no answer from ${path} within 2000ms`))
        })
        socket.once('error', (error) =>
          reject(new Error(`writing to ${path}: ${error.message}`)),
        )
        socket.once('connect', () => {
          for (const line of lines) socket.write(line)
          socket.end(() => resolve())
        })
      })
    },

    leaksToken(text) {
      const token = readKey()?.peerToken
      return typeof token === 'string' && token.length > 0 && text.includes(token)
    },

    async stop() {
      if (!exited) launcher.kill('SIGTERM')
      await Promise.race([exit, sleep(15_000)])
      if (!exited) {
        launcher.kill('SIGKILL')
        await exit
      }
      // The launcher is gone. If it went by SIGKILL, the session it started
      // (in a process group of its own) may have outlived it; that pid is still
      // the one spawned here for as long as it is alive, so it is safe to end.
      if (alive(pid)) {
        process.kill(pid, 'SIGKILL')
        await until(() => (alive(pid) ? null : true), 5000)
      }
      if (alive(pid)) {
        throw new Error(
          `the throwaway session (pid ${pid}) would not die; it is still running`,
        )
      }
      // The harness unregisters on the way out; give its unlinks a moment.
      const deadline = Date.now() + 5000
      let left: Leftovers = leftovers()
      while ((left.entry || left.keyFile || left.socket) && Date.now() < deadline) {
        await sleep(100)
        left = leftovers()
      }
      removeLeftovers()
      // Only a directory this launch created, and only one named for a
      // scratch repository: a transcript directory that was there before is
      // somebody else's, and is left alone.
      const path =
        typeof knownSessionId === 'string' ? transcriptPath(knownSessionId) : null
      for (const dir of new Set([transcriptDir, ...(path ? [dirname(path)] : [])])) {
        const name = basename(dir)
        if (!projectDirsBefore.has(name) && name.includes(SCRATCH_PREFIX)) {
          rmSync(dir, { recursive: true, force: true })
        }
      }
      return left
    },
  }

  /** The end of the terminal, readable, for a failure message. */
  function lastShown(chars = 600): string {
    return raw.replace(ESCAPES, ' ').replace(/\s+/g, ' ').slice(-chars)
  }

  /** Where this session's transcript is, looked for by its own id only. */
  function transcriptPath(sessionId: string): string | null {
    const own = join(transcriptDir, `${sessionId}.jsonl`)
    if (existsSync(own)) return own
    if (!existsSync(PROJECTS_DIR)) return null
    for (const dir of readdirSync(PROJECTS_DIR)) {
      if (!dir.includes(SCRATCH_PREFIX)) continue
      const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  function leftovers(): Leftovers {
    return {
      entry: existsSync(entryPath),
      keyFile: keyName() !== undefined,
      socket: existsSync(socketPath),
    }
  }

  function removeLeftovers() {
    const name = keyName()
    for (const path of [entryPath, socketPath, name ? join(REGISTRY_DIR, name) : null]) {
      if (path && existsSync(path)) unlinkSync(path)
    }
  }

  return session
}

// ---------------------------------------------------------------------------
// A probe address in the harness's socket namespace
// ---------------------------------------------------------------------------

export interface Probe {
  /** `uds:<path>` — what a frame's `from` carries. */
  address: string
  /** Every JSON frame received, oldest first. */
  frames(): Array<Record<string, unknown>>
  /** The first frame matching, or null once `timeoutMs` has passed. */
  waitFor(
    match: (frame: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown> | null>
  close(): Promise<void>
}

/** Every socket path any registry entry names. */
export function claimedSocketPaths(): Set<string> {
  const claimed = new Set<string>()
  for (const name of readdirSync(REGISTRY_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const entry = JSON.parse(readFileSync(join(REGISTRY_DIR, name), 'utf8')) as {
        messagingSocketPath?: unknown
      }
      if (typeof entry.messagingSocketPath === 'string') {
        claimed.add(entry.messagingSocketPath)
      }
    } catch {
      // Half-written or not ours to understand; its path is not claimed by it.
    }
  }
  return claimed
}

/**
 * A listening socket beside the harness's own, so the raw frames the harness
 * sends back can be read field by field. Its name — sixteen hex digits — is one
 * the harness's strict reply-address grammar accepts and no pid can take, and
 * it is refused outright when anything already sits at it or a registry entry
 * names it.
 */
export async function bindProbe(): Promise<Probe> {
  const path = join(SOCKET_DIR, `${randomBytes(8).toString('hex')}.sock`)
  if (existsSync(path) || claimedSocketPaths().has(path)) {
    throw new Error(`refusing to bind ${path}: something already claims it`)
  }
  const received: Array<Record<string, unknown>> = []
  const server = createNetServer((connection) => {
    connection.setEncoding('utf8')
    let buffered = ''
    connection.on('data', (chunk: string) => {
      buffered += chunk
      let newline: number
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        try {
          received.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          received.push({ unparsed: line })
        }
      }
    })
    connection.on('error', () => {})
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })

  return {
    address: `uds:${path}`,
    frames: () => [...received],
    async waitFor(match, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = received.find(match)
        if (found) return found
        await sleep(50)
      }
      return received.find(match) ?? null
    },
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          if (existsSync(path)) unlinkSync(path)
          resolve()
        }),
      ),
  }
}

// ---------------------------------------------------------------------------
// The real dev server
// ---------------------------------------------------------------------------

export interface RealDevServer {
  url: string
  /** Everything the dev server logged, posture block included. */
  log(): string
  close(): Promise<void>
}

/**
 * The example app's dev server, started from the scratch repository with no
 * override at all: it reads the real registry and binds in the real socket
 * directory. This process's own `CLAUDE*` and `VITE_AGENT_INSPECT_*` variables
 * are held back while it runs, so a suite started from inside a Claude Code
 * session does not hand the dev server that session's pid for its preselect.
 */
export async function startRealDevServer(root: string): Promise<RealDevServer> {
  const held = new Map<string, string>()
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isScrubbed(key)) {
      held.set(key, value)
      delete process.env[key]
    }
  }
  const restore = () => {
    for (const [key, value] of held) process.env[key] = value
  }

  const recorder = createRecordingLogger()
  let server: ViteDevServer
  try {
    server = await createServer({
      root,
      configFile: join(root, 'vite.config.ts'),
      logLevel: 'info',
      customLogger: recorder.logger,
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
  } catch (error) {
    restore()
    throw error
  }
  const address = server.httpServer?.address()
  if (!address || typeof address !== 'object') {
    await server.close()
    restore()
    throw new Error('the seam 3 dev server is not listening on a TCP port')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    log: () => recorder.text(),
    async close() {
      await server.waitForRequestsIdle()
      await server.close()
      restore()
    },
  }
}

function hasStatus(entry: RegistryEntry | null): boolean {
  return typeof entry?.status === 'string'
}

/** The harness's name for a cwd's transcript directory. */
function mangle(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Poll until `check` answers something other than null, or give up with null. */
export async function until<T>(
  check: () => T | null,
  timeoutMs: number,
  everyMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value !== null) return value
    await sleep(everyMs)
  }
  return check()
}
