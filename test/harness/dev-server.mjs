import { createServer } from 'vite'
import { applyEnv, createFixtureEnv } from './fixture-env.mjs'
import { exampleAppRoot } from './paths.mjs'

/**
 * Seam 1's entry point: a real Vite dev server, with the plugin, serving the
 * real example app, with the harness faked at its four boundaries. Tests talk
 * to it over HTTP on loopback and never import a server module.
 *
 * @param {object} [options]
 * @param {number} [options.port] 0 lets the OS choose, which is the default.
 * @param {Record<string, string>} [options.env] Extra overrides for this server.
 * @param {number} [options.claudePid] The pid the preselect should match.
 */
export async function startExampleServer({ port = 0, env = {}, claudePid } = {}) {
  const fixture = createFixtureEnv({ claudePid })
  const restoreEnv = applyEnv({ ...fixture.env, ...env })

  let server
  try {
    server = await createServer({
      root: exampleAppRoot,
      configFile: exampleAppRoot + '/vite.config.js',
      logLevel: 'warn',
      server: { host: '127.0.0.1', port, strictPort: port !== 0 },
    })
    await server.listen()
  } catch (error) {
    restoreEnv()
    fixture.cleanup()
    throw error
  }

  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    fixture,
    async close() {
      await server.close()
      restoreEnv()
      fixture.cleanup()
    },
  }
}
