import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Locator, Page, Route } from '@playwright/test'
import { apartFromDrains } from '../harness/drain-lock.js'
import { repoRoot } from '../harness/paths.js'
import { replyTo } from '../harness/session-socket.js'

// Seam 2: Withdraw, as a developer meets it on a minimized Panel
// (`CONTEXT.md`: Withdraw; spec §8, §20, §21; overlay-polish ticket 10). The ×
// is on a Pick exactly where the dev server would take it back, the DELETE is
// the real server's, and what it answers is said on the Panel before it goes:
// a write cannot be recalled, and a Panel that went quietly would imply it had
// been.
//
// Picks go wrong here the way they do for real. An idle notice at the real
// reply address offers one back (report-back.spec.ts); leaving it for the next
// prompt requeues it; a Receipt fails one (receipts.spec.ts). The page's clock
// is the one these journeys move (`page.clock`); the server's is left alone.
//
// Every string is written out rather than imported: the frame fields are the
// harness's, the words are the Overlay's, the part names are its contract
// (docs/agents/testing.md).

const FRAMES_LOG_ENV = 'SEAM2_FRAMES_LOG'
/** The session only report-back journeys address, and end the turns of. */
const REPORT_BACK_FRAMES_LOG_ENV = 'SEAM2_REPORT_BACK_FRAMES_LOG'
const DISCOVERY_ENTRY_ENV = 'SEAM2_DISCOVERY_ENTRY'

const TARGET_NAME = 'seam 2 report-back session'

const STATUS = '**/__agent/status'
const WITHDRAW = '**/__agent/pick/*'
const DRAIN = '/__agent/drain'
const PICKED = '[data-fixture="card-heading"]'

const HOST = 'vite-agent-inspect'
const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const NOTE = '[data-part="note"]'
const TARGET = '[data-part="target"]'
const TARGETS = '[data-part="targets"]'
const TARGET_ROW = '[data-part="target-row"]'
const MINIMIZED = '[data-part="minimized"]'
const MINIMIZED_LINE = '[data-part="minimized-line"]'
const LIGHT = '[data-part="light"]'
const EXPANDED = '[data-part="expanded"]'
const OFFER = '[data-part="offer"]'
const LEAVE = '[data-part="offer-leave"]'
const WITHDRAW_BUTTON = '[data-part="minimized-withdraw"]'
const WITHDRAWN = '[data-part="minimized-withdrawn"]'
const REFUSAL = '[data-part="minimized-refusal"]'

/** The ×'s name: what a screen reader announces, and what the pointer's title says. */
const WITHDRAW_NAME = 'Withdraw this pick'
const alreadySentTo = (name: string) => `Already sent to ${name} — it may still act on it`
const ALREADY_DELIVERED = 'Already delivered to a session — it may still act on it'

const SENT = 'Sent'
const NO_ACK = 'No acknowledgement yet'
const NEVER_PICKED_UP = 'Never picked up'
const WAITING_FOR_PROMPT = 'Waiting for the next prompt'
const FAILED = 'Failed'

/** Longer than the Panel says an already-sent Withdraw for, and its copy's fade. */
const SAID_FOR_MS = 6000

function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
}

