import type { AddressInfo } from 'node:net'
import { Server as TlsServer } from 'node:tls'
import { API_BASE, STATUS_PATH } from '../api.js'
import { boundAddress, loopbackOrigins } from '../server/bound-host.js'
import { createAgentEndpoints } from '../server/http.js'
import { announcePosture, createServerFacts, createServices } from '../server/index.js'
import type { PointoutOptions } from '../server/index.js'
import type { Logger } from '../server/logger.js'
import { createPosture, says, warns } from '../server/posture.js'
import type { PostureLine } from '../server/posture.js'
import { nextFrameResolver } from './frame-resolver.js'
import { findListeningServer, interceptAgentRequests } from './intercept.js'
import { askLoopback } from './loopback.js'

// pointout's life inside Next's dev worker: started once, the first time the
// config is read in the development phase, and closed with the process.

/** How the posture block names this Host. */
const HOST_NAME = 'Next.js'

/** How long the self-check waits for its own answer. */
const SELF_CHECK_TIMEOUT_MS = 5_000

/**
 * The module may be evaluated more than once in a process (Next reads its
 * config through a loader of its own, and calls a function config twice), and
 * there must still be one pointout. So the mark lives on the process.
 */
const STARTED = Symbol.for('pointout.next.started')

/** Next prints through the console, and so does pointout inside it. */
const logger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

export function startPointout(options: PointoutOptions): void {
  const marks = globalThis as { [STARTED]?: true }
  if (marks[STARTED]) return
  marks[STARTED] = true

  if (!process.env.TURBOPACK) {
    logger.warn(
      'pointout: this dev server is not running Turbopack, and pointout supports ' +
        'Turbopack only for now, so it serves nothing here. Run `next dev` without ' +
        '`--webpack` to use it.',
    )
    return
  }

  start(options).catch((error: unknown) => {
    // Fail closed, out loud (spec §21): pointout is not serving, and says why.
    logger.error(
      `pointout did not start, and serves nothing in this dev server: ${String(
        error instanceof Error ? (error.stack ?? error.message) : error,
      )}`,
    )
  })
}

async function start(options: PointoutOptions): Promise<void> {
  const facts = createServerFacts({ hostRoot: process.cwd(), options })

  // Next stores the port it bound in `PORT` just before it reads the config.
  const port = Number.parseInt(process.env.PORT ?? '', 10)
  const server = findListeningServer(Number.isNaN(port) ? null : port)
  if (!server) {
    const block = createPosture().add(
      'self-check',
      warns(
        "found no listening server in Next's dev worker to serve /__agent on — " +
          'pointout serves nothing here, and the Overlay cannot reach it',
      ),
    )
    logger.warn('\n' + block.render() + '\n')
    return
  }
  const address = server.address() as AddressInfo

  const { services, close } = await createServices(facts, logger)

  // Synchronous, and on `exit`: Next sends SIGKILL 100 ms after Ctrl-C, so
  // nothing asynchronous would finish, and a SIGTERM handler of ours would
  // cancel Next's own exit. A config edit restarts the worker through
  // `process.exit`, which runs this too. Closing twice is a no-op.
  process.once('exit', close)
  server.once('close', close)

  const scheme = server instanceof TlsServer ? 'https' : 'http'
  const bound = boundAddress(address)
  const loopbackOrigin = `${scheme}://${bound.host}:${bound.port}`

  const answer = createAgentEndpoints(
    {
      logger,
      ownOrigins: () => ownOrigins(scheme, address.port),
      loopbackOrigin: () => loopbackOrigin,
      resolveFrame: nextFrameResolver({
        origin: loopbackOrigin,
        projectDir: process.cwd(),
      }),
    },
    facts,
    services,
  )
  interceptAgentRequests(server, answer)

  services.discovery.publish(bound)
  const selfCheck = await checkSelf(loopbackOrigin + API_BASE + STATUS_PATH)
  announcePosture(
    {
      logger,
      hostName: HOST_NAME,
      host: address.address,
      connectorLines: [['self-check', selfCheck]],
    },
    facts,
    services,
  )
}

/**
 * Every loopback spelling of the port Next is bound to. A page Next serves on
 * the LAN is refused at the loopback check whatever its origin says.
 */
function ownOrigins(scheme: string, port: number): Set<string> {
  return new Set(loopbackOrigins(scheme, port))
}

/**
 * ADR-0006: pointout depends on Next reading its config after `listen`, which
 * no Next.js document promises. So it asks its own status endpoint, over
 * loopback, the way the Overlay will; anything but pointout's answer is said.
 */
async function checkSelf(url: string): Promise<PostureLine> {
  const failed = (what: string) =>
    warns(
      `pointout did not answer GET ${url} (${what}) — the Overlay cannot reach this ` +
        'server, and no Pick will',
    )
  try {
    const { status, body } = await askLoopback(url, { timeoutMs: SELF_CHECK_TIMEOUT_MS })
    if (status !== 200) return failed(`Next answered ${status}`)
    const parsed = JSON.parse(body) as { picks?: unknown }
    if (!Array.isArray(parsed.picks)) return failed('the answer was not a status')
    return says(`pointout answered GET ${url}`)
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}
