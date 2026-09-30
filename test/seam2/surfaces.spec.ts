import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Seam 2: the Overlay's two standing surfaces (spec §5, §7, §8, §17). The
// Picker's peek and the way back to a Panel that has scrolled away; the Stack
// that exists only while a Pick is outstanding, the minimized Panel each sent
// Pick rests as there, the resting Highlight under it, and the one tick all of
// it is read on.
//
// Every string here is written out rather than imported: the endpoint paths, the
// `/status` payload, the minimized Panel's words and the Overlay's part names are the
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
const STACK = '[data-part="stack"]'
const MINIMIZED = '[data-part="minimized"]'
const LIGHT = '[data-part="light"]'
const DOT = '[data-part="dot"]'
const MINIMIZED_NAME = '[data-part="minimized-name"]'
const MINIMIZED_NOTE = '[data-part="minimized-note"]'
const MINIMIZED_CAMERA = '[data-part="minimized-camera"]'
const MINIMIZED_WORDS = '[data-part="minimized-words"]'
const MINIMIZED_NEXT = '[data-part="minimized-next"]'
const SUMMARY = '[data-part="summary"]'
const MINIMIZED_LINE = '[data-part="minimized-line"]'
const EXPANDED = '[data-part="expanded"]'
const EXPANDED_NOTE = '[data-part="expanded-note"]'
const EXPANDED_TARGET = '[data-part="expanded-target"]'
const EXPANDED_NAME = '[data-part="expanded-name"]'
const EXPANDED_STATE = '[data-part="expanded-state"]'

/** Spec §17's words, written out because they are the contract. */
const SENT = 'Sent'
const NEXT_PROMPT = 'arrives when you next prompt Claude in this repo'
const SEND_AGAIN = 'send it again, or pick another session'
const TTL_FAILURE =
  'Not delivered — nobody prompted Claude in this repo within 30 minutes.'
const working = (name: string) => `${name} is on it`
const reported = (name: string) => `Done — reported by ${name}`
const summaryOf = (sent: number) => `${sent} sent, none acknowledged yet`

/** The traffic light's words, from the ticket that settled them (overlay-polish 08). */
const WAITING_FOR_PROMPT = 'Waiting for the next prompt'
const WORKING = 'Working'
const DONE = 'Done'
const FAILED = 'Failed'

/** `--idle` in the light scheme (docs/overlay-design.md): #7a7f8a. */
const IDLE_GREY = 'rgb(122, 127, 138)'
/** `--accent` in the light scheme: #4f7cff. */
const ACCENT = 'rgb(79, 124, 255)'
/** `--needs` in the light scheme: #c8322b. */
const NEEDS_RED = 'rgb(200, 50, 43)'

/** Spec §8: a `done` Pick's minimized Panel goes on a plain timer of about eight seconds. */
const DISMISS_MS = 8000

/** Spec §14: the Overlay's one tick, "about one to two seconds". */
const TICK_MS = 1500

// The page's clock is moved (`page.clock`) wherever a journey would otherwise
// sit out the done Panel's timer or the tick. Each of those two timers keeps one
// real-time journey, in Chromium only, so that its wall-clock length is still
// proved somewhere: see the two `on the wall clock` tests below.

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
 * toggle, so with a Panel still open the first click puts that away.
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
  // Accepted: the Panel closes, and the Pick rests minimized in the Stack.
  await expect(page.locator(MINIMIZED).filter({ hasText: note })).toHaveCount(1)
  await expect(page.locator(PANEL)).toHaveCount(0)
}

const minimizedAt = (page: Page, index: number) => page.locator(MINIMIZED).nth(index)
const lightOf = (page: Page, index: number) => minimizedAt(page, index).locator(LIGHT)

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
 * this seam owns is the other one: the state reaching the minimized Panel as the words §17
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

/**
 * Stop the page's clock, a moment ahead of where it is, so that from here on
 * only `runFor` moves it. Just ahead, because a clock cannot be stopped in its
 * own past, and it has moved on by the time the call reaches the page.
 */
async function pause(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now())
  await page.clock.pauseAt(now + 500)
}

