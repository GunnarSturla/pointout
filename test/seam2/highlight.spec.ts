import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apartFromHotUpdates } from '../harness/hot-update-lock.js'

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

const HOST = 'pointout-overlay'
const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const MINIMIZED = '[data-part="minimized"]'
const LIGHT = '[data-part="light"]'
const SEND = '[data-part="send"]'
/** The line the Panel adds when the element it is anchored to has left. */
const GONE = '[data-part="gone"]'
const ELEMENT_GONE = 'This element is gone from the page. The pick still sends.'

/** Two elements of the same card, different enough in size to morph between. */
const FIRST = '[data-fixture="card-heading"]'
const SECOND = '[data-fixture="passed-down-badge"]'
/** Above both, so a Panel opened below either never covers it. */
const THIRD = 'h1'

const SCROLL_CONTAINER = '[data-fixture="scroll-container"]'
const SCROLL_TARGET = '[data-fixture="scroll-target"]'
const UNMOUNT_TARGET = '[data-fixture="unmounting-target"]'
const UNMOUNT_BUTTON = '[data-fixture="unmount-now"]'
const HOT_BOX = '[data-fixture="hot-update-box"]'

/** The one declaration a hot update rewrites, and what it says at rest. */
const HOT_CSS = fileURLToPath(
  new URL('../../examples/shared/fixtures/hot-update.css', import.meta.url),
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

/**
 * Record every transition any Highlight starts, or its chip, whether or not it
 * finishes. Listened for on the shadow root, because a Highlight that is not
 * shown is not in the page to be listened to.
 */
async function watchMotion(page: Page): Promise<void> {
  await page.evaluate((host) => {
    const root = document.querySelector(host)?.shadowRoot
    if (!root) throw new Error('the Overlay is not mounted')
    const seen: string[] = []
    Object.assign(window, { seenMotion: seen })
    root.addEventListener('transitionrun', (event) => {
      const target = event.target as Element
      if (!target.closest('[data-part="highlight"]')) return
      seen.push((event as TransitionEvent).propertyName)
    })
  }, HOST)
}

/** What a fade may ease: nothing of it travels or changes size. */
const FADES = ['opacity', 'color', 'background-color', 'border-color', 'outline-color']

const moving = (seen: string[]) => seen.filter((name) => !FADES.includes(name))

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

    await open(page, probe('hot'))
    await page.locator(PICKER).click()
    await pick(page, HOT_BOX)
    const before = await boxOf(page, HOT_BOX)

    // From the first write until the page has the file back as it was: both
    // hot updates, and every page they relay out.
    await apartFromHotUpdates(async () => {
      try {
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
      await expect
        .poll(async () => Math.round((await boxOf(page, HOT_BOX)).height))
        .toBe(Math.round(before.height))
    })
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

test('the morph is still under way frames after the hover that started it', async ({
  page,
}) => {
  // The morph above is read paused inside the hover's own task, which cannot
  // see what the next frames do to it. This watches it run: the drawn width,
  // once a frame, from the hover on. A morph cancelled a couple of frames in
  // — which is what a stray re-measure does — reaches the destination width
  // early and stays there, and no later frame is anywhere in between.
  await open(page, probe('frames'))
  await armWithAlt(page)
  await hover(page, FIRST)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await expect.poll(() => runningOnHighlight(page)).toBe(0)

  const from = (await boxOf(page, FIRST)).width
  const to = (await boxOf(page, SECOND)).width
  const at = await centre(page, SECOND)

  const widths = await apartFromHotUpdates(() =>
    page.evaluate(
      ({ host, x, y }) =>
        new Promise<number[]>((resolve) => {
          const box = document
            .querySelector(host)
            ?.shadowRoot?.querySelector('[data-part="highlight"]')
          if (!box) throw new Error('the Overlay draws no Highlight')
          const drawn: number[] = []
          const frame = () => {
            drawn.push(box.getBoundingClientRect().width)
            if (drawn.length < 8) requestAnimationFrame(frame)
            else resolve(drawn)
          }
          window.dispatchEvent(
            new PointerEvent('pointermove', { clientX: x, clientY: y }),
          )
          requestAnimationFrame(frame)
        }),
      { host: HOST, x: at.x, y: at.y },
    ),
  )

  // The two elements differ by far more than a morph's last frames cover.
  expect(Math.abs(from - to)).toBeGreaterThan(40)
  const low = Math.min(from, to) + 1
  const high = Math.max(from, to) - 1
  const between = widths.slice(2).filter((width) => width > low && width < high)
  expect(`${between.length} of ${JSON.stringify(widths)}`).not.toMatch(/^0 of/)
})

/** The second mark: the one that follows the pointer while Alt is held over a Panel. */
const LIVE = '[data-part="highlight"][data-mark="live"]'
/** The open Pick's own mark. */
const CURRENT = '[data-part="highlight"][data-mark="current"]'

/** How far a mark is from an element, the same way `offFrom` measures. */
async function markOff(
  page: Page,
  mark: string,
  selector: string,
): Promise<Record<string, number>> {
  const element = await boxOf(page, selector)
  const box = await boxOf(page, mark)
  const rounded = (drift: number) => (Math.abs(drift) <= 1 ? 0 : Math.round(drift))
  return {
    left: rounded(box.x - element.x),
    top: rounded(box.y - element.y),
    width: rounded(box.width - element.width),
    height: rounded(box.height - element.height),
  }
}

/** Whether a mark wears the live treatment: a fill, and a chip that shows. */
async function treatmentOf(page: Page, mark: string): Promise<string> {
  return page.locator(mark).evaluate((box: HTMLElement) => {
    const chip = box.querySelector('[data-part="chip"]')
    const fill = getComputedStyle(box).backgroundColor !== 'rgba(0, 0, 0, 0)'
    const chipShown = chip !== null && getComputedStyle(chip).opacity === '1'
    return box.hasAttribute('data-resting') || !fill || !chipShown ? 'resting' : 'lit'
  })
}

test.describe('Alt held over an open Panel', () => {
  test('shows a live Highlight where the pointer is, and rests the Pick’s own', async ({
    page,
  }) => {
    await open(page, probe('alt-preview'))
    await page.locator(PICKER).click()
    await pick(page, SECOND)
    await expect(page.locator(CURRENT)).toBeVisible()
    await expect(page.locator(LIVE)).toHaveCount(0)

    await page.keyboard.down('Alt')
    await hover(page, FIRST)

    await expect(page.locator(LIVE)).toBeVisible()
    await expect.poll(() => markOff(page, LIVE, FIRST)).toEqual(ON_IT)
    await expect.poll(() => treatmentOf(page, LIVE)).toBe('lit')
    await expect(page.locator(LIVE).locator('[data-part="chip"]')).toBeVisible()
    // The Pick is still where it was, dropped to the resting treatment.
    await expect.poll(() => markOff(page, CURRENT, SECOND)).toEqual(ON_IT)
    await expect(page.locator(CURRENT)).toHaveAttribute('data-resting', '')
    await expect.poll(() => treatmentOf(page, CURRENT)).toBe('resting')
    // Painted apart: the live one over the Pick's, and the Pick's over the
    // resting marks of Picks already sent.
    const layers = await page.evaluate((tag) => {
      const root = document.querySelector(tag)?.shadowRoot
      const layer = (selector: string) => {
        const box = root?.querySelector(selector)
        return box ? Number(getComputedStyle(box).zIndex) : Number.NaN
      }
      return {
        live: layer('[data-mark="live"]'),
        current: layer('[data-mark="current"]'),
        panel: layer('[data-part="panel"]'),
      }
    }, HOST)
    expect(layers.live).toBeGreaterThan(layers.current)
    expect(layers.current).toBeGreaterThan(1)
    expect(layers.panel).toBeGreaterThan(layers.live)

    // Let go of Alt: the live one fades where it stands, the Pick's relights.
    await page.keyboard.up('Alt')
    await expect(page.locator(LIVE)).toHaveCount(0)
    await expect(page.locator(CURRENT)).not.toHaveAttribute('data-resting', '')
    await expect.poll(() => treatmentOf(page, CURRENT)).toBe('lit')
    await expect.poll(() => markOff(page, CURRENT, SECOND)).toEqual(ON_IT)
    await expect(page.locator(PANEL)).toHaveCount(1)
  })

  test('the live one fades rather than vanishing when Alt is let go', async ({
    page,
  }) => {
    await open(page, probe('alt-release'))
    await page.locator(PICKER).click()
    await pick(page, SECOND)
    await page.keyboard.down('Alt')
    await hover(page, FIRST)
    await expect(page.locator(LIVE)).toBeVisible()
    await expect.poll(() => runningInOverlay(page)).toBe(0)
    await watchMotion(page)

    await page.keyboard.up('Alt')
    await expect(page.locator(LIVE)).toHaveCount(0)
    expect(await motionSeen(page)).toContain('opacity')
    expect(moving(await motionSeen(page))).toEqual([])
  })

  test('Alt-click makes the live one the Pick, and the old mark fades', async ({
    page,
  }) => {
    await open(page, probe('alt-move'))
    await page.locator(PICKER).click()
    await pick(page, SECOND)
    const panelBefore = await boxOf(page, PANEL)

    await page.keyboard.down('Alt')
    await hover(page, FIRST)
    await expect(page.locator(LIVE)).toBeVisible()
    await expect.poll(() => runningInOverlay(page)).toBe(0)
    await watchMotion(page)
    const at = await centre(page, FIRST)
    await page.mouse.click(at.x, at.y)

    // The mark that was following the pointer is the Pick's now, lit and on
    // the element it was on; the one left behind is the live one until it
    // has faded, and then it is gone.
    await expect.poll(() => markOff(page, CURRENT, FIRST)).toEqual(ON_IT)
    await expect.poll(() => treatmentOf(page, CURRENT)).toBe('lit')
    await expect(page.locator(LIVE)).toHaveCount(0)
    expect(await motionSeen(page)).toContain('opacity')
    expect(moving(await motionSeen(page))).toEqual([])

    // Alt still held: the next element pointed at gets a live mark, lit — not
    // the resting treatment the box it is made of wore a moment ago.
    await hover(page, THIRD)
    await expect(page.locator(LIVE)).toBeVisible()
    await expect.poll(() => markOff(page, LIVE, THIRD)).toEqual(ON_IT)
    await expect.poll(() => treatmentOf(page, LIVE)).toBe('lit')
    await page.keyboard.up('Alt')
    await expect(page.locator(LIVE)).toHaveCount(0)

    // One Panel, moved to the new element (panel-motion.spec.ts watches it go).
    await expect(page.locator(PANEL)).toHaveCount(1)
    await expect.poll(async () => (await boxOf(page, PANEL)).y).not.toBe(panelBefore.y)
    await expect(page.locator(CURRENT)).toHaveCount(1)
  })
})

test('once a Pick is sent, the mark following the pointer is lit and paints over its resting mark', async ({
  page,
}) => {
  const token = probe('alt-submitted')
  await open(page, token)
  await page.locator(PICKER).click()
  await pick(page, FIRST)
  await page.keyboard.type(`rest here ${token}`)
  await page.keyboard.press('Enter')
  // Send minimizes the Panel into the Stack: nothing is open, so nothing of
  // the Pick's own is left on the page but its resting mark.
  await sent(page)
  await expect(page.locator(CURRENT)).toHaveCount(0)

  // Alt arms again. Over the element the sent Pick rests on: both marks on
  // one element, and the one following the pointer is lit and on top.
  await page.keyboard.down('Alt')
  await hover(page, FIRST)
  await expect(page.locator(CURRENT)).toBeVisible()
  await expect.poll(() => treatmentOf(page, CURRENT)).toBe('lit')
  const layers = await page.evaluate((tag) => {
    const root = document.querySelector(tag)?.shadowRoot
    const layer = (selector: string) => {
      const box = root?.querySelector(selector)
      return box ? Number(getComputedStyle(box).zIndex) : Number.NaN
    }
    return {
      following: layer('[data-mark="current"]'),
      resting: layer('[data-part="highlight"][data-resting]:not([data-mark])'),
    }
  }, HOST)
  expect(layers.following).toBeGreaterThan(layers.resting)

  // Alt-click starts a new Pick there, and with Alt still held the next
  // element pointed at gets a lit live mark too.
  const at = await centre(page, FIRST)
  await page.mouse.click(at.x, at.y)
  await expect.poll(() => markOff(page, CURRENT, FIRST)).toEqual(ON_IT)
  await hover(page, THIRD)
  await expect(page.locator(LIVE)).toBeVisible()
  await expect.poll(() => treatmentOf(page, LIVE)).toBe('lit')
  await page.keyboard.up('Alt')
  await expect(page.locator(LIVE)).toHaveCount(0)
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
  await sent(page)
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
    expect(moving(await motionSeen(page))).toEqual([])
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
    expect(moving(await motionSeen(page))).toEqual([])
    await expect.poll(() => runningInOverlay(page)).toBe(0)
  })

  test('Alt over an open Panel previews, rests, relights and moves, with nothing but fades', async ({
    page,
  }) => {
    await open(page, probe('reduce-alt'))
    await page.locator(PICKER).click()
    await pick(page, SECOND)
    await watchMotion(page)

    await page.keyboard.down('Alt')
    await hover(page, FIRST)
    await expect(page.locator(LIVE)).toBeVisible()
    await expect.poll(() => markOff(page, LIVE, FIRST)).toEqual(ON_IT)
    await expect(page.locator(CURRENT)).toHaveAttribute('data-resting', '')

    // Across to another element: the live mark jumps there, it does not travel.
    await hover(page, SECOND)
    await expect.poll(() => markOff(page, LIVE, SECOND)).toEqual(ON_IT)
    await hover(page, FIRST)
    await expect.poll(() => markOff(page, LIVE, FIRST)).toEqual(ON_IT)

    await page.keyboard.up('Alt')
    await expect(page.locator(LIVE)).toHaveCount(0)
    await expect(page.locator(CURRENT)).not.toHaveAttribute('data-resting', '')

    await page.keyboard.down('Alt')
    await hover(page, FIRST)
    const at = await centre(page, FIRST)
    await page.mouse.click(at.x, at.y)
    await page.keyboard.up('Alt')
    await expect.poll(() => markOff(page, CURRENT, FIRST)).toEqual(ON_IT)
    await expect(page.locator(LIVE)).toHaveCount(0)

    expect(moving(await motionSeen(page))).toEqual([])
    await expect.poll(() => runningInOverlay(page)).toBe(0)
  })
})
