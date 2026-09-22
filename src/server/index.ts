import type { ViteDevServer } from 'vite'
import type { CaptureService } from './capture/index.js'
import { socketDirectory } from './claude/reply-socket.js'
import type { DeliveryRoute } from './delivery.js'
import type { Discovery } from './discovery.js'
import { discoverRepoRoot } from './paths.js'
import type { RootMethod } from './paths.js'
import {
  GUARD_LINE,
  createPosture,
  isLoopbackHost,
  lanLine,
  registryLine,
  rootLine,
} from './posture.js'
import { readCandidates, registryDirectory } from './registry.js'

/** The plugin's own options. A normal consumer sets none of them. */
export interface AgentInspectOptions {
  /** The repo root, overriding discovery. */
  root?: string
}

/**
 * Everything the plugin works out once, at `configResolved`, and every request
 * reads afterwards.
 */
export interface ServerFacts {
  root: string
  rootMethod: RootMethod
  registryDir: string
  /**
   * The directory the harness keeps its message sockets in, and where this dev
   * server binds its own reply address (spec §16).
   */
  socketDir: string
  /**
   * The pid of the session whose shell started this dev server, inherited
   * through the environment. Null when nothing started it.
   */
  claudePid: number | null
}

/**
 * The three things `configureServer` brings up before anything is served, each
 * with a line of its own in the posture block and a `close` of its own.
 */
export interface Services {
  route: DeliveryRoute
  captures: CaptureService
  discovery: Discovery
}

export function createServerFacts({
  viteRoot,
  options,
}: {
  viteRoot: string
  options: AgentInspectOptions
}): ServerFacts {
  const { root, method } = discoverRepoRoot(viteRoot, options.root)

  return {
    root,
    rootMethod: method,
    registryDir: registryDirectory(),
    socketDir: socketDirectory(),
    claudePid: parsePid(process.env.CLAUDE_PID),
  }
}

/** One block, once, when the server is actually listening (spec §2, §21). */
export function announcePosture(
  server: ViteDevServer,
  facts: ServerFacts,
  { route, captures, discovery }: Services,
): void {
  const { registry, candidates } = readCandidates(facts)

  const posture = createPosture()
    .add('root', rootLine(facts.root, facts.rootMethod))
    .add('guard', GUARD_LINE)
    .add('registry', registryLine(registry, candidates.length))
    .add('reply socket', route.postureLine)
    .add('screen capture', captures.postureLine)
    .add('discovery entry', discovery.postureLine)

  const address = server.httpServer?.address()
  const host = address && typeof address === 'object' ? address.address : null
  if (host && !isLoopbackHost(host)) posture.add('host', lanLine(host))

  server.config.logger.info('\n' + posture.render() + '\n')
}

/** The port Vite ended up on, or 0 in middleware mode, where there is none. */
export function listeningPort(server: ViteDevServer): number {
  const address = server.httpServer?.address()
  return address && typeof address === 'object' ? address.port : 0
}

function parsePid(value: string | undefined): number | null {
  const pid = Number.parseInt(value ?? '', 10)
  return Number.isNaN(pid) ? null : pid
}