/**
 * One real round trip from the page, after moving its clock. A request a timer
 * fired inside `runFor` reaches this process's `request` listeners before the
 * answer to a request the page made later, so a "nothing was read" checked after
 * this is not checked too early.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => fetch('/?settle').then((response) => response.text()))
}

/** The id the Overlay tracks one minimized Panel by — the Pick the server minted. */
async function pickIdOf(page: Page, index: number): Promise<string> {
  const id = await minimizedAt(page, index).getAttribute('data-pick')
  if (!id) throw new Error('the minimized Panel names no Pick')
  return id
}

test('a Pick rests as a minimized Panel that says only what is known, and clears itself when it is done', async ({
  page,
}) => {
  // The minimized Panel's whole life: sent, acked, reported done, and gone — plus the two
  // things that are true at each end of it.
  test.setTimeout(60_000)
  const token = probe('minimized-life')
  // The page's clock, so the done Panel's timer can be moved past rather than sat
  // out. It flows on its own until the test stops it.
  await page.clock.install()
  await open(page, token)

  // An idle page: the Picker is there and the Stack is not (`CONTEXT.md`).
  await expect(page.locator(STACK)).toHaveCount(0)
  const idle = await boxOf(page, PICKER)
  const seen = await viewport(page)
  expect(idle.y).toBeLessThan(seen.height)
  expect(idle.y + idle.height).toBeGreaterThan(seen.height)

  await send(page, PICKED, `minimized words ${token}`)

  await expect(page.locator(STACK)).toHaveCount(1)
  await expect(page.locator(MINIMIZED)).toHaveCount(1)
  await expect(lightOf(page, 0)).toHaveAttribute('title', SENT)
  await expect(minimizedAt(page, 0).locator(MINIMIZED_WORDS)).toHaveCount(0)

  // The agent's ack: Working, amber, and named for the session that said so.
  const content = await delivered(token)
  const ack = await page.request.post(actionUrl(content, 'ack'))
  expect(ack.ok()).toBe(true)
  await expect(lightOf(page, 0)).toHaveAttribute('title', WORKING)
  await expect(lightOf(page, 0).locator(DOT)).toHaveAttribute('data-status', 'working')
  await expect(minimizedAt(page, 0).locator(MINIMIZED_WORDS)).toHaveText(
    working(TARGET_NAME),
  )

  // Stopped, so the tick that reads the done — and the timer it sets to clear it —
  // happen at a time this test chose, and nothing moves while it waits.
  await pause(page)
  const done = await page.request.post(actionUrl(content, 'done'))
  expect(done.ok()).toBe(true)
  await page.clock.runFor(TICK_MS)
  // Done is the agent's claim, so it is said as one, and attributed (spec §17).
  await expect(lightOf(page, 0)).toHaveAttribute('title', DONE)
  await expect(lightOf(page, 0).locator(DOT)).toHaveAttribute('data-status', 'ready')
  await expect(minimizedAt(page, 0).locator(MINIMIZED_WORDS)).toHaveText(
    reported(TARGET_NAME),
  )
  await expect(page.locator(RESTING)).toHaveCount(1)

  // A plain timer, and then nothing is outstanding, so there is no Stack either.
  // Short of it the minimized Panel is still there; past it, it is gone.
  await page.clock.runFor(DISMISS_MS - 1000)
  await expect(page.locator(MINIMIZED)).toHaveCount(1)
  await page.clock.runFor(2000)
  await expect(page.locator(MINIMIZED)).toHaveCount(0)
  await expect(page.locator(RESTING)).toHaveCount(0)
  await expect(page.locator(STACK)).toHaveCount(0)
})

