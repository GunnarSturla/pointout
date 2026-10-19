// Borrowed: the two stack-frame regexes, the V8-first grammar sniff, and the
//   owner-stack trim that cuts a raw `_debugStack` down to its app frames
// From: React DevTools — https://github.com/facebook/react
// Version: v19.3.0 (2026-09-22)
// License: MIT — full text in LICENSE-THIRDPARTY
// Changes: upstream reads `error.stack` itself and answers every frame as a
//   tuple carrying its enclosing position and its async flag; this takes the
//   raw string the Overlay already read — with `Error.prepareStackTrace` held
//   at `undefined` around the read, as upstream also does — and answers one
//   parsed frame, because the server wants a location rather than a trace. The
//   source-map lookup upstream performs in the browser is dropped: the remap
//   here goes through the Connector's frame resolver. The two regexes, the sniff that
//   tries V8 before the shared Gecko/JavaScriptCore grammar, and the trim
//   between React's top frame and its bottom-frame sentinel are upstream's.

/** One frame of a stack, in whichever grammar the engine wrote it. */
export interface StackFrame {
  /** The function name the engine printed. Empty for an anonymous frame. */
  name: string
  url: string
  /** 1-based, as every engine prints it. */
  line: number
  /** 1-based, as every engine prints it. */
  column: number
}

/** V8: `    at NAME (URL:LINE:COLUMN)`, with its three anonymous spellings. */
const V8_FRAME =
  /^ *at (?:(.+) \((?:(.+):(\d+):(\d+)|<anonymous>)\)|(?:async )?(.+):(\d+):(\d+)|<anonymous>)$/

/** The shared Gecko and JavaScriptCore grammar: `NAME@URL:LINE:COLUMN`. */
const GECKO_FRAME = /^((?:.*".+")?[^@]*)@(.+):(\d+):(\d+)$/

/** The message line V8 prefixes a stack with. It is not a frame. */
const V8_STACK_HEAD = 'Error: react-stack-top-frame\n'

/** The two spellings React has used for the frame below every app frame. */
const BOTTOM_FRAME = 'react_stack_bottom_frame'
const BOTTOM_FRAME_DASHED = 'react-stack-bottom-frame'

/**
 * Cut a raw owner stack down to the app frames between React's own top frame
 * and its bottom-frame sentinel. Empty when there is no sentinel — the stack
 * never reached app code — and empty when nothing is left between the two,
 * which is the frame an engine's proper tail calls deleted.
 */
export function trimOwnerStack(raw: string): string {
  let stack = raw
  if (stack.startsWith(V8_STACK_HEAD)) {
    // V8's default formatting prefixes the message, which is neither wanted
    // nor needed.
    stack = stack.slice(V8_STACK_HEAD.length)
  }
  let at = stack.indexOf('\n')
  // Pop the JSX frame: React captured it inside its own runtime.
  if (at !== -1) stack = stack.slice(at + 1)

  at = stack.indexOf(BOTTOM_FRAME)
  if (at === -1) at = stack.indexOf(BOTTOM_FRAME_DASHED)
  if (at !== -1) at = stack.lastIndexOf('\n', at)

  // Everything below the sentinel is React's internals. No sentinel at all
  // means this stack never came out to app code, so there is nothing to keep.
  return at === -1 ? '' : stack.slice(0, at)
}

/**
 * One frame, in whichever grammar it is written — sniffed from the content and
 * never from the user agent. V8 is tried first, because a url with an `@` in it
 * (`/@vite/client`, `/@fs/…`) would otherwise satisfy the Gecko pattern on a V8
 * line. Null for a frame that carries no location at all: `at <anonymous>`,
 * `map@[native code]`, and anything else that is not a frame.
 */
export function parseFrame(line: string): StackFrame | null {
  const v8 = V8_FRAME.exec(line)
  if (v8) {
    const [, name, namedUrl, namedLine, namedColumn, bareUrl, bareLine, bareColumn] = v8
    if (namedUrl) return frame(name ?? '', namedUrl, namedLine, namedColumn)
    if (bareUrl) return frame('', bareUrl, bareLine, bareColumn)
    return null
  }

  const gecko = GECKO_FRAME.exec(line)
  if (gecko) {
    const [, name, url, geckoLine, geckoColumn] = gecko
    if (url) return frame(name ?? '', url, geckoLine, geckoColumn)
  }
  return null
}

