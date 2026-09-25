import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page, Route } from '@playwright/test'

// Seam 2: targeting inside the Panel (spec §7, §14, §17). Which session a Pick
// is addressed to, how a developer sees and changes it, what the Panel says when
// there is none or the registry cannot be read — and what happens when the
// Target vanishes between naming and sending.
//
// Every string here is written out rather than imported: the endpoint paths, the
// `/sessions` payload, the refusal's field names and the Overlay's own part
// names are the contract (docs/agents/testing.md). Nothing imports a server
// module, and the fake sessions are the ones `test/harness/serve.ts` bound.

const SESSIONS = '**/__agent/sessions'
const PICK_URL = '/__agent/pick'

/** Spec §14: the Overlay's one tick, "about one to two seconds". */
const TICK_MS = 1500

/** Where the second fake session's inbox writes what it received. */
const SECOND_FRAMES_LOG_ENV = 'SEAM2_SECOND_FRAMES_LOG'

/** The four sessions `globalSetup` bound, as it named them. */
const STARTED_NAME = 'seam 2 fake session'
const SECOND_NAME = 'seam 2 second session'
const SECOND_PID = 400_002
/** `test/harness/registry.ts` names a fake session by its pid. */
const SECOND_SESSION_ID = 'session-400002'
const WAITING_NAME = 'seam 2 waiting session'
/** Addressed only by the report-back journeys, which end its turns on purpose. */
const REPORT_BACK_NAME = 'seam 2 report-back session'
const WAITING_FOR = 'Bash(rm -rf build)'
const OTHER_REPO_NAME = 'seam 2 other repo session'

const PICKED = '[data-fixture="card-heading"]'
// Any focusable element of the app's own will do. The test bed loads without its
// decoy, so its "Show decoy" button is on the page from the start.
const APP_FOCUSABLE = '[data-fixture="full-viewport-decoy-restore"]'

const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const NOTE = '[data-part="note"]'
const EMPTY = '[data-part="empty"]'
const SEND = '[data-part="send"]'
const CANCEL = '[data-part="cancel"]'
const TARGET = '[data-part="target"]'
const TARGETS = '[data-part="targets"]'
const ROW = '[data-part="target-row"]'
const ROW_NAME = '[data-part="row-name"]'
const ROW_STATUS = '[data-part="row-status"]'
const ROW_AGE = '[data-part="row-age"]'
const ROW_WAITING = '[data-part="row-waiting"]'
const STARTED = '[data-part="row-started"]'
const DOT = '[data-part="dot"]'
const TARGET_STATUS = '[data-part="target-status"]'
const TARGET_AGE = '[data-part="target-age"]'
const STATUS = '[data-part="status"]'

/** What `GET /__agent/sessions` answers, in the shape §20 publishes it. */
interface CandidatePayload {
  name: string
  status: string
  waitingFor: string | null
  statusUpdatedAt: string | null
  pid: number
  sessionId: string
  startedThisServer: boolean
}

function candidate(overrides: Partial<CandidatePayload> = {}): CandidatePayload {
  return {
    name: 'a session',
    status: 'idle',
    waitingFor: null,
    statusUpdatedAt: null,
    pid: 900_001,
    sessionId: 'session-900001',
    startedThisServer: false,
    ...overrides,
  }
}

function sessionsBody(
  candidates: CandidatePayload[],
  registry: { state?: string; hookFloor?: boolean } = {},
): string {
  return JSON.stringify({
    registry: {
      state: registry.state ?? 'readable',
      hookFloor: registry.hookFloor ?? false,
      rejected: 0,
      directory: '/fake/registry',
    },
    candidates,
  })
}

/** One probe token per test, carried in the url so its frame can be found. */
function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
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

async function open(page: Page, token: string): Promise<void> {
  await page.goto(`/?probe=${token}`)
  await expect(page.locator(PICKER)).toBeVisible()
}

async function pick(page: Page): Promise<void> {
  await page.locator(PICKER).click()
  const box = await page.locator(PICKED).first().boundingBox()
  if (!box) throw new Error(`${PICKED} has no box`)
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
}

/** Every `user` frame one fake session's inbox received, oldest first. */
function deliveredTo(logEnv: string): string[] {
  const log = process.env[logEnv]
  if (!log) throw new Error(`${logEnv} is unset: seam 2's globalSetup did not run`)
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((frame) => frame.type === 'user')
    .map((frame) => (frame.message as { content: string }).content)
}

