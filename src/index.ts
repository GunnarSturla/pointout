import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
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

    config() {
      // The Overlay's real source lives inside this package. When the package
      // is linked rather than installed, it can sit outside Vite's root.
      return { server: { fs: { allow: [packageRoot] } } }
    },

    configResolved(config) {
      facts = createServerFacts({ viteRoot: config.root, options })
    },

    configureServer(server) {
      const resolved = resolvedFacts()
      installAgentEndpoints(server, resolved)
      announcePosture(server, resolved)
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
