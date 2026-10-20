import type { ViteDevServer } from 'vite'
import { parseFrameUrl } from '../server/frame-resolver.js'
import type { Drift, FrameAnswer, FrameResolver } from '../server/frame-resolver.js'

// The Vite Connector's frame resolver (ADR-0005): a served frame's URL looked up
// in the client environment's module graph, where Vite already holds the module's
// file, its transform's source map and the timestamp of its last hot update.

export function viteFrameResolver(server: ViteDevServer): FrameResolver {
  return async (frame): Promise<FrameAnswer> => {
    // The query string belongs to the request and not to the module: Vite's own
    // `?v=` and `?t=` are how a transform is addressed, not what it is.
    const url = parseFrameUrl(frame.url)
    if (!url) {
      return {
        kind: 'absent',
        mode: 'unreadable-frame',
        reason: 'its frame names no url this server can read',
        dependency: false,
      }
    }
    const path = url.pathname

    // From the path alone, before anything is looked up: a dependency is a
    // dependency whether or not its module turns out to be findable.
    const dependency = isDependency(path)

    const module = await server.environments.client.moduleGraph.getModuleByUrl(path)
    if (!module?.file) {
      // Where a prebundled dependency lands: Vite keys an optimized dep by the
      // `?v=` hash it serves it under, so the bare path is in no graph. The
      // `dependency` flag is what says the rest.
      return {
        kind: 'absent',
        mode: 'module-not-in-graph',
        reason: `no module in this dev server's graph at ${path}`,
        dependency,
      }
    }

    return {
      kind: 'found',
      file: module.file,
      map: module.transformResult?.map ?? null,
      served: path,
      drift: transformDrift(url, module.lastHMRTimestamp),
      dependency,
    }
  }
}

/** What the module this frame names has done since the page read the frame. */
function transformDrift(url: URL, lastHMRTimestamp: number): Drift | null {
  const stamp = url.searchParams.get('t')

  if (stamp !== null) {
    if (Number(stamp) === lastHMRTimestamp) return null
    return {
      mode: 'stale-transform',
      reason:
        'the page made this frame against a transform of the module that this ' +
        'server has since replaced, so the line is remapped through a sourcemap ' +
        'that has moved under it',
    }
  }
  if (lastHMRTimestamp > 0) {
    return {
      mode: 'no-transform-timestamp',
      reason:
        'this module has been re-transformed since the page loaded and the frame ' +
        'carries no transform timestamp to compare — Safari strips the query from ' +
        'a stack url — so which transform the frame belongs to is not knowable here',
    }
  }
  return null
}

/**
 * Spec §12's last row, by path: a frame inside a package rather than inside the
 * developer's own source. Both spellings Vite serves one under — the optimizer's
 * `.vite/deps` bundle, and a package served straight from `node_modules`, with or
 * without an `/@fs/` prefix.
 */
function isDependency(path: string): boolean {
  return path.includes('/node_modules/') || path.includes('/.vite/deps/')
}
