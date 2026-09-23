import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { applyEnv, createFixtureEnv } from '../harness/fixture-env.js'
import { createRecordingLogger } from '../harness/logger.js'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import type { HarnessServer } from '../harness/dev-server.js'
import { writeSession } from '../harness/registry.js'

// The one line that opens the startup posture block. Counted, so that later
// tickets appending to the block cannot turn it into two.
const BLOCK_HEADING = 'vite-agent-inspect — startup posture'

const apps = tempApps()
afterEach(apps.cleanup)

const occurrences = (text: string, needle: string) => text.split(needle).length - 1

/**
 * A server whose startup read finds a registry someone else already filled —
 * the posture block is written before the first request, so the entries have to
 * be on disk before it starts.
 */
async function servedOverAPreparedRegistry(
  app: TempApp,
  fill: (fixture: FixtureEnv) => void,
): Promise<HarnessServer> {
  const probe = await apps.serve(app)
  fill(probe.fixture)
  return apps.serve(app, {
    env: { VITE_AGENT_INSPECT_REGISTRY_DIR: probe.fixture.registryDir },
  })
}

describe('the startup posture block', () => {
  it('is printed exactly once, with root, guard posture and registry state', async () => {
    const { app, server } = await apps.start({ app: { git: true } })
    const log = server.log()

    expect(occurrences(log, BLOCK_HEADING)).toBe(1)
    expect(log).toContain(app.checkout)
    expect(log).toContain('git rev-parse --show-toplevel')
    expect(log).toMatch(/loopback only/i)
    expect(log).toMatch(/origin/i)
    expect(log).toMatch(/registry/i)
    expect(log).toMatch(/readable/i)
  })

  it('says how the root was found when there was no git to find it with', async () => {
    const { app, server } = await apps.start({ app: { git: false } })

    expect(server.log()).toContain(app.appDir)
    expect(server.log()).toMatch(/not inside a git repository/i)
  })

  it('names the hook floor when the registry directory is missing', async () => {
    const app = apps.create({ git: true })
    const server = await apps.serve(app, {
      env: { VITE_AGENT_INSPECT_REGISTRY_DIR: app.playground + '/no-such-registry' },
    })

    expect(server.log()).toMatch(/hook floor/i)
    expect(server.log()).toMatch(/directory missing/i)
    expect(occurrences(server.log(), BLOCK_HEADING)).toBe(1)
  })

  it('names the hook floor when the entries are in an unrecognised shape', async () => {
    const app = apps.create({ git: true })
    const server = await servedOverAPreparedRegistry(app, (fixture) => {
      writeSession(fixture, { cwd: app.checkout, omit: ['messagingSocketPath'] })
    })

    expect(server.log()).toMatch(/hook floor/i)
    expect(server.log()).toMatch(/unrecognised shape/i)
  })

  it('counts the sessions it found in this checkout', async () => {
    const app = apps.create({ git: true })
    const server = await servedOverAPreparedRegistry(app, (fixture) => {
      writeSession(fixture, { cwd: app.checkout, name: 'one' })
      writeSession(fixture, { cwd: app.checkout, name: 'two' })
    })

    expect(server.log()).toMatch(/2 sessions in this checkout/)
  })

  it('names an entry it had to ignore rather than dropping it quietly', async () => {
    const app = apps.create({ git: true })
    const server = await servedOverAPreparedRegistry(app, (fixture) => {
      writeSession(fixture, { cwd: app.checkout, name: 'usable' })
      writeSession(fixture, { cwd: app.checkout, omit: ['status'] })
    })

    expect(server.log()).toMatch(/1 session in this checkout/)
    expect(server.log()).toMatch(/1 entry in an unrecognised shape, ignored/)
  })

  it('states where the reply socket bound, inside the one block', async () => {
    const { server } = await apps.start({ app: { git: true } })
    const log = server.log()

    expect(occurrences(log, BLOCK_HEADING)).toBe(1)
    expect(log).toMatch(/reply socket\s+bound at \S+\.sock/)
  })

  it('warns that LAN Picks will be refused when Vite is bound off loopback', async () => {
    const { server } = await apps.start({ app: { git: true }, host: '0.0.0.0' })

    expect(server.log()).toMatch(/LAN/)
    expect(server.log()).toMatch(/refused/i)
  })

  it('says nothing about the LAN when Vite is bound to loopback', async () => {
    const { server } = await apps.start({ app: { git: true } })

    expect(server.log()).not.toMatch(/LAN/)
  })
})

// ---------------------------------------------------------------------------
// The whole block, configuration by configuration (ticket 19). Each expected
// block is written out by hand, from the spec's list (§2) and `docs/posture.md`,
// never produced by the server and pasted back. Only what changes from run to
// run is normalised: the temp paths, this process's pid, the random suffixes,
// and how many leftovers of earlier runs a sweep happened to remove.
// ---------------------------------------------------------------------------

