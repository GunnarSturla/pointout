import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { now } from './clock.js'
import type { Refusal } from './guard.js'
import { parseOwnerChain } from './owner-chain.js'
import type { OwnerLink, OwnerLinkInput } from './owner-chain.js'

// Pick ingress: what arrives on the wire from the Overlay, what is refused, and
// the Pick that comes out the other side (spec §11, §13). Nothing here renders
// and nothing here delivers.

/**
 * Spec §11. The client half — the counter and the disabled Send — is in
 * `src/overlay/panel.ts`, which writes this number out rather than importing it;
 * this is the half that cannot be talked out of, and it rejects rather than
 * truncating, because a silently shortened Note is a silently changed request.
 *
 * **Counted in code points, and so is the client half** (`[...value].length`).
 * Two halves counting UTF-16 units against characters disagree at the boundary.
 */
export const NOTE_MAX_CHARACTERS = 4000

/**
 * The whole POST body. Generous next to the Note cap because the Owner chain
 * (ticket 05) sends one raw stack string per link, uncapped, and Excerpts
 * (ticket 07) ride along; small enough that a runaway page cannot make the dev
 * server hold a megabyte per request.
 */
export const BODY_MAX_BYTES = 256 * 1024

/** The one Candidate a Pick is addressed to, as the body names it (spec §14). */
export interface Target {
  sessionId: string
  pid: number
}

export interface Viewport {
  width: number
  height: number
}

export interface Geometry {
  width: number
  height: number
  x: number
  y: number
}

/**
 * What the Overlay can say about the picked element itself. Everything here is
 * optional but `tag`, so that a descriptor which grows never breaks an older
 * Overlay — and nothing here is a selector path, a computed style or a source
 * snippet, which §13 says it must never be.
 */
export interface ElementDescriptor {
  tag: string
  id?: string
  testId?: string
  role?: string
  aria?: Record<string, string>
  classes?: string[]
}

/** Spec §13: an introduction, never a selector. */
const DESCRIPTOR_CLASS_MAX = 2

/**
 * The kinds of Excerpt this server will render. The set is closed because the
 * kind is written into the Fence, and a kind the page chose would be a Fence
 * whose shape the page chose (`CONTEXT.md`, spec §13).
 */
const EXCERPT_KINDS: readonly string[] = [
  'rendered-text',
  'input-value',
  'textarea',
  'select',
  'contenteditable',
  'attributes',
]

/** Content lifted from the page and carried as evidence (`CONTEXT.md`). */
export interface Excerpt {
  kind: string
  text: string
  /**
   * How many characters were on the page, when more were captured than are
   * carried. Absent when nothing was trimmed: a trim is annotated, never silent.
   */
  captured?: number
}

/** The redaction rules the page may report having applied (spec §13, §21). */
const REDACTION_REASONS: readonly string[] = ['password', 'hidden']

/** The machine-generated half of a Pick (`CONTEXT.md`). */
export interface Pointer {
  url: string
  viewport: Viewport
  descriptor: ElementDescriptor
  geometry: Geometry
  /**
   * The Owner chain, innermost first, filled in at ingest once the frames have
   * been remapped through the module graph. Empty until then, and empty for an
   * element React never owned.
   */
  ownerChain: OwnerLink[]
  /** How many DOM levels the Overlay walked up to find a fiber (spec §4, §12). */
  walkUp: number
  /**
   * The Excerpts, in the order the Overlay lifted them. The 32 KiB cap may take
   * some of them away before the write, and says so when it does (spec §13).
   */
  excerpts: Excerpt[]
  /**
   * Which redaction rules fired in the page. The sentence is written here rather
   * than sent, so a Pointer can never be made to carry prose the page chose.
   */
  redactions: string[]
}

/**
 * The Screen Capture a Pick asks to carry: the one the Overlay started at pick
 * time, and the camera toggle as it stood at Send (spec §10). The server keeps
 * the image when the toggle was on and deletes it when it was off.
 */
export interface CaptureRequest {
  id: string
  keep: boolean
}

