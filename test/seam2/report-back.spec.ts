import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'
import { replyTo } from '../harness/session-socket.js'

// Seam 2: the report-back offer as a developer meets it (spec §8, §17, stories
// 46 to 49). The offer is raised by the real server: an idle notice, sent to
// its real reply address by a connection standing in for the harness, says the
// Target finished a turn after the write with no ack — spec §17's *report back
// now*. The thirty-second countdown is the page's own, so the page's clock is
// the one this suite moves (`page.clock`); the server's is left alone.
//
// Every string is written out rather than imported: the frame fields are the
// harness's, the words are §17's, the part names are the Overlay's contract
// (docs/agents/testing.md).

const SECOND_FRAMES_LOG_ENV = 'SEAM2_SECOND_FRAMES_LOG'
/** The session only these journeys address (test/harness/serve.ts). */
const REPORT_BACK_FRAMES_LOG_ENV = 'SEAM2_REPORT_BACK_FRAMES_LOG'

/**
 * An idle notice offers back every Pick outstanding to its Target, and the
 * specs run in parallel against one server: so these journeys address a
 * session no other spec does, and end its turns without touching anyone else.
 */
const TARGET_NAME = 'seam 2 report-back session'
const SECOND_NAME = 'seam 2 second session'
const WAITING_NAME = 'seam 2 waiting session'

const STATUS = '**/__agent/status'
const PICKED = '[data-fixture="card-heading"]'
const SECOND_PICKED = '[data-fixture="passed-down-badge"]'

const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const PANEL_STATUS = '[data-part="status"]'
const TARGET = '[data-part="target"]'
const TARGETS = '[data-part="targets"]'
const TARGET_ROW = '[data-part="target-row"]'
const STACK = '[data-part="stack"]'
const CHIP = '[data-part="stack-chip"]'
const CHIP_WORDS = '[data-part="chip-words"]'
const CHIP_NEXT = '[data-part="chip-next"]'
const SUMMARY = '[data-part="summary"]'
const OFFER = '[data-part="offer"]'
const QUESTION = '[data-part="offer-question"]'
const ELSEWHERE = '[data-part="offer-elsewhere"]'
const LEAVE = '[data-part="offer-leave"]'
const COUNTDOWN = '[data-part="countdown"]'
const WAITING = '[data-part="stack-waiting"]'
const WAITING_ACTION = `${WAITING} [data-part="target-action"]`

const SENT = 'Sent'
const NEXT_PROMPT = 'arrives when you next prompt Claude in this repo'
const APPROVE = 'approve it in your terminal'
const neverPickedUp = (name: string) => `${name} never picked this up.`
const QUESTION_WORDS =
  'Send it to another session, or leave it for whoever you prompt next?'
const blockedPaused = (name: string) =>
  `${name} is blocked on a permission prompt, so its pick is waiting`
const summaryOf = (sent: number) => `${sent} sent, none acknowledged yet`
const NO_ACK = 'No acknowledgement yet'
const CHECK_TERMINAL = 'check your terminal'

/** Spec §17. */
const OFFER_MS = 30_000
const TTL_MS = 30 * 60 * 1000

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
  subscription: string
  content: string
}

/** The `user` frame carrying this token, and the idle subscription written after it. */
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
        const subscription = frames
          .slice(at + 1)
          .find((frame) => frame.action === 'notify_when_idle')
        if (at === -1 || !user || !subscription) return false
        found = {
          pickId: String(user.msg_id),
          from: String(user.from),
          subscription: String(subscription.msg_id),
          content: contentOf(user),
        }
        return true
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