/**
 * Test-only: the harness version the canaries last passed against, standing in
 * for the recorded file ticket 21 writes. `<version>@<YYYY-MM-DD>`, or `never`.
 */
const VERIFIED_HARNESS_ENV = 'VITE_AGENT_INSPECT_VERIFIED_HARNESS'

const CAPTURE_ROOT = join(tmpdir(), 'vite-agent-inspect-captures')

interface Booted {
  app: TempApp
  server: HarnessServer
  fixture: FixtureEnv
}

let owned: FixtureEnv | undefined
afterEach(() => {
  owned?.cleanup()
  owned = undefined
})

/**
 * Boot one configuration: a fixture the test owns (so the registry can be
 * filled before the server reads it), a verified version, and whatever else
 * the configuration changes.
 */
async function boot({
  verified,
  fill,
  env = {},
  host,
}: {
  verified: string
  fill?: (fixture: FixtureEnv, app: TempApp) => void
  env?: Record<string, string>
  host?: string
}): Promise<Booted> {
  const fixture = createFixtureEnv({ claudePid: 0 })
  owned = fixture
  const app = apps.create({ git: true })
  fill?.(fixture, app)
  const server = await apps.serve(app, {
    env: { ...fixture.env, [VERIFIED_HARNESS_ENV]: verified, ...env },
    ...(host ? { host } : {}),
  })
  return { app, server, fixture }
}

/** The block alone: from its heading to the blank line it ends with. */
function blockOf(log: string): string {
  const start = log.indexOf(BLOCK_HEADING)
  if (start === -1) throw new Error(`no posture block in:\n${log}`)
  const rest = log.slice(start)
  const end = rest.indexOf('\n\n')
  // The block is logged with a blank line after it, which is the log's last
  // line when nothing has been logged since.
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\n+$/, '')
}

/** The block with everything that differs between runs put in angle brackets. */
function normalised({ app, server, fixture }: Booted): string {
  const pid = String(process.pid)
  return blockOf(server.log())
    .split(fixture.dir)
    .join('<fixture>')
    .split(app.checkout)
    .join('<checkout>')
    .split(CAPTURE_ROOT)
    .join('<captures>')
    .replace(/\S*vite-agent-inspect-servers-\d+/g, '<servers>')
    .replace(new RegExp(`\\b${pid}\\b`, 'g'), '<pid>')
    .replace(/<pid>-[0-9a-f]{6}\b/g, '<pid>-<hex>')
    .replace(/\b[0-9a-f]{16}-<pid>/g, '<hash>-<pid>')
    .replace(/[,;] \d+ left by dead dev servers swept/g, '')
}

/** The level the block was logged at: a block that warns of anything is a warning. */
function levelOf(server: HarnessServer): string {
  const entry = server.logEntries().find(({ message }) => message.includes(BLOCK_HEADING))
  if (!entry) throw new Error('no posture block was logged')
  return entry.level
}

/**
 * Every line of the block is said once, in the block, and the block is one
 * contiguous list: nothing that belongs to the posture is logged anywhere else.
 */
function expectSaidOnlyInTheBlock(server: HarnessServer): void {
  const log = server.log()
  expect(occurrences(log, BLOCK_HEADING)).toBe(1)
  const body = blockOf(log).split('\n').slice(1)
  for (const line of body) expect(line).toMatch(/^ {2}\S/)
  for (const line of body) {
    const text = line
      .trim()
      .split(/\s{2,}/)
      .slice(1)
      .join('  ')
    expect(occurrences(log, text), `said outside the block: ${text}`).toBe(1)
  }
}

const block = (...lines: string[]) => [BLOCK_HEADING, ...lines].join('\n')

const ROOT = '  root             <checkout> (git rev-parse --show-toplevel)'
const GUARD =
  '  guard            loopback only; Origin required on Pick ingress, and absent means refused'
const REGISTRY_ONE = '  registry         readable — 1 session in this checkout'
const VERIFIED_EQUAL =
  '  harness version  Claude Code 2.1.280 in the registry; the canaries last ' +
  'passed against 2.1.280 (2026-09-01)'
const REPLY = '  reply socket     bound at <fixture>/sockets/<pid>.sock'
const CAPTURE = '  screen capture   available'
const TEMP =
  '  temp directory   <captures>/<pid>-<hex> (user-only; removed at shutdown, and ' +
  'what dead dev servers left beside it is swept at startup)'
const DISCOVERY =
  '  discovery entry  <servers>/<hash>-<pid>-<hex>.json (user-only; removed at shutdown)'
