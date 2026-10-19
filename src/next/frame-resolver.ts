import type { FrameResolver } from '../server/frame-resolver.js'

// The Next.js Connector's frame resolver, until it can read Turbopack's maps
// (tickets 07 and 08). Every frame is answered `absent`, with a reason, rather
// than guessed at: an Owner chain posted to Next names each link and says why
// it has no location.

export const nextFrameResolver: FrameResolver = () =>
  Promise.resolve({
    kind: 'absent',
    mode: 'no-resolver-for-host',
    reason: "the Next.js Connector does not read Turbopack's source maps yet",
    dependency: false,
  })