async function open(page: Page, token: string): Promise<void> {
  // The page's clock, so thirty seconds can pass in one call. It flows on its
  // own until a test moves it.
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
async function send(
  page: Page,
  selector: string,
  note: string,
  to?: string,
): Promise<void> {
  await arm(page)
  await pick(page, selector)
  if (to) {
    await page.locator(TARGET).click()
    await page
      .locator(`${PANEL} ${TARGETS} ${TARGET_ROW}`)
      .filter({ hasText: to })
      .click()
    await page.locator('[data-part="note"]').click()
  }
  await page.keyboard.type(note)
  await page.keyboard.press('Enter')
  await expect(page.locator(PANEL_STATUS)).toHaveText(SENT)
}

/** No Panel, not armed, and the pointer nowhere near the Stack. */
async function putAway(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.mouse.move(4, 4)
  await expect(page.locator(PANEL)).toHaveCount(0)
}

const chipOf = (page: Page, pickId: string) =>
  page.locator(`${CHIP}[data-pick="${pickId}"]`)

async function offered(page: Page, token: string): Promise<Delivered> {
  await open(page, token)
  await send(page, PICKED, `report back ${token}`, TARGET_NAME)
  const delivered = await deliveredIn(REPORT_BACK_FRAMES_LOG_ENV, token)
  await putAway(page)
  await turnEnded(delivered)
  await expect(chipOf(page, delivered.pickId).locator(OFFER)).toBeVisible()
  return delivered
}

async function statusRow(
  page: Page,
  pickId: string,
): Promise<{ state: string; createdAt: number; expiresAt: number } | undefined> {
  const response = await page.request.get('/__agent/status')
  const { picks } = (await response.json()) as {
    picks: Array<{ pickId: string; state: string; createdAt: number; expiresAt: number }>
  }
  return picks.find((row) => row.pickId === pickId)
}

async function leftOf(page: Page): Promise<number> {
  return Number(await page.locator(COUNTDOWN).first().getAttribute('data-left'))
}

test('a Pick the Target never picked up expands its chip into the offer', async ({
  page,
}) => {
  const delivered = await offered(page, probe('offer'))
  const chip = chipOf(page, delivered.pickId)

  await expect(chip.locator(CHIP_WORDS)).toHaveText(neverPickedUp(TARGET_NAME))
  await expect(chip.locator(QUESTION)).toHaveText(QUESTION_WORDS)
  await expect(chip.locator(ELSEWHERE)).toBeVisible()
  await expect(chip.locator(LEAVE)).toBeVisible()
  await expect(chip.locator(COUNTDOWN)).toBeVisible()
})

test.describe('with motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('the line shortens, easing steadily between its steps', async ({ page }) => {
    await offered(page, probe('depletes'))
    const line = page.locator(COUNTDOWN)

    const first = await leftOf(page)
    await expect.poll(() => leftOf(page), { timeout: 5000 }).toBeLessThan(first)
    await expect(line).toHaveCSS('transition-property', 'transform')
    await expect(line).toHaveCSS('transition-timing-function', 'linear')
    // Drawn, and shorter than whole: its width on screen is the time left.
    const box = await line.boundingBox()
    const chipBox = await page.locator(OFFER).boundingBox()
    expect(box!.width).toBeLessThan(chipBox!.width)
  })
})

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('the line shortens in whole steps, and nothing eases', async ({ page }) => {
    await offered(page, probe('steps'))
    const first = await leftOf(page)
    await expect.poll(() => leftOf(page), { timeout: 5000 }).toBeLessThan(first)
    await expect(page.locator(COUNTDOWN)).toHaveCSS('transition-duration', '0s')
  })
})

test('at zero the Pick is left for the next prompt, with a fresh TTL', async ({
  page,
}) => {
  const delivered = await offered(page, probe('zero'))
  const chip = chipOf(page, delivered.pickId)

  await page.clock.fastForward(OFFER_MS + 1000)

  await expect(chip.locator(OFFER)).toHaveCount(0)
  await expect(chip.locator(CHIP_WORDS)).toHaveText(SENT)
  await expect(chip.locator(CHIP_NEXT)).toHaveText(NEXT_PROMPT)

  const row = await statusRow(page, delivered.pickId)
  expect(row?.state).toBe('queued-unaddressed')
  // Fresh: thirty minutes from the requeue, not from when the Pick was made.
  expect(row!.expiresAt).toBeGreaterThan(row!.createdAt + TTL_MS)
})

test('touching the offer stops its countdown for good', async ({ page }) => {
  const delivered = await offered(page, probe('touched'))
  const chip = chipOf(page, delivered.pickId)

  await chip.locator(QUESTION).hover()
  await expect(chip.locator(COUNTDOWN)).toHaveCount(0)
  await page.mouse.move(4, 4)

  await page.clock.fastForward(OFFER_MS + 1000)
  // Two ticks of the poll, and still the offer, still unresolved.
  for (let tick = 0; tick < 2; tick++) {
    await page.waitForResponse((response) => response.url().includes('/__agent/status'))
  }
  await expect(chip.locator(OFFER)).toBeVisible()
  await expect(chip.locator(COUNTDOWN)).toHaveCount(0)
  expect((await statusRow(page, delivered.pickId))?.state).toBe('sent')
})