test('Send minimizes the Panel into the Stack: a grey light titled Sent, the component, and the Note’s first line', async ({
  page,
}) => {
  const token = probe('minimized')
  await open(page, token)
  await arm(page)
  await pick(page, PICKED)
  await page.keyboard.type(`the first line ${token}`)
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('and a second one')
  await page.keyboard.press('Enter')

  // Send closes the unsubmitted Panel, and the same Pick is the one in the Stack.
  const minimized = page.locator(MINIMIZED)
  await expect(minimized).toHaveCount(1)
  await expect(page.locator(PANEL)).toHaveCount(0)

  // Sent is grey and steady, and says so in words where the colour cannot.
  const light = minimized.locator(LIGHT)
  await expect(light).toHaveAttribute('title', SENT)
  await expect(light).toHaveAccessibleName(SENT)
  await expect(light.locator(DOT)).not.toHaveAttribute('data-status')
  await expect(light.locator(DOT)).toHaveCSS('background-color', IDLE_GREY)

  // The component the element belongs to, and one line of the Note, cut short
  // with an ellipsis rather than wrapped.
  await expect(minimized.locator(MINIMIZED_NAME)).toHaveText('CardHeading')
  const note = minimized.locator(MINIMIZED_NOTE)
  await expect(note).toHaveText(`the first line ${token}`)
  await expect(note).toHaveCSS('text-overflow', 'ellipsis')
  await expect(note).toHaveCSS('white-space', 'nowrap')

  // No Screen Capture went (the toggle starts off), so there is no camera, and
  // nothing to read: one line, and no wider than the plan's 320 px.
  await expect(minimized.locator(MINIMIZED_CAMERA)).toHaveCount(0)
  await expect(minimized.locator(MINIMIZED_WORDS)).toHaveCount(0)
  await expect(minimized.locator(MINIMIZED_NEXT)).toHaveCount(0)
  const box = await boxOf(page, MINIMIZED)
  expect(box.height).toBeLessThanOrEqual(30)
  expect(box.width).toBeLessThanOrEqual(320)
})

/** The colour of a minimized Panel's accent edge, or null when it has none. */
async function edgeOf(page: Page, index: number): Promise<string | null> {
  return minimizedAt(page, index).evaluate((slot) => {
    const edge = getComputedStyle(slot, '::before')
    return edge.content === 'none' ? null : edge.backgroundColor
  })
}

/** Which of the Overlay's own elements has focus, by part name, or null. */
async function focusedPart(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector('pointout-overlay')
        ?.shadowRoot?.activeElement?.getAttribute('data-part') ?? null,
  )
}

test('pressing a minimized Panel opens it above the Stack: the whole Note, and where it went', async ({
  page,
}) => {
  const token = probe('expanded')
  await open(page, token)
  await arm(page)
  await pick(page, PICKED)
  await page.keyboard.type(`the first line ${token}`)
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('and the rest of it')
  await page.keyboard.press('Enter')
  await expect(page.locator(MINIMIZED)).toHaveCount(1)
  await expect(page.locator(EXPANDED)).toHaveCount(0)
  const line = minimizedAt(page, 0).locator(MINIMIZED_LINE)
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  expect(await edgeOf(page, 0)).toBeNull()
  const slot = await boxOf(page, MINIMIZED)

  await line.click()

  // Read-only, above the Stack: the whole Note as it was written, the light's
  // word, the component, and the session it went to.
  const expanded = page.locator(EXPANDED)
  await expect(expanded).toHaveCount(1)
  await expect(expanded.locator(EXPANDED_NOTE)).toHaveText(
    `the first line ${token}\nand the rest of it`,
  )
  await expect(expanded.locator(EXPANDED_STATE)).toHaveText(SENT)
  await expect(expanded.locator(EXPANDED_NAME)).toHaveText('CardHeading')
  await expect(expanded.locator(EXPANDED_TARGET)).toHaveText(`To ${TARGET_NAME}`)
  await expect(expanded.locator('textarea, input')).toHaveCount(0)
  // Once it has grown out of its slot, where motion is allowed.
  const stackTop = (await boxOf(page, STACK)).y
  await expect
    .poll(async () => {
      const above = await boxOf(page, EXPANDED)
      return above.y + above.height <= stackTop
    })
    .toBe(true)
  // Its slot stays where it was, marked with the accent edge.
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  expect(await edgeOf(page, 0)).toBe(ACCENT)
  const kept = await boxOf(page, MINIMIZED)
  expect(Math.abs(kept.y - slot.y)).toBeLessThan(1)
  expect(Math.abs(kept.height - slot.height)).toBeLessThan(1)

  // A second press closes it, and the mark goes with it.
  await line.click()
  await expect(page.locator(EXPANDED)).toHaveCount(0)
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  expect(await edgeOf(page, 0)).toBeNull()
})

