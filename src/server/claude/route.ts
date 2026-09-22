import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import type { Logger } from 'vite'
import { claimedSocketPaths, readCandidates } from '../registry.js'
import type { RegistryQuery } from '../registry.js'
import { addresses } from '../targeting.js'
import { bindReplySocket } from './reply-socket.js'
import type { ReplySocket } from './reply-socket.js'
import type { Delivery, DeliveryOutcome, DeliveryRoute } from '../delivery.js'

// The Claude Code delivery route: the inbox socket, spoken as the probes
// measured it (spike 14 and spike 16 are the reference; nothing is imported
// from either). Everything harness-specific in v0's delivery is in this file
// and its neighbour — `delivery.ts` is the seam a second harness would fit.

/** The whole conversation is three lines, then the connection closes. */
const WRITE_TIMEOUT_MS = 2000

interface ClaudeRouteOptions extends RegistryQuery {
  socketDir: string
  logger: Logger
}

export async function createClaudeRoute(
  options: ClaudeRouteOptions,
): Promise<DeliveryRoute> {
  const { logger } = options

  const reply: ReplySocket = await bindReplySocket({
    socketDir: options.socketDir,
    claimedPaths: claimedSocketPaths(options.registryDir),
  })
  if (!reply.address) logger.warn(`vite-agent-inspect: reply socket ${reply.postureLine}`)

  // v0 never resends a delivery with a byte-identical body, so one Pick is
  // written at most once (spec §13, §15) — and a `duplicate` Receipt is
  // therefore always a real signal rather than one of ours.
  const written = new Set<string>()

  return {
    postureLine: reply.postureLine,

    async deliver({ pickId, body, target }: Delivery): Promise<DeliveryOutcome> {
      if (written.has(pickId)) {
        return { written: false, reason: `pick ${pickId} was already written once` }
      }

      // Where the Target's inbox is. Looked up here rather than carried in the
      // Delivery, because a socket path is this harness's business and the seam
      // above speaks only of a Target.
      const entry = readCandidates(options).registry.entries.find((session) =>
        addresses(session, target),
      )
      if (!entry) {
        return {
          written: false,
          reason: `session ${target.sessionId} is no longer in the registry`,
        }
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
      frames.push({
        type: 'control',
        action: 'notify_when_idle',
        ...(reply.address ? { from: reply.address } : {}),
        msg_id: randomUUID(),
      })

      written.add(pickId)
      try {
        await writeFrames(entry.messagingSocketPath, frames)
      } catch (error) {
        return {
          written: false,
          reason: `writing to ${entry.messagingSocketPath} failed: ${(error as Error).message}`,
        }
      }
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
