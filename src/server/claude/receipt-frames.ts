import { text } from '../parse.js'
import { RECEIPT_STATUSES } from '../receipt.js'
import type { ReceiptStatus } from '../receipt.js'

// One line at the reply address, read (spec §16). Nothing here correlates and
// nothing here decides: this is the harness's wire shape turned into something
// this project has words for, or a refusal saying which part of the shape was
// not there. `route.ts` is what knows which Pick a frame names.
//
// Pinned by shape rather than by version string: `msgV: 1` is the harness's own
// version field, and a frame carrying anything else is from a harness that has
// moved. It is ignored and said out loud, never guessed at (spec §21).

/** The one version of the control frames v0 was measured against. */
const FRAME_VERSION = 1

/** What one line turned out to be. */
export type ReplyFrame =
  | {
      kind: 'status'
      /** The Pick the Receipt names — the `msg_id` this server sent it under. */
      origMsgId: string
      status: ReceiptStatus
      /** Only `dropped` carries one. Null otherwise. */
      dropReason: string | null
      /** The harness's own prose. Null when it sent none. */
      reason: string | null
    }
  | {
      kind: 'idle'
      /** The subscription the notice answers, not a Pick id. */
      origMsgId: string
      finishedAt: number
    }
  /** Not a frame this server can act on, and why. Ignored at the wire. */
  | { kind: 'unusable'; why: string }

export function readReplyFrame(line: string): ReplyFrame {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    return unusable(`it is not JSON (${(error as Error).message})`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return unusable('it is not a JSON object')
  }

  const frame = parsed as Record<string, unknown>
  if (frame.msgV !== FRAME_VERSION) {
    return unusable(
      `its msgV is ${JSON.stringify(frame.msgV)} rather than ${FRAME_VERSION}, ` +
        'which is the one version these frames were measured against',
    )
  }
  if (frame.type !== 'control') {
    return unusable(`its type is ${JSON.stringify(frame.type)} rather than "control"`)
  }

  const origMsgId = text(frame.orig_msg_id)
  if (origMsgId === null) return unusable('it names no orig_msg_id')

  if (frame.action === 'peer_message_status') {
    const status = text(frame.status)
    if (status === null || !isReceiptStatus(status)) {
      return unusable(
        `its status is ${JSON.stringify(frame.status)}, which is none of the six ` +
          'a Receipt can carry',
      )
    }
    return {
      kind: 'status',
      origMsgId,
      status,
      dropReason: text(frame.drop_reason),
      reason: text(frame.reason),
    }
  }

  if (frame.action === 'peer_idle_notice') {
    const finishedAt = frame.finished_at
    if (typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) {
      return unusable(
        `its finished_at is ${JSON.stringify(finishedAt)} rather than a number`,
      )
    }
    return { kind: 'idle', origMsgId, finishedAt }
  }

  return unusable(
    `its action is ${JSON.stringify(frame.action)}, which is neither ` +
      'peer_message_status nor peer_idle_notice',
  )
}

function unusable(why: string): ReplyFrame {
  return { kind: 'unusable', why }
}

function isReceiptStatus(value: string): value is ReceiptStatus {
  return (RECEIPT_STATUSES as readonly string[]).includes(value)
}