test('opening a second submitted Panel closes the first', async ({ page }) => {
  const token = probe('expanded-two')
  await open(page, token)
  await send(page, PICKED, `first ${token}`)
  await send(page, SECOND_PICKED, `second ${token}`)
  await expect(page.locator(MINIMIZED)).toHaveCount(2)

  await minimizedAt(page, 0).locator(MINIMIZED_LINE).click()
  await expect(page.locator(EXPANDED_NOTE)).toHaveText(`first ${token}`)

  await minimizedAt(page, 1).locator(MINIMIZED_LINE).click()
  await expect(page.locator(EXPANDED)).toHaveCount(1)
  await expect(page.locator(EXPANDED_NOTE)).toHaveText(`second ${token}`)
  await expect(minimizedAt(page, 0).locator(MINIMIZED_LINE)).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(minimizedAt(page, 1).locator(MINIMIZED_LINE)).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  expect(await edgeOf(page, 0)).toBeNull()
  expect(await edgeOf(page, 1)).toBe(ACCENT)
})

test('an unsubmitted Panel keeps its place and its focus while a submitted one is opened', async ({
  page,
}) => {
  const token = probe('expanded-focus')
  await open(page, token)
  await send(page, PICKED, `sent ${token}`)
  await arm(page)
  await pick(page, SECOND_PICKED)
  await page.keyboard.type('still ')
  const stood = await boxOf(page, PANEL)

  await minimizedAt(page, 0).locator(MINIMIZED_LINE).click()

  await expect(page.locator(EXPANDED)).toHaveCount(1)
  await expect(page.locator(PANEL)).toHaveCount(1)
  expect(await focusedPart(page)).toBe('note')
  await page.keyboard.type('writing')
  await expect(page.locator(NOTE)).toHaveValue('still writing')
  const kept = await boxOf(page, PANEL)
  expect(Math.abs(kept.x - stood.x)).toBeLessThan(1)
  expect(Math.abs(kept.y - stood.y)).toBeLessThan(1)

  // Escape from the Note is the unsubmitted Panel's, as it always was: it is
  // put away, and the submitted one stays open.
  await page.keyboard.press('Escape')
  await expect(page.locator(PANEL)).toHaveCount(0)
  await expect(page.locator(EXPANDED)).toHaveCount(1)
})

test('clicked into, a submitted Panel closes on Escape and leaves the unsubmitted one open', async ({
  page,
}) => {
  const token = probe('expanded-escape')
  await open(page, token)
  await send(page, PICKED, `sent ${token}`)
  await arm(page)
  await pick(page, SECOND_PICKED)
  await minimizedAt(page, 0).locator(MINIMIZED_LINE).click()
  await expect(page.locator(EXPANDED)).toHaveCount(1)

  await page.locator(EXPANDED_NOTE).click()
  expect(await focusedPart(page)).toBe('expanded')
  await page.keyboard.press('Escape')

  await expect(page.locator(EXPANDED)).toHaveCount(0)
  await expect(page.locator(PANEL)).toHaveCount(1)
  // Focus goes back to what opened it.
  expect(await focusedPart(page)).toBe('minimized-line')
})

test('Escape on a minimized Panel that is not open is still the unsubmitted Panel’s', async ({
  page,
}) => {
  const token = probe('expanded-escape-closed')
  await open(page, token)
  await send(page, PICKED, `sent ${token}`)
  await arm(page)
  await pick(page, SECOND_PICKED)
  await minimizedAt(page, 0).locator(MINIMIZED_LINE).focus()

  await page.keyboard.press('Escape')

  await expect(page.locator(PANEL)).toHaveCount(0)
})

test('a submitted Panel closed by its own line hands focus back to the line', async ({
  page,
}) => {
  const token = probe('expanded-refocus')
  await open(page, token)
  await send(page, PICKED, `sent ${token}`)
  const line = minimizedAt(page, 0).locator(MINIMIZED_LINE)
  await line.click()
  await page.locator(EXPANDED_NOTE).click()
  expect(await focusedPart(page)).toBe('expanded')
  await expect(line).toHaveAttribute('aria-controls', /.+/)
  const controls = await line.getAttribute('aria-controls')
  expect(await page.locator(EXPANDED).getAttribute('id')).toBe(controls)

  await line.click()

  await expect(page.locator(EXPANDED)).toHaveCount(0)
  expect(await focusedPart(page)).toBe('minimized-line')
  await expect(line).not.toHaveAttribute('aria-controls', /.*/)
})

