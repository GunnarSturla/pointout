import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page, Request, Route } from '@playwright/test'

// Seam 2: Screen Capture as the developer meets it (spec §7's footer, §10,
// stories 66 to 68, 70, 71 and 74). The camera toggle in the Panel footer, the
// capture that fires at every pick whether or not it is on, the shutter the
// Overlay closes for it, and what a move, a discard and a Send do to the file.
//
// The dev server is seam 2's own, with ticket 17's fake `screencapture` first on
// its `PATH`, writing a known PNG. That server lives in Playwright's
// `globalSetup` process, so a spec cannot change the fake's mode between picks;
// the two cases that need a server this one is not — a capture that takes two
// seconds to answer, and a server whose capture is disabled — are made at the
// network, with the server's own 409 written out below as the contract it is.
// Seam 1 (`capture.test.ts`) is where the real 409 is proved.
//
// Every string is written out rather than imported (docs/agents/testing.md).

/** Where the fake session's inbox writes what it received (test/harness/serve.ts). */
const FRAMES_LOG_ENV = 'SEAM2_FRAMES_LOG'

/** Where every dev server keeps its captures: `<os tmp>/<this>/<pid>-<hex>/<id>.png`. */
const CAPTURE_ROOT = join(tmpdir(), 'vite-agent-inspect-captures')

const CAPTURE = '**/__agent/capture'

const PICKED = '[data-fixture="card-heading"]'
const SECOND_PICKED = '[data-fixture="passed-down-badge"]'
const THIRD_PICKED = 'h1'

const HOST = 'vite-agent-inspect'
const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const NOTE = '[data-part="note"]'
const FOOTER = '[data-part="footer"]'
const CAMERA = '[data-part="camera"]'
const CAMERA_OFF = '[data-part="camera-off"]'
const PANEL_STATUS = '[data-part="status"]'

/** Spec §17's word for a Pick that was written to its Target. */
const SENT = 'Sent'

/** What a disabled capture endpoint answers (ticket 17), written out. */
const DISABLED_REASON =
  "this dev server is not running on macOS (platform: linux), and v0 crops the display with macOS's own screencapture tool"

/** The toggle's standing choice, by origin, as the Overlay keeps it. */
const TOGGLE_KEY = 'vite-agent-inspect:screen-capture:'

function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
}

async function open(page: Page, token: string): Promise<void> {
  await page.goto(`/?probe=${token}`)
  await expect(page.locator(PICKER)).toBeVisible()
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  // Every fixture in the example app sits below the fold.
  await page.locator(selector).first().scrollIntoViewIfNeeded()
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

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

/** Alt held, and one click: with an unsubmitted Panel open, that moves the Pick. */
async function altClick(page: Page, selector: string): Promise<void> {
  const at = await centre(page, selector)
  await page.keyboard.down('Alt')
  await page.mouse.click(at.x, at.y)
  await page.keyboard.up('Alt')
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

/** Where a capture with this id is on disk, or null when it is on disk nowhere. */
function captureFile(id: string): string | null {
  if (!existsSync(CAPTURE_ROOT)) return null
  for (const server of readdirSync(CAPTURE_ROOT)) {
    const file = join(CAPTURE_ROOT, server, `${id}.png`)
    if (existsSync(file)) return file
  }
  return null
}

/** One capture request, as the page made it. */
interface CaptureCall {
  method: string
  /** The id a DELETE names, or the id a POST was answered with. */
  id: string | null
  body: Record<string, unknown> | null
}

/**
 * Every request the page makes to the capture endpoints, in the order it made
 * them, with each POST's answer filled in once it arrives.
 */
function recordCaptures(page: Page): CaptureCall[] {
  const calls: CaptureCall[] = []
  const byRequest = new Map<Request, CaptureCall>()
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/__agent/capture')) return
    const post = request.method() === 'POST'
    const call: CaptureCall = {
      method: request.method(),
      id: post
        ? null
        : decodeURIComponent(url.pathname.slice('/__agent/capture/'.length)),
      body: post ? (request.postDataJSON() as Record<string, unknown>) : null,
    }
    calls.push(call)
    byRequest.set(request, call)
  })
  page.on('response', async (response) => {
    const call = byRequest.get(response.request())
    if (!call || call.method !== 'POST' || !response.ok()) return
    // A test that has already finished with the page may end before the body
    // is read, and nothing is waiting on the id by then.
    const body = (await response.json().catch(() => ({}))) as { captureId?: string }
    call.id = body.captureId ?? null
  })
  return calls
}

