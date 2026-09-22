import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Logger } from 'vite'
import type { Target } from '../../wire.js'
import { now } from '../clock.js'
import type { Delivery, DeliveryOutcome, DeliveryRoute } from '../delivery.js'
import type { ReplyListener } from '../receipt.js'
import { claimedSocketPaths } from '../registry.js'
import { readReplyFrame } from './receipt-frames.js'
import { bindReplySocket } from './reply-socket.js'
import type { ReplySocket } from './reply-socket.js'

// The Claude Code delivery route: the inbox socket and what comes back at the
// reply address, spoken as the probes measured it (spike 14 and spike 16 are the
// reference; nothing is imported from either). Everything harness-specific in
// v0's delivery is in this file and its neighbours — `delivery.ts` is the seam a
// second harness would fit.
//
// Correlation is this file's own job, because only it knows what it wrote. A
// Receipt's `orig_msg_id` is the Pick's id; an idle notice's is the id of the
// one-shot subscription this route minted **after** that Pick, which is what
// makes both the Target and the send time knowable for a notice that names
// neither (spec §16).

/** The whole conversation is three lines, then the connection closes. */
const WRITE_TIMEOUT_MS = 2000

export interface ClaudeRouteOptions {
  /** Where the harness keeps its session entries and their key files. */
  registryDir: string
  /** Where the harness keeps its sockets, and where this route binds its own. */
  socketDir: string
  logger: Logger
}

