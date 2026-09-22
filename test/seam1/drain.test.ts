import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { advanceClock, createFixtureEnv } from '../harness/fixture-env.js'
import type { FixtureEnv } from '../harness/fixture-env.js'
import { repoRoot } from '../harness/paths.js'
import { fakeSessions } from '../harness/session-socket.js'
import { tempApps } from '../harness/temp-app.js'
import type { TempApp } from '../harness/temp-app.js'
import type { HarnessServer } from '../harness/dev-server.js'

// Every string here is written out rather than imported: the two endpoint paths,
// the drain body's field names, the discovery entry's field names, the hook
// JSON's own shape and the 10,000-character cap are the contract, and a test
// that still passes after the server renames its internals is the test we want
// (docs/agents/testing.md). The CLI is observed the way that file asks for — as
// a child process, through the text it prints and the code it exits with.

const PICK = '/__agent/pick'
const STATUS = '/__agent/status'
const DRAIN = '/__agent/drain'

/** The bin the two hook entries invoke (spec §18). */
const CLI = join(repoRoot, 'dist/cli/main.js')

/** The cap on a hook's output string, from the harness's own documentation. */
const HOOK_OUTPUT_LIMIT = 10_000

/** Past the 30 minutes of spec §15, by enough that no rounding matters. */
const PAST_THE_TTL = 31 * 60 * 1000

/** Spec §17: the sentence a Pick nobody drained within its TTL is reported with. */
const TTL_SENTENCE =
  'Not delivered — nobody prompted Claude in this repo within 30 minutes.'

/** The label the startup posture block states the entry under (spec §21). */
const POSTURE_LABEL = 'discovery entry'

/** One discovery entry, as the CLI and this test both read it off disk. */
interface DiscoveryEntry {
  root: string
  port: number
  secret: string
  pid: number
}

/** What a hook writes on stdout to add context to a turn. */
interface HookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string }
}

const apps = tempApps()
const sessions = fakeSessions()
const fixtures: FixtureEnv[] = []

afterEach(async () => {
  advanceClock(0)
  await apps.cleanup()
  await sessions.closeAll()
  while (fixtures.length) fixtures.pop()!.cleanup()
})

/** A dev server on a checkout of its own, with a registry nothing else shares. */
async function startDrainServer(
  app?: TempApp,
): Promise<{ app: TempApp; server: HarnessServer; env: FixtureEnv }> {
  const env = createFixtureEnv({ claudePid: 0 })
  fixtures.push(env)
  const checkout = app ?? apps.create({ git: true })
  const server = await apps.serve(checkout, { env: env.env })
  return { app: checkout, server, env }
}

/** The path the posture block says this dev server wrote its entry to. */
function entryPath(server: HarnessServer): string {
  const found = new RegExp(`${POSTURE_LABEL}\\s+(\\S+\\.json)`).exec(server.log())
  if (!found?.[1]) {
    throw new Error(`no ${POSTURE_LABEL} line in the posture block:\n${server.log()}`)
  }
  return found[1]
}

function readEntry(server: HarnessServer): DiscoveryEntry {
  return JSON.parse(readFileSync(entryPath(server), 'utf8')) as DiscoveryEntry
}

async function postPick(
  server: HarnessServer,
  note: string | null = 'make this blue',
): Promise<string> {
  const response = await fetch(server.url + PICK, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({
      note,
      url: 'http://localhost:5173/settings',
      viewport: { width: 1280, height: 800 },
      descriptor: { tag: 'button', id: 'save' },
      geometry: { width: 120, height: 40, x: 24, y: 560 },
    }),
  })
  expect(response.status).toBe(200)
  const json = (await response.json()) as { pickId: string }
  return json.pickId
}

/** What `GET /__agent/status` says about one Pick, by the fields used here. */
async function statusRow(
  server: HarnessServer,
  pickId: string,
): Promise<{ state: string; reason: string | null }> {
  const response = await fetch(server.url + STATUS)
  const json = (await response.json()) as {
    picks: Array<{ pickId: string; state: string; reason: string | null }>
  }
  const row = json.picks.find((pick) => pick.pickId === pickId)
  if (!row) throw new Error(`no status row for ${pickId}`)
  return row
}

async function stateOf(server: HarnessServer, pickId: string): Promise<string> {
  return (await statusRow(server, pickId)).state
}

interface DrainAnswer {
  status: number
  text?: string
  drained?: number
  remaining?: number
  error?: string
  reason?: string
}

async function drain(
  server: HarnessServer,
  body: Record<string, unknown>,
  method = 'POST',
): Promise<DrainAnswer> {
  const response = await fetch(server.url + DRAIN, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, ...((await response.json()) as object) }
}

/** The drain body a working CLI would send for this server. */
function drainBody(server: HarnessServer, app: TempApp): Record<string, unknown> {
  return {
    cwd: app.checkout,
    secret: readEntry(server).secret,
    event: 'UserPromptSubmit',
  }
}

