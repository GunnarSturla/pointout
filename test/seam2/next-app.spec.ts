import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { hostURL } from '../harness/hosts.js'

// Tickets 03 and 06 of the Next.js Connector: the Next.js test bed in a browser,
// with pointout in it. Both routers render the shared fixtures and hydrate, the
// framed route hydrates inside its frame, the Overlay is drawn on both routers
// once React has hydrated, and nothing warns about hydration — not the page, and
// not the Overlay, which waits for hydration before it draws anything.

/** What the page printed to its console at `warning` or `error`. */
function complaints(page: Page): string[] {
  const seen: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      seen.push(message.text())
  })
  page.on('pageerror', (error) => seen.push(error.message))
  return seen
}

const HYDRATION = /hydrat/i

const PICKER = '[data-part="picker"]'
const OVERLAY_HOST = 'pointout-overlay'

for (const route of ['/', '/pages-router']) {
  test(`${route} renders the shared fixtures and hydrates, with no hydration warning`, async ({
    page,
  }) => {
    const said = complaints(page)
    await page.goto(hostURL('next', route))

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'pointout — test bed',
    )
    await expect(page.locator('[data-fixture="nested-owners-card"]')).toHaveCount(2)
    await expect(page.locator('[data-fixture="chain-leaf"]')).toHaveText(
      'picked three owners down',
    )

    // Only a hydrated page answers a click.
    await page.locator('[data-fixture="full-viewport-decoy-restore"]').click()
    await expect(page.locator('[data-fixture="full-viewport-decoy"]')).toBeVisible()

    // The Overlay is there, and there is exactly one of it.
    await expect(page.locator(PICKER)).toBeVisible()
    await expect(page.locator(OVERLAY_HOST)).toHaveCount(1)

    expect(said.filter((text) => HYDRATION.test(text))).toEqual([])
  })
}

test('`/?decoy` hydrates into the decoy, with no hydration warning', async ({ page }) => {
  const said = complaints(page)
  await page.goto(hostURL('next', '/?decoy'))

  await expect(page.locator('[data-fixture="full-viewport-decoy"]')).toBeVisible()
  expect(said.filter((text) => HYDRATION.test(text))).toEqual([])
})

test('the Server Component owns a client component that hydrates', async ({ page }) => {
  await page.goto(hostURL('next', '/'))
  const leaf = page.locator('[data-fixture="server-owner"] [data-fixture="client-leaf"]')
  await leaf.scrollIntoViewIfNeeded()
  await leaf.click()
  await expect(leaf).toContainText('Pressed 1 times.')
})

test('the same-origin frame loads its route, which hydrates inside it', async ({
  page,
}) => {
  await page.goto(hostURL('next', '/'))
  const frame = page.frameLocator('[data-fixture="framed-route"]')
  const leaf = frame.locator('[data-fixture="client-leaf"]')
  await expect(leaf).toContainText('Inside a framed route.')
  await leaf.click()
  await expect(leaf).toContainText('Pressed 1 times.')

  // Same origin: the page can read the frame's document.
  const readable = await page
    .locator('[data-fixture="framed-route"]')
    .evaluate(
      (element) =>
        (element as HTMLIFrameElement).contentDocument?.querySelector(
          '[data-fixture="framed-page"]',
        ) !== null,
    )
  expect(readable).toBe(true)

  // The page's Overlay reaches into the frame, so the frame draws none of its
  // own: one Picker, one Alt.
  await expect(page.locator(OVERLAY_HOST)).toHaveCount(1)
  await expect(frame.locator(OVERLAY_HOST)).toHaveCount(0)
})

const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
/** Next's dev indicator, inside the `nextjs-portal` Next draws its tools in. */
const NEXT_INDICATOR = 'nextjs-portal #next-logo'

for (const route of ['/', '/pages-router']) {
  test(`${route}: Next's dev indicator is never highlighted or picked`, async ({
    page,
  }) => {
    await page.goto(hostURL('next', route))
    await expect(page.locator(PICKER)).toBeVisible()
    const indicator = page.locator(NEXT_INDICATOR)
    await expect(indicator).toBeVisible()
    const box = await indicator.boundingBox()
    if (!box) throw new Error("Next's dev indicator has no box")
    const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

    await page.locator(PICKER).click()
    // Somewhere else first, so a Highlight missing over the indicator is
    // missing because of the indicator, not because nothing was hovered.
    const heading = await page.getByRole('heading', { level: 1 }).boundingBox()
    if (!heading) throw new Error('the heading has no box')
    await page.mouse.move(heading.x + 10, heading.y + heading.height / 2)
    await expect(page.locator(HIGHLIGHT)).toBeVisible()

    await page.mouse.move(at.x, at.y, { steps: 4 })
    await expect(page.locator(HIGHLIGHT)).toBeHidden()

    await page.mouse.click(at.x, at.y)
    await expect(page.locator(PANEL)).toHaveCount(0)
  })
}
