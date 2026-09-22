import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Seam 2: the Overlay's two standing surfaces (spec §5, §7, §8, §17). The
// Picker's peek and the way back to a Panel that has scrolled away; the Stack
// that exists only while a Pick is outstanding, the words on each chip, the
// resting Highlight under it, and the one tick all of it is read on.
//
// Every string here is written out rather than imported: the endpoint paths, the
// `/status` payload, the chip words and the Overlay's own part names are the
// contract (docs/agents/testing.md). Nothing imports a server module.
//
// The ack and the done are the real endpoints, taken from the URLs the delivered
// Pick itself prints for the agent — which is the only fake this file needs for
// them, and it is not a fake at all.

/** Where the fake session's inbox writes what it received (test/harness/serve.ts). */
const FRAMES_LOG_ENV = 'SEAM2_FRAMES_LOG'

/** The fake session seam 2 addresses, as `globalSetup` named it. */
const TARGET_NAME = 'seam 2 fake session'

const STATUS = '**/__agent/status'

const PICKED = '[data-fixture="card-heading"]'
const SECOND_PICKED = '[data-fixture="passed-down-badge"]'
const HEADING = 'h1'
const DECOY_DISMISS = '[data-fixture="full-viewport-decoy-dismiss"]'
const EDGES_TOGGLE = '[data-fixture="viewport-edges-toggle"]'
const EDGES = ['top', 'right', 'bottom', 'left'] as const

const PEEK = '[data-part="picker-peek"]'
const PICKER = '[data-part="picker"]'
const BACK = '[data-part="picker-back"]'
const HIGHLIGHT = '[data-part="highlight"]'
const RESTING = '[data-part="highlight"][data-resting]'
const PANEL = '[data-part="panel"]'
const NOTE = '[data-part="note"]'
const SEND = '[data-part="send"]'
const PANEL_STATUS = '[data-part="status"]'
const STACK = '[data-part="stack"]'
const CHIP = '[data-part="stack-chip"]'
const CHIP_WORDS = '[data-part="chip-words"]'
const CHIP_NEXT = '[data-part="chip-next"]'
const SUMMARY = '[data-part="summary"]'

/** Spec §17's words, written out because they are the contract. */
const SENT = 'Sent'
const NEXT_PROMPT = 'arrives when you next prompt Claude in this repo'
const SEND_AGAIN = 'send it again, or pick another session'
const TTL_FAILURE =
  'Not delivered — nobody prompted Claude in this repo within 30 minutes.'
const working = (name: string) => `${name} is on it`
const reported = (name: string) => `Done — reported by ${name}`
const summaryOf = (sent: number) => `${sent} sent, none acknowledged yet`

/** Spec §8: the `done` chip goes on a plain timer of about eight seconds. */
const DISMISS_MS = 8000

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** One probe token per test, carried in the url so its frame can be found. */
function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
}

async function open(page: Page, token: string): Promise<void> {
  await page.goto(`/?probe=${token}`)
  await expect(page.locator(PICKER)).toBeVisible()
}

/** Every `user` frame's rendered content, oldest first. */
function deliveredContents(): string[] {
  const log = process.env[FRAMES_LOG_ENV]
  if (!log)
    throw new Error(`${FRAMES_LOG_ENV} is unset: seam 2's globalSetup did not run`)
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((frame) => frame.type === 'user')
    .map((frame) => (frame.message as { content: string }).content)
}

/** The one delivered body whose Note carries this test's probe token. */
async function delivered(token: string): Promise<string> {
  let found: string | undefined
  await expect
    .poll(
      () => {
        found = deliveredContents().find((content) => content.includes(token))
        return found !== undefined
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return found ?? ''
}

/**
 * The URL a delivered Pick prints for the agent to answer with. Reading it here
 * is how this suite acks and dones without a fake: the agent's own address.
 */
function actionUrl(content: string, action: 'ack' | 'done'): string {
  const found = new RegExp(`^\\s*${action}\\s+(\\S+)$`, 'm').exec(content)
  if (!found?.[1]) throw new Error(`the delivered pick printed no ${action} url`)
  return found[1]
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  // Every fixture in the example app sits below the fold, and a point outside
  // the viewport answers nothing.
  await page.locator(selector).first().scrollIntoViewIfNeeded()
  const box = await boxOf(page, selector)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return box
}

async function viewport(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
}

/**
 * Arm with the Picker, which stays armed without a key held down. It is a
 * toggle, so with a submitted Panel still open the first click puts that away —
 * which is the auto-minimize, and leaves the chip where it was.
 */
async function arm(page: Page): Promise<void> {
  const picker = page.locator(PICKER)
  await picker.click()
  if ((await picker.getAttribute('data-armed')) === null) await picker.click()
  await expect(picker).toHaveAttribute('data-armed', '')
}

async function pick(page: Page, selector: string): Promise<void> {
  const at = await centre(page, selector)
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT).first()).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
}

