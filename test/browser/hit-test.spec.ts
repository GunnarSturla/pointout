import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// The browser suite: the hit-test rules and the node-count shield, in three engines
// (spec §4). A browser is the only place these rules exist at all — three of
// the four are about what `elementsFromPoint` refuses to tell you.
//
// Every string here is written out rather than imported: the Overlay's part
// names, the root attribute it sets on the host document and the rendered
// Pointer's wording are the contract (docs/agents/testing.md). Nothing imports
// a server module.

/** Where the fake session's inbox writes what it received (test/harness/serve.ts). */
const FRAMES_LOG_ENV = 'BROWSER_FRAMES_LOG'

/** The attribute the armed stylesheet rule keys off, on the document element. */
const ARMED_ATTRIBUTE = 'data-pointout-armed'

/** The Overlay's host tag — the one element the armed rule exempts. */
const HOST = 'pointout-overlay'

const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const CHIP_NAME = '[data-part="chip-name"]'
const PANEL = '[data-part="panel"]'
const MINIMIZED = '[data-part="minimized"]'
const LIGHT = '[data-part="light"]'
const SHIELD = '[data-part="shield"]'

const DECOY = '[data-fixture="full-viewport-decoy"]'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Accepted: the Panel closes, and the Pick rests minimized in the Stack, its
 * light titled Sent (overlay-polish 08).
 */
async function sent(page: Page): Promise<void> {
  await expect(page.locator(PANEL)).toHaveCount(0)
  await expect(page.locator(`${MINIMIZED} ${LIGHT}`).last()).toHaveAttribute(
    'title',
    'Sent',
  )
}

/** One probe token per test, carried in the url so its frame can be found. */
function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
}

/** The test bed loads without its decoy; `decoy` turns it on at load. */
async function open(page: Page, token: string, { decoy = false } = {}): Promise<void> {
  await page.goto(decoy ? `?decoy&probe=${token}` : `?probe=${token}`)
  await expect(page.locator(PICKER)).toBeVisible()
}