export async function createClaudeRoute(
  options: ClaudeRouteOptions,
): Promise<DeliveryRoute> {
  const { logger } = options

  // v0 never resends a delivery with a byte-identical body, so one Pick is
  // written at most once (spec §13, §15) — and a `duplicate` Receipt is
  // therefore always a real signal rather than one of ours.
  const written = new Set<string>()

  /** Each Pick this route wrote: to which Target, and when it went. */
  const sent = new Map<string, { target: Target; at: number }>()
  /** Each idle subscription this route minted, and the Pick it followed. */
  const subscriptions = new Map<string, string>()

  /** The ledger's ear, once there is one. Null until the endpoints are up. */
  let listener: ReplyListener | null = null

  const ignored = (why: string) =>
    logger.warn(`vite-agent-inspect: ignored a frame at the reply address — ${why}.`)

  const reply: ReplySocket = await bindReplySocket({
    socketDir: options.socketDir,
    claimedPaths: claimedSocketPaths(options.registryDir),
    refuse: ignored,
    receive(line) {
      try {
        read(line)
      } catch (error) {
        // Reading a line is a parse and two map lookups, so this is a bug in
        // this plugin rather than a bad frame. It is said out loud and the
        // connection is left serving the next one.
        logger.error(
          `vite-agent-inspect: reading a frame at the reply address threw: ` +
            `${(error as Error).stack ?? (error as Error).message}`,
        )
      }
    },
  })
  if (!reply.address) logger.warn(`vite-agent-inspect: reply socket ${reply.postureLine}`)

  /**
   * One line off the reply address. The Pick's id is the whole credential here
   * (user story 82): it is a uuid this dev server minted and wrote to exactly
   * one inbox, and a frame naming anything else is ignored. The frame's own
   * `from` is not checked against the Target's socket, because anything that
   * could reach this socket could equally write that field — the unguessable
   * id is what a forged frame does not have.
   */
  function read(line: string): void {
    const frame = readReplyFrame(line)
    if (frame.kind === 'unusable') return ignored(frame.why)

    if (frame.kind === 'status') {
      if (!sent.has(frame.origMsgId)) {
        return ignored(
          `its orig_msg_id ${frame.origMsgId} is no pick this dev server sent`,
        )
      }
      if (!listener) return ignored('this dev server has nowhere to put it yet')
      return listener.receipt({
        pickId: frame.origMsgId,
        status: frame.status,
        dropReason: frame.dropReason,
        reason: frame.reason,
      })
    }

    const pickId = subscriptions.get(frame.origMsgId)
    const after = pickId ? sent.get(pickId) : undefined
    if (!pickId || !after) {
      return ignored(
        `its orig_msg_id ${frame.origMsgId} is no idle subscription this dev server made`,
      )
    }
    // One-shot and fired immediately against an already-idle Target: a notice
    // older than the send was consumed before the Pick landed and says nothing
    // about it (spike 16). A cheap check, from the frame's own contents.
    if (frame.finishedAt < after.at) {
      return ignored(
        `it is a stale idle notice for pick ${pickId}: it finished at ` +
          `${frame.finishedAt}, before that pick was sent at ${after.at}`,
      )
    }
    if (!listener) return ignored('this dev server has nowhere to put it yet')
    return listener.idle({ target: after.target, pickId, finishedAt: frame.finishedAt })
  }

  return {
    postureLine: reply.postureLine,

    listen(ear) {
      listener = ear
    },

    async deliver({ pickId, body, target, session }: Delivery): Promise<DeliveryOutcome> {
      if (written.has(pickId)) {
        return { written: false, reason: `pick ${pickId} was already written once` }
      }

      const token = peerToken(options.registryDir, target.pid)
      if (token === null) {
        // Auth is enforced on Windows only (spike 14), so a missing key file is
        // not a refusal — but an unauthenticated write is said out loud rather
        // than papered over with an empty token.
        logger.warn(
          `vite-agent-inspect: no key file for pid ${target.pid} in ${options.registryDir}; ` +
            'writing the pick with no auth frame.',
        )
      }

      const frames: Array<Record<string, unknown>> = []
      if (token !== null) frames.push({ type: 'auth', token })
      frames.push({
        type: 'user',
        ...(reply.address ? { from: reply.address } : {}),
        msg_id: pickId,
        priority: 'next',
        session_id: target.sessionId,
        message: { role: 'user', content: body },
      })
      // After the Pick, never before: the subscription is one-shot and fires
      // immediately against an already-idle Target (spike 16).
      const subscription = randomUUID()
      frames.push({
        type: 'control',
        action: 'notify_when_idle',
        ...(reply.address ? { from: reply.address } : {}),
        msg_id: subscription,
      })

      written.add(pickId)
      try {
        await writeFrames(session.messagingSocketPath, frames)
      } catch (error) {
        return {
          written: false,
          reason: `writing to ${session.messagingSocketPath} failed: ${(error as Error).message}`,
        }
      }

      // Only now: a Receipt for a write that failed would name a Pick the
      // harness never saw, and the subscription went out with the same write.
      sent.set(pickId, { target, at: now() })
      subscriptions.set(subscription, pickId)
      return { written: true }
    },

    close: reply.close,
  }
}

/** Connect, write, close. No subscription and no re-arm (spec §15). */
function writeFrames(
  socketPath: string,
  frames: Array<Record<string, unknown>>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const fail = (error: Error) => {
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(WRITE_TIMEOUT_MS, () =>
      fail(new Error(`no answer within ${WRITE_TIMEOUT_MS}ms`)),
    )
    socket.once('error', fail)
    socket.once('connect', () => {
      for (const frame of frames) socket.write(JSON.stringify(frame) + '\n')
      socket.end(() => resolve())
    })
  })
}

/**
 * The session's published peer token, from `<registryDir>/<pid>.<hash>.key`.
 * The hash is the harness's, so the file is found by its pid prefix rather than
 * by a name this plugin would have to guess.
 */
function peerToken(registryDir: string, pid: number): string | null {
  try {
    const name = readdirSync(registryDir).find(
      (file) => file.startsWith(`${pid}.`) && file.endsWith('.key'),
    )
    if (!name) return null
    const parsed: unknown = JSON.parse(readFileSync(join(registryDir, name), 'utf8'))
    const token = (parsed as { peerToken?: unknown } | null)?.peerToken
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}
