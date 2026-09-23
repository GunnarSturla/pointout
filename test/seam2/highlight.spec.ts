import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Seam 2: the Highlight's lifecycle and the only motion in the project.
//
// The browser is the only place any of this is true: whether a box is still on
// its element after the page moved under it, and whether anything is animating,
// are questions only a running engine answers. Every string here is written out
// rather than imported — the Overlay's part names are the contract
// (docs/agents/testing.md).
//
// Every fixture in the test bed now sits below the fold, so anything measured
// here is scrolled into view first: `elementsFromPoint` outside the viewport
// answers nothing, and a hover at a point the page cannot show is not a hover.

/** Where the fake session's inbox writes what it received (test/harness/serve.ts). */
const FRAMES_LOG_ENV = 'SEAM2_FRAMES_LOG'

const HOST = 'vite-agent-inspect'
const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const SEND = '[data-part="send"]'
const STATUS = '[data-part="status"]'
/** The line the Panel adds when the element it is anchored to has left. */
const GONE = '[data-part="gone"]'
const ELEMENT_GONE = 'This element is gone from the page. The pick still sends.'

/** Two elements of the same card, different enough in size to morph between. */
const FIRST = '[data-fixture="card-heading"]'
const SECOND = '[data-fixture="passed-down-badge"]'

const SCROLL_CONTAINER = '[data-fixture="scroll-container"]'
const SCROLL_TARGET = '[data-fixture="scroll-target"]'
const UNMOUNT_TARGET = '[data-fixture="unmounting-target"]'
const UNMOUNT_BUTTON = '[data-fixture="unmount-now"]'
const HOT_BOX = '[data-fixture="hot-update-box"]'

/** The one declaration a hot update rewrites, and what it says at rest. */
const HOT_CSS = fileURLToPath(
  new URL('../../examples/react-app/src/fixtures/hot-update.css', import.meta.url),
)
const HOT_AT_REST = 'height: 3rem'
const HOT_UPDATED = 'height: 7rem'

/** The Highlight sitting exactly on its element, measured both ways. */
const ON_IT = { left: 0, top: 0, width: 0, height: 0 }

interface Box {
  x: number
  y: number
  width: number
  height: number
}

function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
}

async function open(page: Page, token: string): Promise<void> {
  await page.goto(`/?probe=${token}`)
  await expect(page.locator(PICKER)).toBeVisible()
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return box
}

async function centre(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const box = await boxOf(page, selector)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * How far the Highlight is from the element it claims to be on. Zero on every
 * edge is the whole assertion; a pixel of engine rounding is not a finding, and
 * anything larger is reported as it stands.
 */
async function offFrom(page: Page, selector: string): Promise<Record<string, number>> {
  const element = await boxOf(page, selector)
  const highlight = await boxOf(page, HIGHLIGHT)
  const rounded = (drift: number) => (Math.abs(drift) <= 1 ? 0 : Math.round(drift))
  return {
    left: rounded(highlight.x - element.x),
    top: rounded(highlight.y - element.y),
    width: rounded(highlight.width - element.width),
    height: rounded(highlight.height - element.height),
  }
}

/** Record every transition the Highlight starts, whether or not it finishes. */
async function watchMotion(page: Page): Promise<void> {
  await page.evaluate((host) => {
    const box = document
      .querySelector(host)
      ?.shadowRoot?.querySelector('[data-part="highlight"]')
    if (!box) throw new Error('the Overlay draws no Highlight')
    const seen: string[] = []
    Object.assign(window, { seenMotion: seen })
    box.addEventListener('transitionrun', (event) => {
      seen.push((event as TransitionEvent).propertyName)
    })
  }, HOST)
}

async function motionSeen(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { seenMotion?: string[] }).seenMotion ?? [],
  )
}

/** Animations running on the Highlight alone. */
async function runningOnHighlight(page: Page): Promise<number> {
  return page.evaluate((host) => {
    const box = document
      .querySelector(host)
      ?.shadowRoot?.querySelector('[data-part="highlight"]')
    return box ? box.getAnimations().length : -1
  }, HOST)
}

/**
 * Animations running anywhere the Overlay draws — its host and everything in its
 * shadow root, which is all of it (spec §3).
 *
 * The page's own count is deliberately not added. `document.getAnimations()`
 * reports two in WebKit on a page that shows no motion at all: the dependency
 * fixture's skeleton is rendered with its shimmer turned off, which takes the
 * pseudo-element out of display without taking its animation out of the
 * document's accounting. The test bed holds still; that number does not say so.
 */
async function runningInOverlay(page: Page): Promise<number> {
  return page.evaluate((tag) => {
    const host = document.querySelector(tag)
    const root = host?.shadowRoot
    if (!host || !root) return -1
    let count = host.getAnimations().length
    for (const element of root.querySelectorAll('*')) {
      count += element.getAnimations().length
    }
    return count
  }, HOST)
}

/** Arm without touching the Picker, so nothing but the Highlight can move. */
async function armWithAlt(page: Page): Promise<void> {
  await page.keyboard.down('Alt')
}

