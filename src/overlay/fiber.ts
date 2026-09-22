// Fiber access (spec §4), the Owner chain the Pick carries (spec §6), and the
// two things the hover chip is allowed to say about an element (spec §5).
//
// **Nothing here is a stack parser.** Ticket 04 recorded the rule to resolve a
// tension between §5 ("both free from the fiber") and §6 ("the client ships no
// stack parser"), and ticket 05 keeps it: the chain is sent whole and raw, one
// stack string per link, and the server remaps it with the vendored React
// DevTools parser. The only thing read out of a stack here is the chip's
// filename — the basename of the url in the app frame — and no line or column
// ever reaches the chip, because they are in transformed coordinates until the
// server remaps them.

/** How React hangs a fiber off a DOM node in every version v0 supports. */
const FIBER_KEY_PREFIX = '__reactFiber$'

/**
 * The frame React puts below every app frame in an owner stack. Measured in
 * Chromium, Firefox and WebKit: the app frame is the line directly above it in
 * all three, whichever stack grammar the engine writes.
 */
const REACT_STACK_BOTTOM_FRAME = 'react_stack_bottom_frame'

/** The message line V8 prefixes a stack with. It is not a frame. */
const V8_STACK_HEAD = 'Error: react-stack-top-frame'

/** A url inside one stack frame, in either grammar. */
const URL_IN_FRAME = /https?:\/\/[^\s)]+/

interface FiberLike {
  type?: unknown
  _debugOwner?: FiberLike | null
  _debugStack?: { stack?: string } | null
}

/** What the Overlay knows about a picked element before the server is asked. */
export interface OwnerFacts {
  /** The fiber owner's `displayName` or `name`, or null when there is none. */
  name: string | null
  /** The basename of the owner's app frame url, or null. */
  file: string | null
  /** How many `parentElement` steps it took to find a fiber at all (spec §4). */
  walkUp: number
}

/** One link of the Owner chain, exactly as the server is given it (spec §6). */
export interface OwnerChainLink {
  /** The component that wrote this call site: its `displayName` or `name`. */
  name: string | null
  /** The link's raw `_debugStack` string. Parsed by the server, never here. */
  stack: string
}

/** The whole chain, innermost first, and how far the DOM was walked to find it. */
export interface OwnerChain {
  links: OwnerChainLink[]
  walkUp: number
}

/**
 * The chip's two facts: the component that wrote the picked element, and the
 * file it wrote it in. That pair is the chain's innermost link, so the chip and
 * the Pointer can never name different things — and reading one stack rather
 * than the whole chain keeps a hover cheap.
 */
export function readOwner(element: Element): OwnerFacts {
  const { fiber, walkUp } = findFiber(element)
  const owner = fiber?._debugOwner ?? null
  if (!fiber || !owner) return { name: null, file: null, walkUp }

  return {
    name: componentName(owner.type),
    file: appFrameBasename(rawStack(fiber)),
    walkUp,
  }
}

/**
 * The Owner chain at pick time: walk `_debugOwner` outward from the picked
 * element's fiber, and for each step take the component that wrote the call site
 * together with the raw stack of the thing it wrote. A fiber with no owner was
 * not written by a component, so the walk ends there rather than carrying a link
 * nobody can be pointed at.
 *
 * The chain is sent whole and uncapped (spec §6). Nothing is filtered: React's
 * own notion of ownership already leaves out a component that merely forwards a
 * node, and no DOM ancestor is ever added.
 */
export function readOwnerChain(element: Element): OwnerChain {
  const { fiber, walkUp } = findFiber(element)
  const links: OwnerChainLink[] = []
  const seen = new Set<FiberLike>()

  let node = fiber
  while (node && !seen.has(node)) {
    seen.add(node)
    const owner = node._debugOwner ?? null
    if (!owner) break
    const stack = rawStack(node)
    if (stack === null) break
    links.push({ name: componentName(owner.type), stack })
    node = owner
  }

  return { links, walkUp }
}

/**
 * The fiber on the node, or the nearest one above it. A Pick is never refused
 * for want of a fiber (spec §4) — an element with none simply carries no chain,
 * and the distance walked is stated in the Pointer rather than swallowed.
 */
function findFiber(element: Element): { fiber: FiberLike | null; walkUp: number } {
  let node: Element | null = element
  let walkUp = 0

  while (node) {
    const fiber = fiberOf(node)
    if (fiber) return { fiber, walkUp }
    node = node.parentElement
    walkUp += 1
  }
  return { fiber: null, walkUp }
}

function fiberOf(node: Element): FiberLike | null {
  const record = node as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!key.startsWith(FIBER_KEY_PREFIX)) continue
    const value = record[key]
    if (value && typeof value === 'object') return value as FiberLike
  }
  return null
}

/**
 * One fiber's raw `_debugStack` string. `Error.prepareStackTrace` is held at
 * `undefined` across the read and put back afterwards, so a dev-mode error SDK
 * that installs a formatter cannot hand over an already-source-mapped string
 * the server would then remap a second time (spec §6).
 */
function rawStack(fiber: FiberLike): string | null {
  const previous = Error.prepareStackTrace
  try {
    // `undefined` is what V8 accepts for "format it the default way". The types
    // in scope here are Node's, and they do not admit that; the engine does, and
    // React's own owner-stack code sets exactly this.
    Error.prepareStackTrace = undefined as unknown as typeof Error.prepareStackTrace
    const stack = fiber._debugStack?.stack
    return typeof stack === 'string' ? stack : null
  } finally {
    Error.prepareStackTrace = previous
  }
}

/** `type.displayName` or `type.name` — §6's rule, and no other source. */
function componentName(type: unknown): string | null {
  if (typeof type !== 'function' && (typeof type !== 'object' || type === null)) {
    return null
  }
  const named = type as { displayName?: unknown; name?: unknown }
  if (typeof named.displayName === 'string' && named.displayName) return named.displayName
  if (typeof named.name === 'string' && named.name) return named.name
  return null
}

/**
 * The basename of the url in the app frame, and nothing else. The app frame is
 * the one directly above React's own bottom-frame sentinel, once React's top
 * frame has been discarded; a stack with no such frame yields no filename rather
 * than the name of React's own runtime.
 */
function appFrameBasename(stack: string | null): string | null {
  if (!stack) return null

  const lines = stack.split('\n')
  if (lines[0]?.startsWith(V8_STACK_HEAD)) lines.shift()
  // React captured the top frame inside its own runtime; it is never the app's.
  lines.shift()

  const sentinel = lines.findIndex((line) => line.includes(REACT_STACK_BOTTOM_FRAME))
  const frame = sentinel > 0 ? lines[sentinel - 1] : undefined
  if (!frame) return null

  const found = URL_IN_FRAME.exec(frame)
  if (!found) return null

  try {
    // The trailing `:line:col` is part of the frame, not of the url; the query
    // string goes with the url and is dropped by reading the pathname.
    const { pathname } = new URL(found[0].replace(/:\d+:\d+$/, ''))
    return pathname.split('/').pop() || null
  } catch {
    // A frame whose url will not parse names no file, which the chip shows as
    // nothing rather than as the raw frame.
    return null
  }
}
