import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bindProbe,
  createScratchRepo,
  launchSession,
  modelTierArgs,
  openBlackhole,
  preflight,
  scrubbedEnv,
  sleep,
  startRealDevServer,
  until,
} from '../../harness/claude-session.js'
import type {
  Blackhole,
  RealDevServer,
  ScratchRepo,
  ThrowawaySession,
} from '../../harness/claude-session.js'
import { isPickRouteCurl, writeFixtureHook } from './fixture-allowlist.js'
import type { FixtureHook, LoggedToolCall } from './fixture-allowlist.js'

// Seam 3, the model tier (ticket 21). It fakes nothing, and it SPENDS: a
// handful of turns on haiku. Every assertion is on a harness artefact — the
// registry, the transcript on disk, the frames the harness sends back, the ack
// and done hits the dev server records — and none is on what the model says.
//
// One scratch checkout, `init` run in it, one real dev server, and these
// throwaway sessions, all of them this suite's own:
//
// - **the bystander** — safe mode, pointed at the blackhole, alive throughout.
//   With two Candidates the dev server preselects neither, so a Pick sent with
//   no Target stays `queued-unaddressed` for a hook to drain (spec §14). Its
//   one turn — spike 16's duplicate, read raw — goes to the blackhole.
// - **allowlisted** — handed the fixture allowlist, so it acks and finishes a
//   Pick unattended. A real Pick lands byte-for-byte; the same body again is
//   dropped as a duplicate; the ack and done reach the dev server (the one
//   model-dependent canary); and both hooks `init` installed drain a queued
//   Pick exactly once.
// - **manual** — no allowlist. The skill's ack is a shell call, so the Pick
//   stalls on a permission prompt, and approving it through the pty is what
//   returns the session to idle.
// - **subdirectory** — started in `src/`, pointed at the blackhole. It measures
//   whether the root's hooks run there (ticket 16's open question).
//
// Only one of the last three is alive at a time. The tests run in order and
// lean on the ones before: run the file whole.

const harness = preflight()
/** Set by `vitest.seam3.config.ts` in `--mode model`, and nowhere else. */
const spending = process.env.SEAM3_TIER === 'model'
const skip = !harness.runnable || !spending
const why = !spending
  ? 'not in the model tier: run `npm run test:seam3:model`'
  : harness.runnable
    ? ''
    : harness.reason

/** Run `check`; if it fails, fail with `message` first and the detail after. */
function holds(message: string, check: () => void): void {
  try {
    check()
  } catch (error) {
    const failure = new Error(`${message}\n\n${(error as Error).message}`)
    failure.name = 'CanaryError'
    throw failure
  }
}

/** One assumption v0 depends on, and the map ticket that established it. */
function canary(assumption: string, ticket: string, check: () => void): void {
  holds(`${assumption} (map ticket ${ticket})`, check)
}

/** The first line of every delivery the dev server renders, written out. */
const HEADING = 'vite-agent-inspect — 1 pick from the browser.'

const NO_LEFTOVERS = { entry: false, keyFile: false, socket: false }

/** Spike 16 measured a duplicate's Receipt at 8ms. */
const ANSWER_WINDOW_MS = 10_000
/** How long one Pick's handling — skill, ack, done — is given. */
const TURN_WINDOW_MS = 150_000

/** The Pick states, and the ingest answer's word for a socket write, written out. */
const WORKING = 'working'
const DONE = 'done'
const QUEUED_UNADDRESSED = 'queued-unaddressed'
const SENT = 'sent'
const SENT_AWAITING_ACK = 'sent-awaiting-ack'

interface StatusRow {
  pickId: string
  state: string
  history: Array<{ state: string }>
}

/** A Note carrying a marker no other Pick has, and the characters HTML would escape. */
function noteFor(label: string): { note: string; marker: string } {
  const marker = `seam3-${label}-${randomUUID().slice(0, 8)}`
  return {
    marker,
    note:
      `Nothing to change: this is a pipeline test (${marker}). Acknowledge this ` +
      'pick, then mark it done. <b>"quoted" & \'apostrophe\'</b>',
  }
}

async function postPick(
  server: RealDevServer,
  note: string,
  target: { sessionId: string; pid: number } | null,
): Promise<{ pickId: string; state: string }> {
  const response = await fetch(server.url + '/__agent/pick', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({
      note,
      target,
      url: `${server.url}/`,
      viewport: { width: 1280, height: 800 },
      descriptor: { tag: 'button', id: 'save' },
      geometry: { width: 120, height: 40, x: 24, y: 560 },
    }),
  })
  const body = (await response.json()) as { pickId: string; state: string }
  holds(`the dev server refused the Pick: ${JSON.stringify(body)}`, () =>
    expect(response.status).toBe(200),
  )
  return body
}