/** Arm, pick, write and send — one whole Pick, tagged so its frame is findable. */
async function send(page: Page, selector: string, note: string): Promise<void> {
  await arm(page)
  await pick(page, selector)
  await page.keyboard.type(note)
  await page.keyboard.press('Enter')
  await expect(page.locator(PANEL_STATUS)).toHaveText(SENT)
}

const chipFor = (page: Page, index: number) => page.locator(CHIP).nth(index)

/** Alt held, and one click: spec §7's other meaning for the same gesture. */
async function altClick(page: Page, selector: string): Promise<void> {
  const at = await centre(page, selector)
  await page.keyboard.down('Alt')
  await page.mouse.click(at.x, at.y)
  await page.keyboard.up('Alt')
}

/** Whether the frozen Highlight is measuring this element and not another. */
async function onSameBox(page: Page, selector: string): Promise<boolean> {
  const wanted = await boxOf(page, selector)
  const frozen = await boxOf(page, HIGHLIGHT)
  return (
    Math.round(frozen.width) === Math.round(wanted.width) &&
    Math.round(frozen.height) === Math.round(wanted.height)
  )
}

/**
 * Answer `/status` for one real Pick with one of the two states a browser
 * cannot reach from here. The expiry needs a clock thirty minutes ahead and the
 * unaddressed queue needs a registry this dev server cannot read — both of them
 * live in the server process, and both are seam 1's (`status.test.ts`). The half
 * this seam owns is the other one: the state reaching the chip as the words §17
 * gives it, in the shape §20 publishes it, written out here rather than
 * imported.
 */
async function statusSays(
  page: Page,
  told: { pickId: string; state: string; reason: string | null; name: string | null },
): Promise<void> {
  await page.route(STATUS, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        picks: [
          {
            pickId: told.pickId,
            state: told.state,
            reason: told.reason,
            target: told.name === null ? null : { name: told.name },
          },
        ],
      }),
    }),
  )
}

/** The id the Overlay is tracking one chip by — the Pick the server minted. */
async function pickIdOf(page: Page, index: number): Promise<string> {
  const id = await chipFor(page, index).getAttribute('data-pick')
  if (!id) throw new Error('the chip names no Pick')
  return id
}

test('a Pick rests as a chip that says only what is known, and clears itself when it is done', async ({
  page,
}) => {
  // The chip's whole life: sent, acked, reported done, and gone — plus the two
  // things that are true at each end of it.
  test.setTimeout(60_000)
  const token = probe('chip')
  await open(page, token)

  // An idle page: the Picker is there and the Stack is not (`CONTEXT.md`).
  await expect(page.locator(STACK)).toHaveCount(0)
  const idle = await boxOf(page, PICKER)
  const seen = await viewport(page)
  expect(idle.y).toBeLessThan(seen.height)
  expect(idle.y + idle.height).toBeGreaterThan(seen.height)

  await send(page, PICKED, `chip words ${token}`)

  await expect(page.locator(STACK)).toHaveCount(1)
  await expect(page.locator(CHIP)).toHaveCount(1)
  await expect(chipFor(page, 0).locator(CHIP_WORDS)).toHaveText(SENT)

  const content = await delivered(token)
  const ack = await page.request.post(actionUrl(content, 'ack'))
  expect(ack.ok()).toBe(true)
  await expect(chipFor(page, 0).locator(CHIP_WORDS)).toHaveText(working(TARGET_NAME))

  const done = await page.request.post(actionUrl(content, 'done'))
  expect(done.ok()).toBe(true)
  await expect(chipFor(page, 0).locator(CHIP_WORDS)).toHaveText(reported(TARGET_NAME))
  await expect(page.locator(RESTING)).toHaveCount(1)

  // A plain timer, and then nothing is outstanding, so there is no Stack either.
  await expect(page.locator(CHIP)).toHaveCount(0, { timeout: DISMISS_MS + 10_000 })
  await expect(page.locator(RESTING)).toHaveCount(0)
  await expect(page.locator(STACK)).toHaveCount(0)
})

