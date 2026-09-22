import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bindProbe,
  createScratchRepo,
  launchSession,
  openBlackhole,
  preflight,
  refuseRealWorktree,
  sleep,
  startRealDevServer,
  until,
} from '../harness/claude-session.js'
import type {
  Blackhole,
  Probe,
  RealDevServer,
  ScratchRepo,
  ThrowawaySession,
} from '../harness/claude-session.js'
import { repoRoot } from '../harness/paths.js'

// Seam 3, the no-model tier (ticket 20): contract canaries against a real
// Claude Code harness. It fakes nothing and spends nothing — a throwaway
// session is started under a pty in a scratch repository, and every assertion
// is on a harness artefact: the registry files, the sockets, and the frames the
// harness sends back. None is on anything a model says, and no model is asked:
// the one turn this tier makes the session take is pointed at a blackhole.
//
// Each canary checks one assumption v0 depends on, and its failure message
// names that assumption and the map ticket that established it, so a harness
// that has moved reads as a sentence rather than as a stack trace.
//
// The tests run in order, on one session, and some lean on the ones before:
// the idle notice needs the control turn to have finished (a session that has
// never finished one sends no `finished_at`), and the child session runs once
// the peer is gone. Run the file whole; `-t` on one canary can fail it wrongly.

const harness = preflight()

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

/** §14: an entry is usable when it carries these. */
const REQUIRED_FIELDS = [
  'pid',
  'sessionId',
  'cwd',
  'status',
  'name',
  'messagingSocketPath',
]

/**
 * How long the harness is given to answer a frame — with a Receipt or an idle
 * notice. Spike 16 measured a Receipt at 8ms and an idle notice at 801ms.
 */
const ANSWER_WINDOW_MS = 10_000

const NO_LEFTOVERS = { entry: false, keyFile: false, socket: false }

describe('seam 3 — safety', () => {
  it('refuses a temporary directory that resolves to a real worktree root', () => {
    expect(() => refuseRealWorktree(repoRoot)).toThrow(/is the root of a real worktree/)
  })
})