const posts = (calls: CaptureCall[]) => calls.filter((call) => call.method === 'POST')

/** The id of the n-th capture the page started, once its POST has answered. */
async function startedId(calls: CaptureCall[], index: number): Promise<string> {
  await expect.poll(() => posts(calls)[index]?.id ?? null).not.toBeNull()
  return posts(calls)[index]?.id ?? ''
}

/** Answer every capture POST the way a dev server that cannot capture does. */
async function captureDisabled(page: Page): Promise<void> {
  await page.route(CAPTURE, (route: Route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'capture-disabled', reason: DISABLED_REASON }),
        })
      : route.continue(),
  )
}

/** A developer who turned the toggle on at some earlier visit. */
async function cameraLeftOn(page: Page): Promise<void> {
  await page.addInitScript(
    (key) => localStorage.setItem(key + location.origin, 'on'),
    TOGGLE_KEY,
  )
}

async function turnCameraOn(page: Page): Promise<void> {
  await page.locator(CAMERA).click()
  await expect(page.locator(CAMERA)).toHaveAttribute('aria-pressed', 'true')
}

type Seen = Record<string, unknown>

/**
 * The shutter, as the page saw it: every time the host closed or opened it,
 * whether the Highlight was on screen at that moment, and every property that
 * began to ease anywhere in the Overlay afterwards.
 */
async function watchShutter(page: Page): Promise<void> {
  await page.evaluate((tag) => {
    const host = document.querySelector(tag)
    const root = host?.shadowRoot
    if (!host || !root) throw new Error('the Overlay is not mounted')
    const seen: Array<Record<string, unknown>> = []
    Object.assign(window, { seenShutter: seen })
    new MutationObserver(() => {
      const box = root.querySelector('[data-part="highlight"]')
      seen.push({
        closed: host.hasAttribute('data-shutter'),
        at: performance.now(),
        highlight: box ? getComputedStyle(box).visibility : 'none',
      })
    }).observe(host, { attributes: true, attributeFilter: ['data-shutter'] })
    root.addEventListener('transitionrun', (event) => {
      const target = event.target as Element
      seen.push({
        eased: `${target.getAttribute('data-part')} ${(event as TransitionEvent).propertyName}`,
      })
    })
  }, HOST)
}

async function shutterSeen(page: Page): Promise<Seen[]> {
  return page.evaluate(
    () => (window as unknown as { seenShutter?: Seen[] }).seenShutter ?? [],
  )
}

/** The shutter's story with its clock taken out: what happened, in order. */
function sequenceOf(seen: Seen[]): string[] {
  return seen.map((entry) =>
    'eased' in entry
      ? `eased ${String(entry.eased)}`
      : `${entry.closed ? 'closed' : 'opened'}, highlight ${String(entry.highlight)}`,
  )
}

/** How long the shutter stayed closed, from the first close to the first open. */
function heldFor(seen: Seen[]): number {
  const closed = seen.find((entry) => entry.closed === true)
  const opened = seen.find((entry) => entry.closed === false)
  return Number(opened?.at) - Number(closed?.at)
}

async function highlightClosedAt(page: Page): Promise<boolean> {
  return page.evaluate((tag) => {
    const host = document.querySelector(tag)
    const box = host?.shadowRoot?.querySelector('[data-part="highlight"]')
    return (
      host?.hasAttribute('data-shutter') === true &&
      box instanceof Element &&
      getComputedStyle(box).visibility === 'hidden'
    )
  }, HOST)
}

