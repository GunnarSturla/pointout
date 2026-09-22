// The Panel (spec §7): the surface a Pick opens, where the Note is written, the
// Target is shown and chosen, and the Pick's outcome is read.
//
// Element-anchored through Floating UI with `flip`, `shift` and `autoUpdate`.
// Native CSS anchor positioning is not an option here and never will be: anchor
// names are tree-scoped and cannot cross a shadow boundary by spec (§3).
//
// Ticket 04 built the first journey through it; ticket 10 the Target row, the
// rows it expands into, the two zero states and the re-resolve at Send. Ticket
// 12 the state rules around it — what a submitted Panel is, what moving a Pick
// does to it, and how it rides off-screen and is found again. The character
// counter and the cap are ticket 07.

import {
  autoUpdate,
  computePosition,
  flip,
  limitShift,
  offset,
  shift,
} from '@floating-ui/dom'
import { viewportBox } from './deep-element.js'
import {
  preselect,
  rememberTarget,
  rememberedTarget,
  readSessions,
  sendPick,
} from './client.js'
import type { Candidate, NamedTarget, PickBody, Sessions } from './client.js'
import { part } from './root.js'
import { watchTick } from './tick.js'
import {
  APPROVE_IN_TERMINAL,
  CANT_SEE_SESSIONS,
  CHOOSE_A_SESSION,
  NO_SESSION,
  blockedOnPermission,
  goneAskingFor,
  idleFor,
  targetLine,
} from './words.js'

/** Spec §7: "about 380px wide", advisory — and the gap to the element. */
const ELEMENT_GAP = 8
const VIEWPORT_PADDING = 8

/** Spec §7's two labels. A Pick with no Note asks the agent to stand by. */
const STAND_BY = 'Locate & stand by'
const SEND = 'Send'
/** The third: the button the re-resolve question relabels in place (spec §14). */
const CONFIRM = 'Confirm'

/** The badge on the `CLAUDE_PID` match (spec §7). */
const STARTED_THIS_SERVER = 'started this dev server'

/**
 * Spec §5: the picked element unmounted while its Panel was open. Both halves
 * are said, because the second is the surprising one — the Pick is about a state
 * that has ended, and that is precisely when it is worth sending (user story 25).
 */
const ELEMENT_GONE = 'This element is gone from the page. The pick still sends.'

/**
 * Spec §11's Note cap, the client half of it (ticket 07). Written out rather
 * than imported: the server enforces the same number in `src/server/pick.ts`,
 * and neither half may be talked out of it by the other. The server refuses
 * *above* 4,000; Send is off *at* it, which is §7's rule and one character
 * stricter, so a Note the Overlay let through is never one the server rejects.
 */
const NOTE_MAX_CHARACTERS = 4000

/** Spec §7: "a counter appears past about 3,500 characters". */
const COUNTER_FROM = 3500

/** Everything the Panel needs from the Overlay around it. */
export interface PanelDeps {
  document: Document
  /** The page's own window: the tick runs on it, and it owns `localStorage`. */
  view: Window
  shadow: ShadowRoot
  /** The picked element the Panel anchors to. */
  element: Element
  /** The Pointer half of the body, measured at send time. */
  pointer(): Omit<PickBody, 'note' | 'target'>
  /** Told once, when this Panel's Pick has been accepted by the dev server. */
  submitted(pick: { pickId: string; targetName: string | null }): void
}

export interface Panel {
  close(): void
  /** True once this Pick has been sent. It is what Alt-click reads (spec §7). */
  sent(): boolean
  /**
   * The element this Panel is anchored to has left the page (spec §5, user
   * story 25). The Panel says so and stops following it; the Pick stays
   * sendable, because a request about a transient state is not lost because the
   * state ended.
   */
  elementGone(): void
  /**
   * Move the Pick to another element (spec §7): the Panel re-anchors, and the
   * Note the developer already wrote comes with it.
   */
  moveTo(element: Element): void
  /** The anchor has scrolled out of the viewport, and the Panel rode with it. */
  offScreen(): boolean
  /** Scroll the anchor back into view, which brings the Panel with it. */
  bringIntoView(): void
}

