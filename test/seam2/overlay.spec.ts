import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Seam 2: the tracer bullet, in three engines. Arm, hover, pick, write, send —
// and read the frame that reached the fake session's inbox.
//
// Every string here is written out rather than imported: the endpoint path, the
// frame field names, the fence shape and the Overlay's own part names are the
// contract (docs/agents/testing.md). Nothing imports a server module.

/** Where the fake session's inbox writes what it received (test/harness/serve.ts). */
const FRAMES_LOG_ENV = 'SEAM2_FRAMES_LOG'

/** The fake session seam 2 addresses, as `globalSetup` named it. */
const TARGET_NAME = 'seam 2 fake session'

/**
 * The fixture the journeys here pick. Its owner is `CardHeading`, and the app
 * frame of that owner's `_debugStack` is a plain call in `ArticleCard` — which
 * every engine keeps. The `<article>` beside it would not do: WebKit elides the
 * frame of the `.map()` callback that creates it, which is spec §12's
 * tail-deleted frame arriving early, and ticket 05 is where it gets a name.
 */
const PICKED = '[data-fixture="card-heading"]'
const PICKED_TAG = 'h3'
const OWNER_NAME = 'CardHeading'
const OWNER_FILE = 'NestedOwners.tsx'

const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const CHIP_NAME = '[data-part="chip-name"]'
const CHIP_FILE = '[data-part="chip-file"]'
const PANEL = '[data-part="panel"]'
const NOTE = '[data-part="note"]'
const SEND = '[data-part="send"]'
const TARGET = '[data-part="target"]'
const STATUS = '[data-part="status"]'

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

/** The one delivered body whose page url carries this test's probe token. */
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

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return box
}

/** Arm with the Picker, which stays armed without a key held down. */
async function arm(page: Page): Promise<void> {
  await page.locator(PICKER).click()
}

async function pick(page: Page, selector: string): Promise<void> {
  const at = await centre(page, selector)
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
}

test('holding Alt and hovering shows the Highlight and a chip naming the component and its file', async ({
  page,
}) => {
  await open(page, probe('alt'))
  await expect(page.locator(HIGHLIGHT)).toBeHidden()

  const at = await centre(page, PICKED)
  await page.keyboard.down('Alt')
  await page.mouse.move(at.x, at.y)

  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await expect(page.locator(CHIP_NAME)).toHaveText(OWNER_NAME)
  await expect(page.locator(CHIP_FILE)).toHaveText(OWNER_FILE)

  await page.keyboard.up('Alt')
  await expect(page.locator(HIGHLIGHT)).toBeHidden()
})

test('clicking the Picker arms, and the same Highlight and chip appear on hover', async ({
  page,
}) => {
  await open(page, probe('picker'))
  await arm(page)

  const at = await centre(page, PICKED)
  await page.mouse.move(at.x, at.y)

  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await expect(page.locator(CHIP_NAME)).toHaveText(OWNER_NAME)
  await expect(page.locator(CHIP_FILE)).toHaveText(OWNER_FILE)
})

test('while armed, the computed styles of page elements are unchanged but the cursor', async ({
  page,
}) => {
  await open(page, probe('styles'))

  // Everything but `cursor`, on a heading, a card, a paragraph and the body:
  // arming changes the pointer and nothing else (spec §4).
  const styles = () =>
    page.evaluate(() => {
      const snapshot: Record<string, Record<string, string>> = {}
      for (const selector of ['h1', 'article', 'p', 'body']) {
        const element = document.querySelector(selector)
        if (!element) continue
        const computed = getComputedStyle(element)
        const properties: Record<string, string> = {}
        for (const name of computed) {
          if (name !== 'cursor') properties[name] = computed.getPropertyValue(name)
        }
        snapshot[selector] = properties
      }
      return snapshot
    })

  const unarmed = await styles()
  await arm(page)
  const at = await centre(page, PICKED)
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()

  expect(await styles()).toEqual(unarmed)
  expect(await page.evaluate(() => getComputedStyle(document.body).cursor)).toBe(
    'crosshair',
  )
})

test('a click freezes the Highlight and opens the Panel beside the element, focus in the Note', async ({
  page,
}) => {
  await open(page, probe('panel'))
  await arm(page)
  const picked = await boxOf(page, PICKED)
  await pick(page, PICKED)

  const frozen = await boxOf(page, HIGHLIGHT)
  expect(Math.round(frozen.x)).toBe(Math.round(picked.x))
  expect(Math.round(frozen.y)).toBe(Math.round(picked.y))
  expect(Math.round(frozen.width)).toBe(Math.round(picked.width))

  // Beside the element: anchored next to it, never over it.
  const panel = await boxOf(page, PANEL)
  const clears =
    panel.y >= picked.y + picked.height - 1 || panel.y + panel.height <= picked.y + 1
  expect(clears).toBe(true)

  await expect(page.locator(NOTE)).toBeFocused()
  await expect(page.locator(TARGET)).toHaveText(TARGET_NAME)
})

test('Escape returns a picked Overlay to armed, and a second Escape turns picking off', async ({
  page,
}) => {
  await open(page, probe('escape'))
  await arm(page)
  await pick(page, PICKED)

  await page.keyboard.press('Escape')
  await expect(page.locator(PANEL)).toHaveCount(0)

  // Still armed: hovering another element lights it up again.
  const heading = await centre(page, 'h1')
  await page.mouse.move(heading.x, heading.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator(HIGHLIGHT)).toBeHidden()

  await page.mouse.move(heading.x + 1, heading.y + 1)
  await expect(page.locator(HIGHLIGHT)).toBeHidden()
})