function frame(
  name: string,
  url: string,
  line: string | undefined,
  column: string | undefined,
): StackFrame {
  return { name, url, line: Number(line), column: Number(column) }
}

// --- end of borrowed code ---

/**
 * What one raw stack turned out to hold where its app frame should be. Every
 * shape but the first is one of spec §12's structural degraded modes, and each
 * is told apart from the others *here*, because only this module knows the shape
 * of a stack. A link that reads as anything but `frame` keeps its name and says
 * which of these it was (spec §21).
 */
export type AppFrameReading =
  /** The app frame: the line directly above the sentinel, with a location. */
  | { kind: 'frame'; frame: StackFrame }
  /**
   * React's shared placeholder owner stack, handed out above roughly 10,000
   * elements a second. Measured in Chromium and Firefox: it is the only owner
   * stack whose top frame is React's own `UnknownOwner`.
   */
  | { kind: 'placeholder' }
  /** The sentinel is there and nothing is above it: an engine deleted the frame. */
  | { kind: 'elided' }
  /** No sentinel at all: this stack never came out to app code. */
  | { kind: 'no-boundary' }
  /** A line is there above the sentinel and it carries no location. */
  | { kind: 'unreadable' }

/**
 * React's name for the function it captures a placeholder owner stack inside,
 * in `react/jsx-dev-runtime`. Measured against React 19.3.0: the placeholder is
 * `react_stack_bottom_frame(UnknownOwner)` called once at module load, so its
 * top frame is `UnknownOwner` and the sentinel sits directly under it — exactly
 * the shape a tail-deleted frame has. The name is the only thing that tells the
 * two apart, which is the whole of spec §12's ten-minute check.
 *
 * The url is not also checked: React's runtime is served under a different path
 * prebundled, unbundled and linked, and the frame this matches is one React
 * captured inside its own runtime in every case.
 */
const UNKNOWN_OWNER = /(?:^|[.<>/])UnknownOwner$/

/**
 * The app frame of one Owner-chain link: the **first** frame after React's own
 * top frame has been discarded, within the region ending at React's
 * bottom-frame sentinel.
 *
 * This is React DevTools' rule, and a deliberate deviation from spec §12, which
 * says the frame *directly above the sentinel* instead. The two agree for an
 * ordinary call site — there is only one frame between — and disagree whenever a
 * callback sits in the middle, such as a `.map()`. There, the spec's rule names
 * the line the loop starts on and this one names the JSX itself.
 *
 * The JSX is what this project wants. A Pick carries a developer saying "this
 * element needs more padding" or "change this text", and the line they mean is
 * the tag, not the expression that enclosed it. A devtools user reading a render
 * tree may well want the other one; v0 is not that. ADR-0003 records the call.
 *
 * Everything else this can answer is a mode, never a null: a link is annotated
 * rather than dropped, and the annotation says which thing went wrong.
 */
export function readAppFrame(raw: string): AppFrameReading {
  const top = topFrame(raw)
  if (top && UNKNOWN_OWNER.test(top.name)) return { kind: 'placeholder' }
  if (!hasSentinel(raw)) return { kind: 'no-boundary' }

  for (const line of trimOwnerStack(raw).split('\n')) {
    if (line.trim() === '') continue
    const parsed = parseFrame(line)
    return parsed ? { kind: 'frame', frame: parsed } : { kind: 'unreadable' }
  }
  // The sentinel is there and the top frame was the only thing above it.
  return { kind: 'elided' }
}

/** React's own frame, which every owner stack opens with and none of it is the app's. */
function topFrame(raw: string): StackFrame | null {
  const stack = raw.startsWith(V8_STACK_HEAD) ? raw.slice(V8_STACK_HEAD.length) : raw
  const at = stack.indexOf('\n')
  return parseFrame(at === -1 ? stack : stack.slice(0, at))
}

/** Whether React's boundary is in this stack at all, in either spelling. */
function hasSentinel(raw: string): boolean {
  return raw.includes(BOTTOM_FRAME) || raw.includes(BOTTOM_FRAME_DASHED)
}