/** The one body at that session whose page url carries this test's token. */
async function delivered(logEnv: string, token: string): Promise<string> {
  let found: string | undefined
  await expect
    .poll(
      () => {
        found = deliveredTo(logEnv).find((content) => content.includes(token))
        return found !== undefined
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return found ?? ''
}

test('the footer shows the preselected Target and the row lists every Candidate', async ({
  page,
}) => {
  const token = probe('choose')
  await open(page, token)
  await pick(page)

  // Step 1 of §14's chain: the session that started this dev server.
  await expect(page.locator(TARGET)).toHaveText(`${STARTED_NAME} Ready`)

  await page.locator(TARGET).click()
  const rows = page.locator(`${TARGETS} ${ROW}`)
  await expect(rows).toHaveCount(4)
  await expect(rows.locator(ROW_NAME)).toHaveText([
    STARTED_NAME,
    SECOND_NAME,
    WAITING_NAME,
    REPORT_BACK_NAME,
  ])

  // Said on the one that started this dev server, and nowhere else.
  await expect(page.locator(`${TARGETS} ${STARTED}`)).toHaveCount(1)
  await expect(rows.nth(0).locator(STARTED)).toHaveText('started this server')

  // `statusUpdatedAt` three days ago, and a permission prompt named.
  await expect(rows.nth(1).locator(ROW_AGE)).toHaveText('3d')
  await expect(rows.nth(1).locator(ROW_AGE)).toHaveAttribute('title', 'Idle for 3 days')
  await expect(rows.nth(2).locator(ROW_STATUS)).toHaveText('Needs you')
  await expect(rows.nth(2).locator(ROW_WAITING)).toContainText(WAITING_FOR)

  // Another checkout is never offered (spec §14, story 36).
  await expect(page.locator(TARGETS)).not.toContainText(OTHER_REPO_NAME)

  await rows.nth(1).click()
  await expect(page.locator(TARGETS)).toHaveCount(0)
  await expect(page.locator(TARGET)).toHaveText(`${SECOND_NAME} Ready 3d`)

  // Choosing a Target leaves focus on the row that was clicked: the Panel takes
  // focus on its own opening and never again (spec §7).
  const note = `send this one elsewhere ${token}`
  await page.locator(NOTE).click()
  await page.keyboard.type(note)
  await page.keyboard.press('Enter')
  await expect(page.locator(STATUS)).toHaveText('Sent')

  expect(await delivered(SECOND_FRAMES_LOG_ENV, token)).toContain(note)
})

test('the last Target used from this origin is preselected until it stops being a Candidate', async ({
  page,
}) => {
  await open(page, probe('remembered'))
  await pick(page)
  await page.locator(TARGET).click()
  await page.locator(`${TARGETS} ${ROW}`).nth(1).click()
  await expect(page.locator(TARGET)).toHaveText(`${SECOND_NAME} Ready 3d`)

  // Step 3: a reload is a fresh Overlay, and the choice outlives it.
  await page.reload()
  await pick(page)
  await expect(page.locator(TARGET)).toHaveText(`${SECOND_NAME} Ready 3d`)

  // Honoured only while still a Candidate: with that session gone from the
  // registry the chain falls back to the one that started this dev server.
  await page.route(SESSIONS, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: sessionsBody([
        candidate({
          name: STARTED_NAME,
          pid: 400_001,
          sessionId: 'session-400001',
          startedThisServer: true,
        }),
        candidate({ name: WAITING_NAME, pid: 400_003, sessionId: 'session-400003' }),
      ]),
    }),
  )
  await page.reload()
  await pick(page)
  await expect(page.locator(TARGET)).toHaveText(`${STARTED_NAME} Ready`)
})

test('a Target blocked on a permission prompt is flagged and stays selectable', async ({
  page,
}) => {
  await open(page, probe('waiting'))
  await pick(page)

  await page.locator(TARGET).click()
  const waiting = page.locator(`${TARGETS} ${ROW}`).nth(2)
  await expect(waiting.locator(ROW_WAITING)).toContainText(WAITING_FOR)

  await waiting.click()
  await expect(page.locator(TARGET)).toContainText(
    `${WAITING_NAME} is blocked on a permission prompt`,
  )
  await expect(page.locator(TARGET)).toContainText('approve it in your terminal')
  await expect(page.locator(SEND)).toBeEnabled()
})

