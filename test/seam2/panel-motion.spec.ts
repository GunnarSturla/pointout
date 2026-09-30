import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { apartFromHotUpdates } from '../harness/hot-update-lock.js'

// Seam 2: the Panel arriving, leaving and travelling (spec §7, §9;
// docs/motion.md; overlay-polish ticket 07).
//
// The Panel grows out of the edge that faces its element, leaves quickly, and
// travels when an Alt-click moves its Pick. Under reduced motion each of those
// is a fade, where the Panel stands.
//
// Everything here is watched over several frames, not read inside one task:
// ticket 03's morph was cut short a couple of frames in, and a read inside the
// task that started it could not see that. So each journey records the
// transitions the Panel starts and samples what it draws, once a frame, from
// the gesture on. The frame-watching journeys take the hot-update lock, as the
// Highlight's do, because a hot update re-measures everything anchored to the
// page (test/harness/hot-update-lock.ts).
//
// Every string here is written out rather than imported: the Overlay's part
// names are the contract (docs/agents/testing.md).

const HOST = 'pointout-overlay'
const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const NOTE = '[data-part="note"]'
const MINIMIZED = '[data-part="minimized"]'
const MINIMIZED_LINE = '[data-part="minimized-line"]'
const EXPANDED = '[data-part="expanded"]'

const PICKED = '[data-fixture="card-heading"]'
/** Above `PICKED`, so a Panel opened below that one never covers it. */
const HEADING = 'h1'
const EDGES_TOGGLE = '[data-fixture="viewport-edges-toggle"]'
/** Room below it and none above: the Panel opens below. */
const EDGE_TOP = '[data-fixture="edge-top"]'
/** No room below it: the Panel opens above. */
const EDGE_BOTTOM = '[data-fixture="edge-bottom"]'

/** What a fade may ease: nothing of it travels or changes size. */
const FADES = ['opacity', 'color', 'background-color', 'border-color', 'outline-color']

/** How many frames each journey watches: well past the 200 ms the longest takes. */
const FRAMES = 24

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** One frame of what the Panel draws, and of any copy of it still leaving. */
interface Frame {
  /** The live Panel: null in a frame it is not in the page. */
  panel: Drawn | null
  /** A Panel that has gone, leaving: null when there is none. */
  leaving: Drawn | null
  /** The newest minimized Panel in the Stack: null when there is none. */
  minimized: Drawn | null
}

interface Drawn {
  opacity: number
  /** The scale its `transform` draws it at across, 1 when it has none. */
  scale: number
  /** The same, down. */
  scaleY: number
  top: number
  left: number
  width: number
  height: number
  /** Where it is placed, which a travel draws it away from until it arrives. */
  placedTop: number
  /** What its Note field says, or null when it has none. */
  note: string | null
}

interface Watched {
  /** Every transition started on the live Panel, by property. */
  live: string[]
  /** Every transition started on a leaving copy, by property. */
  leaving: string[]
  /** Every transition started on a minimized Panel, by property. */
  minimized: string[]
  frames: Frame[]
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
  // Every fixture in the example app sits below the fold.
  await page.locator(selector).first().scrollIntoViewIfNeeded()
  const box = await boxOf(page, selector)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function arm(page: Page): Promise<void> {
  const picker = page.locator(PICKER)
  await picker.click()
  if ((await picker.getAttribute('data-armed')) === null) await picker.click()
  await expect(picker).toHaveAttribute('data-armed', '')
}

/** Hover first and let the Highlight settle, so what is watched is the click. */
async function hoverAndSettle(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number }> {
  const at = await centre(page, selector)
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT).first()).toBeVisible()
  await settled(page)
  return at
}

/**
 * Nothing in the Overlay is still easing. The session dots loop for ever
 * (overlay-polish ticket 06), so they are left out of the count: a Working or
 * Needs you Target would otherwise never settle.
 */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((tag) => {
        const root = document.querySelector(tag)?.shadowRoot
        if (!root) return -1
        return [...root.querySelectorAll('*')]
          .filter((element) => !element.closest('[data-part="dot"], .dot'))
          .reduce((count, element) => count + element.getAnimations().length, 0)
      }, HOST),
    )
    .toBe(0)
}

/**
 * Start watching, then do `gesture` with the real mouse or keyboard, and
 * answer what the Panel did over the frames after it. `surface` is the part
 * watched: the unsubmitted Panel, or a submitted one opened above the Stack.
 */
