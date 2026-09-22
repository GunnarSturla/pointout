import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { searchForWorkspaceRoot } from 'vite'
import type { Plugin, UserConfig } from 'vite'
import { createCaptureService } from './server/capture/index.js'
import { createClaudeRoute } from './server/claude/route.js'
import { createDiscovery } from './server/discovery.js'
import { installAgentEndpoints } from './server/http.js'
import { announcePosture, createServerFacts, listeningPort } from './server/index.js'
import type { AgentInspectOptions, ServerFacts, Services } from './server/index.js'

export type { AgentInspectOptions, ServerFacts }

/** The id a consumer's page (and a test) refers to the Overlay by. */
const OVERLAY_MODULE_ID = 'virtual:vite-agent-inspect/overlay'
/** Vite's convention for a virtual module's resolved id. */
const RESOLVED_OVERLAY_MODULE_ID = '\0' + OVERLAY_MODULE_ID
/** How Vite serves that resolved id over HTTP. */
const OVERLAY_MODULE_URL = '/@id/__x00__' + OVERLAY_MODULE_ID

/**
 * What the Overlay imports from the consumer's own React. Named here so Vite
 * prebundles them with the app's dependencies rather than discovering them on
 * the first page load and reloading the page to optimize them.
 */
const OVERLAY_DEPENDENCIES = ['react/jsx-runtime', 'react-dom/client']

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
  /** Brought up by `configureServer`, and closed with the server. */
  let services: Services | null = null

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
      // Restricted for their own source. Put the default back, but only when
      // the consumer set none of their own: someone who narrowed `fs.allow`
      // deliberately must not have it widened behind their back.
      const allow = [packageRoot]
      if (!userConfig.server?.fs?.allow) {
        const root = userConfig.root ? resolve(userConfig.root) : process.cwd()
        allow.unshift(searchForWorkspaceRoot(root))
      }
      return {
        server: { fs: { allow } },
        optimizeDeps: { include: OVERLAY_DEPENDENCIES },
      }
    },

    configResolved(config) {
      facts = createServerFacts({ viteRoot: config.root, options })
    },

    async configureServer(server) {
      const resolved = resolvedFacts()
      const { logger } = server.config

      // All three are brought up before anything is served, so the posture
      // block can state what each of them is — where the reply socket bound or
      // why it did not, whether this server can capture and what an earlier one
      // left on disk, and that the dead dev servers' discovery entries are gone
      // (spec §10, §16, §18, §21).
      const route = await createClaudeRoute({
        registryDir: resolved.registryDir,
        socketDir: resolved.socketDir,
        logger,
      })
      const captures = await createCaptureService({ logger })
      const discovery = createDiscovery({
        root: resolved.root,
        warn: (message) => logger.warn(message),
      })
      services = { route, captures, discovery }
      server.httpServer?.once('close', close)

      installAgentEndpoints(server, resolved, services)

      // The discovery entry names the port, which exists only once Vite is
      // listening, and the posture block states where the entry went — so the
      // two happen together and cannot disagree about whether it happened
      // (spec §18, §21).
      const listening = () => {
        discovery.publish(listeningPort(server))
        announcePosture(server, resolved, services!)
      }
      if (server.httpServer) server.httpServer.once('listening', listening)
      else listening()
    },

    // The socket is unlinked, the captures are deleted and the discovery entry
    // is removed on shutdown (spec §10, §16, §18). `httpServer` covers the
    // ordinary dev server; this covers middleware mode, where there is none.
    // Closing twice is a no-op.
    buildEnd: close,

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

  function close(): void {
    services?.route.close()
    services?.captures.close()
    services?.discovery.close()
  }
}

export default agentInspect
