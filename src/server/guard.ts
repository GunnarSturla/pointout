// Borrowed: the fail-closed same-origin check on Pick ingress
// From: vite-plugin-herdr — https://github.com/scaccogatto/vite-plugin-herdr
// Version: 0.2.0 (2026-09-21)
// License: MIT — full text in LICENSE-THIRDPARTY
// Changes: kept the shape — an absent or unparseable Origin is a refusal, never
//   a pass — and dropped the `Sec-Fetch-Site: same-origin` shortcut, so nothing
//   is admitted on a fetch metadata header. Replaced the `Origin`-host versus
//   `Host`-header comparison — two values from the same request, which agree
//   whenever the caller picks the name — with a comparison against the origins
//   this dev server is actually serving on. Applied to Pick ingress alone rather
//   than to every endpoint, because a browser sends no Origin on a same-origin
//   GET and the Overlay's own reads would otherwise be refused.

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'

/** True when the request came from an origin this dev server is serving on. */
function isSameOrigin(headers: IncomingHttpHeaders, ownOrigins: Set<string>): boolean {
  const origin = headers.origin
  if (typeof origin !== 'string') return false
  try {
    return ownOrigins.has(new URL(origin).origin)
  } catch {
    return false
  }
}

// --- end of borrowed code ---

/**
 * A refusal the caller sends as-is. `null` from a check means "may proceed".
 *
 * Every refusal names its part and says why; one that has something further the
 * Overlay must act on — the replacement a re-resolved Target yields (spec §14) —
 * carries it beside the two, rather than burying it in the prose.
 */
export interface Refusal {
  status: number
  body: { error: string; reason: string } & Record<string, unknown>
}

/** IPv4 loopback, IPv6 loopback, and IPv4-mapped-into-IPv6 loopback. */
const LOOPBACK =
  /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

// The ingress check (spec §11). Every `/__agent/*` endpoint is loopback-only;
// the `Origin` requirement is Pick ingress only, because the callers differ —
// the Overlay is a browser and the agent's shell is not.

export function refuseNonLoopback(request: IncomingMessage): Refusal | null {
  const address = request.socket?.remoteAddress
  if (address && LOOPBACK.test(address)) return null

  return forbidden(
    'not-loopback',
    `refused a request from ${address || 'an unknown address'}: ` +
      'vite-agent-inspect only answers on loopback.',
  )
}

/**
 * Pick ingress only. An absent Origin is a refusal, never a pass, and an Origin
 * naming a host that merely resolves to loopback is not this dev server.
 *
 * `ownOrigins` is the set of origins this server is serving on.
 */
export function refuseForeignOrigin(
  request: IncomingMessage,
  ownOrigins: Set<string>,
): Refusal | null {
  if (typeof request.headers.origin !== 'string') {
    return forbidden(
      'origin-missing',
      'refused a Pick with no Origin header: ingress fails closed rather than ' +
        'guessing where a request came from.',
    )
  }
  if (!isSameOrigin(request.headers, ownOrigins)) {
    return forbidden(
      'origin-mismatch',
      `refused a Pick whose Origin (${request.headers.origin}) is not one this ` +
        `dev server is serving on (${[...ownOrigins].join(', ')}).`,
    )
  }
  return null
}

/**
 * Ack and done (spec §11). The Pick's nonce is the credential and there is no
 * other: no token, and no `Origin` requirement, because the caller is the
 * agent's own shell and it sends none. A wrong nonce and a missing one are
 * different mistakes and are told apart, so the agent that made one can read
 * which.
 */
export function refuseWrongNonce(given: string | null, expected: string): Refusal | null {
  if (!given) {
    return forbidden(
      'nonce-missing',
      'refused an ack or done carrying no nonce: the nonce printed beside the ' +
        'pick is the credential, and this endpoint has no other.',
    )
  }
  if (given !== expected) {
    return forbidden(
      'nonce-mismatch',
      'refused an ack or done whose nonce is not the one this pick was minted ' +
        'with. Nothing about the pick was changed.',
    )
  }
  return null
}

function forbidden(error: string, reason: string): Refusal {
  return { status: 403, body: { error, reason } }
}