/** One selection, as the server holds it from ingest onwards. */
export interface Pick {
  id: string
  /** 12 hex characters: the Fence nonce and the ack and done credential. */
  nonce: string
  createdAt: number
  pointer: Pointer
  note: string | null
  target: Target | null
  /**
   * The raw stack strings the Overlay sent, one per Owner-chain link. Excerpts
   * (`CONTEXT.md`): validated here, read by the parser, and never interpolated
   * into the body an agent reads — which is why they sit beside the Pointer
   * rather than inside it.
   */
  ownerLinks: OwnerLinkInput[]
  /** What the body asked for; the capture service is what answers it. */
  captureRequest: CaptureRequest | null
  /**
   * The Pointer's Screen Capture line — a file path, or the statement that a
   * capture was intended and failed — filled in at ingest once the capture has
   * been resolved, and null when the Pick carries none.
   */
  captureLine: string | null
  /**
   * What the 32 KiB cap took out of this Pick's Excerpts, in the words both the
   * payload and the Panel use. Null when the Pick fitted as it was (spec §13).
   */
  trimNote: string | null
}

/** Either a value, or the refusal that says why there is none. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; refusal: Refusal }

const refuse = (status: number, error: string, reason: string): Parsed<never> => ({
  ok: false,
  refusal: { status, body: { error, reason } },
})

/**
 * Read the request body, capped. The stream is drained either way: a refusal
 * that leaves bytes unread is answered with a reset connection rather than with
 * the reason it went to the trouble of writing.
 */
export function readRequestBody(request: IncomingMessage): Promise<Parsed<string>> {
  const limit = BODY_MAX_BYTES
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const settle = (result: Parsed<string>) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        settle(
          refuse(
            413,
            'body-too-large',
            `refused a Pick of more than ${limit} bytes: ingress reads a bounded ` +
              'body, and this one kept going.',
          ),
        )
        request.resume()
        return
      }
      if (!settled) chunks.push(chunk)
    })
    request.on('end', () =>
      settle({ ok: true, value: Buffer.concat(chunks).toString('utf8') }),
    )
    request.on('error', (error: Error) =>
      settle(
        refuse(
          400,
          'body-unreadable',
          `refused a Pick whose body ended: ${error.message}`,
        ),
      ),
    )
  })
}

/** Mint a Pick from a body that has already been parsed and checked. */
function mintPick(parts: {
  pointer: Pointer
  note: string | null
  target: Target | null
  ownerLinks: OwnerLinkInput[]
  captureRequest: CaptureRequest | null
}): Pick {
  return {
    id: randomUUID(),
    nonce: randomBytes(6).toString('hex'),
    createdAt: now(),
    ...parts,
    captureLine: null,
    trimNote: null,
  }
}

/**
 * The ingest check on the body itself (spec §11). Every refusal names the part
 * it refused: a 4xx that says only "bad request" is a silent drop with a status
 * code on it.
 */
export function parsePickBody(text: string): Parsed<Pick> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return refuse(
      400,
      'malformed-json',
      `refused a Pick whose body is not JSON: ${(error as Error).message}`,
    )
  }
  if (!isRecord(parsed)) {
    return refuse(
      400,
      'malformed-json',
      'refused a Pick whose body is not a JSON object.',
    )
  }

  const note = parsed.note
  if (note !== undefined && note !== null && typeof note !== 'string') {
    return refuse(400, 'note-not-text', 'refused a Pick whose note is not text.')
  }
  // Counted in code points: §11 says characters, and an emoji is one character
  // to the developer who typed it however many UTF-16 units it takes.
  const noteLength = typeof note === 'string' ? [...note].length : 0
  if (noteLength > NOTE_MAX_CHARACTERS) {
    return refuse(
      400,
      'note-too-long',
      `refused a Pick whose note is ${noteLength} characters, over the ` +
        `${NOTE_MAX_CHARACTERS} allowed. It is refused rather than shortened, ` +
        'so nothing the developer wrote is lost.',
    )
  }

  const pointer = parsePointer(parsed)
  if (!pointer.ok) return pointer

  const owners = parseOwnerChain(parsed)
  if (!owners.ok) return owners

  const target = parseTarget(parsed.target)
  if (!target.ok) return target

  const captureRequest = parseCaptureRequest(parsed.capture)
  if (!captureRequest.ok) return captureRequest

  return {
    ok: true,
    value: mintPick({
      pointer: { ...pointer.value, walkUp: owners.value.walkUp },
      note: typeof note === 'string' ? note : null,
      target: target.value,
      ownerLinks: owners.value.links,
      captureRequest: captureRequest.value,
    }),
  }
}