async function hover(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().scrollIntoViewIfNeeded()
  const at = await centre(page, selector)
  await page.mouse.move(at.x, at.y)
}

async function pick(page: Page, selector: string): Promise<void> {
  await hover(page, selector)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  const at = await centre(page, selector)
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
  // Every Pick closes the Screen Capture shutter and eases the Highlight back in
  // (ticket 18). That is the shutter, not the Highlight tracking or travelling,
  // so what this file watches starts once it is open again and still.
  await expect
    .poll(() =>
      page.evaluate((tag) => {
        const host = document.querySelector(tag)
        const box = host?.shadowRoot?.querySelector('[data-part="highlight"]')
        if (host?.hasAttribute('data-shutter')) return 'closed'
        return box ? box.getAnimations().length : 0
      }, HOST),
    )
    .toBe(0)
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

test.describe('the Highlight tracks its element', () => {
  test('through a scroll inside a container the window never hears about', async ({
    page,
  }) => {
    await open(page, probe('scroll'))
    await page.locator(PICKER).click()
    await pick(page, SCROLL_TARGET)
    expect(await offFrom(page, SCROLL_TARGET)).toEqual(ON_IT)

    await page
      .locator(SCROLL_CONTAINER)
      .evaluate((container) => container.scrollBy(0, 40))

    await expect.poll(() => offFrom(page, SCROLL_TARGET)).toEqual(ON_IT)
  })

  test('through a viewport resize', async ({ page }) => {
    await open(page, probe('resize'))
    await page.locator(PICKER).click()
    await pick(page, FIRST)

    await page.setViewportSize({ width: 900, height: 620 })
    await expect.poll(() => offFrom(page, FIRST)).toEqual(ON_IT)

    await page.setViewportSize({ width: 620, height: 900 })
    await expect.poll(() => offFrom(page, FIRST)).toEqual(ON_IT)
  })

  test('through a hot update that relays the page out under it', async ({
    page,
    browserName,
  }) => {
    // One engine, and a real file. A hot update is the dev server moving the
    // page, which is the same in all three; the edit is a file on disk, and
    // three engines running this at once would be three writers of it.
    test.skip(browserName !== 'chromium', 'the hot update is the server, not the engine')

    const atRest = readFileSync(HOT_CSS, 'utf8')
    expect(atRest).toContain(HOT_AT_REST)

    try {
      await open(page, probe('hot'))
      await page.locator(PICKER).click()
      await pick(page, HOT_BOX)
      const before = await boxOf(page, HOT_BOX)

      writeFileSync(HOT_CSS, atRest.replace(HOT_AT_REST, HOT_UPDATED))

      // The element grows where it stands, with nothing scrolled and nothing
      // resized: the third way the page moves under a Highlight (spec §5).
      await expect
        .poll(async () => Math.round((await boxOf(page, HOT_BOX)).height))
        .not.toBe(Math.round(before.height))
      await expect.poll(() => offFrom(page, HOT_BOX)).toEqual(ON_IT)
    } finally {
      writeFileSync(HOT_CSS, atRest)
    }
  })
})

test.describe('nothing travels on its first appearance', () => {
  test('the first Highlight is placed on its element with nothing running', async ({
    page,
  }) => {
    await open(page, probe('appear'))
    await armWithAlt(page)
    await watchMotion(page)

    await hover(page, FIRST)
    await expect(page.locator(HIGHLIGHT)).toBeVisible()

    expect(await offFrom(page, FIRST)).toEqual(ON_IT)
    expect(await motionSeen(page)).toEqual([])
    expect(await runningOnHighlight(page)).toBe(0)
  })

  test('the next element it is hovered over is travelled to', async ({ page }) => {
    await open(page, probe('morph'))
    await armWithAlt(page)
    await watchMotion(page)

    await hover(page, FIRST)
    await expect(page.locator(HIGHLIGHT)).toBeVisible()
    expect(await motionSeen(page)).toEqual([])

    await hover(page, SECOND)
    await expect.poll(async () => (await motionSeen(page)).length).toBeGreaterThan(0)
    await expect.poll(() => offFrom(page, SECOND)).toEqual(ON_IT)
  })

  test('a re-measure of the element it is already on is a placement, not a move', async ({
    page,
  }) => {
    await open(page, probe('track'))
    await page.locator(PICKER).click()
    await pick(page, SCROLL_TARGET)
    await watchMotion(page)

    await page
      .locator(SCROLL_CONTAINER)
      .evaluate((container) => container.scrollBy(0, 40))
    await expect.poll(() => offFrom(page, SCROLL_TARGET)).toEqual(ON_IT)

    // A box that eased its way after a scroll would lag behind the thing it
    // marks, which is the opposite of tracking it.
    expect(await motionSeen(page)).toEqual([])
  })
})

test('the morph animates translate, width and height, and distorts no edge of its own', async ({
  page,
}) => {
  await open(page, probe('properties'))
  await armWithAlt(page)
  await hover(page, FIRST)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()

  const at = await centre(page, SECOND)

  // The whole morph is read inside one task: the hover that starts it, the
  // animations it created, and the frame halfway through it. Nothing here waits,
  // so nothing here can arrive after the morph it is about has finished.
  const morph = await page.evaluate(
    ({ host, x, y }) => {
      const box = document
        .querySelector(host)
        ?.shadowRoot?.querySelector('[data-part="highlight"]')
      if (!box) throw new Error('the Overlay draws no Highlight')

      const atRest = getComputedStyle(box)
      const edges = {
        outline: atRest.outlineWidth,
        radius: atRest.borderRadius,
        scale: atRest.scale,
      }
      const from = atRest.translate

      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y }))
      // Forces the style and layout the hover asked for, so the transitions it
      // started exist to be read.
      box.getBoundingClientRect()

      const animations = box.getAnimations()
      for (const animation of animations) {
        animation.pause()
        animation.currentTime = 60
      }

      const midway = getComputedStyle(box)
      return {
        properties: animations
          .map(
            (animation) =>
              (animation as Animation & { transitionProperty?: string })
                .transitionProperty ?? 'not-a-transition',
          )
          .toSorted(),
        edges,
        from,
        midway: {
          outline: midway.outlineWidth,
          radius: midway.borderRadius,
          scale: midway.scale,
        },
        translate: midway.translate,
      }
    },
    { host: HOST, x: at.x, y: at.y },
  )

  expect(morph.properties).toEqual(['height', 'translate', 'width'])
  // It is genuinely halfway: the box is somewhere it was not, which is what
  // makes the next assertion about a frame rather than about a resting state.
  expect(morph.translate).not.toBe(morph.from)
  // `scale` is rejected outright, and this is why: the border and the radius
  // travel undistorted only because nothing is scaling them. The computed values
  // are the weaker half of this — a scaled box distorts its edges in paint while
  // still computing `1.5px` — so the property list above is what carries it, and
  // `scale: none` in the same frame is what says the list is the whole story.
  expect(morph.midway).toEqual(morph.edges)
  expect(morph.midway.scale).toBe('none')
})

