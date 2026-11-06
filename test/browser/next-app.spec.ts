import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { hostURL } from '../harness/hosts.js'
import { repoRoot } from '../harness/paths.js'

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

/** Where the fake session's inbox writes what it received (test/harness/serve.ts). */
const FRAMES_LOG_ENV = 'BROWSER_FRAMES_LOG'

/** The one delivered body that carries this token. */
async function delivered(token: string): Promise<string> {
  const log = process.env[FRAMES_LOG_ENV]
  if (!log)
    throw new Error(
      `${FRAMES_LOG_ENV} is unset: the browser suite's globalSetup did not run`,
    )
  let found: string | undefined
  await expect
    .poll(
      () => {
        found = readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((frame) => frame.type === 'user')
          .map((frame) => (frame.message as { content: string }).content)
          .find((content) => content.includes(token))
        return found !== undefined
      },
      { timeout: 10_000 },
    )
    .toBe(true)
  return found ?? ''
}

/**
 * A Server Component's link as the Pointer says it: the JSX it wrote, read
 * back out of the server chunk's map, exact.
 */
function exactLink(name: string, file: string, marker: string): string {
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n')
  const index = lines.findIndex((line) => line.includes(marker))
  if (index === -1) throw new Error(`${file} no longer contains ${marker}`)
  const column = (lines[index] ?? '').indexOf(marker) + 1
  return `${name} — ${file}:${index + 1}:${column} (exact)`
}

test("picking the Server Component's client child gives a chain through the Server Component's own call site", async ({
  page,
}, info) => {
  const token = `server-owner-${Math.random().toString(16).slice(2)}`
  await page.goto(hostURL('next', `/?probe=${token}`))
  await expect(page.locator(PICKER)).toBeVisible()
  const leaf = page.locator('[data-fixture="server-owner"] [data-fixture="client-leaf"]')
  await leaf.scrollIntoViewIfNeeded()
  const box = await leaf.boundingBox()
  if (!box) throw new Error('the client leaf has no box')
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.locator(PICKER).click()
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
  await page.keyboard.type(`the server-owned leaf ${token}`)
  await page.keyboard.press('Enter')

  const content = await delivered(token)
  // The client component, then the Server Component that rendered it, then the
  // page that rendered that: the chain runs through the server's records and
  // does not stop at the first of them.
  expect(content).toMatch(/ClientLeaf — /)
  if (info.project.name === 'webkit') {
    // Measured, and filed as issue 11: WebKit replays the server's stacks with
    // neither a location in the Server Component's frame nor React's bottom
    // frame, so the server finds no app frame in them at all. The links are
    // still there, named and annotated; what they say differs.
    for (const name of ['ServerOwner', 'AppRouterPage']) {
      expect(content).toContain(`${name} — no location (absent: no-react-boundary — `)
    }
    return
  }
  // `ServerOwner` wrote `<ClientLeaf>`, and `AppRouterPage` wrote `<ServerOwner />`.
  expect(content).toContain(
    exactLink(
      'ServerOwner',
      'examples/next-app/fixtures/ServerOwner.tsx',
      '<ClientLeaf label=',
    ),
  )
  expect(content).toContain(
    exactLink('AppRouterPage', 'examples/next-app/app/page.tsx', '<ServerOwner />'),
  )
})
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
