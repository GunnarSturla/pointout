import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { hostURL } from '../harness/hosts.js'

// Ticket 03 of the Next.js Connector: the Next.js test bed in a browser, with no
// pointout in it yet. Both routers render the shared fixtures and hydrate, the
// framed route hydrates inside its frame, and nothing warns about hydration —
// so when ticket 06 puts the Overlay in, any hydration warning is its own.

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
})
