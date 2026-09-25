import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Seam 2: the Overlay's controls as a hand and a keyboard meet them
// (overlay-polish ticket 05, docs/overlay-design.md's states table). Every
// button answers hover, press and keyboard focus visibly; its colours fade for
// every developer, and only a press moves, where motion is allowed. The Note
// grows with what is typed, up to twelve lines, then scrolls.
//
// Every string here is written out rather than imported: the part names and the
// plan's colours are the contract (docs/agents/testing.md).

const PICKED = '[data-fixture="card-heading"]'

const HOST = 'vite-agent-inspect'
const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const NOTE = '[data-part="note"]'
const SEND = '[data-part="send"]'

/** The plan's `--ink` and `--surface`, light: Send is ink, not blue. */
const INK = 'rgb(27, 29, 34)'
const SURFACE = 'rgb(255, 255, 255)'

/** The only properties a colour fade may ease (docs/motion.md). */
const FADES = ['color', 'background-color', 'border-color', 'outline-color']

/** The Note's line height, the plan's `note` step: 13 / 18 px. */
const NOTE_LINE = 18

async function open(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator(PICKER)).toBeVisible()
}

async function pick(page: Page): Promise<void> {
  const picker = page.locator(PICKER)
  await picker.click()
  if ((await picker.getAttribute('data-armed')) === null) await picker.click()
  await expect(picker).toHaveAttribute('data-armed', '')
  // Every fixture in the example app sits below the fold.
  await page.locator(PICKED).first().scrollIntoViewIfNeeded()
  const box = await page.locator(PICKED).first().boundingBox()
  if (!box) throw new Error(`${PICKED} has no box`)
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT).first()).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
}

/**
 * Nothing in the Overlay is still easing. CSS transitions do not run on
 * `page.clock`, so this is how a test waits for a fade to finish.
 */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((tag) => {
        const root = document.querySelector(tag)?.shadowRoot
        if (!root) return -1
        // A status dot's pulse and rings loop for as long as its state lasts,
        // so they never settle: those two, by name, are left out of the count.
        return root
          .getAnimations()
          .filter(
            (animation) =>
              !['dot-working', 'dot-needs'].includes(
                (animation as CSSAnimation).animationName,
              ),
          ).length
      }, HOST),
    )
    .toBe(0)
}

/** What of Send's look a state can change: its fill, its words and its ring. */
async function looks(page: Page): Promise<string> {
  await settled(page)
  return page.locator(SEND).evaluate((send) => {
    const style = getComputedStyle(send)
    const ring = style.outlineStyle === 'none' ? 'no ring' : style.outlineColor
    return `${style.backgroundColor} / ${style.color} / ${ring}`
  })
}

/**
 * Tab through the Panel until Send has the keyboard's focus. WebKit, like
 * Safari, tabs only to fields unless Option is held.
 */
async function tabToSend(page: Page, browserName: string): Promise<void> {
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
  for (let presses = 0; presses < 8; presses += 1) {
    const onSend = await page.evaluate(
      (tag) =>
        document.querySelector(tag)?.shadowRoot?.activeElement?.getAttribute('data-part'),
      HOST,
    )
    if (onSend === 'send') return
    await page.keyboard.press(tab)
  }
  throw new Error('Tab never reached Send')
}

test.describe('Send', () => {
  test.use({ colorScheme: 'light' })

  test('is ink at rest, and looks different hovered and focused from the keyboard', async ({
    page,
    browserName,
  }) => {
    await open(page)
    await pick(page)
    const send = page.locator(SEND)
    await expect(send).toBeEnabled()
    await page.mouse.move(4, 4)

    const rest = await looks(page)
    expect(rest).toBe(`${INK} / ${SURFACE} / no ring`)

    await send.hover()
    const hovered = await looks(page)

    await page.mouse.move(4, 4)
    await tabToSend(page, browserName)
    const focused = await looks(page)

    expect(new Set([rest, hovered, focused]).size).toBe(3)
  })

  test('fades only its colours for a developer who asked for less motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await open(page)
    await pick(page)
    const eased = await page
      .locator(SEND)
      .evaluate((send) => getComputedStyle(send).transitionProperty.split(', '))
    expect(eased.length).toBeGreaterThan(0)
    for (const property of eased) expect(FADES).toContain(property)
  })

  test('adds only the press where motion is allowed', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await open(page)
    await pick(page)
    const eased = await page
      .locator(SEND)
      .evaluate((send) => getComputedStyle(send).transitionProperty.split(', '))
    expect(eased.filter((property) => !FADES.includes(property))).toEqual(['scale'])
  })
})

/** Type lines `from` to `to` into the focused Note, a Shift+Enter between each. */
async function typeLines(page: Page, from: number, to: number): Promise<void> {
  for (let line = from; line <= to; line += 1) {
    if (line > 1) await page.keyboard.press('Shift+Enter')
    await page.keyboard.type(`line ${line}`)
  }
}

/** The Note's drawn text area, its height less its padding, and whether it scrolls. */
async function noteLines(page: Page): Promise<{ inner: number; scrolls: boolean }> {
  return page.locator(NOTE).evaluate((field) => {
    const style = getComputedStyle(field)
    const inner =
      field.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    return { inner, scrolls: field.scrollHeight > field.clientHeight }
  })
}

const growsWithContent = (page: Page) =>
  page.evaluate(() => CSS.supports('field-sizing', 'content'))

test('the Note grows with what is typed, to twelve lines and no further', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'the growing Note is proved in Chromium')
  await open(page)
  await pick(page)
  expect(await growsWithContent(page)).toBe(true)
  expect((await noteLines(page)).inner).toBe(3 * NOTE_LINE)

  await page.locator(NOTE).focus()
  await typeLines(page, 1, 6)
  expect(await noteLines(page)).toEqual({ inner: 6 * NOTE_LINE, scrolls: false })

  await typeLines(page, 7, 20)
  expect(await noteLines(page)).toEqual({ inner: 12 * NOTE_LINE, scrolls: true })
})

test('where the engine cannot grow the Note, it keeps three lines and scrolls', async ({
  page,
}) => {
  await open(page)
  await pick(page)
  test.skip(await growsWithContent(page), 'this engine grows the Note')
  await page.locator(NOTE).focus()
  await typeLines(page, 1, 20)
  expect(await noteLines(page)).toEqual({ inner: 3 * NOTE_LINE, scrolls: true })
})
