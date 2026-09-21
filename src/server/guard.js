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

/**
 * True when the request came from an origin this dev server is serving on.
 *
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {Set<string>} ownOrigins
 */
function isSameOrigin(headers, ownOrigins) {
  const origin = headers.origin
  if (typeof origin !== 'string') return false
  try {
    return ownOrigins.has(new URL(origin).origin)
  } catch {
    return false
  }
}

// --- end of borrowed code ---

/** IPv4 loopback, IPv6 loopback, and IPv4-mapped-into-IPv6 loopback. */
const LOOPBACK = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/

// The ingress check (spec §11). Every `/__agent/*` endpoint is loopback-only;
// the `Origin` requirement is Pick ingress only, because the callers differ —
// the Overlay is a browser and the agent's shell is not.

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {{ status: number, body: { error: string, reason: string } } | null}
 *   The refusal, or null when the request may proceed.
 */
export function refuseNonLoopback(request) {
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
 * @param {import('node:http').IncomingMessage} request
 * @param {Set<string>} ownOrigins The origins this server is serving on.
 */
export function refuseForeignOrigin(request, ownOrigins) {
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

function forbidden(error, reason) {
  return { status: 403, body: { error, reason } }
}