test('from the keyboard, a minimized Panel opens on Enter or Space and closes on Escape', async ({
  page,
}) => {
  const token = probe('expanded-keys')
  await open(page, token)
  await send(page, PICKED, `sent ${token}`)
  const line = minimizedAt(page, 0).locator(MINIMIZED_LINE)
  await line.focus()

  await page.keyboard.press('Enter')
  await expect(page.locator(EXPANDED)).toHaveCount(1)
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Space')
  await expect(page.locator(EXPANDED)).toHaveCount(0)
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Space')
  await expect(page.locator(EXPANDED)).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator(EXPANDED)).toHaveCount(0)
  expect(await focusedPart(page)).toBe('minimized-line')
})

/**
 * The CSS animations running on the first minimized Panel's light, by name: the
 * dot's own and its pseudo-elements', which `subtree` reaches.
 */
async function lightRunning(page: Page): Promise<string[]> {
  return lightOf(page, 0)
    .locator(DOT)
    .evaluate((element) =>
      element
        .getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running')
        .map((animation) => (animation as CSSAnimation).animationName),
    )
}

/** Send one Pick and have `/status` say `state` about it. */
async function sentAs(page: Page, token: string, state: string): Promise<void> {
  await open(page, token)
  await send(page, PICKED, `light ${token}`)
  await statusSays(page, {
    pickId: await pickIdOf(page, 0),
    state,
    reason: state === 'failed' ? TTL_FAILURE : null,
    name: TARGET_NAME,
  })
  await expect(minimizedAt(page, 0)).toHaveAttribute('data-state', state)
}

test.describe('the traffic light, with motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('pulses while working and rings while held, and holds still once failed', async ({
    page,
  }) => {
    await sentAs(page, probe('light-working'), 'working')
    await expect.poll(() => lightRunning(page)).toEqual(['dot-working'])

    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await sentAs(page, probe('light-held'), 'held')
    await expect.poll(() => lightRunning(page)).toEqual(['dot-needs', 'dot-needs'])

    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await sentAs(page, probe('light-failed'), 'failed')
    await expect(lightOf(page, 0).locator(DOT)).toHaveCSS('background-color', NEEDS_RED)
    expect(await lightRunning(page)).toEqual([])
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })
})

test.describe('the traffic light, with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('holds still in every state, and its colour and title still say it', async ({
    page,
  }) => {
    for (const [state, title] of [
      ['working', WORKING],
      ['held', 'Needs your approval'],
    ] as const) {
      await sentAs(page, probe(`light-${state}-reduce`), state)
      await expect(lightOf(page, 0)).toHaveAttribute('title', title)
      await expect(lightOf(page, 0).locator(DOT)).toHaveAttribute('data-status', /./)
      expect(await lightRunning(page)).toEqual([])
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    }
  })
})

test('a done Panel clears itself on the wall clock, after about eight seconds', async ({
  page,
  browserName,
}) => {
  // The one real-time journey for the done Panel's timer, which every other
  // journey moves the page's clock past. A timer is the page's, not the
  // engine's, so one engine proves it.
  test.skip(browserName !== 'chromium', 'the real-time clearing runs in Chromium only')
  test.setTimeout(60_000)
  const token = probe('wall-clear')
  await open(page, token)
  await send(page, PICKED, `wall clock ${token}`)

  const content = await delivered(token)
  const done = await page.request.post(actionUrl(content, 'done'))
  expect(done.ok()).toBe(true)
  // Read every 100 ms, both ends, so the measured span is within a poll of the
  // timer's own. The timer is set on the tick that read the done, before the
  // words are drawn, so the start is never earlier than the timer's.
  const often = { intervals: [100], timeout: DISMISS_MS + 10_000 }
  await expect
    .poll(() => minimizedAt(page, 0).locator(MINIMIZED_WORDS).textContent(), often)
    .toBe(reported(TARGET_NAME))
  const reportedAt = Date.now()

  await expect.poll(() => page.locator(MINIMIZED).count(), often).toBe(0)
  const took = Date.now() - reportedAt
  // "About eight seconds": not early, and not late by more than a loaded
  // machine's slack.
  expect(took).toBeGreaterThan(DISMISS_MS - 500)
  expect(took).toBeLessThan(DISMISS_MS + 2500)
  await expect(page.locator(STACK)).toHaveCount(0)
})

