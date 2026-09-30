import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Seam 2: spec §21's "every 4xx reason shown inline in the Overlay", for the two
// capture refusals no other journey reached (ticket 19's audit). Each refusal is
// the real server's: the page's own request is changed on its way out, so the
// server refuses it and the words the Panel shows are the server's. `Origin`
// cannot be stripped from a browser request in any engine, so neither journey
// tries; a body the server cannot read and a method it does not answer are
// refusals it really makes.
//
// Every string is written out rather than imported (docs/agents/testing.md).

const CAPTURE = '**/__agent/capture'
const CAPTURE_ITEM = '**/__agent/capture/*'

const PICKED = '[data-fixture="card-heading"]'
const SECOND_PICKED = '[data-fixture="passed-down-badge"]'

const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const CAMERA_FAILED = '[data-part="camera-failed"]'

/** The toggle's standing choice, by origin, as the Overlay keeps it. */
const TOGGLE_KEY = 'pointout:screen-capture:'

/** The Panel's words for a capture the server refused to start (ticket 18). */
const captureFailed = (reason: string) => `No Screen Capture for this pick: ${reason}`
/** And for one it refused to delete. */
const captureNotDeleted = (reason: string) =>
  `A Screen Capture could not be deleted (${reason}). The dev server removes it when it stops.`

function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
}

async function open(page: Page, token: string): Promise<void> {
  await page.goto(`/?probe=${token}`)
  await expect(page.locator(PICKER)).toBeVisible()
}

async function arm(page: Page): Promise<void> {
  const picker = page.locator(PICKER)
  await picker.click()
  if ((await picker.getAttribute('data-armed')) === null) await picker.click()
  await expect(picker).toHaveAttribute('data-armed', '')
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  // Every fixture in the example app sits below the fold.
  await page.locator(selector).first().scrollIntoViewIfNeeded()
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
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

async function cameraLeftOn(page: Page): Promise<void> {
  await page.addInitScript(
    (key) => localStorage.setItem(key + location.origin, 'on'),
    TOGGLE_KEY,
  )
}

test.afterEach(async ({ page }) => {
  // A route left behind throws into the next test on this worker.
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a capture the server refused to start says why in the Panel, in its words', async ({
  page,
}) => {
  await cameraLeftOn(page)
  // The coordinates go out empty, so the real server refuses them with a 400.
  await page.route(CAPTURE, (route) =>
    route.request().method() === 'POST'
      ? route.continue({ postData: '{}' })
      : route.continue(),
  )
  await open(page, probe('capture-refused'))
  await arm(page)

  const refused = page.waitForResponse(
    (response) =>
      response.url().endsWith('/__agent/capture') &&
      response.request().method() === 'POST',
  )
  await pick(page, PICKED)
  const response = await refused
  expect(response.status()).toBe(400)
  const { reason } = (await response.json()) as { reason: string }
  expect(reason).toBeTruthy()

  await expect(page.locator(CAMERA_FAILED)).toHaveText(captureFailed(reason))
})

test('a capture the server refused to delete says so in the Panel, in its words', async ({
  page,
}) => {
  // Every DELETE goes out as a PUT, which the real server refuses with a 405.
  await page.route(CAPTURE_ITEM, (route) =>
    route.request().method() === 'DELETE'
      ? route.continue({ method: 'PUT' })
      : route.continue(),
  )
  await open(page, probe('delete-refused'))
  await arm(page)

  const started = page.waitForResponse(
    (response) =>
      response.url().endsWith('/__agent/capture') &&
      response.request().method() === 'POST',
  )
  await pick(page, PICKED)
  const { captureId } = (await (await started).json()) as { captureId: string }

  // Moving the Pick lets go of the capture it held, and asks for it to go.
  await altClick(page, SECOND_PICKED)

  await expect(page.locator(CAMERA_FAILED)).toHaveText(
    captureNotDeleted(`/__agent/capture/${captureId} answers DELETE, not PUT`),
  )
})
