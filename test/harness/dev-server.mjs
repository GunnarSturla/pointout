import { createServer } from 'vite'
import { applyEnv, createFixtureEnv } from './fixture-env.mjs'
import { createRecordingLogger } from './logger.mjs'
import { exampleAppRoot } from './paths.mjs'

/**
 * Start a real Vite dev server, with the plugin, with the harness faked at its
 * four boundaries. Tests talk to it over HTTP on loopback and never import a
 * server module.
 *
 * @param {object} options
 * @param {string} options.root The Vite root.
 * @param {string} [options.configFile] The consumer config that loads the plugin.
 * @param {number} [options.port] 0 lets the OS choose, which is the default.
 * @param {string} [options.host] What Vite binds to; loopback by default.
 * @param {Record<string, string>} [options.env] Extra overrides for this server.
 * @param {number} [options.claudePid] The pid the preselect should match.
 * @param {boolean} [options.gitShim] Record the subprocesses the server spawns.
 */
export async function startServer({
  root,
  configFile,
  port = 0,
  host = '127.0.0.1',
  env = {},
  claudePid,
  gitShim = false,
} = {}) {
  const fixture = createFixtureEnv({ claudePid, gitShim })
  const restoreEnv = applyEnv({ ...fixture.env, ...env })
  const recorder = createRecordingLogger()

  let server
  try {
    server = await createServer({
      root,
      configFile,
      // The posture block is an `info` line; the recorder swallows the output
      // so a passing run stays quiet.
      logLevel: 'info',
      customLogger: recorder.logger,
      server: { host, port, strictPort: port !== 0 },
    })
    await server.listen()
  } catch (error) {
    restoreEnv()
    fixture.cleanup()
    throw error
  }

  const address = server.httpServer.address()

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    fixture,
    /** Everything the server logged, posture block included. */
    log: () => recorder.text(),
    async close() {
      await server.close()
      restoreEnv()
      fixture.cleanup()
    },
  }
}

/**
 * Seam 1's default server: the real example app, so the module graph and the
 * sourcemaps are real.
 */
export async function startExampleServer(options = {}) {
  return startServer({
    root: exampleAppRoot,
    configFile: exampleAppRoot + '/vite.config.js',
    ...options,
  })
}