async function statusOf(server: RealDevServer, pickId: string): Promise<StatusRow> {
  const body = (await fetch(server.url + '/__agent/status').then((r) => r.json())) as {
    picks: StatusRow[]
  }
  const row = body.picks.find((pick) => pick.pickId === pickId)
  if (!row) throw new Error(`the dev server has no status row for pick ${pickId}`)
  return row
}

function targetOf(session: ThrowawaySession): { sessionId: string; pid: number } {
  const sessionId = session.entry()?.sessionId
  if (typeof sessionId !== 'string') throw new Error('the session has no sessionId')
  return { sessionId, pid: session.pid }
}

/** The transcript entries that are not the model's own words, carrying `text`. */
function carrying(
  session: ThrowawaySession,
  text: string,
): Array<Record<string, unknown>> {
  return session
    .transcript()
    .filter((entry) => entry.type !== 'assistant' && JSON.stringify(entry).includes(text))
}

/** A transcript entry's kind, for a failure message or a measurement. */
function kindOf(entry: Record<string, unknown>): string {
  const attachment = entry.attachment as { type?: unknown } | undefined
  return [entry.type, entry.subtype, attachment?.type].filter(Boolean).join('/')
}

/**
 * Which hook added a transcript entry's context: an attachment names its
 * event, and a `stop_hook_summary` is the Stop hook's by definition.
 */
function hookEventOf(entry: Record<string, unknown>): string | null {
  if (entry.subtype === 'stop_hook_summary') return 'Stop'
  const attachment = entry.attachment as { hookEvent?: unknown } | undefined
  return typeof attachment?.hookEvent === 'string' ? attachment.hookEvent : null
}

/** The additional context a hook entry carries, whichever shape it has. */
function hookContextOf(entry: Record<string, unknown>): string[] {
  if (Array.isArray(entry.hookAdditionalContext))
    return entry.hookAdditionalContext as string[]
  const attachment = entry.attachment as { content?: unknown } | undefined
  return Array.isArray(attachment?.content) ? (attachment.content as string[]) : []
}

/**
 * What one Stop drain leaves in the transcript on 2.1.280: the summary the spec
 * names, the hook's raw output, and the context the model is handed. Sorted.
 */
const STOP_DRAIN_RECORDS = [
  'attachment/hook_additional_context',
  'attachment/hook_success',
  'system/stop_hook_summary',
]

/**
 * The entries among `entries` that hand a Pick to the model: a peer message, or
 * a hook's additional context. The rest are the harness's records of a hook
 * run — its raw output, its summary — which the model is not given again.
 */
function handedToModel(
  entries: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return entries.filter(
    (line) =>
      (line.type === 'user' &&
        (line.origin as { kind?: unknown } | undefined)?.kind === 'peer') ||
      kindOf(line) === 'attachment/hook_additional_context',
  )
}

/** A transcript entry's kind and the shape around it, for a measurement. */
function describeEntry(entry: Record<string, unknown>): string {
  const attachment = entry.attachment as Record<string, unknown> | undefined
  return (
    `${kindOf(entry)} {${Object.keys(entry).join(',')}}` +
    (attachment ? ` attachment {${Object.keys(attachment).join(',')}}` : '') +
    (entry.isMeta ? ' isMeta' : '')
  )
}

/** The peer message the harness recorded for `pickId`, as it sits in the transcript. */
function peerEntry(session: ThrowawaySession, pickId: string) {
  return (
    session.transcript().find((entry) => {
      if (entry.type !== 'user') return false
      const content = (entry.message as { content?: unknown } | undefined)?.content
      return typeof content === 'string' && content.includes(pickId)
    }) ?? null
  )
}

/** `until`, for a check that has to ask the dev server. */
async function untilAsync<T>(
  check: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== null) return value
    await sleep(250)
  }
  return check()
}

/** Type a prompt into the session, the way a developer would. */
async function typePrompt(session: ThrowawaySession, text: string): Promise<void> {
  // An interrupted prompt is put back into the input, so it is cleared first.
  session.press('\x15')
  await sleep(200)
  session.press(text)
  await sleep(600)
  session.press('\r')
}

/**
 * The Bash calls the model has asked for and not yet had answered: those the
 * fixture hook logged whose `tool_result` is not in the transcript yet.
 */
