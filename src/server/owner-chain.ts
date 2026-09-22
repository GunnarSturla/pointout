import { relative, sep } from 'node:path'
import type { ViteDevServer } from 'vite'
import type { OwnerChainLink } from '../wire.js'
import { refuse } from './parse.js'
import type { Parsed } from './parse.js'
import { originalPositionFor } from './sourcemap.js'
import { readAppFrame } from './stack.js'

// The Owner chain, server side (spec §6, §12, §13): the ordered list of JSX call
// sites that produced the picked element, innermost first. The Overlay sends one
// raw stack string per link and no parser; everything that turns those strings
// into repo-relative positions happens here.
//
// The raw strings are Excerpts (`CONTEXT.md`): validated on the way in, read by
// the parser, and never interpolated into the body an agent reads. What the
// Pointer prints is only ever built here, out of a component name, a path this
// server computed, and numbers.

/**
 * One degraded mode, named the way spec §12's table names it. The name travels
 * into the Pointer beside the reason, so an agent reading a link can tell two
 * approximate links apart without parsing a sentence, and a developer reading
 * the same line gets the sentence.
 *
 * The three that §12 does not name — an unreadable frame, a module the graph
 * does not hold, a position the map has nothing at — are its *module not in
 * graph / parse failure* row, split into the three reasons this server can
 * actually tell apart.
 */
export type DegradedMode =
  | 'stale-transform'
  | 'no-transform-timestamp'
  | 'no-sourcemap'
  | 'call-site-frame-elided-by-engine'
  | 'no-react-boundary'
  | 'unknown-owner-placeholder'
  | 'unreadable-frame'
  | 'module-not-in-graph'
  | 'unmapped-position'

/**
 * What one frame of an Owner chain says about itself (`CONTEXT.md`): exact,
 * approximate with a reason, or absent with a reason. A property of a frame and
 * never of a Pick — it is the rule that a Pick degrades by annotation rather
 * than by refusal.
 *
 * **One field, one mode.** Two of spec §12's modes are often true at once — a
 * module can have no sourcemap *and* a transform that has moved since. The one
 * stated is the one that most limits what the location means, in this order:
 * whether there is a location at all, then what its numbers are coordinates
 * *in*, then how much the transform has moved under them.
 */
export type Confidence =
  | { kind: 'exact' }
  | { kind: 'approximate'; mode: DegradedMode; reason: string }
  | { kind: 'absent'; mode: DegradedMode; reason: string }

/** One resolved link, in the words the Pointer will state it in. */
export interface OwnerLink {
  name: string | null
  /** Repo-relative `path:line:col`, or null when there is no location. */
  location: string | null
  confidence: Confidence
  /**
   * The frame is inside a prebundled or `node_modules` module (spec §12's last
   * row). A flag rather than a Confidence: it says the code is not this repo's,
   * which is true whatever the position turned out to be worth.
   */
  dependency: boolean
}

const unreadable = (reason: string) => refuse(400, 'owner-chain-unreadable', reason)

/**
 * The ingest check on the Owner chain the body carries. A chain that is absent
 * is a chain of no links, which is a Pick this server still accepts: a Pick is
 * never refused for want of an owner (spec §4).
 */
export function parseOwnerChain(
  body: Record<string, unknown>,
): Parsed<{ ownerChain: OwnerChainLink[]; walkUp: number }> {
  const { ownerChain, walkUp } = body

  if (
    walkUp !== undefined &&
    (typeof walkUp !== 'number' || !Number.isInteger(walkUp) || walkUp < 0)
  ) {
    return unreadable(
      'refused a Pick whose walk-up distance is not a whole number of DOM levels.',
    )
  }
  const distance = typeof walkUp === 'number' ? walkUp : 0

  if (ownerChain === undefined || ownerChain === null) {
    return { ok: true, value: { ownerChain: [], walkUp: distance } }
  }
  if (!Array.isArray(ownerChain)) {
    return unreadable('refused a Pick whose owner chain is not a list of links.')
  }

  const links: OwnerChainLink[] = []
  for (const link of ownerChain) {
    if (typeof link !== 'object' || link === null || Array.isArray(link)) {
      return unreadable(
        'refused a Pick whose owner chain holds something that is not a link.',
      )
    }
    const { name, stack } = link as Record<string, unknown>
    if (typeof stack !== 'string') {
      return unreadable('refused a Pick whose owner chain has a link with no raw stack.')
    }
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return unreadable(
        'refused a Pick whose owner chain has a link whose component name is not text.',
      )
    }
    links.push({ name: typeof name === 'string' ? name : null, stack })
  }

  return { ok: true, value: { ownerChain: links, walkUp: distance } }
}

/**
 * Resolve every link to a repo-relative position, innermost first and in the
 * order the Overlay sent them. Done once, at ingest: the module graph is what it
 * is at the moment of the Pick, and a Pick drained an hour later must not be
 * remapped through a transform that has moved since.
 */