function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test.describe('the camera toggle', () => {
  test('is the leftmost thing in the Panel footer', async ({ page }) => {
    await open(page, probe('camera-footer'))
    await arm(page)
    await pick(page, PICKED)

    const camera = page.locator(CAMERA)
    await expect(camera).toBeVisible()
    await expect(camera).toHaveAttribute('aria-pressed', 'false')
    const first = await page
      .locator(FOOTER)
      .evaluate((footer) => footer.firstElementChild?.getAttribute('data-part'))
    expect(first).toBe('camera')
  })

  test('stays as it was left across Picks and a reload', async ({ page }) => {
    await open(page, probe('camera-persists'))
    await arm(page)
    await pick(page, PICKED)
    await turnCameraOn(page)

    // A second Pick, after discarding the first.
    await page.keyboard.press('Escape')
    await expect(page.locator(PANEL)).toHaveCount(0)
    await pick(page, SECOND_PICKED)
    await expect(page.locator(CAMERA)).toHaveAttribute('aria-pressed', 'true')

    await page.reload()
    await expect(page.locator(PICKER)).toBeVisible()
    await arm(page)
    await pick(page, PICKED)
    await expect(page.locator(CAMERA)).toHaveAttribute('aria-pressed', 'true')

    // Off again is remembered the same way.
    await page.locator(CAMERA).click()
    await expect(page.locator(CAMERA)).toHaveAttribute('aria-pressed', 'false')
    await page.reload()
    await expect(page.locator(PICKER)).toBeVisible()
    await arm(page)
    await pick(page, PICKED)
    await expect(page.locator(CAMERA)).toHaveAttribute('aria-pressed', 'false')
  })

  test('is shown disabled, with the reason, when the server cannot capture', async ({
    page,
  }) => {
    await captureDisabled(page)
    const calls = recordCaptures(page)
    await open(page, probe('camera-disabled'))
    await arm(page)
    await pick(page, PICKED)

    const camera = page.locator(CAMERA)
    await expect(camera).toBeVisible()
    await expect(camera).toHaveAttribute('aria-disabled', 'true')
    await expect(camera).toHaveAttribute('aria-pressed', 'false')
    await expect(camera).toHaveAttribute('title', new RegExp(escaped(DISABLED_REASON)))

    // Asking for the reason shows it, and never turns the toggle on. Forced,
    // because Playwright will not click what says it is disabled; a developer
    // can, and that is how the reason is asked for.
    await camera.click({ force: true })
    await expect(page.locator(CAMERA_OFF)).toContainText(DISABLED_REASON)
    await expect(camera).toHaveAttribute('aria-pressed', 'false')

    // Told once, the page stops asking: the next Pick sends no capture request.
    await page.keyboard.press('Escape')
    await pick(page, SECOND_PICKED)
    await expect(page.locator(CAMERA)).toHaveAttribute('aria-disabled', 'true')
    expect(posts(calls)).toHaveLength(1)
  })

  test('left on, says so out loud when the server cannot capture', async ({ page }) => {
    await cameraLeftOn(page)
    await captureDisabled(page)
    await open(page, probe('camera-on-disabled'))
    await arm(page)
    await pick(page, PICKED)
    // No click asked for it: a developer who wants a capture is told there will
    // be none before they send, not afterwards by the agent.
    await expect(page.locator(CAMERA_OFF)).toContainText(DISABLED_REASON)
  })

  test('left on, a capture that could not be taken is said to the agent', async ({
    page,
  }) => {
    const token = probe('camera-intended')
    await cameraLeftOn(page)
    // Seam 2's server can capture, so it is the page that is refused here; the
    // Pick then names no capture, and the server says one was meant and why
    // there is none. Seam 1 holds the same line for a server that cannot.
    await captureDisabled(page)
    await open(page, token)
    await arm(page)
    await pick(page, PICKED)
    await expect(page.locator(CAMERA_OFF)).toBeVisible()

    await page.locator(NOTE).fill(`what is this ${token}`)
    await page.locator(NOTE).press('Enter')
    await expect(page.locator(PANEL_STATUS)).toHaveText(SENT)

    expect(await delivered(token)).toMatch(
      /screen capture\s+a capture was intended, and failed/,
    )
  })
})