function pendingCalls(session: ThrowawaySession, hook: FixtureHook): LoggedToolCall[] {
  const answered = new Set<string>()
  for (const entry of session.transcript()) {
    const content = (entry.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        answered.add(block.tool_use_id)
      }
    }
  }
  return hook.calls().filter((call) => !answered.has(call.id))
}

/** Every Bash call the session made that was not the one shape this suite allows. */
function unexpectedCalls(hook: FixtureHook, devServerUrl: string): LoggedToolCall[] {
  return hook
    .calls()
    .filter(
      (call) => call.command === null || !isPickRouteCurl(call.command, devServerUrl),
    )
}

interface Settled {
  /** Every `waitingFor` the registry showed while the session worked. */
  waits: string[]
  /** What the dev server's sessions answer said while the registry read `waiting`. */
  candidateWaits: string[]
  approvals: number
}

/**
 * Wait for the session to finish all it is doing and sit idle. A permission
 * prompt is approved through the pty only when `approve` is given, and only
 * when every call pending is the one command shape `isPickRouteCurl` allows,
 * read exactly off the fixture hook's log; any other prompt is refused with Esc
 * and fails the test, so this suite never approves a command it did not expect.
 */
async function settle(
  session: ThrowawaySession,
  server: RealDevServer,
  hook: FixtureHook,
  { approve, timeoutMs = TURN_WINDOW_MS }: { approve: boolean; timeoutMs?: number },
): Promise<Settled> {
  const settled: Settled = { waits: [], candidateWaits: [], approvals: 0 }
  const deadline = Date.now() + timeoutMs
  let idleSince: number | null = null
  let lastPress = 0
  let waitingSince: number | null = null
  while (Date.now() < deadline) {
    const entry = session.entry()
    const now = Date.now()
    if (entry?.status === 'idle') {
      idleSince ??= now
      if (now - idleSince > 5000) return settled
    } else {
      idleSince = null
    }
    if (entry?.status === 'waiting') {
      const waitingFor = String(entry.waitingFor)
      if (settled.waits.at(-1) !== waitingFor) settled.waits.push(waitingFor)
      const rows = (await fetch(server.url + '/__agent/sessions').then((r) =>
        r.json(),
      )) as { candidates: Array<{ pid: number; waitingFor: string | null }> }
      const row = rows.candidates.find((candidate) => candidate.pid === session.pid)
      settled.candidateWaits.push(String(row?.waitingFor))
      waitingSince ??= now
      // The prompt can show a moment before the hook's log line lands.
      const pending = pendingCalls(session, hook)
      if (now - waitingSince > 1500 && now - lastPress > 2000) {
        const aimed =
          pending.length > 0 &&
          pending.every(
            (call) => call.command !== null && isPickRouteCurl(call.command, server.url),
          )
        if (!approve || !aimed) {
          session.press('\x1b')
          throw new Error(
            `the session is waiting on "${waitingFor}" for something this suite does ` +
              `not approve${approve ? '' : ' (this session is meant to run unattended)'}; ` +
              `refused with Esc. It asked to run: ${JSON.stringify(pending)}`,
          )
        }
        session.press('\r')
        settled.approvals += 1
        lastPress = now
        waitingSince = null
      }
    } else {
      waitingSince = null
    }
    await sleep(250)
  }
  throw new Error(
    `the session did not settle to idle within ${timeoutMs / 1000}s; its terminal ` +
      `showed: ${session.lastShown(1500)}`,
  )
}

/**
 * Stop the session and hold it to leaving nothing behind for its pid, and to
 * its token never having shown: in the terminal, the dev server's log or the
 * transcript. Read before the stop, which removes the key file.
 */
async function expectStopsClean(
  session: ThrowawaySession,
  server: RealDevServer,
): Promise<void> {
  const leaked = [
    session.screen(),
    server.log(),
    JSON.stringify(session.transcript()),
  ].some((text) => session.leaksToken(text))
  const left = await session.stop()
  holds(`the throwaway session (pid ${session.pid}) left artefacts behind`, () =>
    expect(left).toEqual(NO_LEFTOVERS),
  )
  holds('the peer token appeared in the terminal, the log or the transcript', () =>
    expect(leaked).toBe(false),
  )
}

/** The drain took the Pick: it left the queue as `queued-unaddressed` → `sent`. */
async function expectClaimedByDrain(
  server: RealDevServer,
  pickId: string,
  which: string,
): Promise<void> {
  const history = (await statusOf(server, pickId)).history.map((h) => h.state)
  holds(`the ${which} Pick was never claimed off the queue by a drain`, () =>
    expect(history.slice(0, 2)).toEqual([QUEUED_UNADDRESSED, SENT]),
  )
}