/** Every `user` frame's rendered content, oldest first. */
function deliveredContents(): string[] {
  const log = process.env[FRAMES_LOG_ENV]
  if (!log) {
    throw new Error(
      `${FRAMES_LOG_ENV} is unset: the browser suite's globalSetup did not run`,
    )
  }
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

/**
 * A fixture's box, in the viewport. These fixtures sit below the fold, and a
 * point outside the viewport is a point the page's own hit test answers nothing
 * at — so the element is brought into view before it is measured.
 */
async function boxOf(page: Page, selector: string): Promise<Box> {
  const locator = page.locator(selector).first()
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return box
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await boxOf(page, selector)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** Arm with the Picker, which stays armed without a key held down. */
async function arm(page: Page): Promise<void> {
  await page.locator(PICKER).click()
}

/** What the page's own hit test answers at a point, outermost first. */
async function stackAt(page: Page, at: { x: number; y: number }): Promise<string[]> {
  return page.evaluate(
    ([x, y]) =>
      document
        .elementsFromPoint(x as number, y as number)
        .map((element) => element.getAttribute('data-fixture') ?? element.tagName)
        .map((name) => name.toLowerCase()),
    [at.x, at.y],
  )
}

async function pointerEventsOf(page: Page, selector: string): Promise<string> {
  return page.evaluate((css) => {
    const element = document.querySelector(css)
    return element ? getComputedStyle(element).pointerEvents : 'no such element'
  }, selector)
}

/** The Highlight sits on exactly this element's box. */
async function highlightCovers(page: Page, selector: string): Promise<void> {
  const target = await boxOf(page, selector)
  await expect
    .poll(async () => {
      const box = await boxOf(page, HIGHLIGHT)
      return [Math.round(box.x), Math.round(box.y), Math.round(box.width)].join(' ')
    })
    .toBe(
      [Math.round(target.x), Math.round(target.y), Math.round(target.width)].join(' '),
    )
}

async function pickAt(page: Page, at: { x: number; y: number }): Promise<void> {
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
}

async function send(page: Page, note: string): Promise<void> {
  await page.keyboard.type(note)
  await page.keyboard.press('Enter')
  await sent(page)
}

test('a pointer-events: none element is pickable while armed and inert while not', async ({
  page,
}) => {
  await open(page, probe('decorative'))
  const badge = '[data-fixture="pointer-events-none"]'

  // No decoy: what the page's own hit test answers at this point is about the
  // badge and nothing else.
  await expect(page.locator(DECOY)).toHaveCount(0)
  const at = await centre(page, badge)

  expect(await pointerEventsOf(page, badge)).toBe('none')
  expect(await stackAt(page, at)).not.toContain('pointer-events-none')

  await arm(page)

  expect(await pointerEventsOf(page, badge)).toBe('auto')
  expect((await stackAt(page, at))[0]).toBe('pointer-events-none')

  // And the Overlay's own host keeps the pointer-events it was given: the armed
  // rule exempts it by name, or it would swallow every pick made through it.
  expect(await pointerEventsOf(page, HOST)).toBe('none')

  await page.mouse.move(at.x, at.y)
  await highlightCovers(page, badge)
})

test('clicking a path inside the icon picks the svg, and the chip names the icon', async ({
  page,
}) => {
  const token = probe('svg')
  await open(page, token)

  // A point on the icon path's own stroke. The path is drawn in a 24×24 viewBox
  // at 24×24 px and opens `M3 3h8`, a horizontal stroke 1.5 units wide at y = 3;
  // the interior is `fill="none"`, so the middle of its box is not on it.
  const icon = await boxOf(page, '[data-fixture="svg-icon"]')
  const at = { x: icon.x + 7, y: icon.y + 3 }

  const stack = await stackAt(page, at)
  expect(stack.indexOf('svg-icon-path')).toBeGreaterThanOrEqual(0)
  expect(stack.indexOf('svg-icon-path')).toBeLessThan(stack.indexOf('svg-icon'))

  await arm(page)
  await page.mouse.move(at.x, at.y)
  await highlightCovers(page, '[data-fixture="svg-icon"]')
  await expect(page.locator(CHIP_NAME)).toHaveText('TagIcon')

  await pickAt(page, at)
  await send(page, `the icon ${token}`)
  expect(await delivered(token)).toMatch(/\belement\s+svg\b/)
})

test('clicking inside the shadow root picks the element React put there', async ({
  page,
}) => {
  const token = probe('shadow')
  await open(page, token)
  const target = '[data-fixture="shadow-target"]'

  // The document's own hit test answers with the host: everything in a shadow
  // tree is retargeted to it.
  const at = await centre(page, target)
  expect(await stackAt(page, at)).toContain('shadow-host')

  await arm(page)
  await page.mouse.move(at.x, at.y)
  await highlightCovers(page, target)

  await pickAt(page, at)
  await send(page, `inside the shadow root ${token}`)

  const content = await delivered(token)
  expect(content).toMatch(/\belement\s+span\b/)
  expect(content).toContain('ShadowCardBody')
  expect(content).not.toMatch(/owner chain\s+none/)
})

test('clicking inside the same-origin iframe picks the element inside it', async ({
  page,
}) => {
  const token = probe('iframe')
  await open(page, token)
  await expect(page.locator(DECOY)).toHaveCount(0)

  // The frame itself is brought into view first: scrolling from inside it would
  // move the frame's own document and leave the frame where it was.
  await boxOf(page, '[data-fixture="same-origin-iframe"]')
  const inside = page
    .frameLocator('[data-fixture="same-origin-iframe"]')
    .locator('[data-fixture="iframe-target"]')
  await expect(inside).toBeVisible()
  const target = await inside.boundingBox()
  if (!target) throw new Error('the framed element has no box')
  const at = { x: target.x + target.width / 2, y: target.y + target.height / 2 }

  // The top document's hit test stops at the frame.
  expect(await stackAt(page, at)).toContain('same-origin-iframe')

  await arm(page)
  await page.mouse.move(at.x, at.y)

  // Drawn where the element is in the top document, not where the frame begins.
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  const highlight = await boxOf(page, HIGHLIGHT)
  expect(Math.round(highlight.x)).toBe(Math.round(target.x))
  expect(Math.round(highlight.y)).toBe(Math.round(target.y))
  expect(Math.round(highlight.width)).toBe(Math.round(target.width))

  await pickAt(page, at)
  await send(page, `inside the frame ${token}`)

  const content = await delivered(token)
  expect(content).toMatch(/\belement\s+span\b/)
  expect(content).toMatch(
    new RegExp(
      `geometry\\s+${Math.round(target.width)}×${Math.round(target.height)} at \\(${Math.round(target.x)},${Math.round(target.y)}\\)`,
    ),
  )
  // React owns what it portalled into the frame, and the chain says so.
  expect(content).toContain('FrameBody')
  expect(content).not.toMatch(/owner chain\s+none/)
})

test('Alt held over an open Panel previews inside the same-origin iframe, and Alt-click moves the Pick there', async ({
  page,
}) => {
  const token = probe('iframe-alt')
  await open(page, token)
  await expect(page.locator(DECOY)).toHaveCount(0)

  // A Pick first, on the heading just below the frame, so both are in view and
  // the Panel opens clear of the frame.
  const heading = '[data-fixture="same-origin-iframe-section"] + section h2'
  await boxOf(page, '[data-fixture="same-origin-iframe"]')
  await arm(page)
  await pickAt(page, await centre(page, heading))

  const inside = page
    .frameLocator('[data-fixture="same-origin-iframe"]')
    .locator('[data-fixture="iframe-target"]')
  const target = await inside.boundingBox()
  if (!target) throw new Error('the framed element has no box')
  const at = { x: target.x + target.width / 2, y: target.y + target.height / 2 }

  await page.keyboard.down('Alt')
  await page.mouse.move(at.x, at.y, { steps: 4 })

  // The live mark follows the pointer into the frame, drawn where the element
  // is in the top document.
  const live = `${HIGHLIGHT}[data-mark="live"]`
  await expect(page.locator(live)).toBeVisible()
  await expect
    .poll(async () => {
      const box = await boxOf(page, live)
      return [Math.round(box.x), Math.round(box.y), Math.round(box.width)].join(' ')
    })
    .toBe(
      [Math.round(target.x), Math.round(target.y), Math.round(target.width)].join(' '),
    )

  // Alt-click moves the unsubmitted Pick onto the framed element.
  await page.mouse.click(at.x, at.y)
  await page.keyboard.up('Alt')
  await expect(page.locator(PANEL)).toHaveCount(1)
  await send(page, `moved into the frame ${token}`)

  const content = await delivered(token)
  expect(content).toMatch(/\belement\s+span\b/)
  expect(content).toContain('FrameBody')
})

test('the full-viewport decoy is never picked; the element beneath it is', async ({
  page,
}) => {
  const token = probe('beneath')
  await open(page, token, { decoy: true })
  const beneath = '[data-fixture="card-heading"]'

  await expect(page.locator(DECOY)).toBeVisible()
  const at = await centre(page, beneath)

  // The decoy really is on top: the page's own hit test answers with it first.
  expect((await stackAt(page, at))[0]).toBe('full-viewport-decoy')

  await arm(page)
  await page.mouse.move(at.x, at.y)
  await highlightCovers(page, beneath)

  await pickAt(page, at)
  await send(page, `beneath the decoy ${token}`)
  expect(await delivered(token)).toMatch(/\belement\s+h3\b/)
})

test('a normal page arms through the stylesheet and a dense one through the shield', async ({
  page,
}) => {
  const token = probe('dense')
  await open(page, token)

  await arm(page)
  expect(await armedAttribute(page)).toBe(true)
  await expect(page.locator(SHIELD)).toHaveCount(0)

  await page.locator(PICKER).click()
  expect(await armedAttribute(page)).toBe(false)

  // Now make the page dense enough that forcing every element hittable is the
  // cost the shield exists to avoid.
  await page.locator('[data-fixture="dense-mount"]').click()
  await expect(page.locator('[data-fixture="dense-block"]')).toBeVisible()

  await arm(page)
  expect(await armedAttribute(page)).toBe(false)
  await expect(page.locator(SHIELD)).toHaveCount(1)

  // And picking still resolves the element the developer pointed at, through it.
  const target = '[data-fixture="dense-target"]'
  const at = await centre(page, target)
  await page.mouse.move(at.x, at.y)
  await highlightCovers(page, target)

  await pickAt(page, at)
  await send(page, `through the shield ${token}`)
  expect(await delivered(token)).toMatch(/\belement\s+p\b/)

  // The shield is taken down with the arming that raised it.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.locator(SHIELD)).toHaveCount(0)
})

async function armedAttribute(page: Page): Promise<boolean> {
  return page.evaluate(
    (name) => document.documentElement.hasAttribute(name),
    ARMED_ATTRIBUTE,
  )
}
