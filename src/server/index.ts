import type { CaptureService } from './capture/index.js'
import { socketDirectory } from './claude/reply-socket.js'
import type { DeliveryRoute } from './delivery.js'
import type { Discovery } from './discovery.js'
import type { Logger } from './logger.js'
import { discoverRepoRoot } from './paths.js'
import type { RootMethod } from './paths.js'
import { harnessVersionLine } from './claude/harness-version.js'
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
export interface PointoutOptions {
  /** The repo root, overriding discovery. */
  root?: string
}

/**
 * Everything worked out once, when the Connector knows the Host's root, and
 * every request reads afterwards.
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
 * The three things a Connector brings up before anything is served, each with
 * a line of its own in the posture block and a `close` of its own.
 */
export interface Services {
  route: DeliveryRoute
  captures: CaptureService
  discovery: Discovery
}

export function createServerFacts({
  hostRoot,
  options,
}: {
  /** The directory the Host serves the app from, where root discovery starts. */
  hostRoot: string
  options: PointoutOptions
}): ServerFacts {
  const { root, method } = discoverRepoRoot(hostRoot, options.root)

  return {
    root,
    rootMethod: method,
    registryDir: registryDirectory(),
    socketDir: socketDirectory(),
    claudePid: parsePid(process.env.CLAUDE_PID),
  }
}

/**
 * One block, once, when the server is actually listening, in the order spec §2
 * lists it (spec §21). A block carrying any warning is logged as a warning, so it
 * survives `logLevel: 'warn'`; otherwise it is information.
 */
export function announcePosture(
  {
    logger,
    host,
  }: {
    logger: Logger
    /** The address the Host is listening on, as its server answered it; null without one. */
    host: string | null
  },
  facts: ServerFacts,
  { route, captures, discovery }: Services,
): void {
  const { registry, candidates } = readCandidates(facts)

  const posture = createPosture()
    .add('root', rootLine(facts.root, facts.rootMethod))
    .add('guard', GUARD_LINE)
    .add('registry', registryLine(registry, candidates.length))
    .add('harness version', harnessVersionLine(registry.entries))
    .add('reply socket', route.postureLine)
    .add('screen capture', captures.postureLine)
    .add('temp directory', captures.directoryLine)
    .add('discovery entry', discovery.postureLine)

  if (host && !isLoopbackHost(host)) posture.add('host', lanLine(host))

  const block = '\n' + posture.render() + '\n'
  if (posture.warns()) logger.warn(block)
  else logger.info(block)
}

function parsePid(value: string | undefined): number | null {
  const pid = Number.parseInt(value ?? '', 10)
  return Number.isNaN(pid) ? null : pid
}