test('a Target that vanished between naming and sending is named, never swapped', async ({
  page,
}) => {
  const token = probe('retarget')

  // The Target leaves the registry after the Pick was written: the server
  // re-resolves at Send and answers 409 naming the replacement (spec §14).
  let refusals = 0
  await page.route(`**${PICK_URL}`, async (route: Route) => {
    if (refusals > 0) return route.continue()
    refusals += 1
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'target-replaced',
        reason: 'refused a Pick addressed to a session that has left.',
        replacement: {
          sessionId: SECOND_SESSION_ID,
          pid: SECOND_PID,
          name: SECOND_NAME,
        },
      }),
    })
  })

  await open(page, token)
  await pick(page)
  // A Target has to be named before it can vanish between naming and sending,
  // and the first `/sessions` read is what names it. Sending before it lands
  // tests the other branch of §14 — the one where nothing was named at all —
  // and the two were about two milliseconds apart.
  await expect(page.locator(TARGET)).toContainText(STARTED_NAME)
  const note = `this one has to be asked about ${token}`
  await page.keyboard.type(note)
  await page.keyboard.press('Enter')

  // Morphed in place, never a dialog, and the Note is untouched.
  await expect(page.locator(TARGET)).toHaveText(
    `${STARTED_NAME} is gone. Send to ${SECOND_NAME}?`,
  )
  await expect(page.locator(SEND)).toHaveText('Confirm')
  await expect(page.locator(NOTE)).toHaveValue(note)

  await page.locator(SEND).click()
  await expect(page.locator(STATUS)).toHaveText('Sent')
  expect(await delivered(SECOND_FRAMES_LOG_ENV, token)).toContain(note)
})

test('cancelling the replacement sends nothing', async ({ page }) => {
  const token = probe('cancelled')

  let posts = 0
  page.on('request', (request) => {
    if (request.url().includes(PICK_URL) && request.method() === 'POST') posts += 1
  })
  await page.route(`**${PICK_URL}`, (route: Route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'target-replaced',
        reason: 'refused a Pick addressed to a session that has left.',
        replacement: {
          sessionId: SECOND_SESSION_ID,
          pid: SECOND_PID,
          name: SECOND_NAME,
        },
      }),
    }),
  )

  // The page's clock, so the second after the cancel is moved through rather
  // than waited out.
  await page.clock.install()
  await open(page, token)
  await pick(page)
  await page.keyboard.type(`never sent ${token}`)
  await page.keyboard.press('Enter')
  await expect(page.locator(CANCEL)).toBeVisible()

  await page.locator(CANCEL).click()
  await expect(page.locator(CANCEL)).toHaveCount(0)
  await expect(page.locator(SEND)).toHaveText('Send')
  await expect(page.locator(STATUS)).toHaveCount(0)

  // One POST was made and refused; cancelling made no second one. A tick's
  // worth of the page's time, and then a sessions read answered after it: the
  // page has had its timers and a round trip to make a second POST in.
  const answered = page.waitForResponse((response) =>
    response.url().includes('/__agent/sessions'),
  )
  await page.clock.runFor(TICK_MS)
  await answered
  expect(posts).toBe(1)
})

test('with no session running the input is replaced by the message, and morphs back', async ({
  page,
}) => {
  let candidates: CandidatePayload[] = []
  await page.route(SESSIONS, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: sessionsBody(candidates),
    }),
  )

  await open(page, probe('empty'))
  await pick(page)

  await expect(page.locator(EMPTY)).toHaveText(
    'No Claude session is running in this folder',
  )
  await expect(page.locator(NOTE)).toHaveCount(0)
  await expect(page.locator(TARGET)).toHaveCount(0)

  // A session appears; the on-demand tick is what notices.
  candidates = [candidate({ name: 'started mid-Pick', startedThisServer: true })]
  await expect(page.locator(NOTE)).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator(EMPTY)).toHaveCount(0)
  await expect(page.locator(TARGET)).toHaveText('started mid-Pick Ready')

  // Focus had not moved into the app, so the late input takes it (spec §7).
  await expect(page.locator(NOTE)).toBeFocused()
})

test('the late-arriving input does not take focus that moved into the app', async ({
  page,
}) => {
  let candidates: CandidatePayload[] = []
  await page.route(SESSIONS, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: sessionsBody(candidates),
    }),
  )

  await open(page, probe('focus-kept'))
  await pick(page)
  await expect(page.locator(EMPTY)).toBeVisible()

  await page.locator(APP_FOCUSABLE).focus()
  await expect(page.locator(APP_FOCUSABLE)).toBeFocused()

  candidates = [candidate({ name: 'started mid-Pick', startedThisServer: true })]
  await expect(page.locator(NOTE)).toHaveCount(1, { timeout: 10_000 })
  await expect(page.locator(NOTE)).not.toBeFocused()
  await expect(page.locator(APP_FOCUSABLE)).toBeFocused()
})