async function watchPanel(
  page: Page,
  gesture: () => Promise<void>,
  surface: 'panel' | 'expanded' = 'panel',
): Promise<Watched> {
  return apartFromHotUpdates(async () => {
    await page.evaluate(
      ({ tag, frames, part }) => {
        const root = document.querySelector(tag)?.shadowRoot
        if (!root) throw new Error('the Overlay is not mounted')
        const watched = {
          live: [] as string[],
          leaving: [] as string[],
          minimized: [] as string[],
          frames: [] as unknown[],
        }
        Object.assign(window, { watchedPanel: watched, watchedDone: false })
        root.addEventListener('transitionrun', (event) => {
          const target = event.target as Element
          const name = (event as TransitionEvent).propertyName
          if (target.getAttribute('data-part') === 'minimized') {
            watched.minimized.push(name)
            return
          }
          if (!target.classList.contains(part)) return
          if (target.getAttribute('data-part') === part) watched.live.push(name)
          else watched.leaving.push(name)
        })
        const drawn = (node: Element | null) => {
          if (!node) return null
          const style = getComputedStyle(node)
          const rect = node.getBoundingClientRect()
          const matrix =
            style.transform === 'none' ? null : new DOMMatrix(style.transform)
          return {
            opacity: Number(style.opacity),
            scale: matrix ? matrix.a : 1,
            scaleY: matrix ? matrix.d : 1,
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            placedTop: Number.parseFloat(style.top),
            note: node.querySelector('textarea')?.value ?? null,
          }
        }
        const frame = () => {
          watched.frames.push({
            panel: drawn(root.querySelector(`[data-part="${part}"]`)),
            leaving: drawn(root.querySelector(`.${part}:not([data-part="${part}"])`)),
            minimized: drawn(
              [...root.querySelectorAll('[data-part="minimized"]')].at(-1) ?? null,
            ),
          })
          if (watched.frames.length < frames) requestAnimationFrame(frame)
          else Object.assign(window, { watchedDone: true })
        }
        requestAnimationFrame(frame)
      },
      { tag: HOST, frames: FRAMES, part: surface },
    )
    await gesture()
    await page.waitForFunction(
      () => (window as unknown as { watchedDone: boolean }).watchedDone,
    )
    return page.evaluate(
      () => (window as unknown as { watchedPanel: Watched }).watchedPanel,
    )
  })
}

/** Some value strictly between two ends, in a frame after the first two. */
function between(values: number[], from: number, to: number): number[] {
  const low = Math.min(from, to) + 0.001
  const high = Math.max(from, to) - 0.001
  return values.filter((value) => value > low && value < high)
}

/** The Panel's `transform-origin`, as the engine resolves it, in px. */
async function originOf(page: Page): Promise<{ x: number; y: number }> {
  const origin = await page
    .locator(PANEL)
    .evaluate((panel) => getComputedStyle(panel).transformOrigin)
  const [x, y] = origin.split(' ').map((length) => Number.parseFloat(length))
  return { x: x ?? Number.NaN, y: y ?? Number.NaN }
}

/** Open a Pick on `PICKED`, write `note`, and let everything settle before Send. */
async function writeOn(page: Page, note: string): Promise<Box> {
  await arm(page)
  const at = await hoverAndSettle(page, PICKED)
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
  await page.keyboard.type(note)
  await settled(page)
  return boxOf(page, PANEL)
}

/** Write a Pick on `PICKED` and send it, and let the Stack settle. */
async function sendOne(page: Page, note: string): Promise<Box> {
  await writeOn(page, note)
  await page.keyboard.press('Enter')
  await expect(page.locator(MINIMIZED)).toHaveCount(1)
  await settled(page)
  return boxOf(page, MINIMIZED)
}