test('several Picks in flight are counted, never attributed', async ({ page }) => {
  test.setTimeout(60_000)
  const first = probe('first')
  const second = probe('second')
  await open(page, first)

  await send(page, PICKED, `one ${first}`)
  await send(page, SECOND_PICKED, `two ${second}`)

  await expect(page.locator(MINIMIZED)).toHaveCount(2)
  await expect(page.locator(SUMMARY)).toHaveText(summaryOf(2))

  const content = await delivered(first)
  const ack = await page.request.post(actionUrl(content, 'ack'))
  expect(ack.ok()).toBe(true)

  // Only that Pick moved, and the summary counts what is left rather than
  // telling the developer anything about the other one.
  await expect(minimizedAt(page, 0).locator(MINIMIZED_WORDS)).toHaveText(
    working(TARGET_NAME),
  )
  await expect(lightOf(page, 0)).toHaveAttribute('title', WORKING)
  await expect(lightOf(page, 1)).toHaveAttribute('title', SENT)
  await expect(minimizedAt(page, 1).locator(MINIMIZED_WORDS)).toHaveCount(0)
  await expect(page.locator(SUMMARY)).toHaveText(summaryOf(1))
})

test('a submitted Pick rests as a thin outline, and its minimized Panel re-lights it', async ({
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

  await minimizedAt(page, 0).hover()
  await expect(page.locator(RESTING)).toHaveCount(0)
  // Polled: the Stack stays up through the Screen Capture shutter now, so the
  // minimized Panel can be hovered while the shutter still holds every fill off the page.
  await expect
    .poll(() =>
      page
        .locator(HIGHLIGHT)
        .last()
        .evaluate((box: HTMLElement) => getComputedStyle(box).backgroundColor),
    )
    .not.toBe('rgba(0, 0, 0, 0)')
})

test('Alt-click moves an unsubmitted Pick, and starts a new one once it is sent', async ({
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
  await expect(page.locator(MINIMIZED)).toHaveCount(1)
  await expect(page.locator(PANEL)).toHaveCount(0)

  // Submitted: the Panel is minimized in the Stack, and the same gesture
  // starts a new Pick beside it.
  await altClick(page, HEADING)

  await expect(page.locator(PANEL)).toHaveCount(1)
  await expect(page.locator(NOTE)).toHaveValue('')
  await expect(page.locator(SEND)).toHaveText('Locate & stand by')
  await expect(page.locator(MINIMIZED)).toHaveCount(1)
})

test('the Panel opens on-screen at every edge, rides away with its element, and is found again', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await open(page, probe('edges'))
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
  await expect(page.locator(MINIMIZED)).toHaveCount(1)

  const seen = await viewport(page)
  const out = await boxOf(page, PICKER)
  expect(out.y + out.height).toBeLessThanOrEqual(seen.height + 1)
})

test.describe('the armed Picker', () => {
  // `docs/overlay-design.md`: the armed Picker is the Overlay's one solid blue
  // control, `--accent-strong`, with white words on it (4.84:1).
  const ARMED_FILL = 'rgb(58, 102, 240)'
  const ON_FILL = 'rgb(255, 255, 255)'

  /** How wide the "ing…" that turns "Pick" into "Picking…" is drawn. */
  async function tailWidth(page: Page): Promise<number> {
    return (await boxOf(page, '[data-part="picker-tail"]')).width
  }

  /** Arm, then take the pointer off the Picker so no hover tint is read. */
  async function armAndLeave(page: Page): Promise<void> {
    await arm(page)
    await page.mouse.move(4, 4)
  }

  test('says it is picking, in the fill, and lifts off the edge', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await open(page, probe('armed'))
    const picker = page.locator(PICKER)
    await expect(picker).toHaveAccessibleName('Pick')
    expect(await tailWidth(page)).toBe(0)

    await armAndLeave(page)

    // The name, and the words on show: the tail is drawn, not only named.
    await expect(picker).toHaveAccessibleName('Picking…')
    await expect.poll(() => tailWidth(page)).toBeGreaterThan(10)
    await expect(picker).toHaveCSS('background-color', ARMED_FILL)
    await expect(picker).toHaveCSS('color', ON_FILL)
    // Lifted 2 px off the viewport's bottom edge. The Picker is out, held there
    // by being armed, so its resting place is flush with that edge (the
    // reduce journey below measures it there).
    const seen = await viewport(page)
    await expect
      .poll(async () => {
        const box = await boxOf(page, PICKER)
        return Math.round(seen.height - (box.y + box.height))
      })
      .toBe(2)
  })

  test('does not lift for a developer who asked for less motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page, probe('armed-reduce'))
    const picker = page.locator(PICKER)

    await armAndLeave(page)

    // The fill and the words still change: a colour is a fade, not a move.
    await expect(picker).toHaveAccessibleName('Picking…')
    expect(await tailWidth(page)).toBeGreaterThan(10)
    await expect(picker).toHaveCSS('background-color', ARMED_FILL)
    const seen = await viewport(page)
    const box = await boxOf(page, PICKER)
    expect(Math.round(seen.height - (box.y + box.height))).toBe(0)
  })
})

