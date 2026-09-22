import { relative, sep } from 'node:path'
import type { ViteDevServer } from 'vite'
import type { Parsed } from './pick.js'
import { originalPositionFor } from './sourcemap.js'
import { appFrame } from './stack.js'

// The Owner chain, server side (spec §6, §12, §13): the ordered list of JSX call
// sites that produced the picked element, innermost first. The Overlay sends one
// raw stack string per link and no parser; everything that turns those strings
// into repo-relative positions happens here.
//
// The raw strings are Excerpts (`CONTEXT.md`): validated on the way in, read by
// the parser, and never interpolated into the body an agent reads. What the
// Pointer prints is only ever built here, out of a component name, a path this
// server computed, and numbers.

/** One link of the chain as the Overlay sends it. */
export interface OwnerLinkInput {
  /** The owning component's `displayName` or `name`, or null when it has none. */
  name: string | null
  /** The link's raw `_debugStack` string, in whatever grammar the engine wrote. */
  stack: string
}

/**
 * What one frame of an Owner chain says about itself (`CONTEXT.md`): exact,
 * approximate with a reason, or absent with a reason. A property of a frame and
 * never of a Pick — it is the rule that a Pick degrades by annotation rather
 * than by refusal.
 *
 * This ticket lands `exact`. Every other outcome is `absent` with the reason it
 * has; spec §12's named modes — stale transform, missing timestamp, tail-deleted
 * frame, missing sourcemap, dependency flag — are ticket 06, and that is where
 * `approximate` starts being answered.
 */
export type Confidence =
  | { kind: 'exact' }
  | { kind: 'approximate'; reason: string }
  | { kind: 'absent'; reason: string }

/** One resolved link, in the words the Pointer will state it in. */
export interface OwnerLink {
  name: string | null
  /** Repo-relative `path:line:col`, or null when there is no location. */
  location: string | null
  confidence: Confidence
}

/** Everything the Overlay says about ownership, before any of it is resolved. */
export interface OwnerChainInput {
  links: OwnerLinkInput[]
  /** How many `parentElement` steps it took to find a fiber at all (spec §4). */
  walkUp: number
}

const refuse = (reason: string): Parsed<never> => ({
  ok: false,
  refusal: { status: 400, body: { error: 'owner-chain-unreadable', reason } },
})

/**
 * The ingest check on the Owner chain the body carries. A chain that is absent
 * is a chain of no links, which is a Pick this server still accepts: a Pick is
 * never refused for want of an owner (spec §4).
 */
export function parseOwnerChain(body: Record<string, unknown>): Parsed<OwnerChainInput> {
  const { ownerChain, walkUp } = body

  if (
    walkUp !== undefined &&
    (typeof walkUp !== 'number' || !Number.isInteger(walkUp) || walkUp < 0)
  ) {
    return refuse(
      'refused a Pick whose walk-up distance is not a whole number of DOM levels.',
    )
  }
  const distance = typeof walkUp === 'number' ? walkUp : 0

  if (ownerChain === undefined || ownerChain === null) {
    return { ok: true, value: { links: [], walkUp: distance } }
  }
  if (!Array.isArray(ownerChain)) {
    return refuse('refused a Pick whose owner chain is not a list of links.')
  }

  const links: OwnerLinkInput[] = []
  for (const link of ownerChain) {
    if (typeof link !== 'object' || link === null || Array.isArray(link)) {
      return refuse(
        'refused a Pick whose owner chain holds something that is not a link.',
      )
    }
    const { name, stack } = link as Record<string, unknown>
    if (typeof stack !== 'string') {
      return refuse('refused a Pick whose owner chain has a link with no raw stack.')
    }
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return refuse(
        'refused a Pick whose owner chain has a link whose component name is not text.',
      )
    }
    links.push({ name: typeof name === 'string' ? name : null, stack })
  }

  return { ok: true, value: { links, walkUp: distance } }
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
  links: readonly OwnerLinkInput[],
): Promise<OwnerLink[]> {
  const resolved: OwnerLink[] = []
  for (const link of links) resolved.push(await resolveLink(server, root, link))
  return resolved
}

async function resolveLink(
  server: ViteDevServer,
  root: string,
  link: OwnerLinkInput,
): Promise<OwnerLink> {
  const absent = (reason: string): OwnerLink => ({
    name: link.name,
    location: null,
    confidence: { kind: 'absent', reason },
  })

  const frame = appFrame(link.stack)
  if (!frame) {
    return absent(
      'this stack carries no app frame above the frame React puts below every one',
    )
  }

  // The query string belongs to the request and not to the module: Vite's own
  // `?v=` and `?t=` are how a transform is addressed, not what it is.
  const path = modulePath(frame.url)
  if (!path) return absent(`its frame names no url this server can read (${frame.url})`)

  const module = await server.environments.client.moduleGraph.getModuleByUrl(path)
  if (!module?.file) return absent(`no module in this dev server's graph at ${path}`)

  const map = module.transformResult?.map
  if (!map || map.mappings === '') {
    return absent(`the module at ${path} was served without a sourcemap`)
  }

  // Engines print a 1-based column and a sourcemap stores a 0-based one. The
  // divergence between engines is left alone on purpose (spec §12): the map
  // erases it, and normalising it here would be guessing at what it erased.
  const original = originalPositionFor(map, frame.line, frame.column - 1)
  if (!original) {
    return absent(
      `the sourcemap of ${path} maps nothing at ${frame.line}:${frame.column}`,
    )
  }

  return {
    name: link.name,
    location: `${repoRelative(root, module.file)}:${original.line}:${original.column + 1}`,
    confidence: { kind: 'exact' },
  }
}

/** The path half of a frame's url, which is how the module graph is keyed. */
function modulePath(url: string): string | null {
  try {
    return new URL(url).pathname
  } catch {
    return null
  }
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
