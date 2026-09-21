import { fileURLToPath } from 'node:url'
import { installAgentEndpoints } from './server/http.js'
import { announcePosture, createServerFacts } from './server/index.js'

/** The id a consumer's page (and a test) refers to the Overlay by. */
const OVERLAY_MODULE_ID = 'virtual:vite-agent-inspect/overlay'
/** Vite's convention for a virtual module's resolved id. */
const RESOLVED_OVERLAY_MODULE_ID = '\0' + OVERLAY_MODULE_ID
/** How Vite serves that resolved id over HTTP. */
const OVERLAY_MODULE_URL = '/@id/__x00__' + OVERLAY_MODULE_ID

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const overlayEntry = fileURLToPath(new URL('./overlay/index.js', import.meta.url))

/**
 * The Vite plugin. Dev only: it applies to `serve`, so a production build
 * contains no Overlay code and no `/__agent` string.
 *
 * @param {object} [options]
 * @param {string} [options.root] The repo root, overriding discovery. A normal
 *   consumer never sets it.
 * @returns {import('vite').Plugin}
 */
export function agentInspect(options = {}) {
  /** Worked out once at `configResolved`; every request reads it. */
  let facts = null

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
      installAgentEndpoints(server, facts)
      announcePosture(server, facts)
    },

    resolveId(id) {
      if (id === OVERLAY_MODULE_ID) return RESOLVED_OVERLAY_MODULE_ID
    },

    load(id) {
      if (id !== RESOLVED_OVERLAY_MODULE_ID) return
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