test('the way back to a Panel appears beside the Picker without moving it', async ({
  page,
}) => {
  // Geometry, not motion: the Picker was lifted while armed, and under reduce
  // it is back on the edge at once rather than easing down while measured.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await open(page, probe('way-back'))
  await arm(page)
  await pick(page, PICKED)

  const centreX = async () => {
    const box = await boxOf(page, PICKER)
    return box.x + box.width / 2
  }
  const before = await centreX()

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await expect(page.locator(BACK)).toBeVisible()

  // Out of flow, to the Picker's right: the Picker stays bottom-centre.
  expect(await centreX()).toBe(before)
  const back = await boxOf(page, BACK)
  const picker = await boxOf(page, PICKER)
  expect(back.x).toBeGreaterThanOrEqual(picker.x + picker.width)
  expect(Math.round(back.y + back.height)).toBe(Math.round(picker.y + picker.height))
})

test.describe('the reveal', () => {
  test('animates for a developer who has not asked for less of it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await open(page, probe('motion'))

    // The reveal is the `translate` entry, read by name so that a fade added
    // beside it one day does not move it.
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
    expect(moving.duration).toBe('0.18s')
    expect(moving.easing.replaceAll(' ', '')).toBe('cubic-bezier(0.23,1,0.32,1)')
  })

  test('is instant for a developer who has', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page, probe('reduce'))

    // Nothing of it is eased: the reveal is movement, and the Picker has no
    // fade since the Screen Capture shutter stopped hiding it (overlay-polish
    // ticket 03).
    const durations = await page
      .locator(PEEK)
      .evaluate((peeked: HTMLElement) => getComputedStyle(peeked).transitionDuration)
    expect(durations.split(', ').every((duration) => duration === '0s')).toBe(true)

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
  // and nobody is addressed, so the Panel says when it will arrive rather than
  // implying it already has.
  await statusSays(page, {
    pickId: await pickIdOf(page, 0),
    state: 'queued-unaddressed',
    reason: null,
    name: null,
  })

  await expect(lightOf(page, 0)).toHaveAttribute('title', WAITING_FOR_PROMPT)
  await expect(lightOf(page, 0).locator(DOT)).not.toHaveAttribute('data-status')
  await expect(minimizedAt(page, 0).locator(MINIMIZED_WORDS)).toHaveCount(0)
  await expect(minimizedAt(page, 0).locator(MINIMIZED_NEXT)).toHaveText(NEXT_PROMPT)
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

  // Red and steady: nothing is left to happen, only something to do.
  await expect(lightOf(page, 0)).toHaveAttribute('title', FAILED)
  await expect(lightOf(page, 0).locator(DOT)).toHaveAttribute('data-status', 'failed')
  await expect(minimizedAt(page, 0).locator(MINIMIZED_WORDS)).toHaveText(TTL_FAILURE)
  await expect(minimizedAt(page, 0).locator(MINIMIZED_NEXT)).toHaveText(SEND_AGAIN)
})

