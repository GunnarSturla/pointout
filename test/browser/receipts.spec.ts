import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { replyTo } from '../harness/session-socket.js'

// The browser suite: what the harness said about a Pick, as a developer reads it on the
// Pick's minimized Panel in the Stack (spec §16, §17, §21). The Receipts are real frames sent to the
// dev server's real reply address — the one the delivered Pick published in its
// own `from` — by a connection that stands in for the harness. Nothing here
// fakes `/status`: the sentence travels server → poll → Panel, and it is read off
// the page.
//
// Every string is written out rather than imported: the frame fields are the
// harness's, the words are §17's, and the part names are the Overlay's
// contract (docs/agents/testing.md).

/** Where the fake session's inbox writes what it received (test/harness/serve.ts). */
const FRAMES_LOG_ENV = 'BROWSER_FRAMES_LOG'

/** The fake session the browser suite addresses, as `globalSetup` named it. */
const TARGET_NAME = 'the browser suite fake session'

/** Spec §14: the Overlay's one tick, "about one to two seconds". */
const TICK_MS = 1500

const PICKED = '[data-fixture="card-heading"]'
const SECOND_PICKED = '[data-fixture="passed-down-badge"]'

const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const TARGET = '[data-part="target"]'
const TARGET_ACTION = '[data-part="target-action"]'
const TARGETS = '[data-part="targets"]'
const TARGET_ROW = '[data-part="target-row"]'
const STACK = '[data-part="stack"]'
const MINIMIZED = '[data-part="minimized"]'
const LIGHT = '[data-part="light"]'
const DOT = '[data-part="dot"]'
const MINIMIZED_WORDS = '[data-part="minimized-words"]'
const MINIMIZED_NEXT = '[data-part="minimized-next"]'

/** Spec §17's words, written out because they are the contract. */
const SENT = 'Sent'
const APPROVE = 'approve it in your terminal'
const SEND_AGAIN = 'send it again, or pick another session'
const asking = (name: string) => `${name} is asking you to approve this pick`

/** The traffic light's words (overlay-polish 08). */
const NEEDS_APPROVAL = 'Needs your approval'
const FAILED = 'Failed'

/** The browser-suite session blocked on a permission prompt (test/harness/serve.ts). */
const WAITING_NAME = 'the browser suite waiting session'

/**
 * Ticket 13's table, as the harness's machine values reach it. The sentence is
 * the server's; this suite's half is that it reaches the Panel as it is.
 */
const REASON_TABLE: Array<{
  row: string
  receipt: Record<string, unknown>
  sentence: string
}> = [
  {
    row: 'dropped as a duplicate',
    receipt: { status: 'dropped', drop_reason: 'duplicate' },
    sentence: 'Not delivered — an identical pick was just sent.',
  },
  {
    row: 'dropped by a rate limit',
    receipt: { status: 'dropped', drop_reason: 'rate_limit' },
    sentence: 'Not delivered — too many picks too quickly.',
  },
  {
    row: 'dropped against a full queue',
    receipt: { status: 'dropped', drop_reason: 'full_queue' },
    sentence: `Not delivered — ${TARGET_NAME} has too much queued.`,
  },
  {
    row: 'dropped as a relay loop',
    receipt: { status: 'dropped', drop_reason: 'relay_loop' },
    sentence: 'Not delivered — it came back to where it started.',
  },
  {
    row: 'refused by the session',
    receipt: { status: 'refused' },
    sentence: `Not delivered — ${TARGET_NAME} isn't accepting picks.`,
  },
  {
    row: 'denied by the developer',
    receipt: { status: 'denied' },
    sentence: `Not delivered — you declined it in ${TARGET_NAME}.`,
  },
  {
    row: 'expired before approval',
    receipt: { status: 'expired' },
    sentence: "Not delivered — it wasn't approved in time.",
  },
  {
    // A machine value v0 does not know: the harness's own prose, verbatim.
    row: 'dropped for a reason v0 does not know',
    receipt: {
      status: 'dropped',
      drop_reason: 'session_mismatch',
      reason: 'the message named a session this socket does not serve',
    },
    sentence: 'the message named a session this socket does not serve',
  },
]