test('the primary button reads Locate & stand by until the Note has a character', async ({
  page,
}) => {
  await open(page, probe('label'))
  await arm(page)
  await pick(page, PICKED)

  await expect(page.locator(SEND)).toHaveText('Locate & stand by')
  await page.keyboard.type('n')
  await expect(page.locator(SEND)).toHaveText('Send')
})

test('Shift+Enter inserts a newline and does not send', async ({ page }) => {
  await open(page, probe('newline'))
  await arm(page)
  await pick(page, PICKED)

  await page.keyboard.type('first')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('second')

  await expect(page.locator(NOTE)).toHaveValue('first\nsecond')
  await expect(page.locator(PANEL)).toBeVisible()
  await expect(page.locator(STATUS)).toHaveCount(0)
})

test('Enter sends, and the frame carries the Note inside the fences and the Pointer', async ({
  page,
}) => {
  const token = probe('send')
  await open(page, token)
  await arm(page)
  const picked = await boxOf(page, PICKED)
  await pick(page, PICKED)

  const note = `make this card quieter ${token}`
  await page.keyboard.type(note)
  await page.keyboard.press('Enter')
  await expect(page.locator(STATUS)).toHaveText('Sent')

  const content = await delivered(token)
  const fence = /--- note ([0-9a-f]{12}) ---\n([\s\S]*?)\n--- end note \1 ---/.exec(
    content,
  )
  expect(fence?.[2]).toBe(note)

  expect(content).toContain(`?probe=${token}`)
  expect(content).toMatch(new RegExp(`\\belement\\s+${PICKED_TAG}\\b`))
  expect(content).toMatch(
    new RegExp(
      `geometry\\s+${Math.round(picked.width)}×${Math.round(picked.height)} at \\(${Math.round(picked.x)},${Math.round(picked.y)}\\)`,
    ),
  )
  const viewport = page.viewportSize()
  expect(content).toContain(`${viewport?.width}×${viewport?.height}`)
})

test('a note-less send produces a frame with no note fence', async ({ page }) => {
  const token = probe('noteless')
  await open(page, token)
  await arm(page)
  await pick(page, PICKED)

  await expect(page.locator(SEND)).toHaveText('Locate & stand by')
  await page.keyboard.press('Enter')
  await expect(page.locator(STATUS)).toHaveText('Sent')

  const content = await delivered(token)
  expect(content).not.toContain('--- note ')
  expect(content).toContain('The developer sent no note with this pick.')
})

test("a server 4xx renders the server's own reason inline in the Panel", async ({
  page,
}) => {
  const token = probe('refused')

  // A test route that makes the real server refuse. The ticket's own example was
  // stripping `Origin`, which no engine allows: Chromium, Firefox and WebKit all
  // put the browser's own `Origin` back on a `route.continue`, and the Pick is
  // accepted. Changing the method is the same shape — the router refuses it, and
  // the reason the Panel shows is the server's own words, not the Overlay's.
  await page.route('**/__agent/pick', async (route) => {
    await route.continue({ method: 'PUT' })
  })

  await open(page, token)
  await arm(page)
  await pick(page, PICKED)
  await page.keyboard.type('this one never arrives')
  await page.keyboard.press('Enter')

  await expect(page.locator(STATUS)).toHaveText('/__agent/pick answers POST, not PUT')
  await expect(page.locator(NOTE)).toHaveValue('this one never arrives')
})

test('the fixed full-viewport decoy and the Overlay itself are never picked', async ({
  page,
}) => {
  const token = probe('decoy')
  await open(page, token)

  // The decoy is on top of the whole page and takes the pointer; the element
  // under it is what gets highlighted.
  await expect(page.locator('[data-fixture="full-viewport-decoy"]')).toBeVisible()
  await arm(page)
  const picked = await boxOf(page, PICKED)
  await pick(page, PICKED)

  const frozen = await boxOf(page, HIGHLIGHT)
  expect(Math.round(frozen.width)).toBe(Math.round(picked.width))
  expect(Math.round(frozen.height)).toBe(Math.round(picked.height))

  await page.keyboard.press('Escape')

  // And the Overlay's own chrome: hovering the Picker highlights the page under
  // it, never the Picker or the host the whole Overlay hangs from.
  const picker = await boxOf(page, PICKER)
  await page.mouse.move(picker.x + picker.width / 2, picker.y + picker.height / 2)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  const overChrome = await boxOf(page, HIGHLIGHT)
  expect(Math.round(overChrome.width)).not.toBe(Math.round(picker.width))

  await page.keyboard.press('Escape')
  await arm(page)
  await pick(page, PICKED)
  await page.keyboard.press('Enter')
  await expect(page.locator(STATUS)).toHaveText('Sent')
  const content = await delivered(token)
  expect(content).toMatch(new RegExp(`\\belement\\s+${PICKED_TAG}\\b`))
})

test('focus reaches the Note on the Panel opening only, never on a later render', async ({
  page,
}) => {
  await open(page, probe('focus'))
  await arm(page)
  await pick(page, PICKED)
  await expect(page.locator(NOTE)).toBeFocused()

  // Focus leaves the Note, then something the Panel draws changes: the primary
  // button relabels. The Panel may not take focus back.
  await page.locator(NOTE).evaluate((note: HTMLTextAreaElement) => {
    note.blur()
    note.value = 'typed while unfocused'
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })

  await expect(page.locator(SEND)).toHaveText('Send')
  await expect(page.locator(NOTE)).not.toBeFocused()
})
