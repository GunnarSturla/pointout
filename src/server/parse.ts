import type { IncomingMessage } from 'node:http'
import type { Refusal } from './guard.js'

// Checking what arrives on the wire (spec §11, §21). Every ingress — a Pick, a
// drain, a Screen Capture's coordinates — reads untrusted JSON and answers
// either a value or a refusal naming the part it refused: a 4xx that says only
// "bad request" is a silent drop with a status code on it. The shapes differ
// from endpoint to endpoint; the discipline does not, so it is written once.

/** Either a value, or the refusal that says why there is none. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: Refusal }

export function refuse(status: number, error: string, reason: string): Parsed<never> {
  return { ok: false, refusal: { status, body: { error, reason } } }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isText(value: unknown): value is string {
  return typeof value === 'string'
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** A non-empty string, or null: an empty one says as little as an absent one. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The whole of a request body. Generous next to the Note cap because the Owner
 * chain sends one raw stack string per link, uncapped, and Excerpts ride along;
 * small enough that a runaway page cannot make the dev server hold a megabyte
 * per request.
 */
export const BODY_MAX_BYTES = 256 * 1024

/**
 * Read the request body, capped. The stream is drained either way: a refusal
 * that leaves bytes unread is answered with a reset connection rather than with
 * the reason it went to the trouble of writing.
 */
export function readRequestBody(request: IncomingMessage): Promise<Parsed<string>> {
  const limit = BODY_MAX_BYTES
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const settle = (result: Parsed<string>) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        settle(
          refuse(
            413,
            'body-too-large',
            `refused a body of more than ${limit} bytes: ingress reads a bounded ` +
              'body, and this one kept going.',
          ),
        )
        request.resume()
        return
      }
      if (!settled) chunks.push(chunk)
    })
    request.on('end', () =>
      settle({ ok: true, value: Buffer.concat(chunks).toString('utf8') }),
    )
    request.on('error', (error: Error) =>
      settle(
        refuse(
          400,
          'body-unreadable',
          `refused a request whose body ended early: ${error.message}`,
        ),
      ),
    )
  })
}