/**
 * The capture half of the body (spec §20): the id the Overlay was given when it
 * started the capture, and the toggle. Absent is the ordinary case — most Picks
 * carry no Screen Capture, and one that is malformed is refused rather than
 * dropped, because a Pick that silently lost its capture looks like one that
 * never asked for one.
 */
function parseCaptureRequest(value: unknown): Parsed<CaptureRequest | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) {
    return refuse(
      400,
      'capture-unreadable',
      'refused a Pick whose capture names no id. A capture is one this dev ' +
        'server started, or there is none.',
    )
  }
  if (typeof value.keep !== 'boolean') {
    return refuse(
      400,
      'capture-unreadable',
      'refused a Pick whose capture does not say whether the camera toggle was ' +
        'on: the image is kept or deleted, and this server will not guess which.',
    )
  }
  return { ok: true, value: { id: value.id, keep: value.keep } }
}

function parsePointer(body: Record<string, unknown>): Parsed<Pointer> {
  const { url, viewport, descriptor, geometry } = body

  if (typeof url !== 'string' || url.length === 0) {
    return refuse(
      400,
      'pointer-incomplete',
      'refused a Pick whose pointer names no page url.',
    )
  }
  const parsedViewport = parseSize(viewport, 'viewport')
  if (!parsedViewport.ok) return parsedViewport
  const parsedGeometry = parseGeometry(geometry)
  if (!parsedGeometry.ok) return parsedGeometry
  const parsedDescriptor = parseDescriptor(descriptor)
  if (!parsedDescriptor.ok) return parsedDescriptor
  const excerpts = parseExcerpts(body.excerpts)
  if (!excerpts.ok) return excerpts
  const redactions = parseRedactions(body.redactions)
  if (!redactions.ok) return redactions

  return {
    ok: true,
    value: {
      url,
      viewport: parsedViewport.value,
      descriptor: parsedDescriptor.value,
      geometry: parsedGeometry.value,
      // Both filled in by ingest: the chain has to be remapped through the
      // module graph, and reading that graph is asynchronous.
      ownerChain: [],
      walkUp: 0,
      excerpts: excerpts.value,
      redactions: redactions.value,
    },
  }
}

function parseSize(value: unknown, part: string): Parsed<Viewport> {
  if (!isRecord(value) || !isFinite(value.width) || !isFinite(value.height)) {
    return refuse(
      400,
      'pointer-incomplete',
      `refused a Pick whose ${part} is not a width and a height.`,
    )
  }
  return {
    ok: true,
    value: { width: value.width as number, height: value.height as number },
  }
}

function parseGeometry(value: unknown): Parsed<Geometry> {
  const size = parseSize(value, 'geometry')
  if (!size.ok) return size
  const record = value as Record<string, unknown>
  if (!isFinite(record.x) || !isFinite(record.y)) {
    return refuse(
      400,
      'pointer-incomplete',
      'refused a Pick whose geometry names no position.',
    )
  }
  return {
    ok: true,
    value: { ...size.value, x: record.x as number, y: record.y as number },
  }
}

