// Fiber access (spec §4) and the two things the hover chip is allowed to say
// about an element (spec §5).
//
// **Nothing here is a stack parser.** Ticket 04 recorded the rule deliberately,
// to resolve a tension between §5 ("both free from the fiber") and §6 ("the
// client ships no stack parser"): the chip's filename is the basename of the URL
// in the app frame of the owner's raw `_debugStack`, query stripped, and nothing
// else is read out of that string. The Owner chain ships whole and raw to the
// server, which remaps it with the vendored React DevTools parser (ticket 05).
// No line or column ever reaches the chip: they are in transformed coordinates
// until the server remaps them.

/** How React hangs a fiber off a DOM node in every version v0 supports. */
const FIBER_KEY_PREFIX = '__reactFiber$'

/**
 * The frame React puts below every app frame in an owner stack. Measured in
 * Chromium, Firefox and WebKit: the app frame is the line directly above it in
 * all three, whichever stack grammar the engine writes.
 */
const REACT_STACK_BOTTOM_FRAME = 'react_stack_bottom_frame'

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

/**
 * Read the fiber from the node; if it has none, walk `parentElement` until one
 * is found, recording the distance. A Pick is never refused for want of a fiber
 * (spec §4) — an element with none simply carries no name and no file.
 */
export function readOwner(element: Element): OwnerFacts {
  let node: Element | null = element
  let walkUp = 0
  let fiber: FiberLike | null = null

  while (node) {
    fiber = fiberOf(node)
    if (fiber) break
    node = node.parentElement
    walkUp += 1
  }
  if (!fiber) return { name: null, file: null, walkUp }

  const owner = fiber._debugOwner ?? null
  return {
    name: componentName(owner?.type),
    file: appFrameBasename(owner?._debugStack?.stack),
    walkUp,
  }
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
 * the one directly above React's own bottom-frame sentinel; a stack with no
 * sentinel yields no filename rather than a guess.
 */
function appFrameBasename(stack: string | undefined): string | null {
  if (!stack) return null

  const lines = stack.split('\n')
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