function framesIn(env: string): Array<Record<string, unknown>> {
  const log = process.env[env]
  if (!log) throw new Error(`${env} is unset: seam 2's globalSetup did not run`)
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const contentOf = (frame: Record<string, unknown>) =>
  (frame.message as { content: string }).content

interface Delivered {
  pickId: string
  from: string
  /** The idle subscription written after it, when there was one. */
  subscription: string | null
  content: string
}

/** The `user` frame carrying this token, and the idle subscription after it. */
async function deliveredIn(env: string, token: string): Promise<Delivered> {
  let found: Delivered | undefined
  await expect
    .poll(
      () => {
        const frames = framesIn(env)
        const at = frames.findIndex(
          (frame) => frame.type === 'user' && contentOf(frame).includes(token),
        )
        const user = frames[at]
        if (at === -1 || !user) return false
        const subscription = frames
          .slice(at + 1)
          .find((frame) => frame.action === 'notify_when_idle')
        found = {
          pickId: String(user.msg_id),
          from: String(user.from),
          subscription: subscription ? String(subscription.msg_id) : null,
          content: contentOf(user),
        }
        return env !== REPORT_BACK_FRAMES_LOG_ENV || found.subscription !== null
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return found!
}

/** The Target finished a turn after the write, and said so at the reply address. */
async function turnEnded(delivered: Delivered): Promise<void> {
  const reply = await replyTo(delivered.from)
  await reply.send({
    type: 'control',
    action: 'peer_idle_notice',
    orig_msg_id: delivered.subscription,
    state: 'idle',
    finished_at: Date.now() + 1000,
    from_mode: 'prompting',
    msgV: 1,
    msg_id: `idle-${Math.random().toString(16).slice(2)}`,
  })
  await reply.close()
}

/** The harness said it would not deliver the write: a real Receipt fails the Pick. */
async function dropped(delivered: Delivered): Promise<void> {
  const reply = await replyTo(delivered.from)
  await reply.send({
    type: 'control',
    action: 'peer_message_status',
    orig_msg_id: delivered.pickId,
    from: 'uds:/tmp/cc-socks/400001.sock',
    status: 'dropped',
    drop_reason: 'duplicate',
    msgV: 1,
    msg_id: `receipt-${Math.random().toString(16).slice(2)}`,
  })
  await reply.close()
}

async function open(page: Page, token: string): Promise<void> {
  await page.clock.install()
  await page.goto(`/?probe=${token}`)
  await expect(page.locator(PICKER)).toBeVisible()
}

async function arm(page: Page): Promise<void> {
  const picker = page.locator(PICKER)
  await picker.click()
  if ((await picker.getAttribute('data-armed')) === null) await picker.click()
  await expect(picker).toHaveAttribute('data-armed', '')
}

async function pick(page: Page, selector: string): Promise<void> {
  // Every fixture in the example app sits below the fold.
  await page.locator(selector).first().scrollIntoViewIfNeeded()
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT).first()).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
}

/** Arm, pick, write and send; `to` names another Target in the Panel's list. */
async function send(page: Page, note: string, to?: string): Promise<void> {
  await arm(page)
  await pick(page, PICKED)
  if (to) {
    await page.locator(TARGET).click()
    await page
      .locator(`${PANEL} ${TARGETS} ${TARGET_ROW}`)
      .filter({ hasText: to })
      .click()
    await page.locator(NOTE).click()
  }
  await page.keyboard.type(note)
  await page.keyboard.press('Enter')
  await expect(page.locator(MINIMIZED).filter({ hasText: note })).toHaveCount(1)
  await expect(page.locator(PANEL)).toHaveCount(0)
}

/** No Panel, not armed, and the pointer nowhere near the Stack. */
async function putAway(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.mouse.move(4, 4)
  await expect(page.locator(PANEL)).toHaveCount(0)
}

const minimizedOf = (page: Page, pickId: string) =>
  page.locator(`${MINIMIZED}[data-pick="${pickId}"]`)

/** A Pick written to the report-back session, whose turn then ended with no ack. */
async function offered(page: Page, token: string): Promise<Delivered> {
  await open(page, token)
  await send(page, `withdraw ${token}`, TARGET_NAME)
  const delivered = await deliveredIn(REPORT_BACK_FRAMES_LOG_ENV, token)
  await putAway(page)
  await turnEnded(delivered)
  await expect(minimizedOf(page, delivered.pickId).locator(OFFER)).toBeVisible()
  return delivered
}

/** A Pick written to the default session, which a Receipt then failed. */
async function failed(page: Page, token: string): Promise<Delivered> {
  await open(page, token)
  await send(page, `withdraw ${token}`)
  const delivered = await deliveredIn(FRAMES_LOG_ENV, token)
  await putAway(page)
  await dropped(delivered)
  await expect(minimizedOf(page, delivered.pickId).locator(LIGHT)).toHaveAttribute(
    'title',
    FAILED,
  )
  return delivered
}

async function statusRow(
  page: Page,
  pickId: string,
): Promise<{ state: string } | undefined> {
  const response = await page.request.get('/__agent/status')
  const { picks } = (await response.json()) as {
    picks: Array<{ pickId: string; state: string }>
  }
  return picks.find((row) => row.pickId === pickId)
}

/** The next answer the page's own poll gets: what it drew after is that poll's. */
async function nextPoll(page: Page): Promise<void> {
  const polled = page.waitForResponse((response) =>
    response.url().includes('/__agent/status'),
  )
  await page.clock.runFor(2000)
  await polled
}

/** The Pick's own ack URL, off the body its session received. */
function ackUrl(delivered: Delivered): string {
  const found = /^\s*ack\s+(\S+)$/m.exec(delivered.content)
  if (!found?.[1]) throw new Error(`pick ${delivered.pickId} printed no ack url`)
  return found[1]
}

/** Stop the page's clock just ahead of now, so only the test moves it. */
async function pause(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 500)
}

