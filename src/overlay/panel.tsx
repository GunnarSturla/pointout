// The Panel (spec §7): the surface a Pick opens, where the Note is written, the
// Target is shown and chosen, and the Pick's outcome is read. One Panel per
// Pick, and never modal: a plain click anywhere else is the developer using
// their app.
//
// Element-anchored by `placement.ts`: it opens beside its element, never partly
// off-screen, and then rides with the element wherever the page takes it. Native
// CSS anchor positioning is not an option here and never will be: anchor names
// are tree-scoped and cannot cross a shadow boundary by spec (§3).

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import { NOTE_MAX_CHARACTERS } from '../wire.js'
import type { NamedTarget, PickBody } from '../wire.js'
import {
  preselect,
  readSessions,
  rememberTarget,
  rememberedTarget,
  sendPick,
} from './client.js'
import type { Sessions } from './client.js'
import { viewportBox } from './deep-element.js'
import { inViewport, offsetFrom, placeBeside, ride } from './placement.js'
import type { Position, Size } from './placement.js'
import type { Reflow } from './reflow.js'
import { partProps } from './root.js'
import { TargetChoices, TargetRow, sessionsState } from './target-row.js'
import type { Offer } from './target-row.js'
import { watchTick } from './tick.js'
import * as words from './words.js'

/** Spec §7's two labels. A Pick with no Note asks the agent to stand by. */
const STAND_BY = 'Locate & stand by'
const SEND = 'Send'
/** The third: the button the re-resolve question relabels in place (spec §14). */
const CONFIRM = 'Confirm'

/**
 * Spec §5: the picked element unmounted while its Panel was open. Both halves
 * are said, because the second is the surprising one — the Pick is about a state
 * that has ended, and that is precisely when it is worth sending (user story 25).
 */
const ELEMENT_GONE = 'This element is gone from the page. The pick still sends.'

/** Spec §7: "a counter appears past about 3,500 characters". */
const COUNTER_FROM = 3500

/** The Pointer half of a Pick's body: everything but what the developer writes and chooses. */
export type PointerInputs = Omit<PickBody, 'note' | 'target'>

export interface PanelProps {
  /** The page's own window: the tick runs on it, and it owns `localStorage`. */
  view: Window
  reflow: Reflow
  /** The picked element the Panel anchors to. A move (spec §7) replaces it. */
  element: Element
  /**
   * The element has left the page (spec §5, user story 25). The Panel says so
   * and stops following it; the Pick stays sendable, because a request about a
   * transient state is not lost because the state ended.
   */
  gone: boolean
  /** The Pointer half of the body, measured at send time. */
  pointer(): PointerInputs
  /** Told once, when this Panel's Pick has been accepted by the dev server. */
  onSubmitted(pick: { pickId: string; targetName: string | null }): void
}

/** What the Panel says under the footer once a Send has been answered. */
interface Status {
  text: string
  refused: boolean
  /** The server's own line beside a plain confirmation, when it had one. */
  extra: string | null
}