interface CliRun {
  code: number | null
  stdout: string
  stderr: string
}

/** The CLI as a hook runs it: JSON on stdin, JSON or nothing on stdout. */
function runCli(input: Record<string, unknown>): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'drain'], { stdio: 'pipe' })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(JSON.stringify(input))
  })
}

function hookOutput(run: CliRun): HookOutput {
  expect(run.code).toBe(0)
  return JSON.parse(run.stdout) as HookOutput
}

describe('the discovery entry', () => {
  it('is written under the OS temp root, readable only by this user', async () => {
    const { server, app } = await startDrainServer()
    const path = entryPath(server)

    expect(path.startsWith(tmpdir())).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)

    const entry = readEntry(server)
    expect(entry.root).toBe(app.checkout)
    expect(entry.port).toBe(server.port)
    expect(entry.secret).toMatch(/^[0-9a-f]{32,}$/)
    expect(entry.pid).toBe(process.pid)
  })

  it('is removed at shutdown, and the other server on that root keeps its own', async () => {
    const { server: first, app } = await startDrainServer(apps.create({ git: true }))
    const { server: second } = await startDrainServer(app)

    const paths = [entryPath(first), entryPath(second)]
    // Several dev servers for one root each have an entry (spec §18).
    expect(new Set(paths).size).toBe(2)
    expect(dirname(paths[0]!)).toBe(dirname(paths[1]!))
    expect(paths.every((path) => existsSync(path))).toBe(true)

    await first.close()

    expect(existsSync(paths[0]!)).toBe(false)
    expect(existsSync(paths[1]!)).toBe(true)
  })
})

describe('POST /__agent/drain', () => {
  it('answers POST only', async () => {
    const { server, app } = await startDrainServer()

    const answer = await drain(server, drainBody(server, app), 'GET')

    expect(answer.status).toBe(405)
    expect(answer.reason).toContain('POST')
  })

  it('refuses a wrong secret, and a wrong cwd, each with its reason', async () => {
    const { server, app } = await startDrainServer()
    await postPick(server)

    const wrongSecret = await drain(server, {
      ...drainBody(server, app),
      secret: 'ffffffffffffffffffffffffffffffff',
    })
    expect(wrongSecret.status).toBeGreaterThanOrEqual(400)
    expect(wrongSecret.status).toBeLessThan(500)
    expect(wrongSecret.reason).toBeTruthy()

    const wrongCwd = await drain(server, {
      ...drainBody(server, app),
      cwd: app.addSiblingRepo('elsewhere'),
    })
    expect(wrongCwd.status).toBeGreaterThanOrEqual(400)
    expect(wrongCwd.status).toBeLessThan(500)
    expect(wrongCwd.reason).toBeTruthy()

    // Neither refusal touched the queue.
    const drained = await drain(server, drainBody(server, app))
    expect(drained.drained).toBe(1)
  })

  it('returns the queued pick, rendered with its age, and claims it', async () => {
    const { server, app } = await startDrainServer()
    const pickId = await postPick(server, 'this button is the wrong blue')

    const first = await drain(server, drainBody(server, app))

    expect(first.status).toBe(200)
    expect(first.drained).toBe(1)
    expect(first.text).toContain(pickId)
    expect(first.text).toContain('this button is the wrong blue')
    // Ticket 03's renderer, list-shaped, with the age stated (spec §15).
    expect(first.text).toContain('pick 1 of 1')
    expect(first.text).toContain('just now')
    expect(await stateOf(server, pickId)).toBe('sent')

    const second = await drain(server, drainBody(server, app))

    expect(second.status).toBe(200)
    expect(second.drained).toBe(0)
    expect(second.text).toBe('')
  })

  it('never hands out a pick the TTL has already taken', async () => {
    // Ticket 11 put the sweep ahead of every route so this would hold for
    // routes that did not exist yet. This is the first one that re-reads the
    // queue, so it is the first that could have handed the pick out anyway.
    const { server, app } = await startDrainServer()
    const pickId = await postPick(server)
    advanceClock(PAST_THE_TTL)

    const answer = await drain(server, drainBody(server, app))

    expect(answer.drained).toBe(0)
    expect(answer.text).toBe('')
    const row = await statusRow(server, pickId)
    expect(row.state).toBe('failed')
    expect(row.reason).toBe(TTL_SENTENCE)
  })

  it('never takes a pick already written to a session socket', async () => {
    const { server, app, env } = await startDrainServer()
    await sessions.open(env, { cwd: app.checkout, name: 'the session' })
    const pickId = await postPick(server)
    expect(await stateOf(server, pickId)).toBe('sent')

    const answer = await drain(server, drainBody(server, app))

    expect(answer.drained).toBe(0)
    expect(answer.text).toBe('')
  })
})

