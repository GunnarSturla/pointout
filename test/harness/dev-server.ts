import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import { applyEnv, createFixtureEnv } from './fixture-env.js'
import type { FixtureEnv } from './fixture-env.js'
import { createRecordingLogger } from './logger.js'
import { exampleAppRoot } from './paths.js'

export interface StartServerOptions {
  /** The Vite root. */
  root: string
  /** The consumer config that loads the plugin. */
  configFile?: string
  /** 0 lets the OS choose, which is the default. */
  port?: number
  /** What Vite binds to; loopback by default. */
  host?: string
  /** Extra overrides for this server. */
  env?: Record<string, string>
  /** The pid the preselect should match. */
  claudePid?: number
  /** Record the subprocesses the server spawns. */
  gitShim?: boolean
}

/** A running harness server, and everything a test reads it through. */
export interface HarnessServer {
  url: string
  port: number
  fixture: FixtureEnv
  /** Everything the server logged, posture block included. */
  log(): string
  close(): Promise<void>
}

/**
 * Start a real Vite dev server, with the plugin, with the harness faked at its
 * four boundaries. Tests talk to it over HTTP on loopback and never import a
 * server module.
 */
export async function startServer({
  root,
  configFile,
  port = 0,
  host = '127.0.0.1',
  env = {},
  claudePid,
  gitShim = false,
}: StartServerOptions): Promise<HarnessServer> {
  const fixture = createFixtureEnv({ claudePid, gitShim })
  const restoreEnv = applyEnv({ ...fixture.env, ...env })
  const recorder = createRecordingLogger()

  let server: ViteDevServer
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

  const address = server.httpServer?.address()
  if (!address || typeof address !== 'object') {
    await server.close()
    restoreEnv()
    fixture.cleanup()
    throw new Error('the harness dev server is not listening on a TCP port')
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    fixture,
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
export async function startExampleServer(
  options: Partial<StartServerOptions> = {},
): Promise<HarnessServer> {
  return startServer({
    root: exampleAppRoot,
    configFile: exampleAppRoot + '/vite.config.ts',
    ...options,
  })
}