test('several Picks in flight are counted, never attributed', async ({ page }) => {
  test.setTimeout(60_000)
  const first = probe('first')
  const second = probe('second')
  await open(page, first)

  await send(page, PICKED, `one ${first}`)
  await send(page, SECOND_PICKED, `two ${second}`)

  await expect(page.locator(CHIP)).toHaveCount(2)
  await expect(page.locator(SUMMARY)).toHaveText(summaryOf(2))

  const content = await delivered(first)
  const ack = await page.request.post(actionUrl(content, 'ack'))
  expect(ack.ok()).toBe(true)

  // Only that Pick moved, and the summary counts what is left rather than
  // telling the developer anything about the other one.
  await expect(chipFor(page, 0).locator(CHIP_WORDS)).toHaveText(working(TARGET_NAME))
  await expect(chipFor(page, 1).locator(CHIP_WORDS)).toHaveText(SENT)
  await expect(page.locator(SUMMARY)).toHaveText(summaryOf(1))
})

test('a submitted Pick rests as a thin outline, and its chip re-lights it', async ({
  page,
}) => {
  const token = probe('resting')
  await open(page, token)
  await send(page, PICKED, `resting ${token}`)

  const resting = page.locator(RESTING)
  await expect(resting).toHaveCount(1)
  // No fill, a thinner line than the live Highlight's 1.5px, and no chip — the
  // box carries none at all, so there is nothing to hide.
  const treatment = await resting.evaluate((box: HTMLElement) => {
    const style = getComputedStyle(box)
    return {
      background: style.backgroundColor,
      outlineWidth: style.outlineWidth,
      chips: box.querySelectorAll('[data-part="chip"]').length,
    }
  })
  expect(treatment.chips).toBe(0)
  expect(treatment.background).toBe('rgba(0, 0, 0, 0)')
  expect(Number.parseFloat(treatment.outlineWidth)).toBeLessThan(1.5)

  await chipFor(page, 0).hover()
  await expect(page.locator(RESTING)).toHaveCount(0)
  const lit = await page
    .locator(HIGHLIGHT)
    .last()
    .evaluate((box: HTMLElement) => getComputedStyle(box).backgroundColor)
  expect(lit).not.toBe('rgba(0, 0, 0, 0)')
})

test('Alt-click moves an unsubmitted Pick and starts a new one from a submitted Panel', async ({
  page,
}) => {
  const token = probe('move')
  await open(page, token)
  await arm(page)
  // The Panel opens below what it is anchored to, so every element this test
  // moves the Pick onto is one *above* the last — otherwise the click lands on
  // the Panel, which is the Overlay's own chrome and means nothing to the page.
  await pick(page, SECOND_PICKED)

  const carried = `carry me ${token}`
  await page.keyboard.type(carried)

  // Unsubmitted: the Pick moves, and the Note it already holds moves with it.
  await altClick(page, PICKED)

  await expect(page.locator(PANEL)).toHaveCount(1)
  await expect(page.locator(NOTE)).toHaveValue(carried)
  await expect(page.locator(STACK)).toHaveCount(0)
  await expect.poll(() => onSameBox(page, PICKED)).toBe(true)

  await page.keyboard.press('Enter')
  await expect(page.locator(PANEL_STATUS)).toHaveText(SENT)
  await expect(page.locator(CHIP)).toHaveCount(1)

  // Submitted: the same gesture starts a new Pick, and the old Panel is gone —
  // minimized into the chip that has been resting there since it was sent.
  await altClick(page, HEADING)

  await expect(page.locator(PANEL)).toHaveCount(1)
  await expect(page.locator(NOTE)).toHaveValue('')
  await expect(page.locator(SEND)).toHaveText('Locate & stand by')
  await expect(page.locator(CHIP)).toHaveCount(1)
})

