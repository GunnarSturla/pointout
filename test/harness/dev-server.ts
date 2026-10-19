import { createServer } from 'vite'
import type { ViteDevServer } from 'vite'
import { applyEnv, createFixtureEnv } from './fixture-env.js'
import type { FixtureEnv } from './fixture-env.js'
import { createRecordingLogger } from './logger.js'
import type { LogEntry } from './logger.js'
import { exampleAppRoot } from './paths.js'
import { startNextServer } from './next-server.js'
import type { NextHarnessServer } from './next-server.js'
import type { HostName } from './hosts.js'

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
  /** The same, one entry per logger call, with the level it was made at. */
  logEntries(): LogEntry[]
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
    // The address it is bound to, spelled for a URL: a server told `::1` does
    // not answer on 127.0.0.1. One bound to every interface is dialled on
    // loopback, in the family it was bound in.
    url: `http://${dialled(address.address, address.family)}:${address.port}`,
    port: address.port,
    fixture,
    log: () => recorder.text(),
    logEntries: () => recorder.entries(),
    async close() {
      // First. A test that asked for a module leaves Vite's dependency
      // optimizer running behind the answer, and `close()` called while it runs
      // never returns — measured against plain Vite with no plugin at all, so it
      // is Vite's own behaviour and not this plugin's. `waitForRequestsIdle` is
      // Vite's own way to say "when you have finished with what I asked for".
      //
      // Both steps are bounded, so a close that hangs fails as itself, naming the
      // server, rather than as whichever timeout the runner reaches first. The
      // environment and the fixture are put back either way.
      try {
        await withinDeadline(
          async () => {
            await server.waitForRequestsIdle()
            await server.close()
          },
          CLOSE_DEADLINE_MS,
          `the harness dev server at ${root} (port ${address.port})`,
        )
      } finally {
        restoreEnv()
        fixture.cleanup()
      }
    },
  }
}

export interface ExampleServerOptions extends Partial<StartServerOptions> {
  /**
   * Which Host serves the example: `vite` (the default) is
   * `examples/react-app` in this process, `next` is `examples/next-app` under
   * a `next dev` of its own (next-server.ts). Both render `examples/shared/`.
   */
  on?: HostName
}

/**
 * Seam 1's default server: the real example app, so the module graph and the
 * sourcemaps are real. A test names the Host it wants with `on`.
 */
export async function startExampleServer(
  options: ExampleServerOptions & { on: 'next' },
): Promise<NextHarnessServer>
export async function startExampleServer(
  options?: ExampleServerOptions,
): Promise<HarnessServer>
export async function startExampleServer({
  on = 'vite',
  ...options
}: ExampleServerOptions = {}): Promise<HarnessServer> {
  if (on === 'next') {
    const { root, configFile, ...next } = options
    if (root !== undefined || configFile !== undefined) {
      throw new Error(
        'the Next.js example takes no root or config file: it is always ' +
          'examples/next-app',
      )
    }
    return startNextServer(next)
  }
  return startServer({
    root: exampleAppRoot,
    configFile: exampleAppRoot + '/vite.config.ts',
    ...options,
  })
}

/**
 * How long `close()` may take. A healthy close takes a fraction of this; it is
 * below seam 1's 30 s hook timeout, so the named error is the one a hung close
 * reports, rather than the runner's anonymous timeout.
 */
const CLOSE_DEADLINE_MS = 20_000

/** Run `work`, or fail with an error naming `what` once `ms` have passed. */
async function withinDeadline(
  work: () => Promise<void>,
  ms: number,
  what: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${what} did not close within ${ms / 1000} s: waitForRequestsIdle() ` +
              'or close() never returned',
          ),
        ),
      ms,
    )
  })
  try {
    await Promise.race([work(), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Where a test on this machine reaches a server bound to `address`. */
function dialled(address: string, family: string): string {
  if (address === '0.0.0.0') return '127.0.0.1'
  if (address === '::') return '[::1]'
  return family === 'IPv6' ? `[${address}]` : address
}