/** Which of the Overlay's parts has focus, by name. */
function focusedPart(page: Page): Promise<string | null> {
  return page.evaluate(
    (tag) =>
      document.querySelector(tag)?.shadowRoot?.activeElement?.getAttribute('data-part') ??
      null,
    HOST,
  )
}

/** What the drain would hand the next prompt, read the way the hook reads it. */
async function drain(page: Page): Promise<{ text: string }> {
  const entry = process.env[DISCOVERY_ENTRY_ENV]
  if (!entry) throw new Error(`${DISCOVERY_ENTRY_ENV} is unset: globalSetup did not run`)
  const { secret } = JSON.parse(readFileSync(entry, 'utf8')) as { secret: string }
  const response = await page.request.post(DRAIN, {
    data: { cwd: repoRoot, secret, event: 'UserPromptSubmit', budget: 9000 },
  })
  expect(response.status()).toBe(200)
  return (await response.json()) as { text: string }
}

/**
 * It is gone from the page and from the server. The page polls only while
 * something is outstanding, so a journey that wants a poll after it keeps
 * another Pick in the Stack and waits for one itself.
 */
async function goneForGood(page: Page, minimized: Locator, pickId: string) {
  await expect(minimized).toHaveCount(0)
  await page.clock.runFor(2000)
  await expect(minimized).toHaveCount(0)
  expect(await statusRow(page, pickId)).toBeUndefined()
}

test('a Pick nobody picked up is withdrawn, says who already has it, and leaves', async ({
  page,
}) => {
  const delivered = await offered(page, probe('offered'))
  const minimized = minimizedOf(page, delivered.pickId)
  await expect(minimized.locator(LIGHT)).toHaveAttribute('title', NEVER_PICKED_UP)

  const withdraw = minimized.locator(WITHDRAW_BUTTON)
  await expect(withdraw).toHaveAccessibleName(WITHDRAW_NAME)
  await withdraw.click()

  // Said in place, and the × is gone with what it would have done.
  await expect(minimized.locator(WITHDRAWN)).toHaveText(alreadySentTo(TARGET_NAME))
  await expect(minimized.locator(WITHDRAW_BUTTON)).toHaveCount(0)
  await expect(minimized.locator(OFFER)).toHaveCount(0)
  // Pressing it was not pressing the line.
  await expect(page.locator(EXPANDED)).toHaveCount(0)
  await expect(minimized.locator(MINIMIZED_LINE)).toHaveAttribute(
    'aria-expanded',
    'false',
  )

  await page.clock.runFor(SAID_FOR_MS)
  await goneForGood(page, minimized, delivered.pickId)
})