test.describe('with motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('the Panel grows in from the edge that faces its element', async ({ page }) => {
    await open(page, probe('enter'))
    await arm(page)
    const at = await hoverAndSettle(page, PICKED)

    const watched = await watchPanel(page, () => page.mouse.click(at.x, at.y))

    expect(watched.live).toContain('opacity')
    expect(watched.live).toContain('transform')
    expect(watched.live).not.toContain('translate')
    expect(watched.live.filter((name) => !FADES.includes(name))).toEqual(['transform'])

    // It really grows, frame after frame: a scale somewhere between the two
    // ends, and an opacity somewhere between, after the frame it arrived in.
    const drawn = watched.frames.flatMap((frame) => (frame.panel ? [frame.panel] : []))
    expect(drawn.length).toBeGreaterThan(4)
    const later = drawn.slice(1)
    expect(
      between(
        later.map((frame) => frame.scale),
        0.96,
        1,
      ).length,
    ).toBeGreaterThan(0)
    expect(
      between(
        later.map((frame) => frame.opacity),
        0,
        1,
      ).length,
    ).toBeGreaterThan(0)
    // It arrives where it is going: nothing of it travels in.
    const tops = drawn.map((frame) => frame.top)
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(12)
    await settled(page)
    expect(
      await page.locator(PANEL).evaluate((panel) => getComputedStyle(panel).opacity),
    ).toBe('1')
  })

  test('its origin is on the side its element is on', async ({ page }) => {
    await open(page, probe('origin'))
    await page.locator(EDGES_TOGGLE).click()

    // Opened below its element, it grows downward out of its top edge.
    await arm(page)
    const top = await hoverAndSettle(page, EDGE_TOP)
    await page.mouse.click(top.x, top.y)
    await expect(page.locator(PANEL)).toBeVisible()
    const belowElement = await boxOf(page, EDGE_TOP)
    await settled(page)
    const below = await boxOf(page, PANEL)
    expect(below.y).toBeGreaterThan(belowElement.y)
    const fromTop = await originOf(page)
    expect(fromTop.y).toBe(0)
    // Across, it grows from where the element is, within the Panel's width.
    const elementMiddle = belowElement.x + belowElement.width / 2 - below.x
    expect(
      Math.abs(fromTop.x - Math.min(Math.max(elementMiddle, 0), below.width)),
    ).toBeLessThan(2)

    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // Opened above, out of its bottom edge.
    await arm(page)
    const bottom = await hoverAndSettle(page, EDGE_BOTTOM)
    await page.mouse.click(bottom.x, bottom.y)
    await expect(page.locator(PANEL)).toBeVisible()
    await settled(page)
    const above = await boxOf(page, PANEL)
    expect(above.y).toBeLessThan((await boxOf(page, EDGE_BOTTOM)).y)
    const fromBottom = await originOf(page)
    expect(Math.abs(fromBottom.y - above.height)).toBeLessThan(2)
  })

  test('Escape takes it away quickly, shrinking back where it stood', async ({
    page,
  }) => {
    await open(page, probe('leave'))
    await arm(page)
    const at = await hoverAndSettle(page, PICKED)
    await page.mouse.click(at.x, at.y)
    await expect(page.locator(PANEL)).toBeVisible()
    await settled(page)
    const stood = await boxOf(page, PANEL)

    const watched = await watchPanel(page, () => page.keyboard.press('Escape'))

    // The Panel itself is gone at once: nothing can type into it or read it
    // as the Panel. What leaves is a still copy of it, which fades and
    // shrinks where it stood, and is then taken out.
    await expect(page.locator(PANEL)).toHaveCount(0)
    expect(watched.live).toEqual([])
    expect(watched.leaving).toContain('opacity')
    expect(watched.leaving).toContain('transform')
    const leaving = watched.frames.flatMap((frame) =>
      frame.leaving ? [frame.leaving] : [],
    )
    expect(leaving.length).toBeGreaterThan(1)
    expect(
      between(
        leaving.slice(1).map((frame) => frame.opacity),
        0,
        1,
      ).length,
    ).toBeGreaterThan(0)
    expect(Math.abs((leaving[0]?.top ?? Number.NaN) - stood.y)).toBeLessThan(12)
    // It has faded out within the frames watched, and is then taken out.
    // (How many frames that takes is the engine's: Firefox draws them faster.)
    expect(watched.frames.at(-1)?.leaving?.opacity ?? 0).toBe(0)
    await expect(page.locator(`${HOST} .panel`)).toHaveCount(0)
  })

  test('an Alt-click travels the Panel to the new element, with its Note', async ({
    page,
  }) => {
    const token = probe('travel')
    await open(page, token)
    await arm(page)
    const first = await hoverAndSettle(page, PICKED)
    await page.mouse.click(first.x, first.y)
    await expect(page.locator(PANEL)).toBeVisible()
    await page.keyboard.type(`carried ${token}`)
    await settled(page)
    const from = await boxOf(page, PANEL)

    const to = await centre(page, HEADING)
    await page.keyboard.down('Alt')
    await page.mouse.move(to.x, to.y)
    await settled(page)
    const watched = await watchPanel(page, () => page.mouse.click(to.x, to.y))
    await page.keyboard.up('Alt')

    expect(watched.live).toContain('translate')
    expect(watched.leaving).toEqual([])
    await settled(page)
    const arrived = await boxOf(page, PANEL)
    expect(Math.abs(arrived.y - from.y)).toBeGreaterThan(40)
    // It is on its way in the frames after the click: somewhere it neither
    // started nor ended, and never scaled on the way.
    const tops = watched.frames.flatMap((frame) => (frame.panel ? [frame.panel.top] : []))
    expect(between(tops.slice(1), from.y, arrived.y).length).toBeGreaterThan(0)
    expect(watched.frames.every((frame) => (frame.panel?.scale ?? 1) === 1)).toBe(true)
    await expect(page.locator(PANEL)).toHaveCount(1)
    await expect(page.locator(NOTE)).toHaveValue(`carried ${token}`)
  })

  test('Send shrinks the Panel into its slot in the Stack, in one motion', async ({
    page,
  }) => {
    const token = probe('send')
    await open(page, token)
    const stood = await writeOn(page, `shrinks ${token}`)

    const watched = await watchPanel(page, () => page.keyboard.press('Enter'))

    await expect(page.locator(PANEL)).toHaveCount(0)
    await expect(page.locator(MINIMIZED)).toHaveCount(1)
    await settled(page)
    const slot = await boxOf(page, MINIMIZED)

    // What leaves is a copy of the open Panel, and it goes somewhere: a
    // transform that takes it from its own box toward the minimized one.
    expect(watched.leaving).toContain('transform')
    expect(watched.leaving).toContain('opacity')
    const leaving = watched.frames.flatMap((frame) =>
      frame.leaving ? [frame.leaving] : [],
    )
    expect(leaving.length).toBeGreaterThan(3)
    expect(Math.abs((leaving[0]?.top ?? Number.NaN) - stood.y)).toBeLessThan(12)
    // On its way, frame after frame: somewhere between the open box and the
    // slot, and smaller than it started, both across and down.
    const later = leaving.slice(1)
    const middles = later.map((frame) => frame.top + frame.height / 2)
    expect(
      between(middles, stood.y + stood.height / 2, slot.y + slot.height / 2).length,
    ).toBeGreaterThan(0)
    expect(
      between(
        later.map((frame) => frame.scale),
        slot.width / stood.width,
        1,
      ).length,
    ).toBeGreaterThan(0)
    expect(
      between(
        later.map((frame) => frame.scaleY),
        slot.height / stood.height,
        1,
      ).length,
    ).toBeGreaterThan(0)
    // It ends on the slot, not short of it.
    const last = leaving.at(-1)
    expect(Math.abs((last?.top ?? Number.NaN) - slot.y)).toBeLessThan(4)
    expect(Math.abs((last?.left ?? Number.NaN) - slot.x)).toBeLessThan(4)
    expect(Math.abs((last?.width ?? Number.NaN) - slot.width)).toBeLessThan(4)
    // The minimized Panel fades in where it rests, and nothing of it moves.
    expect(watched.minimized).toEqual(['opacity'])
    await expect(page.locator(`${HOST} .panel`)).toHaveCount(0)
  })

  test('a submitted Panel grows up out of its slot, and shrinks back into it', async ({
    page,
  }) => {
    const token = probe('expand')
    await open(page, token)
    const slot = await sendOne(page, `opened ${token}`)
    // By where it is, so nothing but the press itself happens while it is watched.
    const line = await centre(page, MINIMIZED_LINE)
    const press = () => page.mouse.click(line.x, line.y)

    const opening = await watchPanel(page, press, 'expanded')

    expect(opening.live).toContain('opacity')
    expect(opening.live).toContain('transform')
    expect(opening.live.filter((name) => !FADES.includes(name))).toEqual(['transform'])
    await settled(page)
    const opened = await boxOf(page, EXPANDED)
    expect(opened.y + opened.height).toBeLessThan(slot.y)
    // It starts on the slot and grows from it, frame after frame: a height
    // somewhere between the two, and nothing drawn below the slot's top edge
    // rising past where it ends.
    const drawn = opening.frames.flatMap((frame) => (frame.panel ? [frame.panel] : []))
    expect(drawn.length).toBeGreaterThan(4)
    expect(Math.abs((drawn[0]?.top ?? Number.NaN) - slot.y)).toBeLessThan(4)
    expect(Math.abs((drawn[0]?.height ?? Number.NaN) - slot.height)).toBeLessThan(4)
    expect(
      between(
        drawn.slice(1).map((frame) => frame.height),
        slot.height,
        opened.height,
      ).length,
    ).toBeGreaterThan(0)

    const closing = await watchPanel(page, press, 'expanded')

    await expect(page.locator(EXPANDED)).toHaveCount(0)
    expect(closing.leaving).toContain('transform')
    const leaving = closing.frames.flatMap((frame) =>
      frame.leaving ? [frame.leaving] : [],
    )
    expect(leaving.length).toBeGreaterThan(3)
    expect(Math.abs((leaving[0]?.top ?? Number.NaN) - opened.y)).toBeLessThan(4)
    const last = leaving.at(-1)
    expect(Math.abs((last?.top ?? Number.NaN) - slot.y)).toBeLessThan(4)
    expect(Math.abs((last?.height ?? Number.NaN) - slot.height)).toBeLessThan(4)
    await expect(page.locator(`${HOST} .expanded`)).toHaveCount(0)
  })
})