describe('the drain CLI', () => {
  it('prints the rendered pick as additionalContext for UserPromptSubmit', async () => {
    const { server, app } = await startDrainServer()
    const pickId = await postPick(server, 'the label is cut off')

    const run = await runCli({
      session_id: 'abc123',
      // The Vite root, not the checkout: the CLI normalizes what the hook hands it.
      cwd: app.appDir,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'have a look at this',
    })

    const output = hookOutput(run)
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(output.hookSpecificOutput.additionalContext).toContain(pickId)
    expect(output.hookSpecificOutput.additionalContext).toContain('the label is cut off')
    expect(await stateOf(server, pickId)).toBe('sent')
  })

  it('names Stop when a turn ending is what invoked it', async () => {
    const { server, app } = await startDrainServer()

    const pickId = await postPick(server)

    const run = await runCli({ cwd: app.checkout, hook_event_name: 'Stop' })

    const output = hookOutput(run)
    expect(output.hookSpecificOutput.hookEventName).toBe('Stop')
    expect(output.hookSpecificOutput.additionalContext).toContain(pickId)
    expect(await stateOf(server, pickId)).toBe('sent')
  })

  it('drains one pick exactly once, however many times it is invoked', async () => {
    const { server, app } = await startDrainServer()
    const pickId = await postPick(server)

    const first = await runCli({ cwd: app.checkout, hook_event_name: 'UserPromptSubmit' })
    const second = await runCli({ cwd: app.checkout, hook_event_name: 'Stop' })

    expect(hookOutput(first).hookSpecificOutput.additionalContext).toContain(pickId)
    expect(second.code).toBe(0)
    expect(second.stdout).toBe('')
    expect(await stateOf(server, pickId)).toBe('sent')
  })

  it('drains every dev server serving that checkout, in one turn', async () => {
    const app = apps.create({ git: true })
    const { server: first } = await startDrainServer(app)
    const { server: second } = await startDrainServer(app)
    const onFirst = await postPick(first, 'the header overlaps')
    const onSecond = await postPick(second, 'the footer is cut off')

    const run = await runCli({ cwd: app.checkout, hook_event_name: 'UserPromptSubmit' })

    const context = hookOutput(run).hookSpecificOutput.additionalContext
    expect(context).toContain(onFirst)
    expect(context).toContain(onSecond)
    expect(run.stdout.length).toBeLessThanOrEqual(HOOK_OUTPUT_LIMIT)
  })

  it('exits 0 with empty stdout when no dev server is running', async () => {
    const app = apps.create({ git: true })

    const run = await runCli({ cwd: app.checkout, hook_event_name: 'UserPromptSubmit' })

    expect(run.code).toBe(0)
    expect(run.stdout).toBe('')
  })

  it('exits 0, never 2, when the dev server refuses it, and says why on stderr', async () => {
    const { server, app } = await startDrainServer()
    await postPick(server)
    // The secret the entry publishes is the credential; a CLI holding the wrong
    // one is refused, and a refused hook must still leave the prompt alone.
    const path = entryPath(server)
    const entry = readEntry(server)
    writeFileSync(path, JSON.stringify({ ...entry, secret: 'f'.repeat(32) }))

    const run = await runCli({ cwd: app.checkout, hook_event_name: 'UserPromptSubmit' })

    expect(run.code).toBe(0)
    expect(run.code).not.toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('vite-agent-inspect')
  })

  it('stays under the hook output cap and says how many picks remain', async () => {
    const { server, app } = await startDrainServer()
    const note = 'the spacing here is wrong. '.repeat(24)
    const pickIds: string[] = []
    for (let n = 0; n < 24; n++) pickIds.push(await postPick(server, note))

    const run = await runCli({ cwd: app.checkout, hook_event_name: 'UserPromptSubmit' })
    const context = hookOutput(run).hookSpecificOutput.additionalContext

    expect(run.stdout.length).toBeLessThanOrEqual(HOOK_OUTPUT_LIMIT)
    expect(context).toContain(pickIds[0]!)
    expect(context).not.toContain(pickIds.at(-1)!)
    const last = context.trimEnd().split('\n').at(-1) ?? ''
    expect(last).toMatch(/\d+ more picks? still queued/)

    // The rest are still queued, and the next drain takes the next batch.
    const next = await runCli({ cwd: app.checkout, hook_event_name: 'Stop' })
    expect(hookOutput(next).hookSpecificOutput.additionalContext.length).toBeGreaterThan(
      0,
    )
  })

  it('delivers a pick the unreadable registry left unaddressed', async () => {
    const { server, app, env } = await startDrainServer()
    rmSync(env.registryDir, { recursive: true, force: true })

    const pickId = await postPick(server, 'this row is misaligned')
    // Spec §17: the chip reads Sent with the next-prompt sub-line, which is the
    // queue's own word published unchanged (ticket 11).
    expect(await stateOf(server, pickId)).toBe('queued-unaddressed')

    const run = await runCli({ cwd: app.checkout, hook_event_name: 'UserPromptSubmit' })

    expect(hookOutput(run).hookSpecificOutput.additionalContext).toContain(
      'this row is misaligned',
    )
    expect(await stateOf(server, pickId)).toBe('sent')
  })
})