describe.skipIf(skip)(`seam 3 — model tier${skip ? ` (skipped: ${why})` : ''}`, () => {
  let repo: ScratchRepo
  let server: RealDevServer
  let initOutput = ''
  /** The dev server's reply address, as its posture block states it. */
  let replyAddress = ''
  let blackhole: Blackhole
  /**
   * A second session in the checkout, in the no-model tier's safe mode and
   * pointed at the blackhole, that is never written to. It is here so that a
   * Pick sent with no Target stays `queued-unaddressed`: with one Candidate
   * the dev server would preselect it (spec §14) and write to its socket.
   */
  let bystander: ThrowawaySession
  let bystanderStopped = false

  beforeAll(async () => {
    repo = createScratchRepo()
    // `init` exactly as a consumer runs it, from the installed bin.
    initOutput = execFileSync(
      'node',
      [join(repo.dir, 'node_modules/vite-agent-inspect/dist/cli/main.js'), 'init'],
      { cwd: repo.dir, env: scrubbedEnv(), encoding: 'utf8' },
    )
    server = await startRealDevServer(repo.dir)
    replyAddress = /reply socket\s+bound at (\S+\.sock)/.exec(server.log())?.[1] ?? ''
    blackhole = await openBlackhole()
    bystander = await launchSession({ cwd: repo.dir, modelUrl: blackhole.url })
    await bystander.ready()
  })

  afterAll(async () => {
    if (!bystanderStopped) await bystander?.stop()
    await blackhole?.close()
    await server?.close()
    repo?.cleanup()
  })

  it("init writes the hooks and the skill into the scratch project's own .claude/, and no permission", () => {
    expect(initOutput).toContain(join(repo.dir, '.claude/settings.json'))
    expect(initOutput).toContain(
      join(repo.dir, '.claude/skills/vite-agent-inspect/SKILL.md'),
    )
    const settings = JSON.parse(
      readFileSync(join(repo.dir, '.claude/settings.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(settings)).toEqual(['hooks'])
    expect(Object.keys(settings.hooks as object).toSorted()).toEqual([
      'Stop',
      'UserPromptSubmit',
    ])
    expect(replyAddress).not.toBe('')
  })

  it('a byte-identical frame returns a dropped / duplicate Receipt, read raw (the bystander, no model)', async () => {
    // Spike 16's dedup case, on the bystander, whose turn goes to the blackhole.
    // Its fields are read raw at the probe: the dev server's reply socket takes
    // the same Receipt for the real Pick below, where only its log can be read.
    const probe = await bindProbe()
    try {
      const frame = (msgId: string) => ({
        type: 'user',
        from: probe.address,
        msg_id: msgId,
        priority: 'next',
        session_id: targetOf(bystander).sessionId,
        message: {
          role: 'user',
          content: `seam 3 canary: a duplicate (${randomUUID()}).`,
        },
      })
      const once = frame(randomUUID())
      const twice = { ...once, msg_id: randomUUID() }
      await bystander.send([once])
      await sleep(1000)
      await bystander.send([twice])
      const receipt = await probe.waitFor(
        (answer) => answer.orig_msg_id === twice.msg_id,
        ANSWER_WINDOW_MS,
      )
      process.stdout.write(
        `\nseam 3 measurement — the duplicate's Receipt: ${JSON.stringify(receipt && { action: receipt.action, status: receipt.status, drop_reason: receipt.drop_reason, msgV: receipt.msgV })}\n`,
      )
      canary('a byte-identical frame inside 30 s no longer earns a Receipt', '16', () =>
        expect(receipt).not.toBeNull(),
      )
      canary('the duplicate is no longer a `peer_message_status` Receipt', '16', () =>
        expect(receipt?.action).toBe('peer_message_status'),
      )
      canary(
        'the duplicate is no longer `dropped` with `drop_reason: duplicate`',
        '16',
        () => {
          expect(receipt?.status).toBe('dropped')
          expect(receipt?.drop_reason).toBe('duplicate')
        },
      )
      canary('the Receipt no longer carries `msgV: 1`', '16', () =>
        expect(receipt?.msgV).toBe(1),
      )
      canary(
        'the first of the two no longer earns no Receipt (accept is silent)',
        '16',
        () =>
          expect(
            probe.frames().some((answer) => answer.orig_msg_id === once.msg_id),
          ).toBe(false),
      )
    } finally {
      // End the bystander's blackholed turn from the terminal.
      bystander.press('\x1b')
      await until(() => (bystander.entry()?.status === 'idle' ? true : null), 15_000)
      await probe.close()
    }
  })

  describe('an allowlisted session', () => {
    let session: ThrowawaySession
    let settingsDir: string
    let hook: FixtureHook
    let stopped = false
    const first = noteFor('socket')
    const atStop = noteFor('stop-hook')
    const atPrompt = noteFor('prompt-hook')
    const atPeerTurn = noteFor('peer-turn')
    let peerTurnPickId = ''
    let pickId = ''
    let stopPickId = ''
    let promptPickId = ''

    beforeAll(async () => {
      // The fixture allowlist, in a temporary directory handed to this session alone.
      settingsDir = mkdtempSync(join(tmpdir(), 'vite-agent-inspect-seam3-fixture-'))
      hook = writeFixtureHook(settingsDir, server.url, { allow: true })
      session = await launchSession({
        cwd: repo.dir,
        args: modelTierArgs('--settings', hook.settingsFile),
      })
      await session.ready(30_000)
    })

    afterAll(async () => {
      if (!stopped) await session?.stop()
      if (settingsDir) rmSync(settingsDir, { recursive: true, force: true })
    })

    it('starts with no CLAUDE* variable inherited, and it and the bystander are the only Candidates', async () => {
      expect(session.envNames.filter((name) => name.startsWith('CLAUDE'))).toEqual([])
      expect(session.envNames).not.toContain('ANTHROPIC_BASE_URL')
      const body = (await fetch(server.url + '/__agent/sessions').then((r) =>
        r.json(),
      )) as { candidates: Array<{ pid: number }> }
      expect(body.candidates.map((candidate) => candidate.pid).toSorted()).toEqual(
        [bystander.pid, session.pid].toSorted(),
      )
    })

    it('a real Pick flips the registry idle → busy and lands in the transcript byte-for-byte', async () => {
      canary('a fresh session no longer reads `status: idle`', '16', () =>
        expect(session.entry()?.status).toBe('idle'),
      )
      // Queued first, with no Target: it waits for whichever hook runs next.
      const early = await postPick(server, atPeerTurn.note, null)
      peerTurnPickId = early.pickId
      holds('the Pick with no Target was not left queued-unaddressed', () =>
        expect(early.state).toBe(QUEUED_UNADDRESSED),
      )
      const accepted = await postPick(server, first.note, targetOf(session))
      pickId = accepted.pickId
      holds('the dev server did not write the Pick to the session', () =>
        expect(accepted.state).toBe(SENT_AWAITING_ACK),
      )
      const busy = await until(
        () => (session.entry()?.status === 'busy' ? true : null),
        15_000,
      )
      canary('a Pick to an idle session no longer flips it `idle → busy`', '16', () =>
        expect(busy).toBe(true),
      )
      const entry = await until(() => peerEntry(session, pickId), 15_000)
      // A peer message's turn runs the UserPromptSubmit hook as it starts, and
      // so drains the queue (measured in run 1 of ticket 21). The Pick for the
      // Stop hook is queued only once that has happened, while the turn still
      // runs: then Stop is the one hook left to drain it.
      const drainedAtPeerTurn = await until(() => {
        const found = carrying(session, atPeerTurn.marker)
        return found.length > 0 ? found : null
      }, 15_000)
      process.stdout.write(
        `\nseam 3 measurement — a peer message's turn ` +
          (drainedAtPeerTurn
            ? `RUNS the UserPromptSubmit hook: it drained the queued Pick into ${drainedAtPeerTurn.map((e) => `${kindOf(e)} (${String(hookEventOf(e))})`).join(', ')}`
            : 'drained nothing through a hook within 15 s') +
          '\n',
      )
      canary(
        "a peer message's turn no longer runs the UserPromptSubmit hook, which drains " +
          'the queue into it',
        '15',
        () => {
          expect(drainedAtPeerTurn?.map(kindOf)).toEqual([
            'attachment/hook_additional_context',
          ])
          expect(hookEventOf(drainedAtPeerTurn?.[0] ?? {})).toBe('UserPromptSubmit')
        },
      )
      stopPickId = (await postPick(server, atStop.note, null)).pickId
      canary(
        'a peer message no longer lands in the transcript as a `user` entry',
        '14',
        () => expect(entry).not.toBeNull(),
      )
      const content = String(
        (entry?.message as { content?: unknown } | undefined)?.content ?? '',
      )
      process.stdout.write(
        `\nseam 3 measurement — the peer entry's fields: ${Object.keys(entry ?? {}).join(', ')}` +
          `; origin ${JSON.stringify(entry?.origin)}; version ${String(entry?.version)}\n`,
      )
      canary(
        'the transcript no longer carries the origin record ' +
          '{"kind":"peer","from":"uds:…","verifiedPeerPid":<dev server pid>}',
        '16',
        () =>
          expect(entry?.origin).toMatchObject({
            kind: 'peer',
            from: `uds:${replyAddress}`,
            verifiedPeerPid: process.pid,
          }),
      )
      const nonce = /fence nonce\s+(\S+)/.exec(content)?.[1] ?? ''
      canary('the Note no longer arrives between its fences, verbatim', '10', () =>
        expect(content).toContain(
          `--- note ${nonce} ---\n${first.note}\n--- end note ${nonce} ---`,
        ),
      )
      canary('the Pick is HTML-escaped on its way into the transcript', '10', () => {
        for (const escaped of ['&lt;', '&gt;', '&amp;', '&quot;', '&#39;']) {
          expect(content).not.toContain(escaped)
        }
      })
      // The harness wraps a peer message in an envelope of its own: a line
      // before and a paragraph after. The body the dev server wrote is what
      // sits between, from its heading to the newline that ends it.
      const endFence = `--- end note ${nonce} ---\n`
      const start = content.indexOf(HEADING)
      const body = content.slice(start, content.indexOf(endFence) + endFence.length)
      process.stdout.write(
        `\nseam 3 measurement — the peer envelope: ${JSON.stringify(content.slice(0, start))} ` +
          `before the body, ${JSON.stringify(content.slice(start + body.length, start + body.length + 60))}… after it\n`,
      )
      canary(
        'the body no longer arrives whole, from its heading to its end',
        '10',
        () => {
          expect(start).toBeGreaterThanOrEqual(0)
          expect(body.endsWith(endFence)).toBe(true)
        },
      )

      // Byte-for-byte: that body, sent again inside 30 s from the address the
      // dev server wrote it from, is what the harness's identical-body filter
      // drops — so it is the very bytes the dev server wrote, and the envelope
      // is all the harness added. The Receipt goes to the dev server's reply
      // socket. Its msg_id is fresh, so the dev server takes it for no Pick of
      // its own and says so, which it does only once the frame has passed its
      // shape checks: `type: control`, `msgV: 1`, `peer_message_status`, a
      // status out of the six (spec §16). Its fields are read raw below, on
      // the bystander.
      const msgId = randomUUID()
      await session.send([
        {
          type: 'user',
          from: `uds:${replyAddress}`,
          msg_id: msgId,
          priority: 'next',
          session_id: targetOf(session).sessionId,
          message: { role: 'user', content: body },
        },
      ])
      const heard = await until(
        () =>
          server
            .log()
            .includes(`its orig_msg_id ${msgId} is no pick this dev server sent`)
            ? true
            : null,
        ANSWER_WINDOW_MS,
      )
      canary(
        "the transcript's copy of the body, sent again from the dev server's address, " +
          "earned no Receipt at the dev server's reply socket — either the harness " +
          'no longer drops an identical body, or it did not record the bytes it was sent',
        '16',
        () => expect(heard).toBe(true),
      )
      canary('the duplicate reached the transcript as a second delivery', '16', () =>
        expect(
          carrying(session, first.marker).filter((e) => e.type === 'user'),
        ).toHaveLength(1),
      )
    })

    it('MODEL-DEPENDENT: with the fixture allowlist, the agent acks and then finishes the Pick', async () => {
      process.stdout.write(
        '\nseam 3 — MODEL-DEPENDENT canary: the ack and done depend on the model ' +
          'following the skill. A failure here alone may be the model, not the harness.\n',
      )
      await settle(session, server, hook, { approve: false })
      const row = await untilAsync(async () => {
        const status = await statusOf(server, pickId)
        return status.state === DONE ? status : null
      }, 30_000)
      const history = (row ?? (await statusOf(server, pickId))).history.map(
        (h) => h.state,
      )
      holds(
        `MODEL-DEPENDENT: the agent's ack and done did not both reach the dev server ` +
          `(the Pick went ${history.join(' → ')})`,
        () => {
          expect(history).toContain(WORKING)
          expect(history.at(-1)).toBe(DONE)
          expect(history.indexOf(WORKING)).toBeLessThan(history.lastIndexOf(DONE))
        },
      )
    })

    it('the Stop hook drains a queued Pick at turn end, exactly once', async () => {
      const found = carrying(session, atStop.marker)
      process.stdout.write(
        `\nseam 3 measurement — the Stop-drained Pick sits in: ${found.map(describeEntry).join(', ') || 'nothing'}\n`,
      )
      canary(
        'the Stop hook `init` installed no longer delivers a queued Pick as a ' +
          '`stop_hook_summary` entry — with, on 2.1.280, its `hook_success` and ' +
          '`hook_additional_context` attachments beside it, all three the one Stop run',
        '15',
        () => {
          expect(found.map(kindOf).toSorted()).toEqual(STOP_DRAIN_RECORDS)
          expect(found.map(hookEventOf)).toEqual(['Stop', 'Stop', 'Stop'])
          const summary = found.find((line) => line.subtype === 'stop_hook_summary') ?? {}
          expect(
            hookContextOf(summary).filter((t) => t.includes(stopPickId)),
          ).toHaveLength(1)
        },
      )
      canary(
        'a Stop drain no longer reaches the model once, as additional context',
        '15',
        () => expect(handedToModel(found)).toHaveLength(1),
      )
      await expectClaimedByDrain(server, stopPickId, 'Stop-drained')
    })

    it('the UserPromptSubmit hook drains a queued Pick as additionalContext on the next prompt, exactly once', async () => {
      const queued = await postPick(server, atPrompt.note, null)
      promptPickId = queued.pickId
      expect(queued.state).toBe(QUEUED_UNADDRESSED)
      await typePrompt(session, 'Reply with the single word ok.')
      const found = await until(() => {
        const entries = carrying(session, atPrompt.marker)
        return entries.length > 0 ? entries : null
      }, 30_000)
      process.stdout.write(
        `\nseam 3 measurement — the prompt-drained Pick sits in: ${(found ?? []).map(describeEntry).join(', ') || 'nothing'}\n`,
      )
      await settle(session, server, hook, { approve: false })
      const all = carrying(session, atPrompt.marker)
      canary(
        'the UserPromptSubmit hook `init` installed no longer delivers a queued Pick ' +
          'into the transcript',
        '15',
        () => expect(found).not.toBeNull(),
      )
      canary(
        'a prompt-drained Pick is delivered more than once, or as a Stop drain',
        '15',
        () => {
          expect(all.map(kindOf)).toEqual(['attachment/hook_additional_context'])
          expect(hookEventOf(all[0] ?? {})).toBe('UserPromptSubmit')
          expect(
            hookContextOf(all[0] ?? {}).filter((t) => t.includes(promptPickId)),
          ).toHaveLength(1)
        },
      )
      await expectClaimedByDrain(server, promptPickId, 'prompt-drained')
    })

    it('every Pick this session was sent was delivered exactly once, by one route', async () => {
      canary('the socket Pick reached the transcript more than once', '11', () =>
        expect(
          carrying(session, first.marker).filter((e) => e.type === 'user'),
        ).toHaveLength(1),
      )
      canary(
        'the Pick drained at the peer turn reached the transcript more than once',
        '15',
        () => expect(handedToModel(carrying(session, atPeerTurn.marker))).toHaveLength(1),
      )
      canary('the Stop-drained Pick reached the model more than once', '15', () =>
        expect(handedToModel(carrying(session, atStop.marker))).toHaveLength(1),
      )
      await expectClaimedByDrain(server, peerTurnPickId, 'peer-turn')
    })

    it('ran no command but the one shape allowed, and stops clean', async () => {
      await expectStopsClean(session, server)
      stopped = true
      expect(unexpectedCalls(hook, server.url)).toEqual([])
    })
  })

  describe('a session in manual permission mode, with no allowlist', () => {
    let session: ThrowawaySession
    let settingsDir: string
    let hook: FixtureHook
    let stopped = false
    const pick = noteFor('manual')
    let pickId = ''

    beforeAll(async () => {
      // The same hook, allowing nothing: it only logs what is asked, exactly.
      settingsDir = mkdtempSync(join(tmpdir(), 'vite-agent-inspect-seam3-fixture-'))
      hook = writeFixtureHook(settingsDir, server.url, { allow: false })
      session = await launchSession({
        cwd: repo.dir,
        args: modelTierArgs('--settings', hook.settingsFile),
      })
      await session.ready(30_000)
    })

    afterAll(async () => {
      if (!stopped) await session?.stop()
      if (settingsDir) rmSync(settingsDir, { recursive: true, force: true })
    })

    it('a Pick whose skill-driven ack is a shell call waits on a permission prompt, and approval returns it to idle', async () => {
      pickId = (await postPick(server, pick.note, targetOf(session))).pickId
      const settled = await settle(session, server, hook, { approve: true })
      process.stdout.write(
        `\nseam 3 measurement — manual mode: waitingFor ${JSON.stringify(settled.waits)}, ` +
          `the dev server's Candidate said ${JSON.stringify([...new Set(settled.candidateWaits)])}, ` +
          `${settled.approvals} approval(s) through the pty\n`,
      )
      canary(
        'a Pick into a manual-mode session no longer shows `status: waiting` with ' +
          '`waitingFor: "permission prompt"`',
        '07',
        () => expect(settled.waits).toContain('permission prompt'),
      )
      canary(
        "the dev server's Candidate no longer carries the registry's `waitingFor`",
        '11',
        () => expect(settled.candidateWaits).toContain('permission prompt'),
      )
      canary('approval through the pty no longer returns the session to idle', '07', () =>
        expect(session.entry()?.status).toBe('idle'),
      )
      const history = (await statusOf(server, pickId)).history.map((h) => h.state)
      holds(
        `the approved ack never reached the dev server (${history.join(' → ')})`,
        () => expect(history).toContain(WORKING),
      )
    })

    it('ran no command but the one shape allowed, and stops clean', async () => {
      await expectStopsClean(session, server)
      stopped = true
      expect(unexpectedCalls(hook, server.url)).toEqual([])
    })
  })

  describe('measures: a session started in a subdirectory of the checkout (no model)', () => {
    it("whether the root's hooks run there, and whether their path resolves, recorded either way", async () => {
      // Ticket 16's open question. The hook command is
      // `node ${CLAUDE_PROJECT_DIR}/node_modules/…`, so a session in `src/` can
      // fail it two ways: the root's settings are not loaded at all, or they
      // are and `CLAUDE_PROJECT_DIR` is `src/`, where that path is missing. A
      // second prompt, with `src/node_modules` linked in, tells the two apart.
      const before = blackhole.connections()
      const cwd = join(repo.dir, 'src')
      const session = await launchSession({
        cwd,
        modelUrl: blackhole.url,
        args: modelTierArgs(),
      })
      /** Queue a Pick, type a prompt, and say whether a hook drained it. */
      const promptDrains = async (label: string) => {
        const pick = noteFor(label)
        const pickId = (await postPick(server, pick.note, null)).pickId
        await typePrompt(session, 'Reply with the single word ok.')
        const drained = await untilAsync(async () => {
          const status = await statusOf(server, pickId)
          return status.state === QUEUED_UNADDRESSED ? null : true
        }, 15_000)
        const entries = carrying(session, pick.marker).map(kindOf)
        // End the blackholed turn from the terminal before the next prompt.
        session.press('\x1b')
        await until(() => (session.entry()?.status === 'idle' ? true : null), 15_000)
        return { drained: drained === true, entries }
      }
      try {
        await session.ready(30_000)
        await sleep(2000)
        const plain = await promptDrains('subdirectory')
        let linked: { drained: boolean; entries: string[] } | null = null
        if (!plain.drained) {
          symlinkSync(join(repo.dir, 'node_modules'), join(cwd, 'node_modules'), 'dir')
          linked = await promptDrains('subdirectory-linked')
        }
        const answer = plain.drained
          ? "the root's hooks run there, and their path resolves"
          : linked?.drained
            ? "the root's hooks run there, but CLAUDE_PROJECT_DIR is the subdirectory, " +
              'so their path resolves only once node_modules is reachable from it'
            : "the root's hooks do not run there at all"
        process.stdout.write(
          `\nseam 3 measurement — a session started in ${cwd} (registry cwd ` +
            `${String(session.entry()?.cwd)}): ${answer}. The first prompt's Pick ` +
            `${plain.drained ? 'was' : 'was not'} drained (${plain.entries.join(', ') || 'in no entry'})` +
            (linked
              ? `; with src/node_modules linked, it ${linked.drained ? 'was' : 'was not'} ` +
                `(${linked.entries.join(', ') || 'in no entry'})`
              : '') +
            `. Its turns went to the blackhole ${blackhole.connections() - before} time(s).\n`,
        )
        holds('the subdirectory session took no turn at the blackhole', () =>
          expect(blackhole.connections()).toBeGreaterThan(before),
        )
      } finally {
        await expectStopsClean(session, server)
      }
    })
  })

  it('the bystander was never sent a Pick, and stops clean', async () => {
    const picks = bystander
      .transcript()
      .filter((entry) => JSON.stringify(entry).includes(HEADING))
    expect(picks).toEqual([])
    await expectStopsClean(bystander, server)
    bystanderStopped = true
  })
})