test.describe('with motion allowed, interrupted', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('Escape on the way leaves it where it was drawn, not where it was going', async ({
    page,
  }) => {
    await open(page, probe('travel-leave'))
    await arm(page)
    const first = await hoverAndSettle(page, PICKED)
    await page.mouse.click(first.x, first.y)
    await expect(page.locator(PANEL)).toBeVisible()
    await settled(page)
    const from = await boxOf(page, PANEL)

    const to = await centre(page, HEADING)
    await page.keyboard.down('Alt')
    await page.mouse.move(to.x, to.y)
    await settled(page)
    let going = Number.NaN
    const watched = await watchPanel(page, async () => {
      await page.mouse.click(to.x, to.y)
      await page.keyboard.up('Alt')
      // Put away as soon as it has somewhere else to be, and while it is still
      // on its way there.
      const placed = await page.waitForFunction(
        ({ tag, was }) => {
          const panel = document
            .querySelector(tag)
            ?.shadowRoot?.querySelector<HTMLElement>('[data-part="panel"]')
          const top = panel ? Number.parseFloat(panel.style.top) : was
          return Math.abs(top - was) > 40 ? top : null
        },
        { tag: HOST, was: from.y },
      )
      going = Number(await placed.jsonValue())
      await page.keyboard.press('Escape')
    })

    const left = watched.frames.flatMap((frame) => (frame.leaving ? [frame.leaving] : []))
    expect(left.length).toBeGreaterThan(0)
    // The copy starts from somewhere the travel had brought the Panel to, not
    // from where it was going: 200 ms had not passed.
    const start = left[0]?.top ?? Number.NaN
    expect(Math.abs(start - going)).toBeGreaterThan(2)
    expect(
      between([start], from.y, going).length + (Math.abs(start - from.y) < 2 ? 1 : 0),
    ).toBe(1)
  })
})