test('× on an unknown Pick says it was already sent to its Target, and it does not come back', async ({
  page,
}) => {
  // `unknown` is the server's minute to call (seam 1 makes it pass). The Pick
  // underneath is real, written and offered back, so the server withdraws it;
  // only the page is told the state it would have had a minute later.
  const token = probe('unknown')
  await page.route(STATUS, async (route: Route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { picks: Array<Record<string, unknown>> }
    for (const row of body.picks) {
      if ((row.reportBack as { state?: string } | null)?.state === 'offered') {
        row.state = 'unknown'
        row.reportBack = null
      }
    }
    await route.fulfill({ response, json: body })
  })
  try {
    await open(page, token)
    await send(page, `withdraw ${token}`, TARGET_NAME)
    const delivered = await deliveredIn(REPORT_BACK_FRAMES_LOG_ENV, token)
    await putAway(page)
    await turnEnded(delivered)
    const minimized = minimizedOf(page, delivered.pickId)
    await expect(minimized.locator(LIGHT)).toHaveAttribute('title', NO_ACK)
    // A second Pick, only sent, keeps the Stack out and the page polling.
    await send(page, `outstanding ${token}`)
    await putAway(page)

    await minimized.locator(WITHDRAW_BUTTON).click()
    await expect(minimized.locator(WITHDRAWN)).toHaveText(alreadySentTo(TARGET_NAME))
    await page.clock.runFor(SAID_FOR_MS)
    await goneForGood(page, minimized, delivered.pickId)
    await nextPoll(page)
    await expect(minimized).toHaveCount(0)
    await expect(page.locator(MINIMIZED)).toHaveCount(1)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

test('× on a queued Pick takes it out of the queue, so the drain carries nothing', async ({
  page,
}) => {
  const token = probe('queued')
  await apartFromDrains(async () => {
    const delivered = await offered(page, token)
    const minimized = minimizedOf(page, delivered.pickId)
    // Left for whoever is prompted next: it is queued again.
    await minimized.locator(LEAVE).click()
    await expect(minimized.locator(LIGHT)).toHaveAttribute('title', WAITING_FOR_PROMPT)
    expect((await statusRow(page, delivered.pickId))?.state).toBe('queued-unaddressed')

    await minimized.locator(WITHDRAW_BUTTON).click()
    // Queued again, but the session was written to before: that is not undone.
    await expect(minimized.locator(WITHDRAWN)).toHaveText(alreadySentTo(TARGET_NAME))
    await page.clock.runFor(SAID_FOR_MS)
    await goneForGood(page, minimized, delivered.pickId)

    expect((await drain(page)).text).not.toContain(token)
  })
})

test('a failed Pick nobody had is withdrawn from the keyboard, and just leaves', async ({
  page,
  browserName,
}) => {
  const delivered = await failed(page, probe('failed'))
  const minimized = minimizedOf(page, delivered.pickId)

  // The line, then the ×: two stops, and the × has the keyboard's ring.
  await minimized.locator(MINIMIZED_LINE).focus()
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab')
  expect(await focusedPart(page)).toBe('minimized-withdraw')
  const ring = await minimized
    .locator(WITHDRAW_BUTTON)
    .evaluate((withdraw) => getComputedStyle(withdraw).outlineStyle)
  expect(ring).toBe('solid')

  await page.keyboard.press('Enter')
  // Nothing was written that a session could act on, so there is nothing to say.
  await expect(minimized).toHaveCount(0)
  await expect(page.locator(WITHDRAWN)).toHaveCount(0)
  await expect(page.locator(EXPANDED)).toHaveCount(0)
  await goneForGood(page, minimized, delivered.pickId)
})

test('pressing × keeps the Note being written in focus', async ({ page }) => {
  const delivered = await failed(page, probe('focus'))
  await arm(page)
  await pick(page, PICKED)
  await page.keyboard.type('still writing')
  expect(await focusedPart(page)).toBe('note')

  await minimizedOf(page, delivered.pickId).locator(WITHDRAW_BUTTON).click()
  await expect(minimizedOf(page, delivered.pickId)).toHaveCount(0)
  expect(await focusedPart(page)).toBe('note')
  await expect(page.locator(NOTE)).toHaveValue('still writing')
})

test('a Pick that is only sent, or being worked on, has no ×', async ({ page }) => {
  const token = probe('sent')
  await open(page, token)
  await send(page, `withdraw ${token}`)
  const delivered = await deliveredIn(FRAMES_LOG_ENV, token)
  const minimized = minimizedOf(page, delivered.pickId)
  await putAway(page)
  await nextPoll(page)
  await expect(minimized.locator(LIGHT)).toHaveAttribute('title', SENT)
  await expect(minimized.locator(WITHDRAW_BUTTON)).toHaveCount(0)

  await page.request.post(ackUrl(delivered))
  await expect(minimized.locator(LIGHT)).toHaveAttribute('title', 'Working')
  await expect(minimized.locator(WITHDRAW_BUTTON)).toHaveCount(0)
})

// Spec §21: a refusal is shown where it happened, never swallowed. The Pick was
// acknowledged between the page's last poll and the press, so the server holds
// it past taking back; its 409 is the real one.
test('a Withdraw the server refuses says why, and the Panel stays', async ({ page }) => {
  const delivered = await offered(page, probe('refused'))
  const minimized = minimizedOf(page, delivered.pickId)
  await pause(page)
  await page.request.post(ackUrl(delivered))

  const answered = page.waitForResponse(
    (response) => response.request().method() === 'DELETE',
  )
  await minimized.locator(WITHDRAW_BUTTON).click()
  const response = await answered
  expect(response.status()).toBe(409)
  const { reason } = (await response.json()) as { reason: string }
  expect(reason).toContain('it is working')

  await expect(minimized.locator(REFUSAL)).toHaveText(reason)
  await expect(minimized.locator(WITHDRAWN)).toHaveCount(0)
  // The next poll reads the row again: it is working, and past taking back.
  await nextPoll(page)
  await expect(minimized.locator(LIGHT)).toHaveAttribute('title', 'Working')
  await expect(minimized.locator(WITHDRAW_BUTTON)).toHaveCount(0)
  await expect(minimized.locator(REFUSAL)).toHaveText(reason)
  await expect(minimized).toHaveCount(1)
})

// A browser cannot send a request without its own Origin (the build brief's
// measured facts), so the guard's 403 is stood in for, in the guard's shape.
test('a Withdraw the guard refuses says why, and the Panel stays', async ({ page }) => {
  const delivered = await failed(page, probe('forbidden'))
  const minimized = minimizedOf(page, delivered.pickId)
  const reason =
    'refused a Pick whose Origin (http://elsewhere.test) is not one this dev server is serving on.'
  await page.route(WITHDRAW, (route: Route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          status: 403,
          json: { error: 'origin-mismatch', reason },
        })
      : route.fallback(),
  )
  try {
    await minimized.locator(WITHDRAW_BUTTON).click()
    await expect(minimized.locator(REFUSAL)).toHaveText(reason)
    await nextPoll(page)
    await expect(minimized).toHaveCount(1)
    await expect(minimized.locator(LIGHT)).toHaveAttribute('title', FAILED)
    // Still there to be tried again.
    await expect(minimized.locator(WITHDRAW_BUTTON)).toBeVisible()
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

test('a Pick the server no longer holds is treated as gone', async ({
  page,
  baseURL,
}) => {
  const delivered = await failed(page, probe('gone'))
  const minimized = minimizedOf(page, delivered.pickId)
  // Withdrawn already, from somewhere else: the page has not polled since.
  await pause(page)
  const first = await page.request.delete(`/__agent/pick/${delivered.pickId}`, {
    headers: { origin: baseURL! },
  })
  expect(first.status()).toBe(200)

  const answered = page.waitForResponse(
    (response) => response.request().method() === 'DELETE',
  )
  await minimized.locator(WITHDRAW_BUTTON).click()
  expect((await answered).status()).toBe(404)
  await expect(minimized).toHaveCount(0)
  await expect(page.locator(REFUSAL)).toHaveCount(0)
})

// The hook floor drains a Pick into whichever prompt comes next, so the server
// cannot say which session has it. The withdraw is real; its answer is read as
// the floor's would be, with no name.
test('a Pick the hook floor carried says a session has it, naming none', async ({
  page,
}) => {
  const delivered = await offered(page, probe('floor'))
  const minimized = minimizedOf(page, delivered.pickId)
  await page.route(WITHDRAW, async (route: Route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, unknown>
    await route.fulfill({ response, json: { ...body, targetName: null } })
  })
  try {
    await minimized.locator(WITHDRAW_BUTTON).click()
    await expect(minimized.locator(WITHDRAWN)).toHaveText(ALREADY_DELIVERED)
    await page.clock.runFor(SAID_FOR_MS)
    await goneForGood(page, minimized, delivered.pickId)
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

/** What the copy a withdrawn Panel leaves behind eases, while it is there. */
async function leavingEases(page: Page, pickId: string): Promise<string[]> {
  const minimized = minimizedOf(page, pickId)
  await minimized.locator(WITHDRAW_BUTTON).click()
  const copy = page.locator(`.minimized[data-leaving][data-pick="${pickId}"]`)
  await expect(copy).toHaveCount(1)
  await expect(copy).toHaveAttribute('aria-hidden', 'true')
  const eased = await copy.evaluate((node) =>
    getComputedStyle(node).transitionProperty.split(', '),
  )
  await expect(minimized).toHaveCount(0)
  return eased
}

test.describe('a withdrawn Panel leaving', () => {
  test('fades where it stood for a developer who asked for less motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const delivered = await failed(page, probe('leaves-reduce'))
    expect(await leavingEases(page, delivered.pickId)).toEqual(['opacity'])
  })

  test('also shrinks a little where motion is allowed', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const delivered = await failed(page, probe('leaves-moves'))
    expect(await leavingEases(page, delivered.pickId)).toEqual(['opacity', 'transform'])
  })
})