/** One probe token per test, carried in the url and the Note so its frame can be found. */
function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
}

async function open(page: Page, token: string): Promise<void> {
  await page.goto(`?probe=${token}`)
  await expect(page.locator(PICKER)).toBeVisible()
}

/** Every frame the default session received, oldest first. */
function framesReceived(): Array<Record<string, unknown>> {
  const log = process.env[FRAMES_LOG_ENV]
  if (!log)
    throw new Error(
      `${FRAMES_LOG_ENV} is unset: the browser suite's globalSetup did not run`,
    )
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/**
 * The delivered `user` frame whose Note carries this test's probe token: its
 * `msg_id` is the Pick, and its `from` is where the harness answers.
 */
async function deliveredFrame(token: string): Promise<{ pickId: string; from: string }> {
  let found: Record<string, unknown> | undefined
  await expect
    .poll(
      () => {
        found = framesReceived().find(
          (frame) =>
            frame.type === 'user' &&
            (frame.message as { content: string }).content.includes(token),
        )
        return found !== undefined
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  const from = found?.from
  if (typeof from !== 'string' || !from.startsWith('uds:'))
    throw new Error('the delivered pick published no uds: reply address')
  return { pickId: String(found?.msg_id), from }
}

/** One Receipt, as the harness writes it: a fresh connection to the reply address. */
async function receipt(
  at: { pickId: string; from: string },
  fields: Record<string, unknown>,
): Promise<void> {
  const reply = await replyTo(at.from)
  await reply.send({
    type: 'control',
    action: 'peer_message_status',
    orig_msg_id: at.pickId,
    from: 'uds:/tmp/cc-socks/400001.sock',
    msgV: 1,
    msg_id: `receipt-${Math.random().toString(16).slice(2)}`,
    ...fields,
  })
  await reply.close()
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

/** Arm, pick, write and send one Pick; answer with the frame it was delivered in. */
async function send(
  page: Page,
  token: string,
): Promise<{ pickId: string; from: string }> {
  await arm(page)
  await pick(page, PICKED)
  await page.keyboard.type(`receipt ${token}`)
  await page.keyboard.press('Enter')
  await expect(page.locator(MINIMIZED)).toHaveCount(1)
  await expect(page.locator(PANEL)).toHaveCount(0)
  await expect(light(page)).toHaveAttribute('title', SENT)
  return deliveredFrame(token)
}

const minimized = (page: Page) => page.locator(MINIMIZED).first()
const light = (page: Page) => minimized(page).locator(LIGHT)

/** Put everything away: no Panel, not armed, and the pointer nowhere near the Overlay. */
async function putAway(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.mouse.move(4, 4)
  await expect(page.locator(PANEL)).toHaveCount(0)
  await expect(page.locator(PICKER)).not.toHaveAttribute('data-armed', '')
}

/** Everything the Overlay's shadow root says, as text. */
function overlayText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const hosts = [...document.querySelectorAll('*')].filter((each) => each.shadowRoot)
    return hosts.map((host) => host.shadowRoot?.textContent ?? '').join('\n')
  })
}

/** Whether an element lies wholly inside the viewport. */
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

test('a held Pick asks for approval in the terminal, and a release returns it to Sent', async ({
  page,
}) => {
  const token = probe('held')
  await open(page, token)
  const delivered = await send(page, token)

  await receipt(delivered, { status: 'held' })

  await expect(minimized(page).locator(MINIMIZED_WORDS)).toHaveText(asking(TARGET_NAME))
  await expect(minimized(page).locator(MINIMIZED_NEXT)).toHaveText(APPROVE)
  // Red, sending out rings where motion is allowed: the one state waiting on
  // the developer, and its title says so in words.
  await expect(light(page)).toHaveAttribute('title', NEEDS_APPROVAL)
  await expect(light(page).locator(DOT)).toHaveAttribute('data-status', 'needs')

  // The harness released it: the Panel is Sent again, and stops asking.
  await receipt(delivered, { status: 'delivered' })

  await expect(light(page)).toHaveAttribute('title', SENT)
  await expect(minimized(page).locator(MINIMIZED_WORDS)).toHaveCount(0)
  await expect(minimized(page).locator(MINIMIZED_NEXT)).toHaveCount(0)
  // A return to Sent is the whole of what a release says (spec §17, §21).
  expect(await overlayText(page)).not.toMatch(/delivered/i)
})

test('the held Panel and the waiting footer name the one action in the same words', async ({
  page,
}) => {
  const token = probe('imperative')
  await open(page, token)
  const delivered = await send(page, token)
  await receipt(delivered, { status: 'held' })
  await expect(minimized(page).locator(MINIMIZED_NEXT)).toHaveText(APPROVE)

  // A second Pick, addressed to the session blocked on a permission prompt:
  // its footer names the same action, and the held Panel is still asking.
  await arm(page)
  await pick(page, SECOND_PICKED)
  await page.locator(TARGET).click()
  await page.locator(`${TARGETS} ${TARGET_ROW}`).filter({ hasText: WAITING_NAME }).click()

  await expect(page.locator(TARGET_ACTION)).toHaveText(APPROVE)
  await expect(minimized(page).locator(MINIMIZED_NEXT)).toHaveText(APPROVE)
})

test('a held Pick keeps the Picker and its own Panel out where the developer can see them', async ({
  page,
}) => {
  const token = probe('pulled-out')
  await open(page, token)
  const delivered = await send(page, token)
  await putAway(page)

  await receipt(delivered, { status: 'held' })
  await expect(minimized(page).locator(MINIMIZED_WORDS)).toHaveText(asking(TARGET_NAME))

  // Nothing is hovered, armed or open: the Picker is out of its tuck and the
  // minimized Panel that asks is wholly on screen, because the one action it
  // names is the developer's (spec §8). The Panel held both out before the
  // Receipt too: a `held` Pick is outstanding, and that is the rule that keeps
  // it in view.
  await expect.poll(() => onScreen(page, PICKER)).toBe(true)
  await expect.poll(() => onScreen(page, MINIMIZED)).toBe(true)
  await expect(page.locator(STACK)).toBeVisible()
})

for (const { row, receipt: fields, sentence } of REASON_TABLE) {
  test(`a Pick ${row} reads as not delivered, with the sentence`, async ({ page }) => {
    const token = probe('failed')
    await open(page, token)
    const delivered = await send(page, token)

    await receipt(delivered, fields)

    await expect(minimized(page)).toHaveAttribute('data-state', 'failed')
    await expect(light(page)).toHaveAttribute('title', FAILED)
    await expect(light(page).locator(DOT)).toHaveAttribute('data-status', 'failed')
    await expect(minimized(page).locator(MINIMIZED_WORDS)).toHaveText(sentence)
    await expect(minimized(page).locator(MINIMIZED_NEXT)).toHaveText(SEND_AGAIN)
  })
}

test('silence says nothing: a Pick no Receipt was sent for never reads as delivered', async ({
  page,
}) => {
  const token = probe('silence')
  // The page's clock, so the ticks are moved through rather than waited out.
  // The tick itself is proved on the wall clock once, in Chromium, by
  // surfaces.spec.ts's `the tick runs on the wall clock`.
  await page.clock.install()
  await open(page, token)
  await send(page, token)

  // Accept is silent (spec §16), so ticks answered with nothing new about this
  // Pick must leave it exactly where it was.
  for (let tick = 0; tick < 3; tick++) {
    const answered = page.waitForResponse((response) =>
      response.url().includes('/__agent/status'),
    )
    await page.clock.runFor(TICK_MS)
    await answered
  }

  await expect(light(page)).toHaveAttribute('title', SENT)
  await expect(minimized(page).locator(MINIMIZED_WORDS)).toHaveCount(0)
  expect(await overlayText(page)).not.toMatch(/delivered/i)
})