test('one timer reads both endpoints, and only while something is open or outstanding', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const token = probe('tick')

  // The page's clock, installed before the counting below so that what is
  // counted is the Overlay's own timer on it. The idle stretches and the ticks
  // are moved through rather than waited out.
  await page.clock.install()

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

  // Each read is labelled with the tick the test last moved the clock through,
  // so "on the same tick" is read off the page's clock rather than guessed from
  // how close together two requests happened to reach this process.
  let movedThrough = 0
  const asked: Array<{ path: string; tick: number }> = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === '/__agent/sessions' || path === '/__agent/status') {
      asked.push({ path, tick: movedThrough })
    }
  })
  const pathsOn = (tick: number) =>
    [
      ...new Set(asked.filter((one) => one.tick === tick).map((one) => one.path)),
    ].toSorted()

  const timers = () =>
    page.evaluate(
      () =>
        (window as unknown as { overlayTimers: { made: number; cleared: number } })
          .overlayTimers,
    )

  await open(page, token)
  // An idle page reads nothing at all, and starts no timer to read it with.
  await page.clock.runFor(4000)
  await settle(page)
  expect(asked).toHaveLength(0)
  expect(await timers()).toEqual({ made: 0, cleared: 0 })

  await send(page, PICKED, `ticking ${token}`)
  // Send closes the Panel, so a second one is opened: something open and
  // something outstanding, the two watchers the one timer serves.
  await arm(page)
  await pick(page, SECOND_PICKED)

  // Stopped, so the only ticks from here are the ones moved through, one at a
  // time, each with its own label.
  await pause(page)
  // Whatever was already in flight lands before the first labelled tick.
  await settle(page)
  const settled = asked.length
  for (let tick = 1; tick <= 3; tick++) {
    movedThrough = tick
    const read = Promise.all([
      page.waitForResponse((response) => response.url().includes('/__agent/status')),
      page.waitForResponse((response) => response.url().includes('/__agent/sessions')),
    ])
    await page.clock.runFor(TICK_MS)
    await read
  }
  expect(asked.length).toBeGreaterThan(settled)

  // One timer, and both endpoints read on the same turn of it.
  const running = await timers()
  expect(running.made - running.cleared).toBe(1)
  for (let tick = 1; tick <= 3; tick++) {
    expect(`tick ${tick} read ${pathsOn(tick).join(' and ')}`).toBe(
      `tick ${tick} read /__agent/sessions and /__agent/status`,
    )
  }
  for (const status of asked.filter((one) => one.path === '/__agent/status')) {
    expect(`a sessions read beside the status read: ${pathsOn(status.tick)}`).toBe(
      'a sessions read beside the status read: /__agent/sessions,/__agent/status',
    )
  }

  // Nothing open and nothing outstanding: the timer goes out with the Stack.
  const content = await delivered(token)
  const reply = await page.request.post(actionUrl(content, 'done'))
  expect(reply.ok()).toBe(true)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.clock.runFor(TICK_MS)
  await expect(minimizedAt(page, 0).locator(MINIMIZED_WORDS)).toHaveText(
    reported(TARGET_NAME),
  )
  await page.clock.runFor(DISMISS_MS + 1000)
  await expect(page.locator(STACK)).toHaveCount(0)

  const stopped = await timers()
  expect(stopped.made - stopped.cleared).toBe(0)
  const quiet = asked.length
  await page.clock.runFor(4000)
  await settle(page)
  expect(asked).toHaveLength(quiet)
})

test('the tick runs on the wall clock, about every second and a half', async ({
  page,
  browserName,
}) => {
  // The one real-time journey for the tick, which every other journey moves
  // the page's clock through. An interval is the page's, not the engine's, so
  // one engine proves it.
  test.skip(browserName !== 'chromium', 'the real-time tick runs in Chromium only')
  test.setTimeout(60_000)
  const token = probe('wall-tick')

  const statusReads: number[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/__agent/status')
      statusReads.push(Date.now())
  })

  await open(page, token)
  await send(page, PICKED, `wall clock ${token}`)

  const from = statusReads.length
  await expect
    .poll(() => statusReads.length - from, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(4)
  const ticks = statusReads.slice(from, from + 4)
  const meanGap = (ticks[3]! - ticks[0]!) / 3
  // "About one to two seconds", with room above it for a loaded machine.
  expect(meanGap).toBeGreaterThan(1000)
  expect(meanGap).toBeLessThan(3000)
})