test.describe('a capture at every pick', () => {
  test('is asked for at once, with where the element is, toggle or no toggle', async ({
    page,
  }) => {
    const calls = recordCaptures(page)
    await open(page, probe('capture-at-pick'))
    await arm(page)
    await pick(page, PICKED)
    await expect(page.locator(CAMERA)).toHaveAttribute('aria-pressed', 'false')

    await expect.poll(() => calls.length).toBe(1)
    const call = calls[0]
    expect(call?.method).toBe('POST')
    const box = await page.locator(PICKED).first().boundingBox()
    const seen = await page.evaluate(() => ({
      screenX: window.screenX,
      screenY: window.screenY,
      chromeWidth: window.outerWidth - window.innerWidth,
      chromeHeight: window.outerHeight - window.innerHeight,
      screen: { width: window.screen.width, height: window.screen.height },
    }))
    const body = call?.body as { rect: Record<string, number> } & Record<string, unknown>
    expect({
      x: Math.round(body.rect.x ?? NaN),
      y: Math.round(body.rect.y ?? NaN),
      width: Math.round(body.rect.width ?? NaN),
      height: Math.round(body.rect.height ?? NaN),
    }).toEqual({
      x: Math.round(box?.x ?? 0),
      y: Math.round(box?.y ?? 0),
      width: Math.round(box?.width ?? 0),
      height: Math.round(box?.height ?? 0),
    })
    expect({
      screenX: body.screenX,
      screenY: body.screenY,
      chromeWidth: body.chromeWidth,
      chromeHeight: body.chromeHeight,
      screen: body.screen,
    }).toEqual(seen)
  })

  test('never holds the Panel back, however long the capture takes', async ({ page }) => {
    // A capture that takes two seconds to answer. The request goes through at
    // once and its answer is held, which is the slower of the two cases: ticket
    // 17's server answers the id at once and runs the tool behind it.
    let answered = false
    await page.route(CAPTURE, async (route: Route) => {
      const response = await route.fetch()
      await new Promise((resolve) => setTimeout(resolve, 2000))
      answered = true
      await route.fulfill({ response })
    })
    await open(page, probe('capture-slow'))
    await arm(page)
    const at = await centre(page, PICKED)
    await page.mouse.move(at.x, at.y)
    await expect(page.locator(HIGHLIGHT).first()).toBeVisible()

    const clicked = Date.now()
    await page.mouse.click(at.x, at.y)
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 1000 })
    expect(Date.now() - clicked).toBeLessThan(1000)
    expect(answered).toBe(false)
    // The held answer outlives the test; left in flight, its fetch throws into
    // whichever test the worker runs next.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })
})