export function openPanel(deps: PanelDeps): Panel {
  const { document, view, shadow } = deps
  /** The element this Panel is anchored to. A move (spec §7) replaces it. */
  let element = deps.element

  const panel = part(document, 'div', 'panel')
  const note = part(document, 'textarea', 'note')
  note.rows = 3
  note.placeholder = 'What about this element?'

  /** Ticket 07: absent below `COUNTER_FROM`, and Send's reason at the cap. */
  const counter = part(document, 'div', 'counter')

  const footer = part(document, 'div', 'footer')
  const target = part(document, 'button', 'target')
  target.type = 'button'
  const primary = part(document, 'button', 'send')
  primary.type = 'button'
  primary.textContent = STAND_BY

  footer.append(target, primary)
  panel.append(note, footer)
  shadow.append(panel)

  /** What the last read said. Null until the first one answers, or it failed. */
  let sessions: Sessions | null = null
  /** A `/sessions` that could not be read at all, in the server's own words. */
  let unreadable: string | null = null
  let chosen: NamedTarget | null = null
  let expanded = false
  /** The re-resolve offer: what left, and what the chain yields instead. */
  let left: string | null = null
  let replacement: NamedTarget | null = null
  let sent = false
  let sending = false

  const candidates = (): Candidate[] => sessions?.candidates ?? []
  /** Expandable only when there is a choice to make (spec §7: no picker when degraded). */
  const choosable = (): boolean =>
    sessions !== null && !sessions.hookFloor && sessions.candidates.length > 0
  /** Zero Candidates: the input is replaced, and no Target is shown. */
  const noSession = (): boolean =>
    sessions !== null && !sessions.hookFloor && sessions.candidates.length === 0

  const say = (text: string, refused: boolean, extra?: string) => {
    for (const stale of panel.querySelectorAll(
      '[data-part="status"], [data-part="status-reason"]',
    )) {
      stale.remove()
    }
    const status = part(document, 'div', 'status')
    status.textContent = text
    if (refused) status.setAttribute('data-refused', '')
    panel.append(status)
    if (!extra) return
    const line = part(document, 'div', 'status-reason')
    line.textContent = extra
    panel.append(line)
  }

  /**
   * Focus is taken by the late-arriving input only when nothing has claimed it
   * (spec §7). Anything else — an app field, or the Overlay's own chrome, which
   * `activeElement` reports as the host — counts as claimed, because a developer
   * who moved is a developer who is somewhere else.
   */
  const focusIsIdle = (): boolean => {
    const active = document.activeElement
    return (
      active === null || active === document.body || active === document.documentElement
    )
  }

  /** The collapsed Target row: one line, plus the imperative when there is one. */
  const renderTargetRow = () => {
    // Zero Candidates shows no Target at all: there is nothing to name, and an
    // empty row would be a place to look for one (spec §7).
    if (noSession()) {
      target.remove()
      return
    }
    if (!target.isConnected) footer.prepend(target)

    target.replaceChildren()
    const line = part(document, 'span', 'target-line')

    if (replacement) {
      line.textContent = goneAskingFor(left ?? 'That session', replacement.name)
      target.append(line)
      return
    }
    if (unreadable) {
      line.textContent = unreadable
      target.append(line)
      return
    }
    if (sessions === null) return
    if (sessions.hookFloor) {
      line.textContent = CANT_SEE_SESSIONS
      target.append(line)
      return
    }
    if (!chosen) {
      // Step 4 of §14's chain: Send is off, and the row says why rather than
      // leaving a grey button to be puzzled over.
      line.textContent = CHOOSE_A_SESSION
      target.append(line)
      return
    }

    const live = candidates().find(
      (candidate) => candidate.sessionId === chosen?.sessionId,
    )
    if (live?.status === 'waiting') {
      line.textContent = blockedOnPermission(live.name)
      const action = part(document, 'span', 'target-action')
      action.textContent = APPROVE_IN_TERMINAL
      target.append(line, action)
      return
    }

    line.textContent = live
      ? targetLine(live.name, statusOf(live), live.waitingFor ?? undefined)
      : chosen.name
    target.append(line)
  }

  /** The rows the Target row expands into, inside the Panel and never a dialog. */
  const renderRows = () => {
    panel.querySelector('[data-part="targets"]')?.remove()
    if (!expanded || !choosable() || replacement) return

    const list = part(document, 'div', 'targets')
    for (const candidate of candidates()) {
      const row = part(document, 'button', 'target-row')
      row.type = 'button'
      if (candidate.sessionId === chosen?.sessionId) row.setAttribute('data-chosen', '')

      const name = part(document, 'span', 'row-name')
      name.textContent = candidate.name
      const status = part(document, 'span', 'row-status')
      status.textContent = candidate.status
      row.append(name, status)

      const stale = idleFor(candidate.statusUpdatedAt, Date.now())
      if (stale) {
        const idle = part(document, 'span', 'row-idle')
        idle.textContent = stale
        row.append(idle)
      }
      if (candidate.waitingFor) {
        // A `waiting` Candidate is flagged, never skipped (spec §14).
        const waiting = part(document, 'span', 'row-waiting')
        waiting.textContent = candidate.waitingFor
        row.append(waiting)
      }
      if (candidate.startedThisServer) {
        const badge = part(document, 'span', 'started-badge')
        badge.textContent = STARTED_THIS_SERVER
        row.append(badge)
      }

      row.addEventListener('click', () => {
        chosen = {
          sessionId: candidate.sessionId,
          pid: candidate.pid,
          name: candidate.name,
        }
        rememberTarget(view, candidate.sessionId)
        expanded = false
        render()
      })
      list.append(row)
    }
    footer.before(list)
  }

  /** The two zero states differ in shape, and this is the shape (spec §7). */
  const renderInput = () => {
    if (noSession()) {
      if (!note.isConnected) return
      note.remove()
      const empty = part(document, 'div', 'empty')
      empty.textContent = NO_SESSION
      panel.prepend(empty)
      return
    }

    const empty = panel.querySelector('[data-part="empty"]')
    if (!empty) return
    // The message morphs back into the input the moment a session appears, and
    // the input keeps whatever was typed before the sessions went away.
    empty.remove()
    panel.prepend(note)
    if (focusIsIdle()) note.focus()
  }

  /**
   * The counter (spec §7): absent until the Note is long enough to be worth
   * watching, and at the cap it is the reason Send is off — so it says the
   * count, which is what the developer has to act on.
   */
  const renderCounter = (length: number, overCap: boolean) => {
    if (length < COUNTER_FROM) {
      counter.remove()
      return
    }
    counter.textContent = overCap
      ? `${length} / ${NOTE_MAX_CHARACTERS} — too long to send`
      : `${length} / ${NOTE_MAX_CHARACTERS}`
    if (overCap) counter.setAttribute('data-over', '')
    else counter.removeAttribute('data-over')
    if (!counter.isConnected && note.isConnected) note.after(counter)
  }

  const render = () => {
    renderInput()
    renderTargetRow()
    renderRows()

    // Marked rather than disabled: a row with nothing to expand into is still
    // the line that says why, and a disabled button is not read by everything.
    if (choosable() && !replacement) target.setAttribute('data-expandable', '')
    else target.removeAttribute('data-expandable')

    // Ticket 07's half of §11's Note cap. Counted in **code points**, because
    // the server counts them that way (ticket 03) and two halves that counted
    // differently would disagree at the boundary.
    const noteLength = [...note.value].length
    const overCap = noteLength >= NOTE_MAX_CHARACTERS
    renderCounter(noteLength, overCap)

    primary.textContent = replacement ? CONFIRM : note.value.length > 0 ? SEND : STAND_BY
    primary.disabled =
      sending ||
      sent ||
      overCap ||
      (!replacement && (noSession() || (choosable() && !chosen)))

    const cancel = panel.querySelector('[data-part="cancel"]')
    if (replacement && !cancel) {
      const button = part(document, 'button', 'cancel')
      button.type = 'button'
      button.textContent = 'Cancel'
      // Cancelling sends nothing: the Pick stays where it is, unaddressed and
      // unsent, and the developer chooses again.
      button.addEventListener('click', () => {
        replacement = null
        left = null
        render()
      })
      primary.before(button)
    } else if (!replacement && cancel) {
      cancel.remove()
    }
  }

  const send = async () => {
    if (sent || sending) return
    if (replacement) {
      // Confirmed, in place: the developer was asked and answered (spec §14).
      chosen = replacement
      rememberTarget(view, replacement.sessionId)
      replacement = null
      left = null
    }
    if (primary.disabled) return

    sending = true
    render()

    const body: PickBody = {
      ...deps.pointer(),
      // An empty Note is no Note at all: a Pick without one is meaningful
      // rather than degenerate (`CONTEXT.md`), and the payload says so.
      note: note.value.length > 0 ? note.value : null,
      target: chosen ? { sessionId: chosen.sessionId, pid: chosen.pid } : null,
    }

    const outcome = await sendPick(body)
    sending = false
    if (!outcome.ok) {
      if (outcome.replacement) {
        // The Target left between naming and sending. It is named, the one that
        // would take it is named, and nothing has been sent (spec §21).
        left = chosen?.name ?? null
        replacement = outcome.replacement
        render()
        return
      }
      // Fail closed, say so out loud (spec §21): the server's own reason, at the
      // point it happened, with the Note untouched so nothing written is lost.
      render()
      say(outcome.reason, true)
      return
    }

    sent = true
    render()
    // A 200 that went nowhere is not silent either: the server says why, and so
    // does the Panel, beside the plain confirmation.
    say('Sent', false, outcome.reason)
    // What the 32 KiB cap took out of the Excerpts, as one quiet line —
    // information, not a warning: the Pick was accepted and the Note travelled
    // whole (spec §7, ticket 07).
    if (outcome.trimmed) {
      const trimmed = part(document, 'div', 'trimmed')
      trimmed.textContent = outcome.trimmed
      panel.append(trimmed)
    }
    // The Pick now rests in the Stack, where it says what becomes of it. This
    // Panel stays open until the developer makes another Pick (spec §7).
    deps.submitted({ pickId: outcome.pickId, targetName: chosen?.name ?? null })
  }

  note.addEventListener('input', render)
  note.addEventListener('keydown', (event: KeyboardEvent) => {
    // `Shift+Enter` is a newline, which is the textarea's own behaviour: it is
    // left alone rather than re-implemented.
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void send()
  })
  primary.addEventListener('click', () => void send())
  target.addEventListener('click', () => {
    // While the re-resolve question stands, the row is the question.
    if (!choosable() || replacement) return
    expanded = !expanded
    render()
  })

  /**
   * Spec §7 asks for two things that pull opposite ways: the Panel never opens
   * partly off-screen, and it rides off-screen with its element when the
   * developer scrolls. So the opening is shifted into the viewport unbounded,
   * and every placement after it is limited to the anchor — which is what makes
   * the Panel travel with the element instead of sticking to the edge.
   */
  let riding = false

  const reanchor = async () => {
    const { x, y } = await computePosition(element, panel, {
      strategy: 'fixed',
      placement: 'bottom-start',
      middleware: [
        offset(ELEMENT_GAP),
        flip({ padding: VIEWPORT_PADDING }),
        shift({
          padding: VIEWPORT_PADDING,
          ...(riding ? { limiter: limitShift() } : {}),
        }),
      ],
    })
    panel.style.left = `${x}px`
    panel.style.top = `${y}px`
    riding = true
  }

  let stopFollowing = autoUpdate(element, panel, () => void reanchor())

  /**
   * Read the Candidates, and keep the Target honest: one that is no longer a
   * Candidate is replaced by whatever the chain yields now — visibly, in the
   * row, while the developer is still writing. At Send the server re-resolves
   * again, and there the developer is asked (spec §14).
   */
  const refresh = async () => {
    const read = await readSessions()
    if (!panel.isConnected) return
    if (!read.ok) {
      unreadable = read.reason
      sessions = null
      render()
      return
    }

    unreadable = null
    sessions = read.sessions
    const live = read.sessions.candidates
    const stillACandidate =
      chosen !== null &&
      live.some(
        (candidate) =>
          candidate.sessionId === chosen?.sessionId && candidate.pid === chosen.pid,
      )
    if (!stillACandidate) chosen = preselect(live, rememberedTarget(view))
    render()
  }

  // Spec §14: read at pick time, then on the Overlay's one tick while this Panel
  // is open. A Panel that is closed reads nothing, and an idle page never asks.
  const stopTicking = watchTick(view, () => void refresh())
  void refresh()

  // Spec §7: auto-focus on the Panel's own opening, and never again. The one
  // exception is the zero-Candidate morph above, and it asks first.
  note.focus()

  return {
    close() {
      stopTicking()
      stopFollowing()
      panel.remove()
    },

    sent: () => sent,

    elementGone() {
      if (panel.querySelector('[data-part="gone"]')) return
      // There is nothing left to follow: Floating UI measures a detached element
      // at the page's top-left corner, and a Panel that jumped there would be
      // exactly the unexpected movement spec §5 forbids. It stays where the
      // developer left it, saying what happened.
      stopFollowing()
      const line = part(document, 'div', 'gone')
      line.textContent = ELEMENT_GONE
      footer.before(line)
    },

    moveTo(next) {
      element = next
      stopFollowing()
      // Placed as if it had just opened: a moved Pick is still a Pick that has
      // only now appeared here, and §7 says it may not land partly off-screen.
      riding = false
      stopFollowing = autoUpdate(element, panel, () => void reanchor())
    },

    offScreen() {
      // An element that has left the page has not ridden anywhere, and there is
      // nothing to bring back into view (ticket 09).
      if (!element.isConnected) return false
      const rect = viewportBox(element)
      return (
        rect.top + rect.height <= 0 ||
        rect.top >= view.innerHeight ||
        rect.left + rect.width <= 0 ||
        rect.left >= view.innerWidth
      )
    },

    bringIntoView() {
      element.scrollIntoView({ block: 'center', inline: 'nearest' })
    },
  }
}

/** *idle for Nd* stands in for the status word only where it can be true. */
function statusOf(candidate: Candidate): string {
  if (candidate.status !== 'idle') return candidate.status
  return idleFor(candidate.statusUpdatedAt, Date.now()) ?? candidate.status
}