test.describe('for a developer who asked for less motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('the Panel fades in where it opens, and nothing of it grows', async ({ page }) => {
    await open(page, probe('enter-reduced'))
    await arm(page)
    const at = await hoverAndSettle(page, PICKED)

    const watched = await watchPanel(page, () => page.mouse.click(at.x, at.y))

    expect(watched.live).toEqual(['opacity'])
    const drawn = watched.frames.flatMap((frame) => (frame.panel ? [frame.panel] : []))
    expect(drawn.every((frame) => frame.scale === 1)).toBe(true)
    expect(
      between(
        drawn.slice(1).map((frame) => frame.opacity),
        0,
        1,
      ).length,
    ).toBeGreaterThan(0)
  })

  test('Escape fades it where it stands, Note and all', async ({ page }) => {
    const token = probe('leave-reduced')
    await open(page, token)
    await arm(page)
    const at = await hoverAndSettle(page, PICKED)
    await page.mouse.click(at.x, at.y)
    await expect(page.locator(PANEL)).toBeVisible()
    await page.keyboard.type(`going ${token}`)
    await settled(page)

    const watched = await watchPanel(page, () => page.keyboard.press('Escape'))

    await expect(page.locator(PANEL)).toHaveCount(0)
    expect(watched.leaving).toEqual(['opacity'])
    const leaving = watched.frames.flatMap((frame) =>
      frame.leaving ? [frame.leaving] : [],
    )
    expect(leaving.every((frame) => frame.scale === 1)).toBe(true)
    // What fades is what was there: the Note as it was written.
    expect(leaving.length).toBeGreaterThan(0)
    expect(leaving.every((frame) => frame.note === `going ${token}`)).toBe(true)
    await expect(page.locator(`${HOST} .panel`)).toHaveCount(0)
  })

  test('an Alt-click fades it out where it was and in where it goes', async ({
    page,
  }) => {
    const token = probe('travel-reduced')
    await open(page, token)
    await arm(page)
    const first = await hoverAndSettle(page, PICKED)
    await page.mouse.click(first.x, first.y)
    await expect(page.locator(PANEL)).toBeVisible()
    await page.keyboard.type(`carried ${token}`)
    await settled(page)
    const from = await boxOf(page, PANEL)

    const to = await centre(page, HEADING)
    await page.keyboard.down('Alt')
    await page.mouse.move(to.x, to.y)
    await settled(page)
    const watched = await watchPanel(page, () => page.mouse.click(to.x, to.y))
    await page.keyboard.up('Alt')

    // Nothing travels: the old place fades out, the new one fades in.
    expect(watched.live).toEqual(['opacity'])
    expect(watched.leaving).toEqual(['opacity'])
    await settled(page)
    const arrived = await boxOf(page, PANEL)
    expect(Math.abs(arrived.y - from.y)).toBeGreaterThan(40)
    const tops = watched.frames.flatMap((frame) => (frame.panel ? [frame.panel.top] : []))
    expect(between(tops, from.y, arrived.y)).toEqual([])
    const left = watched.frames.flatMap((frame) =>
      frame.leaving ? [frame.leaving.top] : [],
    )
    expect(left.length).toBeGreaterThan(0)
    expect(left.every((top) => Math.abs(top - from.y) < 2)).toBe(true)
    await expect(page.locator(NOTE)).toHaveValue(`carried ${token}`)
    await expect(page.locator(`${HOST} .panel`)).toHaveCount(1)
  })
  test('Send fades the Panel out where it stood, and the minimized one in at its slot', async ({
    page,
  }) => {
    const token = probe('send-reduced')
    await open(page, token)
    const stood = await writeOn(page, `fades ${token}`)

    const watched = await watchPanel(page, () => page.keyboard.press('Enter'))

    await expect(page.locator(MINIMIZED)).toHaveCount(1)
    expect(watched.leaving).toEqual(['opacity'])
    expect(watched.minimized).toEqual(['opacity'])
    const leaving = watched.frames.flatMap((frame) =>
      frame.leaving ? [frame.leaving] : [],
    )
    expect(leaving.length).toBeGreaterThan(0)
    expect(leaving.every((frame) => frame.scale === 1 && frame.scaleY === 1)).toBe(true)
    expect(leaving.every((frame) => Math.abs(frame.top - stood.y) < 2)).toBe(true)
    const minimized = watched.frames.flatMap((frame) =>
      frame.minimized ? [frame.minimized] : [],
    )
    expect(
      between(
        minimized.map((frame) => frame.opacity),
        0,
        1,
      ).length,
    ).toBeGreaterThan(0)
    const tops = minimized.map((frame) => frame.top)
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1)
    await expect(page.locator(`${HOST} .panel`)).toHaveCount(0)
  })
  test('a submitted Panel fades in above the Stack and out where it stood', async ({
    page,
  }) => {
    const token = probe('expand-reduced')
    await open(page, token)
    await sendOne(page, `opened ${token}`)
    // By where it is, so nothing but the press itself happens while it is watched.
    const line = await centre(page, MINIMIZED_LINE)
    const press = () => page.mouse.click(line.x, line.y)

    const opening = await watchPanel(page, press, 'expanded')

    expect(opening.live).toEqual(['opacity'])
    const drawn = opening.frames.flatMap((frame) => (frame.panel ? [frame.panel] : []))
    expect(drawn.every((frame) => frame.scale === 1 && frame.scaleY === 1)).toBe(true)
    expect(
      between(
        drawn.slice(1).map((frame) => frame.opacity),
        0,
        1,
      ).length,
    ).toBeGreaterThan(0)
    await settled(page)
    const opened = await boxOf(page, EXPANDED)

    const closing = await watchPanel(page, press, 'expanded')

    expect(closing.leaving).toEqual(['opacity'])
    const leaving = closing.frames.flatMap((frame) =>
      frame.leaving ? [frame.leaving] : [],
    )
    expect(leaving.length).toBeGreaterThan(0)
    expect(leaving.every((frame) => Math.abs(frame.top - opened.y) < 2)).toBe(true)
    expect(leaving.every((frame) => frame.scale === 1 && frame.scaleY === 1)).toBe(true)
    await expect(page.locator(`${HOST} .expanded`)).toHaveCount(0)
  })
})