test.describe('the shutter', () => {
  test.use({ reducedMotion: 'no-preference' })

  /** One Pick, and the shutter it closed and opened, with nothing else moving. */
  async function shutterOf(page: Page, name: string): Promise<Seen[]> {
    await open(page, probe(name))
    await arm(page)
    // Hover first and let the Highlight settle, so what is recorded is the Pick
    // and nothing before it.
    const at = await centre(page, PICKED)
    await page.mouse.move(at.x, at.y)
    await expect(page.locator(HIGHLIGHT).first()).toBeVisible()
    await page.waitForTimeout(400)
    await watchShutter(page)
    await page.mouse.click(at.x, at.y)
    await expect(page.locator(PANEL)).toBeVisible()
    await expect.poll(async () => (await shutterSeen(page)).length).toBeGreaterThan(2)
    await page.waitForTimeout(400)
    return shutterSeen(page)
  }

  test('reads the same with the toggle on, off, and with capture disabled', async ({
    browser,
  }) => {
    const setUps: Array<[string, (page: Page) => Promise<void>]> = [
      ['shutter-on', cameraLeftOn],
      ['shutter-off', async () => {}],
      ['shutter-disabled', captureDisabled],
    ]
    const runs: Seen[][] = []
    for (const [name, setUp] of setUps) {
      const context = await browser.newContext({ reducedMotion: 'no-preference' })
      const page = await context.newPage()
      await setUp(page)
      runs.push(await shutterOf(page, name))
      const on = name === 'shutter-on' ? 'true' : 'false'
      await expect(page.locator(CAMERA)).toHaveAttribute('aria-pressed', on)
      await context.close()
    }

    const [first, ...rest] = runs.map(sequenceOf)
    // Closed with the Highlight gone at once, opened, and eased back in — and
    // exactly that, in the same order, in every run.
    expect(first?.slice(0, 2)).toEqual([
      'closed, highlight hidden',
      'opened, highlight visible',
    ])
    expect(first).toContain('eased highlight opacity')
    for (const run of rest) expect(run).toEqual(first)
    for (const run of runs) {
      expect(heldFor(run)).toBeGreaterThanOrEqual(200)
      expect(heldFor(run)).toBeLessThan(600)
    }
  })

  test('is closed while the capture is asked for', async ({ page }) => {
    let closedAtRequest: boolean | null = null
    await page.route(CAPTURE, async (route: Route) => {
      closedAtRequest = await highlightClosedAt(page)
      await route.continue()
    })
    await open(page, probe('shutter-closed'))
    await arm(page)
    await pick(page, PICKED)
    await expect.poll(() => closedAtRequest).toBe(true)
  })
})

test.describe('the shutter under reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('hides and shows at once, and is still closed for the capture', async ({
    page,
  }) => {
    let closedAtRequest: boolean | null = null
    await page.route(CAPTURE, async (route: Route) => {
      closedAtRequest = await highlightClosedAt(page)
      await route.continue()
    })
    await open(page, probe('shutter-reduced'))
    await arm(page)
    const at = await centre(page, PICKED)
    await page.mouse.move(at.x, at.y)
    await expect(page.locator(HIGHLIGHT).first()).toBeVisible()
    await watchShutter(page)
    await page.mouse.click(at.x, at.y)
    await expect(page.locator(PANEL)).toBeVisible()
    await expect.poll(() => closedAtRequest).toBe(true)
    await expect.poll(async () => (await shutterSeen(page)).length).toBeGreaterThan(1)
    await page.waitForTimeout(300)

    // Nothing eased: the Overlay left and came back, and that is all.
    expect(sequenceOf(await shutterSeen(page))).toEqual([
      'closed, highlight hidden',
      'opened, highlight visible',
    ])
    const opacity = await page.evaluate((tag) => {
      const box = document
        .querySelector(tag)
        ?.shadowRoot?.querySelector('[data-part="highlight"]')
      return box ? getComputedStyle(box).opacity : null
    }, HOST)
    expect(opacity).toBe('1')
  })
})

