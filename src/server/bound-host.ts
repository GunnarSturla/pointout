import type { AddressInfo } from 'node:net'

// Where an agent's shell on this machine dials this dev server: the address it
// is actually bound to, spelled for a URL. It is written into the ack and done
// URLs of every Pick and into the hook discovery entry, so the preamble and the
// drain cannot disagree about where the server is.
//
// Not `localhost`: the Host resolved that name once to choose what to bind, and
// a caller resolving it again gets both families and may reach a different
// server on the other one. And not a fixed 127.0.0.1: Vite's default host, like
// `next dev -H localhost`, is `localhost`, which on a machine whose resolver
// lists `::1` first is bound there and nowhere else.
//
// The Connector hands over what the Host's listening server's `address()`
// answered; nothing here knows which Host that is.

/** Where this server listens, or port 0 when it has no listening server of its own. */
export interface BoundAddress {
  /** A host a URL can carry: `127.0.0.1`, `[::1]`, or whatever the Host bound. */
  host: string
  port: number
}

export function boundAddress(
  address: AddressInfo | string | null | undefined,
): BoundAddress {
  if (!address || typeof address !== 'object') return { host: '127.0.0.1', port: 0 }
  return { host: urlHost(address.address, address.family), port: address.port }
}

function urlHost(address: string, family: string): string {
  // Every interface: loopback answers in the family the wildcard was bound in.
  if (address === '0.0.0.0') return '127.0.0.1'
  if (address === '::') return '[::1]'
  // A specific address, loopback or not. One that is not loopback is refused by
  // the Guard whoever dials it, and the posture block has already said so.
  return family === 'IPv6' ? `[${address}]` : address
}