export const Panel = memo(function Panel({
  view,
  reflow,
  element,
  gone,
  pointer,
  onSubmitted,
}: PanelProps) {
  const [note, setNote] = useState('')
  const [sessions, setSessions] = useState<Sessions | null>(null)
  const [unreadable, setUnreadable] = useState<string | null>(null)
  const [chosen, setChosen] = useState<NamedTarget | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [offer, setOffer] = useState<Offer | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [trimmed, setTrimmed] = useState<string | null>(null)

  const { choosable, noSession } = sessionsState(sessions)
  const panel = usePlacement(element, gone, view, reflow)

  // Spec §14: read at pick time, then on the Overlay's one tick while this Panel
  // is open. A Panel that is closed reads nothing, and an idle page never asks.
  // The Target is kept honest on every read: one that is no longer a Candidate
  // is replaced by whatever the chain yields now — visibly, in the row, while
  // the developer is still writing. At Send the server re-resolves again, and
  // there the developer is asked.
  useEffect(() => {
    let open = true
    const refresh = async () => {
      const read = await readSessions()
      if (!open) return
      if (!read.ok) {
        setUnreadable(read.reason)
        setSessions(null)
        return
      }
      setUnreadable(null)
      setSessions(read.sessions)
      const live = read.sessions.candidates
      setChosen((previous) => {
        const stillACandidate =
          previous !== null &&
          live.some(
            (candidate) =>
              candidate.sessionId === previous.sessionId &&
              candidate.pid === previous.pid,
          )
        if (stillACandidate) return previous
        const next = preselect(live, rememberedTarget(view))
        return next ? { sessionId: next.sessionId, pid: next.pid, name: next.name } : null
      })
    }
    void refresh()
    const stop = watchTick(view, () => void refresh())
    return () => {
      open = false
      stop()
    }
  }, [view])

  // The textarea owns the Note; `note` mirrors it for the label and the counter.
  // It is read off the element's own `input` event rather than React's
  // `onChange`: React ignores an `input` event for a value it has already seen
  // written to the element, and a Note put into the textarea by anything other
  // than keystrokes — a script, an extension, a test driver — still counts. And
  // Send reads the element, not the mirror, because a mirror set from outside
  // React's own events is a render behind the last few fast keystrokes. The
  // element is uncontrolled for the same reasons, and when the zero-state morph
  // below re-mounts it, the text it held is put back.
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const written = useRef('')
  const noteField = useCallback((field: HTMLTextAreaElement | null) => {
    textarea.current = field
    if (!field) return
    field.value = written.current
    const read = () => {
      written.current = field.value
      setNote(field.value)
    }
    field.addEventListener('input', read)
    return () => {
      field.removeEventListener('input', read)
      textarea.current = null
    }
  }, [])

  // Spec §7: auto-focus on the Panel's own opening, and never again — with one
  // exception. When the zero-Candidate message morphs back into the input, the
  // late-arriving input takes focus only when nothing has claimed it: an app
  // field, or the Overlay's own chrome, counts as claimed, because a developer
  // who moved is a developer who is somewhere else.
  useEffect(() => {
    textarea.current?.focus()
  }, [])
  const wasNoSession = useRef(false)
  useEffect(() => {
    const morphedBack = wasNoSession.current && !noSession
    wasNoSession.current = noSession
    const field = textarea.current
    if (!morphedBack || !field) return
    const active = field.ownerDocument.activeElement
    const idle =
      active === null ||
      active === field.ownerDocument.body ||
      active === field.ownerDocument.documentElement
    if (idle) field.focus()
  }, [noSession])

  // Spec §11's Note cap, the client half, counted in code points like the
  // server's. Send is off *at* the cap, one character stricter than the server,
  // so a Note the Overlay let through is never one the server rejects.
  const noteLength = [...note].length
  const overCap = noteLength >= NOTE_MAX_CHARACTERS

  const send = async () => {
    if (sent || sending) return
    const text = textarea.current?.value ?? written.current
    let target = chosen
    if (offer) {
      // Confirmed, in place: the developer was asked and answered (spec §14).
      target = offer.replacement
      setChosen(target)
      rememberTarget(view, target.sessionId)
      setOffer(null)
    } else if (
      [...text].length >= NOTE_MAX_CHARACTERS ||
      noSession ||
      (choosable && !chosen)
    ) {
      return
    }

    setSending(true)
    const body: PickBody = {
      ...pointer(),
      // An empty Note is no Note at all: a Pick without one is meaningful
      // rather than degenerate (`CONTEXT.md`), and the payload says so.
      note: text.length > 0 ? text : null,
      target: target ? { sessionId: target.sessionId, pid: target.pid } : null,
    }
    const outcome = await sendPick(body)
    setSending(false)

    if (!outcome.ok) {
      if (outcome.replacement) {
        // The Target left between naming and sending. It is named, the one that
        // would take it is named, and nothing has been sent (spec §21).
        setOffer({ left: target?.name ?? null, replacement: outcome.replacement })
        return
      }
      // Fail closed, say so out loud (spec §21): the server's own reason, at the
      // point it happened, with the Note untouched so nothing written is lost.
      setStatus({ text: outcome.reason, refused: true, extra: null })
      return
    }

    // A 200 that went nowhere is not silent either: the server says why, and so
    // does the Panel, beside the plain confirmation. What the 32 KiB cap took
    // out of the Excerpts is one quiet line — information, not a warning: the
    // Pick was accepted and the Note travelled whole (spec §7, §13).
    setSent(true)
    setStatus({ text: 'Sent', refused: false, extra: outcome.reason ?? null })
    setTrimmed(outcome.trimmed ?? null)
    // The Pick now rests in the Stack, where it says what becomes of it. This
    // Panel stays open until the developer makes another Pick (spec §7).
    onSubmitted({ pickId: outcome.pickId, targetName: target?.name ?? null })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // `Shift+Enter` is a newline, which is the textarea's own behaviour: it is
    // left alone rather than re-implemented.
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  }

  const choose = useCallback(
    (candidate: { sessionId: string; pid: number; name: string }) => {
      setChosen({
        sessionId: candidate.sessionId,
        pid: candidate.pid,
        name: candidate.name,
      })
      rememberTarget(view, candidate.sessionId)
      setExpanded(false)
    },
    [view],
  )
  const toggle = useCallback(() => setExpanded((was) => !was), [])

  const targetRow = {
    sessions,
    unreadable,
    chosen,
    expanded,
    offer,
    onToggle: toggle,
    onChoose: choose,
  }
  const label = offer ? CONFIRM : note.length > 0 ? SEND : STAND_BY
  const disabled =
    sending || sent || overCap || (!offer && (noSession || (choosable && !chosen)))

  return (
    <div ref={panel} {...partProps('panel')}>
      {noSession ? (
        // The two zero states differ in shape, and this is the shape (spec §7):
        // no session at all replaces the input with the message.
        <div {...partProps('empty')}>{words.NO_SESSION}</div>
      ) : (
        <textarea
          ref={noteField}
          {...partProps('note')}
          rows={3}
          placeholder="What about this element?"
          onKeyDown={onKeyDown}
        />
      )}
      {!noSession && noteLength >= COUNTER_FROM && (
        // The counter (spec §7): absent until the Note is long enough to be
        // worth watching, and at the cap it is the reason Send is off — so it
        // says the count, which is what the developer has to act on.
        <div {...partProps('counter')} data-over={overCap ? '' : undefined}>
          {overCap
            ? `${noteLength} / ${NOTE_MAX_CHARACTERS} — too long to send`
            : `${noteLength} / ${NOTE_MAX_CHARACTERS}`}
        </div>
      )}
      <TargetChoices {...targetRow} />
      {gone && <div {...partProps('gone')}>{ELEMENT_GONE}</div>}
      <div {...partProps('footer')}>
        <TargetRow {...targetRow} />
        {offer && (
          // Cancelling sends nothing: the Pick stays where it is, unaddressed
          // and unsent, and the developer chooses again.
          <button type="button" {...partProps('cancel')} onClick={() => setOffer(null)}>
            Cancel
          </button>
        )}
        <button
          type="button"
          {...partProps('send')}
          disabled={disabled}
          onClick={() => void send()}
        >
          {label}
        </button>
      </div>
      {status && (
        <div {...partProps('status')} data-refused={status.refused ? '' : undefined}>
          {status.text}
        </div>
      )}
      {status?.extra && <div {...partProps('status-reason')}>{status.extra}</div>}
      {trimmed && <div {...partProps('trimmed')}>{trimmed}</div>}
    </div>
  )
})

