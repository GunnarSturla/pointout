import { discoverRepoRoot } from './paths.js'
import {
  GUARD_LINE,
  createPosture,
  isLoopbackHost,
  lanLine,
  registryLine,
  rootLine,
} from './posture.js'
import { readCandidates, registryDirectory } from './registry.js'

/**
 * Everything the plugin works out once, at `configResolved`, and every request
 * reads afterwards.
 *
 * @param {object} args
 * @param {string} args.viteRoot
 * @param {object} args.options The plugin's own options.
 */
export function createServerFacts({ viteRoot, options }) {
  const { root, method } = discoverRepoRoot(viteRoot, options.root)

  return {
    root,
    rootMethod: method,
    registryDir: registryDirectory(),
    // The pid of the session whose shell started this dev server, inherited
    // through the environment. Absent when nothing started it.
    claudePid: parsePid(process.env.CLAUDE_PID),
  }
}

/** One block, once, when the server is actually listening (spec §2, §21). */
export function announcePosture(server, facts) {
  const print = () => {
    const { registry, candidates } = readCandidates(facts)

    const posture = createPosture()
      .add('root', rootLine(facts.root, facts.rootMethod))
      .add('guard', GUARD_LINE)
      .add('registry', registryLine(registry, candidates.length))

    const address = server.httpServer?.address()
    const host = address && typeof address === 'object' ? address.address : null
    if (host && !isLoopbackHost(host)) posture.add('host', lanLine(host))

    server.config.logger.info('\n' + posture.render() + '\n')
  }

  if (server.httpServer) server.httpServer.once('listening', print)
  else print()
}

function parsePid(value) {
  const pid = Number.parseInt(value ?? '', 10)
  return Number.isNaN(pid) ? null : pid
}
