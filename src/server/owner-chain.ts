import { relative, sep } from 'node:path'
import type { OwnerChainLink } from '../wire.js'
import type { FrameAnswer, FrameResolver } from './frame-resolver.js'
import { refuse } from './parse.js'
import type { Parsed } from './parse.js'
import { isEmptyMap, originalPositionFor } from './sourcemap.js'
import { readAppFrame } from './stack.js'

// The Owner chain, server side (spec §6, §12, §13): the ordered list of JSX call
// sites that produced the picked element, innermost first. The Overlay sends one
// raw stack string per link and no parser; everything that turns those strings
// into repo-relative positions happens here.
//
// The raw strings are Excerpts (`GLOSSARY.md`): validated on the way in, read by
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
  | 'source-not-on-disk'

/**
 * What one frame of an Owner chain says about itself (`GLOSSARY.md`): exact,
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
 * order the Overlay sent them. Done once, at ingest: the Host's modules are what
 * they are at the moment of the Pick, and a Pick drained an hour later must not
 * be remapped through a transform that has moved since.
 *
 * Where a frame's map is, whether it has moved and whether it is vendor code are
 * the Connector's to say (`frame-resolver.ts`); what that makes the link's
 * Confidence is decided here.
 */
export async function resolveOwnerChain(
  resolveFrame: FrameResolver,
  root: string,
  links: readonly OwnerChainLink[],
  pageLoadedAt: number | null,
): Promise<OwnerLink[]> {
  const resolved: OwnerLink[] = []
  for (const link of links) {
    resolved.push(await resolveLink(resolveFrame, root, link, pageLoadedAt))
  }
  return resolved
}

async function resolveLink(
  resolveFrame: FrameResolver,
  root: string,
  link: OwnerChainLink,
  pageLoadedAt: number | null,
): Promise<OwnerLink> {
  const read = readAppFrame(link.stack)
  switch (read.kind) {
    case 'placeholder':
      // Spec §12's documented ceiling, and it is annotated rather than silent:
      // above roughly 10,000 elements a second React hands every element one
      // shared stack, which names React's own runtime and no call site at all.
      return absentLink(
        link,
        'unknown-owner-placeholder',
        'React stopped recording owner stacks for this render — above roughly ' +
          '10,000 elements a second it hands out one shared placeholder — so this ' +
          "element's call site was never captured",
      )
    case 'elided':
      return absentLink(
        link,
        'call-site-frame-elided-by-engine',
        "this engine's proper tail calls deleted the frame of the call site, which " +
          // No `<tag>` here: spec §13 keeps every markup character out of the
          // body, and this sentence is in it.
          'happens to a component whose body does nothing but return one element; the component ' +
          'is named and its line is not knowable from here',
      )
    case 'no-boundary':
      return absentLink(
        link,
        'no-react-boundary',
        'this stack carries no frame React puts below every one, so it never came ' +
          "out to app code — React's ten-frame cap, or an element created outside render",
      )
    case 'unreadable':
      return absentLink(
        link,
        'unreadable-frame',
        "the frame above React's own carries no location this server can read",
      )
  }
  const frame = read.frame

  const answer = await resolveFrame({
    url: frame.url,
    line: frame.line,
    column: frame.column,
    pageLoadedAt,
  })
  const context: LinkContext = { link, root, frame }
  switch (answer.kind) {
    case 'absent':
      return absentLink(link, answer.mode, answer.reason, answer.dependency)
    case 'chunk':
      return resolveInChunk(context, answer)
    case 'found':
      return resolveInModule(context, answer)
  }
}

/** What every step of resolving one link reads: the link, the root, its frame. */
interface LinkContext {
  link: OwnerChainLink
  root: string
  frame: { line: number; column: number }
}

/**
 * A frame in one served module, decoded against that module's own map. A
 * module served without one keeps its served position, and says so.
 */
function resolveInModule(
  { link, root, frame }: LinkContext,
  answer: Extract<FrameAnswer, { kind: 'found' }>,
): OwnerLink {
  const { dependency, served } = answer
  const file = repoRelative(root, answer.file)

  const map = answer.map
  if (!map || isEmptyMap(map)) {
    // §12 keeps the transformed position rather than dropping the link. It is a
    // real position in a real file, and the reason says which coordinates it is
    // in, so nobody edits line 4,431 of a file that has 60 lines.
    return approximateLink(link, `${file}:${frame.line}:${frame.column}`, dependency, {
      mode: 'no-sourcemap',
      reason:
        `the module at ${served} was served without a sourcemap, so the line and ` +
        "column are the served module's own rather than the source file's",
    })
  }

  // Engines print a 1-based column and a sourcemap stores a 0-based one. The
  // divergence between engines is left alone on purpose (spec §12): the map
  // erases it, and normalising it here would be guessing at what it erased.
  const original = originalPositionFor(map, frame.line, frame.column - 1)
  if (!original) {
    return absentLink(
      link,
      'unmapped-position',
      `the sourcemap of ${served} maps nothing at ${frame.line}:${frame.column}`,
      dependency,
    )
  }
  const location = `${file}:${original.line}:${original.column + 1}`

  if (answer.drift) return approximateLink(link, location, dependency, answer.drift)
  return exactLink(link, location, dependency)
}

/**
 * A frame in a bundle of many files: the map says which file as well as which
 * line, so a position it maps to no file of this machine has no location at
 * all, and a source its `ignoreList` names is vendor code whatever the
 * bundle's path said.
 */
function resolveInChunk(
  { link, root, frame }: LinkContext,
  answer: Extract<FrameAnswer, { kind: 'chunk' }>,
): OwnerLink {
  const { served } = answer
  // One column off for the same reason as a module's: engines print 1-based.
  const original = originalPositionFor(answer.map, frame.line, frame.column - 1)
  if (!original?.source) {
    return absentLink(
      link,
      'unmapped-position',
      `the sourcemap of ${served} maps nothing at ${frame.line}:${frame.column}`,
    )
  }

  const source = answer.source(original.source)
  if (!source) {
    return absentLink(
      link,
      'source-not-on-disk',
      `the sourcemap of ${served} maps ${frame.line}:${frame.column} into a source ` +
        "that is no file on this machine, such as the bundler's own runtime",
      original.ignored,
    )
  }
  const dependency = source.dependency || original.ignored
  const location = `${repoRelative(root, source.file)}:${original.line}:${original.column + 1}`

  if (source.drift) return approximateLink(link, location, dependency, source.drift)
  return exactLink(link, location, dependency)
}

/** A link with no location, and why. */
function absentLink(
  link: OwnerChainLink,
  mode: DegradedMode,
  reason: string,
  dependency = false,
): OwnerLink {
  return {
    name: link.name,
    location: null,
    confidence: { kind: 'absent', mode, reason },
    dependency,
  }
}

/** A link with a location that is worth less than it looks, and why. */
function approximateLink(
  link: OwnerChainLink,
  location: string,
  dependency: boolean,
  { mode, reason }: { mode: DegradedMode; reason: string },
): OwnerLink {
  return {
    name: link.name,
    location,
    confidence: { kind: 'approximate', mode, reason },
    dependency,
  }
}

function exactLink(
  link: OwnerChainLink,
  location: string,
  dependency: boolean,
): OwnerLink {
  return { name: link.name, location, confidence: { kind: 'exact' }, dependency }
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