function parseDescriptor(value: unknown): Parsed<ElementDescriptor> {
  if (!isRecord(value) || typeof value.tag !== 'string' || value.tag.length === 0) {
    return refuse(
      400,
      'pointer-incomplete',
      'refused a Pick whose descriptor names no element tag.',
    )
  }

  // Refused rather than filtered. Dropping the parts of a descriptor that are
  // not text would point the agent at an element described by less than the
  // Overlay sent, and say nothing about it (spec §21).
  const descriptor: ElementDescriptor = { tag: value.tag }
  for (const field of ['id', 'testId', 'role'] as const) {
    const given = value[field]
    if (given === undefined) continue
    if (!isText(given)) {
      return refuse(
        400,
        'pointer-incomplete',
        `refused a Pick whose descriptor has a ${field} that is not text.`,
      )
    }
    descriptor[field] = given
  }
  if (value.aria !== undefined) {
    if (!isRecord(value.aria) || !Object.values(value.aria).every(isText)) {
      return refuse(
        400,
        'pointer-incomplete',
        'refused a Pick whose descriptor has aria attributes that are not text.',
      )
    }
    if (Object.keys(value.aria).length > 0) {
      descriptor.aria = value.aria as Record<string, string>
    }
  }
  if (value.classes !== undefined) {
    if (!Array.isArray(value.classes) || !value.classes.every(isText)) {
      return refuse(
        400,
        'pointer-incomplete',
        'refused a Pick whose descriptor has class names that are not text.',
      )
    }
    // Refused rather than sliced, for the same reason the Note is: a descriptor
    // quietly cut down to two classes is one that describes less than the
    // Overlay sent and says nothing about it (spec §13, §21).
    if (value.classes.length > DESCRIPTOR_CLASS_MAX) {
      return refuse(
        400,
        'pointer-incomplete',
        `refused a Pick whose descriptor carries ${value.classes.length} classes. ` +
          `A descriptor names at most two classes, because it is an introduction ` +
          'and never a selector path.',
      )
    }
    if (value.classes.length > 0) descriptor.classes = value.classes as string[]
  }
  return { ok: true, value: descriptor }
}

/**
 * The Excerpts, as the page lifted them (spec §13). The kind is checked against
 * a closed set because it is written into the Fence; the text is checked for
 * being text, and nothing else — the caps belong where the lifting happened, and
 * the 32 KiB payload cap is what bounds what is written.
 */
function parseExcerpts(value: unknown): Parsed<Excerpt[]> {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (!Array.isArray(value)) {
    return refuse(
      400,
      'excerpt-unreadable',
      'refused a Pick whose excerpts are not a list.',
    )
  }

  const excerpts: Excerpt[] = []
  for (const given of value) {
    if (!isRecord(given) || typeof given.kind !== 'string') {
      return refuse(
        400,
        'excerpt-unreadable',
        'refused a Pick carrying an excerpt that names no kind.',
      )
    }
    if (!EXCERPT_KINDS.includes(given.kind)) {
      return refuse(
        400,
        'excerpt-unreadable',
        `refused a Pick carrying an excerpt of kind "${given.kind}", which this ` +
          `dev server does not lift. The kinds it renders are ` +
          `${EXCERPT_KINDS.join(', ')}.`,
      )
    }
    if (!isText(given.text)) {
      return refuse(
        400,
        'excerpt-unreadable',
        `refused a Pick whose ${given.kind} excerpt is not text.`,
      )
    }
    const captured = given.captured
    if (captured !== undefined && !isFinite(captured)) {
      return refuse(
        400,
        'excerpt-unreadable',
        `refused a Pick whose ${given.kind} excerpt does not say how much was ` +
          'captured in a number.',
      )
    }
    excerpts.push({
      kind: given.kind,
      text: given.text,
      ...(captured === undefined ? {} : { captured: captured as number }),
    })
  }
  return { ok: true, value: excerpts }
}

/**
 * Which redaction rules the page reports having applied. A reason this server
 * has no sentence for is refused rather than dropped: a redaction nobody is told
 * about is exactly the silence §21 forbids.
 */
function parseRedactions(value: unknown): Parsed<string[]> {
  if (value === undefined || value === null) return { ok: true, value: [] }
  if (!Array.isArray(value)) {
    return refuse(
      400,
      'redaction-unreadable',
      'refused a Pick whose redactions are not a list.',
    )
  }
  for (const reason of value) {
    if (!isText(reason) || !REDACTION_REASONS.includes(reason)) {
      return refuse(
        400,
        'redaction-unreadable',
        `refused a Pick naming "${String(reason)}" as a redaction. This dev ` +
          `server states ${REDACTION_REASONS.join(' and ')}, and will not repeat ` +
          'a reason it has no words for.',
      )
    }
  }
  return { ok: true, value: value as string[] }
}

function parseTarget(value: unknown): Parsed<Target | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !isFinite(value.pid)) {
    return refuse(
      400,
      'target-unreadable',
      'refused a Pick whose target names no sessionId and pid. A Pick is addressed ' +
        'to exactly one session, or to none.',
    )
  }
  return { ok: true, value: { sessionId: value.sessionId, pid: value.pid as number } }
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}
