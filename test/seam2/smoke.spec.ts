import { expect, test } from '@playwright/test'

// Seam 2's smoke test: the example app renders in all three engines and the
// Overlay module reaches the page. Ticket 04 adds the journeys only a browser
// can show; this one only proves the harness works in Chromium, Firefox and
// WebKit.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('the app renders its initial fixtures', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'vite-agent-inspect — test bed',
  )

  // Nested owner chain: two cards, each with a heading its parent's parent
  // wrote, and a badge created two owners above where it renders.
  await expect(page.locator('[data-fixture="nested-owners-card"]')).toHaveCount(2)
  await expect(page.locator('[data-fixture="passed-down-badge"]').first()).toHaveText(
    'draft',
  )

  // A component from node_modules, and an SVG icon with a pickable path.
  await expect(page.locator('[data-fixture="dependency-skeleton"]')).toBeVisible()
  await expect(page.locator('[data-fixture="svg-icon-path"]')).toBeVisible()
})

test('the fixed full-viewport decoy covers the page and dismisses', async ({ page }) => {
  const decoy = page.locator('[data-fixture="full-viewport-decoy"]')
  await expect(decoy).toBeVisible()

  const size = await decoy.boundingBox()
  const viewport = page.viewportSize()
  expect(size).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(size?.width).toBe(viewport?.width)
  expect(size?.height).toBe(viewport?.height)

  await page.locator('[data-fixture="full-viewport-decoy-dismiss"]').click()
  await expect(decoy).toHaveCount(0)
  await expect(page.locator('[data-fixture="full-viewport-decoy-restore"]')).toBeVisible()
})

test('the Overlay module is served, evaluated, and mounted on one open shadow root', async ({
  page,
}) => {
  await expect
    .poll(() =>
      // The marker's shape is written out here rather than imported from the
      // Overlay: what the page exposes is the contract, and a test that still
      // passes after the Overlay renames its internals is the test we want.
      page.evaluate(() => {
        const marker = (
          globalThis as {
            __viteAgentInspect?: { apiBase?: string; host?: Element }
          }
        ).__viteAgentInspect
        const host = marker?.host
        return {
          apiBase: marker?.apiBase,
          tag: host?.tagName.toLowerCase(),
          mode: host?.shadowRoot ? 'open' : 'closed or absent',
          roots: document.querySelectorAll('vite-agent-inspect').length,
        }
      }),
    )
    .toEqual({
      apiBase: '/__agent',
      tag: 'vite-agent-inspect',
      mode: 'open',
      roots: 1,
    })
})