test('with nothing preselected Send is off and the footer says why', async ({ page }) => {
  // Step 4 of §14's chain: several Candidates, none of them the `CLAUDE_PID`
  // match and none remembered, so the Overlay chooses nothing for the developer.
  await page.route(SESSIONS, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: sessionsBody([
        candidate({ name: 'one of two', pid: 900_101, sessionId: 'session-900101' }),
        candidate({ name: 'two of two', pid: 900_102, sessionId: 'session-900102' }),
      ]),
    }),
  )

  await open(page, probe('undecided'))
  await pick(page)

  await expect(page.locator(SEND)).toBeDisabled()
  await expect(page.locator(TARGET)).toHaveText('Choose which session this goes to')

  await page.locator(TARGET).click()
  await page.locator(`${TARGETS} ${ROW}`).nth(1).click()
  await expect(page.locator(TARGET)).toHaveText('two of two Ready')
  await expect(page.locator(SEND)).toBeEnabled()
})

test('an unreadable registry keeps the input, says so, and offers no rows', async ({
  page,
}) => {
  await page.route(SESSIONS, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: sessionsBody([], { state: 'directory-missing', hookFloor: true }),
    }),
  )

  await open(page, probe('degraded'))
  await pick(page)

  await expect(page.locator(NOTE)).toHaveCount(1)
  await expect(page.locator(EMPTY)).toHaveCount(0)
  await expect(page.locator(TARGET)).toHaveText(
    "Can't see your sessions — sending the slower way",
  )

  await page.locator(TARGET).click()
  await expect(page.locator(TARGETS)).toHaveCount(0)
})

test('sessions are read only while the Panel is open', async ({ page }) => {
  let reads = 0
  page.on('request', (request) => {
    if (request.url().includes('/__agent/sessions')) reads += 1
  })

  // The page's clock, so the idle stretches are moved through rather than
  // waited out. The tick is proved on the wall clock once, in Chromium, by
  // surfaces.spec.ts's `the tick runs on the wall clock`.
  await page.clock.install()
  await open(page, probe('polling'))

  // An idle page reads nothing at all (spec §14).
  await page.clock.runFor(5000)
  await settle(page)
  expect(reads).toBe(0)

  await pick(page)
  await page.clock.runFor(2 * TICK_MS)
  await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(1)

  await page.keyboard.press('Escape')
  await expect(page.locator(PANEL)).toHaveCount(0)
  const afterClosing = reads
  await page.clock.runFor(3000)
  await settle(page)
  expect(reads).toBe(afterClosing)
})
/** Four Candidates, one in each state the Session list tells apart. */
function everyState(): CandidatePayload[] {
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000 - 60_000).toISOString()
  return [
    candidate({ name: 'ready one', pid: 900_201, sessionId: 'session-900201' }),
    candidate({
      name: 'working one',
      status: 'busy',
      pid: 900_202,
      sessionId: 'session-900202',
    }),
    candidate({
      name: 'blocked one',
      status: 'waiting',
      waitingFor: WAITING_FOR,
      pid: 900_203,
      sessionId: 'session-900203',
    }),
    candidate({
      name: 'old one',
      statusUpdatedAt: threeDaysAgo,
      pid: 900_204,
      sessionId: 'session-900204',
    }),
  ]
}

async function serveEveryState(page: Page): Promise<void> {
  await page.route(SESSIONS, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: sessionsBody(everyState()),
    }),
  )
}

/**
 * The CSS animations running on a dot and on its rings, by name. The rings are
 * the dot's own pseudo-elements, which `subtree` reaches.
 */
async function running(page: Page, dot: string): Promise<string[]> {
  return page.locator(dot).evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === 'running')
      .map((animation) => (animation as CSSAnimation).animationName),
  )
}

/** The dot of the Session list's row at `at`, counted from one. */
function rowDot(at: number): string {
  return `${TARGETS} ${ROW}:nth-child(${at}) ${DOT}`
}