describe.skipIf(!harness.runnable)(
  `seam 3 — no-model tier${harness.runnable ? '' : ` (skipped: ${harness.reason})`}`,
  () => {
    let repo: ScratchRepo
    let blackhole: Blackhole
    let session: ThrowawaySession
    let server: RealDevServer
    let probe: Probe
    let stopped = false
    /** How long the peer session took to register once it was up. */
    let registeredAfterMs = 0

    beforeAll(async () => {
      repo = createScratchRepo()
      blackhole = await openBlackhole()
      session = await launchSession({ cwd: repo.dir, modelUrl: blackhole.url })
      await session.ready()
      const readyAt = Date.now()
      await until(() => session.entry(), 20_000)
      registeredAfterMs = Date.now() - readyAt
      server = await startRealDevServer(repo.dir)
      probe = await bindProbe()
    })

    afterAll(async () => {
      await probe?.close()
      await server?.close()
      if (!stopped) await session?.stop()
      await blackhole?.close()
      repo?.cleanup()
    })

    it('starts the session with no CLAUDE* variable inherited', () => {
      expect(session.envNames.filter((name) => name.startsWith('CLAUDE'))).toEqual([])
    })

    it('the session appears in the registry with every field §14 requires, idle', () => {
      const entry = session.entry()
      canary(
        'a trusted peer session no longer writes ~/.claude/sessions/<pid>.json',
        '14',
        () => expect(entry).not.toBeNull(),
      )
      for (const field of REQUIRED_FIELDS) {
        canary(`registry entries no longer carry \`${field}\``, '14', () =>
          expect(entry).toHaveProperty(field),
        )
      }
      canary('a registry entry is no longer named for its own pid', '14', () =>
        expect(entry?.pid).toBe(session.pid),
      )
      canary(
        "a registry entry's `cwd` is no longer the session's working directory",
        '11',
        () => expect(entry?.cwd).toBe(repo.dir),
      )
      canary('a fresh session no longer reads `status: idle`', '16', () =>
        expect(entry?.status).toBe('idle'),
      )
    })

    it('its key file holds a peerToken', () => {
      const key = session.keyFile()
      canary(
        'a session no longer publishes ~/.claude/sessions/<pid>.<hash>.key',
        '14',
        () => expect(key).not.toBeNull(),
      )
      canary('the key file is no longer named <pid>.<sha256>.key', '14', () =>
        expect(key?.name).toMatch(new RegExp(`^${session.pid}\\.[0-9a-f]{64}\\.key$`)),
      )
      canary('the key file no longer holds a `peerToken`', '14', () =>
        expect(key?.hasPeerToken).toBe(true),
      )
    })

    it('its socket exists 1:1 with its entry', () => {
      const entry = session.entry()
      canary("the entry's socket is no longer /tmp/cc-socks/<pid>.sock", '14', () =>
        expect(entry?.messagingSocketPath).toBe(`/tmp/cc-socks/${session.pid}.sock`),
      )
      canary('the socket the entry names does not exist', '14', () =>
        expect(session.socketExists()).toBe(true),
      )
    })

    it('the dev server offers the throwaway session, and only it, as a Candidate', async () => {
      // A safety gate as much as a canary: nothing below is aimed anywhere but
      // the pid this suite spawned, and the dev server agrees.
      const body = (await fetch(server.url + '/__agent/sessions').then((r) =>
        r.json(),
      )) as {
        registry: { state: string }
        candidates: Array<{ pid: number }>
      }
      canary('the real registry no longer reads as `readable`', '11', () =>
        expect(body.registry.state).toBe('readable'),
      )
      canary("the throwaway session is not the dev server's only Candidate", '11', () =>
        expect(body.candidates.map((candidate) => candidate.pid)).toEqual([session.pid]),
      )
    })

    it('measures: a user frame whose session_id mismatches is not delivered, and whether it earns a Receipt', async () => {
      const msgId = randomUUID()
      await session.send([
        {
          type: 'user',
          from: probe.address,
          msg_id: msgId,
          priority: 'next',
          session_id: randomUUID(),
          message: {
            role: 'user',
            content: 'seam 3 canary: a frame addressed to another session.',
          },
        },
      ])
      const receipt = await probe.waitFor(
        (frame) => frame.orig_msg_id === msgId,
        ANSWER_WINDOW_MS,
      )
      const status = session.entry()?.status
      const shown = session.screen().includes('aframeaddressedtoanothersession')

      // Recorded either way (ticket 20). A Receipt here would make this the
      // zero-cost delivery canary; its absence is the measurement.
      const result = receipt
        ? `a Receipt came back: ${JSON.stringify({ status: receipt.status, drop_reason: receipt.drop_reason })}`
        : `no Receipt within ${ANSWER_WINDOW_MS / 1000}s — the drop is silent`
      process.stdout.write(
        `\nseam 3 measurement — session_id mismatch: ${result}; ` +
          `the registry read \`${String(status)}\` afterwards and the frame ` +
          `${shown ? 'WAS' : 'was not'} shown in the session.\n`,
      )

      canary('a frame whose `session_id` mismatches is delivered anyway', '11', () =>
        expect(shown).toBe(false),
      )
      canary('a frame whose `session_id` mismatches still starts a turn', '11', () =>
        expect(status).toBe('idle'),
      )
    })

    it('the same frame with the right session_id is taken, and its turn goes to the blackhole', async () => {
      // The control for the measurement above: the mismatch frame was dropped
      // because of its session_id, not because of anything else about it.
      const before = blackhole.connections()
      await session.send([
        {
          type: 'user',
          from: probe.address,
          msg_id: randomUUID(),
          priority: 'next',
          session_id: session.entry()?.sessionId,
          message: { role: 'user', content: 'seam 3 canary: the control frame.' },
        },
      ])
      const busy = await until(
        () => (session.entry()?.status === 'busy' ? true : null),
        10_000,
      )
      canary(
        'a peer frame to an idle session no longer flips it `idle → busy`',
        '16',
        () => expect(busy).toBe(true),
      )
      const reached = await until(
        () => (blackhole.connections() > before ? true : null),
        10_000,
      )
      holds(
        'the turn did not go to ANTHROPIC_BASE_URL — the no-model tier may have reached a real model',
        () => expect(reached).toBe(true),
      )

      // End the turn from the terminal, the way a developer would.
      session.press('\x1b')
      const idle = await until(
        () => (session.entry()?.status === 'idle' ? true : null),
        15_000,
      )
      holds('the interrupted control turn never returned the session to idle', () =>
        expect(idle).toBe(true),
      )
    })

    it('a notify_when_idle frame returns a peer_idle_notice carrying from_mode, finished_at and msgV: 1', async () => {
      const msgId = randomUUID()
      await session.send([
        {
          type: 'control',
          action: 'notify_when_idle',
          from: probe.address,
          msg_id: msgId,
        },
      ])
      const notice = await probe.waitFor(
        (frame) => frame.orig_msg_id === msgId,
        ANSWER_WINDOW_MS,
      )
      canary('`notify_when_idle` no longer answers with anything', '16', () =>
        expect(notice).not.toBeNull(),
      )
      canary('the idle notice is no longer `type: control`', '16', () =>
        expect(notice?.type).toBe('control'),
      )
      canary('the idle notice is no longer `action: peer_idle_notice`', '16', () =>
        expect(notice?.action).toBe('peer_idle_notice'),
      )
      canary('the idle notice no longer carries `state: idle`', '16', () =>
        expect(notice?.state).toBe('idle'),
      )
      canary('the idle notice no longer carries `msgV: 1`', '16', () =>
        expect(notice?.msgV).toBe(1),
      )
      canary('the idle notice no longer carries `from_mode`', '16', () =>
        expect(typeof notice?.from_mode).toBe('string'),
      )
      canary('the idle notice no longer carries a numeric `finished_at`', '16', () =>
        expect(typeof notice?.finished_at).toBe('number'),
      )
    })

    it("and the same notice reaches the dev server's reply address, whose name the harness accepts", async () => {
      const address = /reply socket\s+bound at (\S+\.sock)/.exec(server.log())?.[1]
      holds('the dev server did not bind its reply socket — see its posture block', () =>
        expect(address).toBeDefined(),
      )
      const msgId = randomUUID()
      await session.send([
        {
          type: 'control',
          action: 'notify_when_idle',
          from: `uds:${address}`,
          msg_id: msgId,
        },
      ])
      // The dev server made no such subscription, so it ignores the notice out
      // loud — and it says so only once the frame has passed its shape checks:
      // `type`, `msgV: 1`, `orig_msg_id`, the action and a numeric `finished_at`.
      const heard = await until(
        () =>
          server
            .log()
            .includes(
              `its orig_msg_id ${msgId} is no idle subscription this dev server made`,
            )
            ? true
            : null,
        ANSWER_WINDOW_MS,
      )
      const said = server
        .log()
        .split('\n')
        .filter((line) => line.includes('reply address'))
        .join('\n')
      canary(
        "an idle notice to the dev server's `uds:/tmp/cc-socks/<pid>.sock` never arrived, " +
          `or arrived in a shape v0 does not read${said ? `:\n${said}` : ''}`,
        '16',
        () => expect(heard).toBe(true),
      )
    })

    it('killing the session removes its registry entry, key file and socket, and no token was shown', async () => {
      // Read while the key file still exists: the stop removes it.
      const leaked = [
        session.screen(),
        server.log(),
        JSON.stringify(probe.frames()),
      ].some((text) => session.leaksToken(text))
      const left = await session.stop()
      stopped = true
      holds('the throwaway session left artefacts behind for its pid', () =>
        expect(left).toEqual(NO_LEFTOVERS),
      )
      holds(
        'the peer token appeared in the terminal, the dev server log or a frame the harness sent back',
        () => expect(leaked).toBe(false),
      )
    })

    it('a session started with CLAUDE_CODE_CHILD_SESSION set does not register', async () => {
      // This guards the scrub itself: the one variable it exists to remove.
      const child = await launchSession({
        cwd: repo.dir,
        modelUrl: blackhole.url,
        env: { CLAUDE_CODE_CHILD_SESSION: '1' },
      })
      try {
        await child.ready()
        // The peer above registered this long after coming up; the child is
        // given three times that, and never less than eight seconds.
        await sleep(Math.max(8000, 3 * registeredAfterMs))
        canary(
          'a session inheriting CLAUDE_CODE_CHILD_SESSION now registers — the scrub ' +
            'may no longer be needed, or no longer be enough',
          '07',
          () => expect(child.entry()).toBeNull(),
        )
      } finally {
        const left = await child.stop()
        holds('the child session left artefacts behind for its pid', () =>
          expect(left).toEqual(NO_LEFTOVERS),
        )
      }
    })
  },
)