const NEWER =
  'This harness is newer than the last one verified. v0 carries on, because it pins ' +
  'the shapes it reads rather than a version, and a shape that has moved is ' +
  'reported where it is read.'

/** One session in this checkout, reporting a version. */
const oneSession =
  (version: string) =>
  (fixture: FixtureEnv, app: TempApp): void => {
    writeSession(fixture, { cwd: app.checkout, name: 'main', version })
  }

describe('the complete startup posture block', () => {
  it('reads, on the happy path, as one list in the spec order', async () => {
    const booted = await boot({
      verified: '2.1.280@2026-09-01',
      fill: oneSession('2.1.280'),
    })

    expect(normalised(booted)).toBe(
      block(ROOT, GUARD, REGISTRY_ONE, VERIFIED_EQUAL, REPLY, CAPTURE, TEMP, DISCOVERY),
    )
    expect(levelOf(booted.server)).toBe('info')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('names the hook floor when the registry directory is missing', async () => {
    const booted = await boot({
      verified: '2.1.280@2026-09-01',
      env: {
        VITE_AGENT_INSPECT_REGISTRY_DIR: '/nonexistent/vite-agent-inspect-registry',
      },
    })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        '  registry         directory missing (/nonexistent/vite-agent-inspect-registry) ' +
          '— targeting falls back to the hook floor',
        '  harness version  no readable registry entry reports a version; the canaries ' +
          'last passed against 2.1.280 (2026-09-01)',
        REPLY,
        CAPTURE,
        TEMP,
        DISCOVERY,
      ),
    )
    expect(levelOf(booted.server)).toBe('warn')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('names the hook floor when every entry is in a shape it does not recognise', async () => {
    const booted = await boot({
      verified: '2.1.280@2026-09-01',
      fill: (fixture, app) => {
        writeSession(fixture, {
          cwd: app.checkout,
          version: '2.1.280',
          omit: ['messagingSocketPath'],
        })
      },
    })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        '  registry         entries in an unrecognised shape (<fixture>/registry) — ' +
          'targeting falls back to the hook floor',
        '  harness version  no readable registry entry reports a version; the canaries ' +
          'last passed against 2.1.280 (2026-09-01)',
        REPLY,
        CAPTURE,
        TEMP,
        DISCOVERY,
      ),
    )
    expect(levelOf(booted.server)).toBe('warn')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('says LAN Picks will be refused when Vite is bound off loopback', async () => {
    const booted = await boot({
      verified: '2.1.280@2026-09-01',
      fill: oneSession('2.1.280'),
      host: '0.0.0.0',
    })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        REGISTRY_ONE,
        VERIFIED_EQUAL,
        REPLY,
        CAPTURE,
        TEMP,
        DISCOVERY,
        '  host             Vite is bound to 0.0.0.0 — Picks arriving from the LAN will ' +
          'be refused',
      ),
    )
    expect(levelOf(booted.server)).toBe('warn')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('says why the reply socket is not bound when a session already owns its path', async () => {
    const booted = await boot({
      verified: '2.1.280@2026-09-01',
      // Outside this checkout, so not a Candidate — but it owns the path.
      fill: (fixture, app) => {
        writeSession(fixture, {
          cwd: app.playground,
          pid: process.pid,
          version: '2.1.280',
        })
      },
    })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        '  registry         readable — 0 sessions in this checkout',
        VERIFIED_EQUAL,
        '  reply socket     not bound — a registered session already owns ' +
          '<fixture>/sockets/<pid>.sock, and this plugin never binds over a path the ' +
          'session registry names. Receipts will not arrive; delivery is unaffected.',
        CAPTURE,
        TEMP,
        DISCOVERY,
      ),
    )
    expect(levelOf(booted.server)).toBe('warn')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('says why Screen Capture is disabled when the startup probe finds no image', async () => {
    const booted = await boot({
      verified: '2.1.280@2026-09-01',
      fill: oneSession('2.1.280'),
      env: { FAKE_SCREENCAPTURE_MODE: 'empty' },
    })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        REGISTRY_ONE,
        VERIFIED_EQUAL,
        REPLY,
        '  screen capture   disabled — the startup probe found that the tool exited ' +
          'cleanly but wrote no image, which is what screencapture does when the ' +
          'process that started this dev server has no Screen Recording permission ' +
          '(System Settings → Privacy & Security → Screen Recording)',
        TEMP,
        DISCOVERY,
      ),
    )
    expect(levelOf(booted.server)).toBe('warn')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('says why Screen Capture is disabled off macOS', async () => {
    const booted = await boot({
      verified: '2.1.280@2026-09-01',
      fill: oneSession('2.1.280'),
      env: { VITE_AGENT_INSPECT_PLATFORM: 'linux' },
    })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        REGISTRY_ONE,
        VERIFIED_EQUAL,
        REPLY,
        '  screen capture   disabled — this dev server is not running on macOS ' +
          "(platform: linux), and v0 takes a Screen Capture with macOS's own " +
          'screencapture tool',
        TEMP,
        DISCOVERY,
      ),
    )
    expect(levelOf(booted.server)).toBe('warn')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('says never verified when no canary run has recorded a version', async () => {
    const booted = await boot({ verified: 'never', fill: oneSession('2.1.280') })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        REGISTRY_ONE,
        '  harness version  Claude Code 2.1.280 in the registry; never verified — no ' +
          'canary run has recorded a version it passed against',
        REPLY,
        CAPTURE,
        TEMP,
        DISCOVERY,
      ),
    )
    // Never verified is a fact, not a warning: only a newer harness warns.
    expect(levelOf(booted.server)).toBe('info')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('warns, and refuses nothing, when the harness is newer than the one verified', async () => {
    const booted = await boot({
      verified: '2.1.279@2026-08-01',
      fill: oneSession('2.1.280'),
    })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        REGISTRY_ONE,
        '  harness version  Claude Code 2.1.280 in the registry; the canaries last ' +
          `passed against 2.1.279 (2026-08-01). ${NEWER}`,
        REPLY,
        CAPTURE,
        TEMP,
        DISCOVERY,
      ),
    )
    expect(levelOf(booted.server)).toBe('warn')
    expectSaidOnlyInTheBlock(booted.server)

    // A warning, never a refusal: the session is still offered as a Candidate.
    const answer = await fetch(booted.server.url + '/__agent/sessions')
    const sessions = (await answer.json()) as { candidates: Array<{ name: string }> }
    expect(sessions.candidates.map(({ name }) => name)).toEqual(['main'])
  })

  it('does not warn when the newest harness in the registry is the one verified', async () => {
    const booted = await boot({
      verified: '2.1.280@2026-09-01',
      fill: (fixture, app) => {
        writeSession(fixture, { cwd: app.checkout, name: 'old', version: '2.1.279' })
        writeSession(fixture, { cwd: app.checkout, name: 'new', version: '2.1.280' })
      },
    })

    expect(normalised(booted)).toBe(
      block(
        ROOT,
        GUARD,
        '  registry         readable — 2 sessions in this checkout',
        '  harness version  Claude Code 2.1.279 and 2.1.280 in the registry; the ' +
          'canaries last passed against 2.1.280 (2026-09-01)',
        REPLY,
        CAPTURE,
        TEMP,
        DISCOVERY,
      ),
    )
    expect(levelOf(booted.server)).toBe('info')
    expectSaidOnlyInTheBlock(booted.server)
  })

  it('compares by version number, not by spelling', async () => {
    const booted = await boot({
      verified: '2.1.99@2026-08-01',
      fill: oneSession('2.1.100'),
    })

    expect(normalised(booted)).toContain(`passed against 2.1.99 (2026-08-01). ${NEWER}`)
  })

  it('reads the recorded version from the package when nothing overrides it', async () => {
    const fixture = createFixtureEnv({ claudePid: 0 })
    owned = fixture
    const app = apps.create({ git: true })
    const server = await apps.serve(app, { env: fixture.env })

    // Whatever ticket 21 last recorded, or never: both are stated, neither is blank.
    expect(blockOf(server.log())).toMatch(
      /harness version {2}no readable registry entry reports a version; (never verified|the canaries last passed against \d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\))/,
    )
  })

  // Middleware mode has no port, so no hook can reach this server: the one
  // line that is not written is said, and the block is a warning (spec §18).
  it('says no discovery entry was written in middleware mode, and why', async () => {
    const fixture = createFixtureEnv({ claudePid: 0 })
    owned = fixture
    const app = apps.create({ git: true })
    const restore = applyEnv({ ...fixture.env, [VERIFIED_HARNESS_ENV]: 'never' })
    const recorder = createRecordingLogger()
    const server = await createServer({
      root: app.appDir,
      configFile: app.configFile,
      logLevel: 'info',
      customLogger: recorder.logger,
      server: { middlewareMode: true },
    })
    try {
      expect(blockOf(recorder.text())).toContain(
        '  discovery entry  not written — this dev server is not listening on a TCP ' +
          'port, so no hook could reach it; picks left for the next prompt will expire',
      )
      const logged = recorder
        .entries()
        .find(({ message }) => message.includes(BLOCK_HEADING))
      expect(logged?.level).toBe('warn')
      expect(occurrences(recorder.text(), 'not written')).toBe(1)
    } finally {
      await server.close()
      restore()
    }
  })
})