test('the Panel opens on-screen at every edge, rides away with its element, and is found again', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await open(page, probe('edges'))
  await page.locator(DECOY_DISMISS).click()
  await page.locator(EDGES_TOGGLE).click()

  const seen = await viewport(page)
  for (const edge of EDGES) {
    await arm(page)
    await pick(page, `[data-fixture="edge-${edge}"]`)

    const panel = await boxOf(page, PANEL)
    expect(`${edge} left: ${panel.x >= -1}`).toBe(`${edge} left: true`)
    expect(`${edge} top: ${panel.y >= -1}`).toBe(`${edge} top: true`)
    expect(`${edge} right: ${panel.x + panel.width <= seen.width + 1}`).toBe(
      `${edge} right: true`,
    )
    expect(`${edge} bottom: ${panel.y + panel.height <= seen.height + 1}`).toBe(
      `${edge} bottom: true`,
    )

    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }

  // Scrolled away, the Panel goes with its element and keeps the keystrokes.
  await arm(page)
  await pick(page, PICKED)
  await page.keyboard.type('first')
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))

  await expect(page.locator(NOTE)).toBeFocused()
  await page.keyboard.type(' second')
  await expect(page.locator(NOTE)).toHaveValue('first second')

  // Floating UI re-anchors on its own schedule, so both ends of the ride are
  // waited for rather than measured once.
  await expect
    .poll(async () => (await boxOf(page, PANEL)).y + (await boxOf(page, PANEL)).height)
    .toBeLessThan(0)

  await expect(page.locator(BACK)).toBeVisible()
  await page.locator(BACK).click()
  await expect(page.locator(BACK)).toHaveCount(0)

  await expect.poll(async () => (await boxOf(page, PANEL)).y).toBeGreaterThanOrEqual(-1)
  const back = await boxOf(page, PANEL)
  expect(back.y + back.height).toBeLessThanOrEqual(seen.height + 1)
})

test('the Picker holds its position while a Pick is outstanding', async ({ page }) => {
  const token = probe('held')
  await open(page, token)
  await send(page, PICKED, `held ${token}`)

  // Nothing is hovering it, nothing is armed, its Panel is closed — and it still
  // may not tuck, because a Pick is unresolved (spec §8).
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.mouse.move(4, 4)
  await expect(page.locator(PANEL)).toHaveCount(0)
  await expect(page.locator(CHIP)).toHaveCount(1)

  const seen = await viewport(page)
  const out = await boxOf(page, PICKER)
  expect(out.y + out.height).toBeLessThanOrEqual(seen.height + 1)
})

test.describe('the reveal', () => {
  test('animates for a developer who has not asked for less of it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await open(page, probe('motion'))

    // The reveal is the `translate` entry. The Picker also eases its opacity,
    // which is the Screen Capture shutter reopening (ticket 18), not the reveal.
    const moving = await page.locator(PEEK).evaluate((peeked: HTMLElement) => {
      const style = getComputedStyle(peeked)
      const at = style.transitionProperty.split(', ').indexOf('translate')
      // Split on the commas between entries, not the ones inside a curve.
      const easings = style.transitionTimingFunction.split(/,\s*(?![^(]*\))/)
      return {
        duration: style.transitionDuration.split(', ')[at],
        easing: easings[at] ?? '',
      }
    })
    expect(moving.duration).toBe('0.22s')
    expect(moving.easing.replaceAll(' ', '')).toBe('cubic-bezier(0.23,1,0.32,1)')
  })

  test('is instant for a developer who has', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page, probe('reduce'))

    const duration = await page
      .locator(PEEK)
      .evaluate((peeked: HTMLElement) => getComputedStyle(peeked).transitionDuration)
    expect(duration).toBe('0s')

    // Still the two positions, still reached: the Picker comes out, at once.
    const seen = await viewport(page)
    const tucked = await boxOf(page, PICKER)
    expect(tucked.y + tucked.height).toBeGreaterThan(seen.height)
    await page.locator(PICKER).hover()
    const out = await boxOf(page, PICKER)
    expect(out.y + out.height).toBeLessThanOrEqual(seen.height + 1)
  })
})

