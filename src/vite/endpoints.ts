import type { ViteDevServer } from 'vite'
import { API_BASE } from '../api.js'
import { boundAddress, loopbackOrigins } from '../server/bound-host.js'
import { createAgentEndpoints } from '../server/http.js'
import type { ServerFacts, Services } from '../server/index.js'
import { viteFrameResolver } from './frame-resolver.js'

// The Guard's endpoints on Vite's middlewares. Mounted inside `configureServer`'s
// body, so they run ahead of Vite's own middlewares and the SPA fallback never
// swallows an unknown `/__agent` path.

export function installAgentEndpoints(
  server: ViteDevServer,
  facts: ServerFacts,
  services: Services,
): void {
  const answer = createAgentEndpoints(
    {
      logger: server.config.logger,
      ownOrigins: onceOwnOrigins(server),
      loopbackOrigin: () => loopbackOrigin(server),
      resolveFrame: viteFrameResolver(server),
    },
    facts,
    services,
  )

  // Connect strips the mount path, so `request.url` is already relative to it.
  server.middlewares.use(API_BASE, (request, response) => {
    answer(request, response, request.url ?? '/')
  })
}

/**
 * The origins this dev server is actually serving on. Vite knows them only once
 * it is listening, and no request can arrive before that, so they are worked
 * out on the first one and kept.
 */
function onceOwnOrigins(server: ViteDevServer): () => Set<string> {
  let origins: Set<string> | null = null

  return () => {
    if (origins) return origins
    origins = new Set<string>()

    const resolved = server.resolvedUrls
    for (const url of [...(resolved?.local ?? []), ...(resolved?.network ?? [])]) {
      try {
        origins.add(new URL(url).origin)
      } catch {
        // Vite printed something that is not a URL. Nothing to allow.
      }
    }

    // Vite lists the URLs it advertises; the Overlay can also be loaded through
    // any loopback spelling of the port it is bound to.
    const address = server.httpServer?.address()
    if (address && typeof address === 'object') {
      const scheme = server.config.server.https ? 'https' : 'http'
      for (const origin of loopbackOrigins(scheme, address.port)) origins.add(origin)
    }
    return origins
  }
}

/**
 * The origin the ack and done URLs are printed with: the address this server is
 * bound to, not a name (`bound-host.ts`). The caller is the agent's shell on
 * this machine, and a hostname it would have to resolve is one more thing that
 * can be wrong.
 *
 * In middleware mode there is no `httpServer` and no port to print — but there
 * are also no `resolvedUrls`, so `onceOwnOrigins` is empty and every Pick is
 * already refused at the Origin check before a body is ever rendered.
 */
function loopbackOrigin(server: ViteDevServer): string {
  const { host, port } = boundAddress(server.httpServer?.address())
  const scheme = server.config.server.https ? 'https' : 'http'
  return `${scheme}://${host}:${port}`
}