export async function resolveOwnerChain(
  server: ViteDevServer,
  root: string,
  links: readonly OwnerChainLink[],
): Promise<OwnerLink[]> {
  const resolved: OwnerLink[] = []
  for (const link of links) resolved.push(await resolveLink(server, root, link))
  return resolved
}

async function resolveLink(
  server: ViteDevServer,
  root: string,
  link: OwnerChainLink,
): Promise<OwnerLink> {
  const absent = (mode: DegradedMode, reason: string, dependency = false): OwnerLink => ({
    name: link.name,
    location: null,
    confidence: { kind: 'absent', mode, reason },
    dependency,
  })

  const read = readAppFrame(link.stack)
  switch (read.kind) {
    case 'placeholder':
      // Spec §12's documented ceiling, and it is annotated rather than silent:
      // above roughly 10,000 elements a second React hands every element one
      // shared stack, which names React's own runtime and no call site at all.
      return absent(
        'unknown-owner-placeholder',
        'React stopped recording owner stacks for this render — above roughly ' +
          '10,000 elements a second it hands out one shared placeholder — so this ' +
          "element's call site was never captured",
      )
    case 'elided':
      return absent(
        'call-site-frame-elided-by-engine',
        "this engine's proper tail calls deleted the frame of the call site, which " +
          'happens to a component whose body is a bare `return <tag>`; the component ' +
          'is named and its line is not knowable from here',
      )
    case 'no-boundary':
      return absent(
        'no-react-boundary',
        'this stack carries no frame React puts below every one, so it never came ' +
          "out to app code — React's ten-frame cap, or an element created outside render",
      )
    case 'unreadable':
      return absent(
        'unreadable-frame',
        "the frame above React's own carries no location this server can read",
      )
  }
  const frame = read.frame

  // The query string belongs to the request and not to the module: Vite's own
  // `?v=` and `?t=` are how a transform is addressed, not what it is.
  const url = frameUrl(frame.url)
  if (!url) {
    return absent('unreadable-frame', 'its frame names no url this server can read')
  }
  const path = url.pathname

  // From the path alone, before anything is looked up: a dependency is a
  // dependency whether or not its module turns out to be findable.
  const dependency = isDependency(path)
  const approximate = (
    mode: DegradedMode,
    reason: string,
    location: string,
  ): OwnerLink => ({
    name: link.name,
    location,
    confidence: { kind: 'approximate', mode, reason },
    dependency,
  })

  const module = await server.environments.client.moduleGraph.getModuleByUrl(path)
  if (!module?.file) {
    // Where a prebundled dependency lands: Vite keys an optimized dep by the
    // `?v=` hash it serves it under, so the bare path is in no graph. The
    // `dependency` flag is what says the rest.
    return absent(
      'module-not-in-graph',
      `no module in this dev server's graph at ${path}`,
      dependency,
    )
  }
  const file = repoRelative(root, module.file)

  const map = module.transformResult?.map
  if (!map || map.mappings === '') {
    // §12 keeps the transformed position rather than dropping the link. It is a
    // real position in a real file, and the reason says which coordinates it is
    // in, so nobody edits line 4,431 of a file that has 60 lines.
    return approximate(
      'no-sourcemap',
      `the module at ${path} was served without a sourcemap, so the line and ` +
        "column are the served module's own rather than the source file's",
      `${file}:${frame.line}:${frame.column}`,
    )
  }

  // Engines print a 1-based column and a sourcemap stores a 0-based one. The
  // divergence between engines is left alone on purpose (spec §12): the map
  // erases it, and normalising it here would be guessing at what it erased.
  const original = originalPositionFor(map, frame.line, frame.column - 1)
  if (!original) {
    return absent(
      'unmapped-position',
      `the sourcemap of ${path} maps nothing at ${frame.line}:${frame.column}`,
      dependency,
    )
  }
  const location = `${file}:${original.line}:${original.column + 1}`

  const moved = transformDrift(url, module.lastHMRTimestamp)
  if (moved) return approximate(moved.mode, moved.reason, location)

  return { name: link.name, location, confidence: { kind: 'exact' }, dependency }
}

/** What the module this frame names has done since the page read the frame. */
function transformDrift(
  url: URL,
  lastHMRTimestamp: number,
): { mode: DegradedMode; reason: string } | null {
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
 * A frame's url, parsed. Null for a frame that names no url at all, and the
 * frame's own text never travels with the refusal: the raw stacks are Excerpts
 * and nothing lifted from one is ever interpolated into the body (spec §13).
 */
function frameUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
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

/**
 * Repo-root relative, in posix spelling, so the agent can open the file and no
 * developer's home directory travels (user story 53). A file above the root
 * keeps its `../` prefix rather than falling back to an absolute path, which
 * would leak exactly what this is here to keep out.
 */
function repoRelative(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}