test('a Pick nobody is addressed to says when it will arrive', async ({ page }) => {
  const token = probe('unaddressed')
  await open(page, token)
  await send(page, PICKED, `unaddressed ${token}`)

  // The hook floor's own case (spec §18): the Pick is real and really queued,
  // and nobody is addressed, so the chip says when it will arrive rather than
  // implying it already has.
  await statusSays(page, {
    pickId: await pickIdOf(page, 0),
    state: 'queued-unaddressed',
    reason: null,
    name: null,
  })

  await expect(chipFor(page, 0).locator(CHIP_WORDS)).toHaveText(SENT)
  await expect(chipFor(page, 0).locator(CHIP_NEXT)).toHaveText(NEXT_PROMPT)
})

test('a Pick that ran out of time reads as not delivered, with the reason', async ({
  page,
}) => {
  const token = probe('ttl')
  await open(page, token)
  await send(page, PICKED, `expiring ${token}`)

  await statusSays(page, {
    pickId: await pickIdOf(page, 0),
    state: 'failed',
    reason: TTL_FAILURE,
    name: TARGET_NAME,
  })

  await expect(chipFor(page, 0).locator(CHIP_WORDS)).toHaveText(TTL_FAILURE)
  await expect(chipFor(page, 0).locator(CHIP_NEXT)).toHaveText(SEND_AGAIN)
})

test('one timer reads both endpoints, and only while something is open or outstanding', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const token = probe('tick')

  // Spec §14 gives the tick "about one to two seconds", so an interval inside
  // that band is the Overlay's. Counting them is how "one timer, not one per
  // watcher" is read from outside.
  await page.addInitScript(() => {
    const live = { made: 0, cleared: 0 }
    ;(window as unknown as { overlayTimers: typeof live }).overlayTimers = live
    const setEvery = window.setInterval.bind(window)
    const stop = window.clearInterval.bind(window)
    const polling = (delay: unknown) =>
      typeof delay === 'number' && delay >= 1000 && delay <= 2000
    const ours = new Set<number>()

    window.setInterval = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      const handle = setEvery(handler, delay, ...rest)
      if (polling(delay)) {
        live.made++
        ours.add(handle)
      }
      return handle
    }) as typeof window.setInterval

    window.clearInterval = ((handle?: number) => {
      if (handle !== undefined && ours.delete(handle)) live.cleared++
      stop(handle)
    }) as typeof window.clearInterval
  })

  const asked: Array<{ path: string; at: number }> = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === '/__agent/sessions' || path === '/__agent/status') {
      asked.push({ path, at: Date.now() })
    }
  })

  const timers = () =>
    page.evaluate(
      () =>
        (window as unknown as { overlayTimers: { made: number; cleared: number } })
          .overlayTimers,
    )

  await open(page, token)
  // An idle page reads nothing at all, and starts no timer to read it with.
  await page.waitForTimeout(4000)
  expect(asked).toHaveLength(0)
  expect(await timers()).toEqual({ made: 0, cleared: 0 })

  await send(page, PICKED, `ticking ${token}`)
  const settled = asked.length
  await page.waitForTimeout(5000)
  expect(asked.length).toBeGreaterThan(settled)

  // One timer, and both endpoints read on the same turn of it.
  const running = await timers()
  expect(running.made - running.cleared).toBe(1)
  for (const status of asked.filter((one) => one.path === '/__agent/status')) {
    const together = asked.some(
      (one) => one.path === '/__agent/sessions' && Math.abs(one.at - status.at) < 250,
    )
    expect(`a sessions read beside the status read: ${together}`).toBe(
      'a sessions read beside the status read: true',
    )
  }

  // Nothing open and nothing outstanding: the timer goes out with the Stack.
  const content = await delivered(token)
  const reply = await page.request.post(actionUrl(content, 'done'))
  expect(reply.ok()).toBe(true)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator(STACK)).toHaveCount(0, { timeout: DISMISS_MS + 10_000 })

  const stopped = await timers()
  expect(stopped.made - stopped.cleared).toBe(0)
  const quiet = asked.length
  await page.waitForTimeout(4000)
  expect(asked).toHaveLength(quiet)
})