/**
 * Spec §7 asks for two things that pull opposite ways: the Panel never opens
 * partly off-screen, and it rides off-screen with its element when the
 * developer scrolls. So the opening is placed and shifted into the viewport,
 * and every reflow after it keeps the offset that opening chose — which is what
 * makes the Panel travel with the element instead of sticking to the edge. A
 * move (spec §7) is a fresh opening on the new element.
 */
function usePlacement(
  element: Element,
  gone: boolean,
  view: Window,
  reflow: Reflow,
): RefObject<HTMLDivElement | null> {
  const panel = useRef<HTMLDivElement | null>(null)
  const offset = useRef<Position | null>(null)

  // Placed before the first paint, and again as if just opened when the Pick
  // moves to another element.
  useLayoutEffect(() => {
    if (panel.current) offset.current = openBeside(panel.current, element, view)
  }, [element, view])

  // Following the element, for as long as it is on the page. A detached element
  // measures at the page's top-left corner, and a Panel that jumped there is
  // exactly the unexpected movement spec §5 forbids: a Panel whose element has
  // gone stays where the developer left it, saying so.
  useEffect(() => {
    if (gone) return
    return reflow.subscribe(() => {
      if (panel.current && offset.current) follow(panel.current, element, offset.current)
    })
  }, [element, gone, reflow])

  // Its own size changing — rows expanding, a status line arriving — can push
  // it off-screen. While the element is in view the Panel is placed again, whole;
  // once the element has scrolled away it only follows, so a Panel that has
  // ridden off-screen is not dragged back by its own growth.
  useEffect(() => {
    const node = panel.current
    if (!node || gone) return
    const observer = new ResizeObserver(() => {
      if (!element.isConnected) return
      if (inViewport(viewportBox(element), viewportOf(view))) {
        offset.current = openBeside(node, element, view)
      } else if (offset.current) {
        follow(node, element, offset.current)
      }
    })
    observer.observe(node)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, gone, view])

  return panel
}

function viewportOf(view: Window): Size {
  return { width: view.innerWidth, height: view.innerHeight }
}

/** The opening placement, applied. Answers the offset that riding then keeps. */
function openBeside(node: HTMLElement, element: Element, view: Window): Position {
  const anchor = viewportBox(element)
  const { width, height } = node.getBoundingClientRect()
  const position = placeBeside(anchor, { width, height }, viewportOf(view))
  moveTo(node, position)
  return offsetFrom(anchor, position)
}

function follow(node: HTMLElement, element: Element, offset: Position): void {
  if (!element.isConnected) return
  moveTo(node, ride(viewportBox(element), offset))
}

function moveTo(node: HTMLElement, position: Position): void {
  node.style.left = `${position.left}px`
  node.style.top = `${position.top}px`
}