test('sending it to another session writes a fresh Pick there and forgets the old', async ({
  page,
}) => {
  const token = probe('elsewhere')
  const delivered = await offered(page, token)
  const chip = chipOf(page, delivered.pickId)

  await chip.locator(ELSEWHERE).click()
  const rows = page.locator(`${STACK} ${TARGETS} ${TARGET_ROW}`)
  await expect(rows.filter({ hasText: SECOND_NAME })).toBeVisible()
  await rows.filter({ hasText: SECOND_NAME }).click()

  const fresh = await deliveredIn(SECOND_FRAMES_LOG_ENV, token)
  expect(fresh.pickId).not.toBe(delivered.pickId)
  expect(nonceOf(fresh.content)).not.toBe(nonceOf(delivered.content))

  const moved = chipOf(page, fresh.pickId)
  await expect(moved.locator(CHIP_WORDS)).toHaveText(SENT)
  await expect(chipOf(page, delivered.pickId)).toHaveCount(0)
  expect(await statusRow(page, delivered.pickId)).toBeUndefined()
  expect((await statusRow(page, fresh.pickId))?.state).toBe('sent')
})

test('two Picks to an idle Target both raise offers, and the summary holds', async ({
  page,
}) => {
  const token = probe('two')
  await open(page, token)
  await send(page, PICKED, `first ${token}`, TARGET_NAME)
  const first = await deliveredIn(REPORT_BACK_FRAMES_LOG_ENV, `first ${token}`)
  await send(page, SECOND_PICKED, `second ${token}`, TARGET_NAME)
  const second = await deliveredIn(REPORT_BACK_FRAMES_LOG_ENV, `second ${token}`)
  await putAway(page)
  await expect(page.locator(SUMMARY)).toHaveText(summaryOf(2))

  // One turn ended after both were written, and neither was acked.
  await turnEnded(second)

  for (const { pickId } of [first, second]) {
    await expect(chipOf(page, pickId).locator(OFFER)).toBeVisible()
  }
  await expect(page.locator(SUMMARY)).toHaveText(summaryOf(2))
})

test('a Target waiting on a permission prompt pauses the clock, and says so', async ({
  page,
}) => {
  const token = probe('paused')
  await open(page, token)
  await send(page, PICKED, `paused ${token}`, WAITING_NAME)
  await putAway(page)

  await expect(page.locator(WAITING)).toContainText(blockedPaused(WAITING_NAME))
  await expect(page.locator(WAITING_ACTION)).toHaveText(APPROVE)
  // Session-level evidence: the chip itself still says only Sent.
  await expect(page.locator(CHIP).first().locator(CHIP_WORDS)).toHaveText(SENT)
  // Nothing is armed or open, and the Stack and the Picker are both out.
  await expect(page.locator(STACK)).toBeVisible()
  await expect.poll(() => onScreen(page, PICKER)).toBe(true)
  await expect.poll(() => onScreen(page, WAITING)).toBe(true)
})

test('a Pick nobody has acknowledged in a minute reads as unknown', async ({ page }) => {
  // The minute is the server's (seam 1 makes it pass); this is the chip's half,
  // read off a real Pick whose status answers `unknown`.
  const token = probe('unknown')
  await open(page, token)
  await page.route(STATUS, async (route: Route) => {
    const response = await route.fetch()
    const body = (await response.json()) as { picks: Array<Record<string, unknown>> }
    for (const row of body.picks) row.state = 'unknown'
    await route.fulfill({ response, json: body })
  })
  await send(page, PICKED, `unknown ${token}`)

  await expect(page.locator(CHIP).first().locator(CHIP_WORDS)).toHaveText(NO_ACK)
  await expect(page.locator(CHIP).first().locator(CHIP_NEXT)).toHaveText(CHECK_TERMINAL)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

function nonceOf(content: string): string {
  const found = /[?&]n=([0-9a-f]+)/.exec(content)
  if (!found?.[1]) throw new Error('the body carried no nonce')
  return found[1]
}

async function onScreen(page: Page, selector: string): Promise<boolean> {
  const box = await page.locator(selector).first().boundingBox()
  const seen = page.viewportSize()
  if (!box || !seen) return false
  return (
    box.x >= -1 &&
    box.y >= -1 &&
    box.x + box.width <= seen.width + 1 &&
    box.y + box.height <= seen.height + 1
  )
}
