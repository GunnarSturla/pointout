import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// The browser suite: the Owner chain, made by a real engine in three of them. A browser is
// the only honest way to produce an owner stack, which is the whole reason this
// suite exists — the server suite builds its stacks, and only a pick can show that what
// React actually hands over survives the trip.
//
// Every string here is written out rather than imported: the frame fields, the
// row wording and the Overlay's part names are the contract
// (docs/agents/testing.md). Nothing imports a server module.

/** Where the fake session's inbox writes what it received (test/harness/serve.ts). */
const FRAMES_LOG_ENV = 'BROWSER_FRAMES_LOG'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The fixture picked here: a span three owners down, and every call site above
 * it an argument to another JSX call rather than a tail call — so no engine's
 * proper tail calls delete a frame and the chain is exact in all three.
 */
const FIXTURE = 'examples/shared/fixtures/OwnerChainDepth.tsx'
const LEAF = '[data-fixture="chain-leaf"]'

/** The forwarding case: ArticleList creates the badge, ArticleCard only places it. */
const NESTED_FIXTURE = 'examples/shared/fixtures/NestedOwners.tsx'
const BADGE = '[data-fixture="passed-down-badge"]'

const PICKER = '[data-part="picker"]'
const HIGHLIGHT = '[data-part="highlight"]'
const PANEL = '[data-part="panel"]'
const SEND = '[data-part="send"]'

/** One probe token per test, carried in the url so its frame can be found. */
function probe(name: string): string {
  return `${name}-${Math.random().toString(16).slice(2)}`
}

async function open(page: Page, token: string): Promise<void> {
  await page.goto(`?probe=${token}`)
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

/** Where a JSX call site sits in a fixture's own source, as `line:col`. */
function original(file: string, marker: string): string {
  const lines = readFileSync(repoRoot + file, 'utf8').split('\n')
  const index = lines.findIndex((line) => line.includes(marker))
  const line = lines[index]
  if (index === -1 || line === undefined) {
    throw new Error(`${file} no longer contains ${marker}`)
  }
  return `${index + 1}:${line.indexOf(marker) + 1}`
}

async function arm(page: Page): Promise<void> {
  await page.locator(PICKER).click()
}

async function pickAndSend(page: Page, selector: string): Promise<void> {
  await arm(page)
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
  await page.locator(SEND).click()
}

test('the innermost link is exact and names the line the tag was written on', async ({
  page,
}) => {
  const token = probe('leaf')
  await open(page, token)
  await pickAndSend(page, LEAF)

  const content = await delivered(token)
  expect(content).toContain(
    `ChainLeaf — ${FIXTURE}:${original(FIXTURE, '<span data-fixture="chain-leaf">')} (exact)`,
  )
})

test('the whole chain arrives, innermost first', async ({ page }) => {
  const token = probe('chain')
  await open(page, token)
  await pickAndSend(page, LEAF)

  const content = await delivered(token)
  const leaf = `ChainLeaf — ${FIXTURE}:${original(FIXTURE, '<span data-fixture="chain-leaf">')} (exact)`
  const middle = `ChainMiddle — ${FIXTURE}:${original(FIXTURE, '<ChainLeaf />')} (exact)`
  const outer = `OwnerChainDepth — ${FIXTURE}:${original(FIXTURE, '<ChainMiddle />')} (exact)`

  for (const link of [leaf, middle, outer]) expect(content).toContain(link)
  expect(content.indexOf(leaf)).toBeLessThan(content.indexOf(middle))
  expect(content.indexOf(middle)).toBeLessThan(content.indexOf(outer))
})

test('a component that merely forwards a node is not on the chain', async ({ page }) => {
  const token = probe('forwarder')
  await open(page, token)
  await pickAndSend(page, BADGE)

  const content = await delivered(token)
  // React's own notion of ownership: ArticleList wrote the badge and ArticleCard
  // only placed it, so the innermost link is ArticleList and ArticleCard is not
  // a link at all. A DOM ancestry walk would have put it there.
  expect(content).toMatch(/owner chain\s+ArticleList — /)
  expect(content).not.toContain('ArticleCard')

  // `ArticleList` is a bare `return articles.map(…)`, so WebKit's proper tail
  // calls delete its frame and the link keeps its name while saying it has no
  // location (spec §12; ticket 06 is where that reason gets its own name).
  // ADR-0003: the badge is created inside `articles.map(…)`, so ArticleList's
  // stack carries two app frames. The link names the line the `<span>` is on,
  // not the line the map starts on — the tag the developer pointed at.
  //
  // This is exact in WebKit too, which the spec's "frame directly above the
  // sentinel" rule could not manage: that frame is ArticleList's own tail call
  // and JSC deletes it, so the link used to read `no location` here. Choosing
  // the JSX recovers a location Safari was losing. The genuinely tail-called
  // case still exists and is ticket 06's `card-heading` journey.
  const source = readFileSync(repoRoot + NESTED_FIXTURE, 'utf8').split('\n')
  const badgeLine =
    source.findIndex((line) => line.includes('data-fixture="passed-down-badge"')) + 1
  const mapLine = source.findIndex((line) => line.includes('return articles.map(')) + 1

  expect(badgeLine).toBeGreaterThan(0)
  expect(mapLine).toBeGreaterThan(0)
  expect(content).toContain(`ArticleList — ${NESTED_FIXTURE}:${badgeLine}:`)
  expect(content).not.toContain(`ArticleList — ${NESTED_FIXTURE}:${mapLine}:`)
})

test('an element with no fiber still sends, and says how far it walked up', async ({
  page,
}) => {
  const token = probe('walkup')
  await open(page, token)

  // A plain node injected outside React, inside something React did render.
  await page.evaluate(() => {
    const host = document.querySelector('[data-fixture="owner-chain-depth"]')
    if (!host) throw new Error('the owner-chain-depth fixture is not on the page')
    const plain = document.createElement('div')
    plain.setAttribute('data-plain', 'true')
    plain.textContent = 'injected outside React'
    plain.style.cssText = 'height:40px;background:#eee'
    host.append(plain)
  })

  await pickAndSend(page, '[data-plain="true"]')

  const content = await delivered(token)
  expect(content).toContain('walked up')
  expect(content).toMatch(/walked up\s+1 DOM level\b/)
})

test('an element that has a fiber says nothing about a walk-up', async ({ page }) => {
  const token = probe('no-walkup')
  await open(page, token)
  await pickAndSend(page, LEAF)

  const content = await delivered(token)
  expect(content).not.toContain('walked up')
})

test('a page that formats its own stacks still sends a raw one', async ({ page }) => {
  const token = probe('prepare')
  // What a dev-mode error SDK does: install a formatter, so `.stack` comes back
  // already source-mapped. The Overlay holds `prepareStackTrace` at undefined
  // across its own read, so the server still gets transformed coordinates it can
  // remap once rather than twice (spec §6).
  await page.addInitScript(() => {
    Error.prepareStackTrace = () => 'an SDK already source-mapped this'
  })
  await open(page, token)
  await pickAndSend(page, LEAF)

  const content = await delivered(token)
  expect(content).not.toContain('an SDK already source-mapped this')
  expect(content).toContain(
    `ChainLeaf — ${FIXTURE}:${original(FIXTURE, '<span data-fixture="chain-leaf">')} (exact)`,
  )
})
