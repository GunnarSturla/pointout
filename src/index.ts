import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { searchForWorkspaceRoot } from 'vite'
import type { Plugin, UserConfig } from 'vite'
import { createCaptureService } from './server/capture/index.js'
import type { CaptureService } from './server/capture/index.js'
import { createClaudeRoute } from './server/claude/route.js'
import type { DeliveryRoute } from './server/delivery.js'
import { createDiscovery } from './server/discovery.js'
import type { Discovery } from './server/discovery.js'
import { installAgentEndpoints } from './server/http.js'
import { announcePosture, createServerFacts } from './server/index.js'
import type { AgentInspectOptions, ServerFacts } from './server/index.js'

export type { AgentInspectOptions, ServerFacts }

/** The id a consumer's page (and a test) refers to the Overlay by. */
const OVERLAY_MODULE_ID = 'virtual:vite-agent-inspect/overlay'
/** Vite's convention for a virtual module's resolved id. */
const RESOLVED_OVERLAY_MODULE_ID = '\0' + OVERLAY_MODULE_ID
/** How Vite serves that resolved id over HTTP. */
const OVERLAY_MODULE_URL = '/@id/__x00__' + OVERLAY_MODULE_ID

// Both of these read off the emitted layout rather than the source layout: this
// module is `dist/index.js` in a consumer's node_modules, so the package root is
// one level up and the Overlay is a sibling directory. `tsc` emits one file per
// module for exactly this reason (ADR-0001) — a build that nested the output a
// level deeper would break `server.fs.allow` with no test naming it.
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const overlayEntry = fileURLToPath(new URL('./overlay/index.js', import.meta.url))

/**
 * The Vite plugin. Dev only: it applies to `serve`, so a production build
 * contains no Overlay code and no `/__agent` string.
 */
export function agentInspect(options: AgentInspectOptions = {}): Plugin {
  /** Worked out once at `configResolved`; every request reads it. */
  let facts: ServerFacts | null = null
  /** The delivery route, once `configureServer` has bound its reply socket. */
  let route: DeliveryRoute | null = null
  /** Screen Capture, once `configureServer` has probed for it. */
  let captures: CaptureService | null = null
  /** The hook discovery entry, once `configureServer` has minted its secret. */
  let discovery: Discovery | null = null

  // Vite runs `configResolved` before `configureServer`, so this never fires.
  // It throws rather than shrugging: a plugin that quietly served no endpoints
  // is the silent nothing spec §21 forbids.
  const resolvedFacts = (): ServerFacts => {
    if (!facts) {
      throw new Error(
        'vite-agent-inspect: configureServer ran before configResolved, so the ' +
          'repo root and the session registry are unknown. This is a bug.',
      )
    }
    return facts
  }

  return {
    name: 'vite-agent-inspect',
    apply: 'serve',

    config(userConfig: UserConfig) {
      // The Overlay's real source lives inside this package. When the package
      // is linked rather than installed, it can sit outside Vite's root.
      //
      // Vite resolves this field as `raw?.fs?.allow ?? [workspaceRoot]`, so
      // contributing ours *displaces* the workspace root rather than joining it
      // — and a consumer whose app is not inside this package then gets 403
      // Restricted for their own source (ticket 25). Put the default back, but
      // only when the consumer set none of their own: someone who narrowed
      // `fs.allow` deliberately must not have it widened behind their back.
      const allow = [packageRoot]
      if (!userConfig.server?.fs?.allow) {
        const root = userConfig.root ? resolve(userConfig.root) : process.cwd()
        allow.unshift(searchForWorkspaceRoot(root))
      }
      return { server: { fs: { allow } } }
    },

    configResolved(config) {
      facts = createServerFacts({ viteRoot: config.root, options })
    },

    async configureServer(server) {
      const resolved = resolvedFacts()

      // The reply socket is bound before anything is served, so the posture
      // block can state where it bound — or why it did not (spec §16, §21).
      route = await createClaudeRoute({
        ...resolved,
        logger: server.config.logger,
      })
      server.httpServer?.once('close', route.close)

      // Probed before anything is served, for the same reason as the socket:
      // the posture block states whether this server can capture, and what an
      // earlier dev server left on disk is swept now rather than never
      // (spec §10, §21).
      captures = await createCaptureService({ logger: server.config.logger })
      server.httpServer?.once('close', captures.close)

      // The secret is minted and the dead dev servers' entries are swept now;
      // the entry itself is written once there is a port, which the posture
      // block is what waits for (spec §18, §21).
      discovery = createDiscovery({
        root: resolved.root,
        warn: (message) => server.config.logger.warn(message),
      })
      server.httpServer?.once('close', discovery.close)

      installAgentEndpoints(server, resolved, route, captures, discovery)
      announcePosture(server, resolved, route, captures, discovery)
    },

    // The socket is unlinked, the captures are deleted and the discovery entry
    // is removed on shutdown (spec §10, §16, §18). `httpServer` covers the
    // ordinary dev server; this covers middleware mode, where there is none.
    // Closing twice is a no-op.
    buildEnd() {
      route?.close()
      captures?.close()
      discovery?.close()
    },

    resolveId(id) {
      if (id === OVERLAY_MODULE_ID) return RESOLVED_OVERLAY_MODULE_ID
      return undefined
    },

    load(id) {
      if (id !== RESOLVED_OVERLAY_MODULE_ID) return undefined
      // Re-export rather than inline, so the Overlay's own source goes through
      // Vite's transform pipeline like any other module.
      return `import ${JSON.stringify(overlayEntry)}\n`
    },

    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: OVERLAY_MODULE_URL },
          injectTo: 'head',
        },
      ]
    },
  }
}

export default agentInspect
