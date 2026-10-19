// The one lookup this server needs from a source map: which original position a
// transformed one came from (spec §12). The Connector's frame resolver finds the
// map (for Vite, `transformResult.map` on the module), so nothing here fetches,
// parses JSON or resolves a `sourceMappingURL`; it decodes the `mappings` field
// and answers.
//
// Written rather than depended on. The package ships one runtime dependency, on
// the Overlay's side (spec §1), and the whole of what a source-map library
// would be used for here is the fifty lines below.

/** What this reads off a source map; a Host's own type is usually wider. */
export interface SourceMapLike {
  mappings: string
  sources?: readonly (string | null)[]
}

export interface OriginalPosition {
  /** 1-based, the way an editor and a stack frame both count lines. */
  line: number
  /** 0-based, the way a source map stores columns. */
  column: number
  /** The map's own name for the file, which may be relative to it. */
  source: string | null
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGITS = new Map<string, number>([...BASE64].map((digit, value) => [digit, value]))

/** The continuation bit and the value mask of one base-64 VLQ digit. */
const CONTINUES = 32
const VALUE = 31

/**
 * The original position a transformed one came from, or null when the map has
 * nothing to say about it — an unmapped column, a generated line past the end
 * of the mappings, or a mappings string this cannot read. Null is a link that
 * says so rather than one that guesses (spec §21).
 *
 * `generatedLine` is 1-based and `generatedColumn` 0-based, which is the pair a
 * stack frame gives once its own 1-based column has had one taken off it.
 */
export function originalPositionFor(
  map: SourceMapLike,
  generatedLine: number,
  generatedColumn: number,
): OriginalPosition | null {
  if (generatedLine < 1 || generatedColumn < 0) return null

  const groups = map.mappings.split(';')
  if (generatedLine > groups.length) return null

  // The source, line and column fields are deltas carried the whole length of
  // the mappings, so every line up to the wanted one has to be decoded.
  let sourceIndex = 0
  let sourceLine = 0
  let sourceColumn = 0
  let found: OriginalPosition | null = null

  for (let index = 0; index < generatedLine; index += 1) {
    const wanted = index === generatedLine - 1
    let column = 0
    let best: OriginalPosition | null = null

    for (const segment of (groups[index] ?? '').split(',')) {
      if (segment === '') continue
      const fields = decodeSegment(segment)
      if (!fields || fields[0] === undefined) return null

      column += fields[0]
      const hasSource =
        fields[1] !== undefined && fields[2] !== undefined && fields[3] !== undefined
      if (hasSource) {
        sourceIndex += fields[1] as number
        sourceLine += fields[2] as number
        sourceColumn += fields[3] as number
      }
      if (!wanted || column > generatedColumn) continue

      // A segment of one field ends the mapping before it and starts nothing:
      // the columns it covers came from nowhere the map is willing to name.
      best = hasSource
        ? {
            line: sourceLine + 1,
            column: sourceColumn,
            source: map.sources?.[sourceIndex] ?? null,
          }
        : null
    }

    if (wanted) found = best
  }

  return found
}

/** One comma-separated segment, as the base-64 VLQ signed integers it holds. */
function decodeSegment(segment: string): number[] | null {
  const fields: number[] = []
  let at = 0

  while (at < segment.length) {
    let value = 0
    let shift = 0
    let digit = 0

    do {
      const read = DIGITS.get(segment.charAt(at))
      if (read === undefined) return null
      at += 1
      digit = read
      value += (digit & VALUE) * 2 ** shift
      shift += 5
    } while (digit & CONTINUES)

    // Arithmetic rather than bitwise: a bit shift would silently wrap a field
    // wider than 32 bits, and a source map that had one would be read as
    // something else rather than as unreadable.
    const negative = value % 2 === 1
    const magnitude = (value - (negative ? 1 : 0)) / 2
    fields.push(negative ? -magnitude : magnitude)
  }

  return fields
}