test.describe('a capture that is moved, discarded or sent', () => {
  test('a move deletes the capture it leaves before it takes the next', async ({
    page,
  }) => {
    const calls = recordCaptures(page)
    await open(page, probe('capture-move'))
    await arm(page)
    await pick(page, PICKED)
    const first = await startedId(calls, 0)

    // Watch the disk the whole time the Pick is moved through three elements.
    const ids = new Set<string>()
    let most = 0
    const watching = setInterval(() => {
      for (const call of calls) if (call.id) ids.add(call.id)
      const present = [...ids].filter((id) => captureFile(id) !== null).length
      most = Math.max(most, present)
    }, 2)
    try {
      await altClick(page, SECOND_PICKED)
      const second = await startedId(calls, 1)
      await altClick(page, THIRD_PICKED)
      const third = await startedId(calls, 2)
      await expect.poll(() => captureFile(third)).not.toBeNull()

      expect(calls.map((call) => `${call.method} ${call.id}`)).toEqual([
        `POST ${first}`,
        `DELETE ${first}`,
        `POST ${second}`,
        `DELETE ${second}`,
        `POST ${third}`,
      ])
      expect(captureFile(first)).toBeNull()
      expect(captureFile(second)).toBeNull()

      // Discarded: `Escape` deletes the last one too.
      await page.keyboard.press('Escape')
      await expect(page.locator(PANEL)).toHaveCount(0)
      await expect
        .poll(() => calls.map((call) => `${call.method} ${call.id}`).at(-1))
        .toBe(`DELETE ${third}`)
      await expect.poll(() => captureFile(third)).toBeNull()
    } finally {
      clearInterval(watching)
    }
    expect(most).toBe(1)
  })

  test('sent with the toggle on, the agent is handed the file', async ({ page }) => {
    const token = probe('capture-kept')
    const calls = recordCaptures(page)
    await open(page, token)
    await arm(page)
    await pick(page, PICKED)
    await turnCameraOn(page)
    const id = await startedId(calls, 0)

    await page.locator(NOTE).fill(`what is this ${token}`)
    await page.locator(NOTE).press('Enter')
    await expect(page.locator(PANEL_STATUS)).toHaveText(SENT)

    const body = await delivered(token)
    const line = new RegExp(`^.*screen capture\\s+(\\S*${id}\\.png)`, 'm').exec(body)
    const file = line?.[1] ?? ''
    expect(file).not.toBe('')
    expect(existsSync(file)).toBe(true)
    // It is the server's to keep now: nothing on the page deletes it.
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0)
  })

  test('sent with the toggle off, no line travels and the file is gone', async ({
    page,
  }) => {
    const token = probe('capture-deleted')
    const calls = recordCaptures(page)
    await open(page, token)
    await arm(page)
    await pick(page, PICKED)
    const id = await startedId(calls, 0)
    await expect.poll(() => captureFile(id)).not.toBeNull()

    await page.locator(NOTE).fill(`what is this ${token}`)
    await page.locator(NOTE).press('Enter')
    await expect(page.locator(PANEL_STATUS)).toHaveText(SENT)

    const body = await delivered(token)
    expect(body).not.toContain('screen capture')
    expect(body).not.toContain(id)
    expect(captureFile(id)).toBeNull()
  })

  test('a reload with a Pick still open deletes its capture', async ({ page }) => {
    const calls = recordCaptures(page)
    await open(page, probe('capture-reload'))
    await arm(page)
    await pick(page, PICKED)
    const id = await startedId(calls, 0)
    await expect.poll(() => captureFile(id)).not.toBeNull()

    await page.reload()
    await expect(page.locator(PICKER)).toBeVisible()
    await expect.poll(() => captureFile(id)).toBeNull()
  })

  test('a move while the Send is in flight leaves the sent capture alone', async ({
    page,
  }) => {
    const token = probe('capture-in-flight')
    const calls = recordCaptures(page)
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    await page.route('**/__agent/pick', async (route: Route) => {
      await held
      await route.continue()
    })
    await open(page, token)
    await arm(page)
    await pick(page, PICKED)
    await turnCameraOn(page)
    const sent = await startedId(calls, 0)

    await page.locator(NOTE).fill(`what is this ${token}`)
    await page.locator(NOTE).press('Enter')
    // The Send is on its way and not yet answered; the developer moves the Pick.
    await altClick(page, SECOND_PICKED)
    const moved = await startedId(calls, 1)
    release()
    await expect(page.locator(PANEL_STATUS)).toHaveText(SENT)

    const body = await delivered(token)
    expect(body).toContain(`${sent}.png`)
    expect(captureFile(sent)).not.toBeNull()
    expect(calls.filter((call) => call.method === 'DELETE' && call.id === sent)).toEqual(
      [],
    )
    // The one the move took belongs to no Pick once the Send is accepted.
    await expect.poll(() => captureFile(moved)).toBeNull()
  })
})
