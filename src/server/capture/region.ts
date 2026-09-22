import type { Parsed } from '../pick.js'

// The one piece of Screen Capture arithmetic (spec §10). The page ships
// coordinates only — it cannot see the physical display — and this turns them
// into the region `screencapture -R` is given. Pure, and deliberately so: every
// other module here spawns something or writes to disk.

/** The fixed margin around the element, on every side. Spacing is often why. */
export const MARGIN = 24

/**
 * How much wider than its viewport a window may be before the capture is called
 * possibly-offset. A couple of pixels is a window border or a rounding; more is
 * chrome this server cannot locate, because it assumes chrome sits on top with
 * a left offset of zero and has no way to check.
 */
export const CHROME_WIDTH_THRESHOLD = 4

export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

/** What the page measured at the moment of the pick. */
export interface Coordinates {
  /** The element's rectangle in the viewport. */
  rect: Rectangle
  /** `window.screenX` and `window.screenY`. */
  screenX: number
  screenY: number
  /** `outerWidth − innerWidth` and `outerHeight − innerHeight`. */
  chromeWidth: number
  chromeHeight: number
  screen: { width: number; height: number }
}

/** The region `screencapture -R` is given, and what it may be wrong about. */
export interface Region extends Rectangle {
  /**
   * The horizontal chrome difference when it is over the threshold, and null
   * when it is not — the payload says the capture may be offset by this many
   * pixels rather than pretending the arithmetic was safe.
   */
  offsetBy: number | null
}

/**
 * The element's bounds, translated to the display, grown by the margin and
 * clamped to the screen the page reported. Chrome is assumed to be entirely on
 * top: the vertical difference is added, the horizontal one is only reported.
 */
export function regionFor(coordinates: Coordinates): Region {
  const { rect, screenX, screenY, chromeWidth, chromeHeight, screen } = coordinates

  const left = screenX + rect.x - MARGIN
  const top = screenY + chromeHeight + rect.y - MARGIN

  const x = clamp(left, 0, screen.width)
  const y = clamp(top, 0, screen.height)

  return {
    x,
    y,
    width: clamp(left + rect.width + 2 * MARGIN, x, screen.width) - x,
    height: clamp(top + rect.height + 2 * MARGIN, y, screen.height) - y,
    offsetBy: chromeWidth > CHROME_WIDTH_THRESHOLD ? Math.round(chromeWidth) : null,
  }
}

/**
 * The POST body, checked the way Pick ingest checks its own (spec §11): every
 * refusal names the part it refused, because a 4xx that says only "bad request"
 * is a silent drop with a status code on it.
 */
export function parseCaptureBody(text: string): Parsed<Coordinates> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return incomplete(`its body is not JSON: ${(error as Error).message}`)
  }
  if (!isRecord(parsed)) return incomplete('its body is not a JSON object')

  const rect = parseRectangle(parsed.rect)
  if (!rect.ok) return rect

  const screen = parsed.screen
  if (!isRecord(screen) || !isSize(screen.width) || !isSize(screen.height)) {
    return incomplete('it names no screen width and height to clamp the region to')
  }

  const offsets: Array<'screenX' | 'screenY' | 'chromeWidth' | 'chromeHeight'> = [
    'screenX',
    'screenY',
    'chromeWidth',
    'chromeHeight',
  ]
  const window: Record<string, number> = {}
  for (const name of offsets) {
    const given = parsed[name]
    if (!isFiniteNumber(given)) {
      return incomplete(`its ${name} is not a number, so the window cannot be placed`)
    }
    window[name] = given
  }

  return {
    ok: true,
    value: {
      rect: rect.value,
      screenX: window.screenX as number,
      screenY: window.screenY as number,
      chromeWidth: window.chromeWidth as number,
      chromeHeight: window.chromeHeight as number,
      screen: { width: screen.width as number, height: screen.height as number },
    },
  }
}

function parseRectangle(value: unknown): Parsed<Rectangle> {
  if (
    !isRecord(value) ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isSize(value.width) ||
    !isSize(value.height)
  ) {
    return incomplete("it names no rectangle for the element in the page's viewport")
  }
  return {
    ok: true,
    value: {
      x: value.x as number,
      y: value.y as number,
      width: value.width as number,
      height: value.height as number,
    },
  }
}

function incomplete(what: string): Parsed<never> {
  return {
    ok: false,
    refusal: {
      status: 400,
      body: {
        error: 'capture-coordinates-incomplete',
        reason: `refused a Screen Capture because ${what}.`,
      },
    },
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.round(Math.min(Math.max(value, low), high))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSize(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}