test('the Session list says Ready, Working and Needs you, each beside its dot', async ({
  page,
}) => {
  await serveEveryState(page)
  await open(page, probe('every-state'))
  await pick(page)
  await page.locator(TARGET).click()

  const rows = page.locator(`${TARGETS} ${ROW}`)
  await expect(rows).toHaveCount(4)
  await expect(rows.locator(ROW_STATUS)).toHaveText([
    'Ready',
    'Working',
    'Needs you',
    'Ready',
  ])
  const dots = rows.locator(DOT)
  await expect(dots).toHaveCount(4)
  for (const [at, status] of ['ready', 'working', 'needs', 'ready'].entries()) {
    await expect(dots.nth(at)).toHaveAttribute('data-status', status)
  }

  // Each state is its own colour, and the same state is the same colour.
  const colours = await dots.evaluateAll((all) =>
    all.map((dot) => getComputedStyle(dot).backgroundColor),
  )
  expect(new Set(colours.slice(0, 3)).size).toBe(3)
  expect(colours[3]).toBe(colours[0])

  // A waiting one says what it waits for; the others say nothing more.
  await expect(rows.nth(2).locator(ROW_WAITING)).toHaveText(WAITING_FOR)
  await expect(page.locator(`${TARGETS} ${ROW_WAITING}`)).toHaveCount(1)

  // Only the long-idle one carries an age, in figures that line up.
  await expect(page.locator(`${TARGETS} ${ROW_AGE}`)).toHaveCount(1)
  const age = rows.nth(3).locator(ROW_AGE)
  await expect(age).toHaveText('3d')
  await expect(age).toHaveAttribute('title', 'Idle for 3 days')
  await expect(age).toHaveCSS('font-variant-numeric', 'tabular-nums')

  // With motion allowed, Working pulses and Needs you rings; Ready holds still.
  expect(await running(page, rowDot(1))).toEqual([])
  expect((await running(page, rowDot(2))).length).toBeGreaterThan(0)
  expect((await running(page, rowDot(3))).length).toBeGreaterThan(0)
  expect(await running(page, rowDot(4))).toEqual([])
})

test('the Target row says each state in words beside its dot, and a long idle as 3d', async ({
  page,
}) => {
  await serveEveryState(page)
  await open(page, probe('target-states'))
  await pick(page)
  const choose = async (name: string) => {
    await page.locator(TARGET).click()
    await page.locator(`${TARGETS} ${ROW}`).filter({ hasText: name }).click()
    await expect(page.locator(TARGETS)).toHaveCount(0)
  }

  await choose('ready one')
  await expect(page.locator(TARGET)).toHaveText('ready one Ready')
  await expect(page.locator(`${TARGET} ${DOT}`)).toHaveAttribute('data-status', 'ready')
  await expect(page.locator(TARGET_AGE)).toHaveCount(0)

  await choose('working one')
  await expect(page.locator(TARGET)).toHaveText('working one Working')
  await expect(page.locator(TARGET_STATUS)).toHaveText('Working')
  await expect(page.locator(`${TARGET} ${DOT}`)).toHaveAttribute('data-status', 'working')
  // With motion allowed the Target row's own dot pulses too.
  expect((await running(page, `${TARGET} ${DOT}`)).length).toBeGreaterThan(0)

  await choose('blocked one')
  await expect(page.locator(TARGET)).toContainText(
    'blocked one is blocked on a permission prompt',
  )
  await expect(page.locator(TARGET)).toContainText('approve it in your terminal')
  await expect(page.locator(`${TARGET} ${DOT}`)).toHaveAttribute('data-status', 'needs')

  await choose('old one')
  await expect(page.locator(TARGET)).toHaveText('old one Ready 3d')
  await expect(page.locator(TARGET_AGE)).toHaveAttribute('title', 'Idle for 3 days')
  await expect(page.locator(TARGET_AGE)).toHaveCSS('font-variant-numeric', 'tabular-nums')
})

test('under reduced motion no pulse or ring animates', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await serveEveryState(page)
  await open(page, probe('still'))
  await pick(page)
  await page.locator(TARGET).click()
  await expect(page.locator(`${TARGETS} ${ROW}`)).toHaveCount(4)

  for (const at of [1, 2, 3, 4]) expect(await running(page, rowDot(at))).toEqual([])
  // The dots are still there, and still say which is which.
  await expect(page.locator(`${TARGETS} ${DOT}[data-status="working"]`)).toBeVisible()
  await expect(page.locator(`${TARGETS} ${DOT}[data-status="needs"]`)).toBeVisible()

  // Nor does the Target row's, working or blocked.
  for (const name of ['working one', 'blocked one']) {
    await page.locator(`${TARGETS} ${ROW}`).filter({ hasText: name }).click()
    await expect(page.locator(TARGETS)).toHaveCount(0)
    await expect(page.locator(`${TARGET} ${DOT}`)).toHaveAttribute(
      'data-status',
      name === 'working one' ? 'working' : 'needs',
    )
    expect(await running(page, `${TARGET} ${DOT}`)).toEqual([])
    await page.locator(TARGET).click()
  }
})
