import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// The browser suite: the degraded modes an engine actually produces (spec §12, user story
// 91). The server suite builds its stacks; only a real engine can show that a frame is
// really gone, and that the link beside it is really still exact.
//
// Playwright's WebKit is a proxy for Safari: it is JavaScriptCore, and proper
// tail calls are a JavaScriptCore behaviour, so what it deletes here is what
// Safari deletes for a teammate.
//
// Every string is written out rather than imported (docs/agents/testing.md).

const FRAMES_LOG_ENV = 'BROWSER_FRAMES_LOG'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * `CardHeading` is a bare `return <h3>`, which is a tail call: JavaScriptCore
 * deletes its frame and no other engine does. `ArticleCard` writes
 * `<CardHeading>` as an argument to another JSX call, so its own frame survives
 * everywhere — which is what makes this fixture the mixed chain this ticket needs.
 */
const NESTED_FIXTURE = 'examples/shared/fixtures/NestedOwners.tsx'
const CARD_HEADING = '[data-fixture="card-heading"]'

/** The element whose owner lives in a package Vite pre-bundled. */
const SKELETON = '[data-fixture="dependency-skeleton"] .react-loading-skeleton'

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

async function pickAndSend(page: Page, selector: string): Promise<void> {
  await page.locator(PICKER).click()
  // The fixture set is taller than the viewport, and a Pick is made with the
  // mouse: an element below the fold has to be brought into it first.
  const target = page.locator(selector).first()
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
  await page.locator(SEND).click()
}

test('a component that returns its JSX directly keeps its name in WebKit, Safari proxy, and says the engine deleted its frame', async ({
  page,
  browserName,
}) => {
  const token = probe('elided')
  await open(page, token)
  await pickAndSend(page, CARD_HEADING)

  const content = await delivered(token)

  // Named either way: user story 91 is that the teammate still sees the
  // component, and learns what they did not get.
  expect(content).toMatch(/owner chain\s+CardHeading — /)

  if (browserName === 'webkit') {
    expect(content).toContain(
      'CardHeading — no location (absent: call-site-frame-elided-by-engine — ',
    )
  } else {
    expect(content).toContain(
      `CardHeading — ${NESTED_FIXTURE}:${original(NESTED_FIXTURE, '<h3 className="card-heading"')} (exact)`,
    )
  }

  // The rest of the chain is unaffected: the link above it is exact in every
  // engine, because its call site is an argument rather than a tail call.
  expect(content).toContain(
    `ArticleCard — ${NESTED_FIXTURE}:${original(NESTED_FIXTURE, '<CardHeading>')} (exact)`,
  )
})

test('an element owned by a package is flagged dependency, wherever it is pointed at', async ({
  page,
}, info) => {
  const token = probe('dependency')
  await open(page, token)
  await pickAndSend(page, SKELETON)

  const content = await delivered(token)

  if (info.project.name.includes('-next-')) {
    // Turbopack bundles the package into a chunk whose map names its file, and
    // lists it in `ignoreList`: the link has a location, and the flag ahead of
    // it is what tells the agent not to edit there.
    expect(content).toMatch(
      /owner chain\s+Skeleton — node_modules\/react-loading-skeleton\/\S+ \(dependency, exact\)/,
    )
    return
  }
  // Vite keys a pre-bundled dependency by the `?v=` hash it serves it under, so
  // the bare path the frame remaps through is in no module graph. The link
  // still travels, flagged, which is what tells the agent not to edit there.
  expect(content).toMatch(/owner chain\s+Skeleton — no location \(dependency, absent:/)
})

test('a Pick says when its page began to load, which a Turbopack frame is judged against', async ({
  page,
}) => {
  const token = probe('loaded-at')
  await open(page, token)
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/__agent/pick'),
  )
  await pickAndSend(page, CARD_HEADING)

  const body = (await sent).postDataJSON() as { pageLoadedAt?: unknown }
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  expect(body.pageLoadedAt).toBe(Math.floor(timeOrigin))
  await delivered(token)
})