test('a picked element that unmounts fades, says so, and is still sent', async ({
  page,
}) => {
  const token = probe('unmount')
  await open(page, token)
  await page.locator(PICKER).click()
  await pick(page, UNMOUNT_TARGET)

  const note = `it went away before I sent this ${token}`
  await page.keyboard.type(note)

  // Dispatched rather than clicked: the Panel this Pick opened is anchored
  // beside its element and is in front of the button, which is what a Panel
  // beside its element looks like.
  await page.locator(UNMOUNT_BUTTON).dispatchEvent('click')

  await expect(page.locator(HIGHLIGHT)).toHaveCSS('opacity', '0')
  await expect(page.locator(GONE)).toHaveText(ELEMENT_GONE)

  await page.locator(SEND).click()
  await expect(page.locator(STATUS)).toHaveText('Sent')
  expect(await delivered(token)).toContain(note)
})

test.describe('with reduced motion asked for', () => {
  test.use({ reducedMotion: 'reduce' })

  test('the Highlight jumps between elements and the Panel opens without movement', async ({
    page,
  }) => {
    await open(page, probe('reduce'))
    await armWithAlt(page)
    await watchMotion(page)

    await hover(page, FIRST)
    await expect(page.locator(HIGHLIGHT)).toBeVisible()
    expect(await offFrom(page, FIRST)).toEqual(ON_IT)

    await hover(page, SECOND)
    // Positions still update. That is the half of the morph that survives.
    await expect.poll(() => offFrom(page, SECOND)).toEqual(ON_IT)
    expect(await motionSeen(page)).toEqual([])

    const at = await centre(page, SECOND)
    await page.mouse.click(at.x, at.y)
    await expect(page.locator(PANEL)).toBeVisible()

    // The pick closes and reopens the Screen Capture shutter, and its reopening
    // is a fade: the one thing that eases under reduce (the review-animations
    // gate). Nothing travelled or changed size.
    expect((await motionSeen(page)).filter((name) => name !== 'opacity')).toEqual([])
    await expect.poll(() => runningInOverlay(page)).toBe(0)
  })

  test('an unmounted element fades its Highlight where it stood, and nothing moves', async ({
    page,
  }) => {
    await open(page, probe('reduce-unmount'))
    await page.locator(PICKER).click()
    await pick(page, UNMOUNT_TARGET)
    await watchMotion(page)

    await page.locator(UNMOUNT_BUTTON).dispatchEvent('click')

    await expect(page.locator(GONE)).toHaveText(ELEMENT_GONE)
    await expect(page.locator(HIGHLIGHT)).toHaveCSS('opacity', '0')
    // A fade is not movement, so it is kept for a developer who asked for less
    // of it; nothing else runs.
    expect((await motionSeen(page)).filter((name) => name !== 'opacity')).toEqual([])
    await expect.poll(() => runningInOverlay(page)).toBe(0)
  })
})
