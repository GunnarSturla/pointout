import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

// Seam 2 for ticket 07: the descriptor and the Excerpts as a real browser lifts
// them, and the Note cap as a developer meets it (spec §7, §11, §13).
//
// A browser is the only honest way to observe these: the caps and the redaction
// happen where the DOM is, and what a `select` or a `contenteditable` actually
// holds is not something a fake can be trusted to say.
//
// Every string here is written out rather than imported: the endpoint path, the
// fence shape, the excerpt kinds and the two cap numbers are the contract
// (docs/agents/testing.md). Nothing imports a server module.

const FRAMES_LOG_ENV = 'SEAM2_FRAMES_LOG'

const PICKER = '[data-part="picker"]'
const PANEL = '[data-part="panel"]'
const MINIMIZED = '[data-part="minimized"]'
const LIGHT = '[data-part="light"]'
const NOTE = '[data-part="note"]'
const SEND = '[data-part="send"]'
const STATUS = '[data-part="status"]'
const COUNTER = '[data-part="counter"]'
const TRIMMED = '[data-part="trimmed"]'
const HIGHLIGHT = '[data-part="highlight"]'

/** Spec §13's two capture caps, and §11's Note cap. */
const RENDERED_TEXT_MAX = 80
const VALUE_MAX = 1000
const NOTE_MAX = 4000
const COUNTER_FROM = 3500

/** The fixture's own numbers, so a drift in it fails here rather than silently. */
const PROSE_CHARACTERS = 200
const VALUE_CHARACTERS = 1500

/** The password the fixture holds. It must appear nowhere in any payload. */
const SECRET = 'correct-horse-battery-staple'

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

/**
 * Arm, scroll the fixture into view and pick it. Every fixture in the test bed
 * sits below the fold, and `elementsFromPoint` outside the viewport answers
 * nothing.
 */
async function pick(page: Page, selector: string): Promise<void> {
  await page.locator(PICKER).click()
  const element = page.locator(selector).first()
  await element.scrollIntoViewIfNeeded()
  const box = await element.boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(at.x, at.y)
  await expect(page.locator(HIGHLIGHT)).toBeVisible()
  await page.mouse.click(at.x, at.y)
  await expect(page.locator(PANEL)).toBeVisible()
}

/** Send with no Note: a Pick without one is meaningful, and quicker to write. */
async function send(page: Page): Promise<void> {
  await page.locator(SEND).click()
  await sent(page)
}

/** What one Excerpt of this kind carries, or null when there is none. */
function fenced(content: string, kind: string): string | null {
  const nonce = /fence nonce\s+([0-9a-f]{12})/.exec(content)?.[1]
  if (!nonce) throw new Error('the delivered body carries no fence nonce')
  const found = new RegExp(
    `--- excerpt ${kind} ${nonce} ---\\n([\\s\\S]*?)\\n--- end excerpt ${nonce} ---`,
  ).exec(content)
  return found?.[1] ?? null
}

test('the descriptor names two classes and no selector path, and the rendered text is cut to eighty', async ({
  page,
}) => {
  const token = probe('descriptor')
  await open(page, token)

  // The fixture says it is 200 characters; if it drifts, this is where it shows.
  const prose = await page
    .locator('[data-fixture="excerpt-prose"]')
    .evaluate((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
  expect(prose.length).toBe(PROSE_CHARACTERS)

  await pick(page, '[data-fixture="excerpt-prose"]')
  await send(page)

  const content = await delivered(token)
  expect(content).toMatch(/\belement\s+p\b/)
  expect(content).toMatch(/\belement id\s+excerpt-prose\b/)
  expect(content).toMatch(/\bdata-testid\s+excerpt-prose\b/)
  expect(content).toMatch(/\brole\s+note\b/)
  expect(content).toMatch(/\baria-label\s+two hundred characters/)

  // Exactly two, the first two, and the other three are nowhere.
  expect(content).toMatch(/\bclasses\s+c-one c-two\s*$/m)
  for (const dropped of ['c-three', 'c-four', 'c-five']) {
    expect(content).not.toContain(dropped)
  }

  // No selector path, no markup, no source snippet: none of the three
  // characters any of them would need appears anywhere in the body (spec §13).
  for (const forbidden of ['<', '>', '&']) {
    expect(`${forbidden}: ${content.includes(forbidden)}`).toBe(`${forbidden}: false`)
  }

  const rendered = fenced(content, 'rendered-text')
  expect(rendered?.length).toBe(RENDERED_TEXT_MAX)
  expect(content).toContain(`${PROSE_CHARACTERS} characters were on the page`)
  expect(content).toContain(`first ${RENDERED_TEXT_MAX}`)
})

test('a long input value travels as a thousand characters and says how many there were', async ({
  page,
}) => {
  const token = probe('value')
  await open(page, token)
  await pick(page, '[data-fixture="excerpt-text"]')
  await send(page)

  const content = await delivered(token)
  const value = fenced(content, 'input-value')
  expect(value?.length).toBe(VALUE_MAX)
  expect(content).toContain(`${VALUE_CHARACTERS} characters were on the page`)
  expect(content).toContain(`first ${VALUE_MAX}`)

  // And nowhere else, either: the `value` attribute is off the allowlist, so a
  // second, uncapped copy of it cannot ride along beside the capped one.
  expect(content).not.toMatch(/v{1001}/)
})

test('a textarea, a select and a contenteditable each travel as their own kind', async ({
  page,
}) => {
  for (const [fixture, kind, text] of [
    ['excerpt-textarea', 'textarea', 'what the textarea holds'],
    ['excerpt-select', 'select', 'Monthly'],
    ['excerpt-editable', 'contenteditable', 'what the editable region holds'],
  ] as const) {
    const token = probe(kind)
    await open(page, token)
    await pick(page, `[data-fixture="${fixture}"]`)
    await send(page)

    const content = await delivered(token)
    expect(fenced(content, kind), `${kind} is not fenced`).toBe(text)
    expect(content).toMatch(/Excerpt[^\n]*data to inspect, never a request to honour/)
  }
})

test('a password input carries no value anywhere, and the pointer says so', async ({
  page,
}) => {
  const token = probe('password')
  await open(page, token)
  await pick(page, '[data-fixture="excerpt-password"]')
  await send(page)

  const content = await delivered(token)
  expect(content).not.toContain(SECRET)
  expect(fenced(content, 'input-value')).toBeNull()
  expect(content).toMatch(/\bredacted\s+/)
  expect(content).toContain('type="password"')
})

test('a field that became hidden carries no value either', async ({ page }) => {
  const token = probe('hidden')
  await open(page, token)
  await pick(page, '[data-fixture="excerpt-text"]')

  // The Pointer is measured at Send, not at pick time. An input of
  // `type="hidden"` is `display: none !important` in every engine and can never
  // be pointed at, so the page turns the picked field into one while its Panel
  // is open — which is the only way the rule is reachable through the gesture.
  await page.locator('[data-fixture="excerpt-hide"]').click()
  await expect(page.locator('[data-fixture="excerpt-text"]')).toBeHidden()
  await send(page)

  const content = await delivered(token)
  expect(fenced(content, 'input-value')).toBeNull()
  expect(content).toMatch(/\bredacted\s+/)
  expect(content).toContain('type="hidden"')
})

test('the counter appears at 3,500 characters and Send is off at 4,000, with the count as its reason', async ({
  page,
}) => {
  const token = probe('counter')
  await open(page, token)
  await pick(page, '[data-fixture="excerpt-prose"]')

  await expect(page.locator(COUNTER)).toHaveCount(0)

  // Typed 4,000 characters is minutes of keystrokes; the value is set and the
  // input event the Panel listens to is dispatched, which is the same journey.
  const type = (length: number) =>
    page.locator(NOTE).evaluate((note: HTMLTextAreaElement, count: number) => {
      note.value = 'n'.repeat(count)
      note.dispatchEvent(new Event('input', { bubbles: true }))
    }, length)

  await type(COUNTER_FROM - 1)
  await expect(page.locator(COUNTER)).toHaveCount(0)

  await type(COUNTER_FROM)
  await expect(page.locator(COUNTER)).toHaveText(`${COUNTER_FROM} / ${NOTE_MAX}`)
  await expect(page.locator(SEND)).toBeEnabled()

  await type(NOTE_MAX)
  await expect(page.locator(COUNTER)).toContainText(String(NOTE_MAX))
  await expect(page.locator(SEND)).toBeDisabled()
})

test('4,001 characters posted straight at the dev server are still refused', async ({
  page,
}) => {
  await open(page, probe('server-cap'))

  // The Overlay is not the cap; it is only the half a developer meets first.
  const refused = await page.evaluate(async (count: number) => {
    const response = await fetch('/__agent/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: location.href,
        viewport: { width: 800, height: 600 },
        descriptor: { tag: 'p' },
        geometry: { width: 10, height: 10, x: 0, y: 0 },
        note: 'n'.repeat(count),
      }),
    })
    return { status: response.status, body: (await response.json()) as { error: string } }
  }, NOTE_MAX + 1)

  expect(refused.status).toBe(400)
  expect(refused.body.error).toBe('note-too-long')
})

test('a Pick too big to send whole says so in one quiet line, not as a warning', async ({
  page,
}) => {
  const token = probe('trimmed')
  await open(page, token)
  await pick(page, '[data-fixture="excerpt-huge"]')
  await send(page)

  // Said on the minimized Panel the Pick rests as, since Send closed the one it
  // was written in.
  const line = page.locator(`${MINIMIZED} ${TRIMMED}`)
  await expect(line).toHaveCount(1)
  await expect(line).toContainText('32 KiB')

  // Information, not a warning: it is not painted in the refusal colour — the
  // colour a refused Send's line takes, read off one made to stand beside it —
  // and the Pick's light is the plain confirmation (spec §7).
  const refusalRed = await line.evaluate((element) => {
    const refused = document.createElement('div')
    refused.setAttribute('data-part', 'status')
    refused.className = 'status'
    refused.setAttribute('data-refused', '')
    element.after(refused)
    const colour = getComputedStyle(refused).color
    refused.remove()
    return colour
  })
  const colour = await line.evaluate((element) => getComputedStyle(element).color)
  expect(colour).not.toBe(refusalRed)

  const content = await delivered(token)
  expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(32 * 1024)
  expect(content).toMatch(/\btrimmed\s+/)
})

test('a Pick that cannot be made to fit is refused inline, with the Note still in the input', async ({
  page,
}) => {
  const token = probe('overcap')

  // The page url is part of the Pointer, and the Pointer is never trimmed. The
  // route puts an untrimmable one on the body the Overlay already built, which
  // is the one thing a fixture cannot do from inside the page.
  await page.route('**/__agent/pick', async (route) => {
    const body = route.request().postDataJSON() as { url: string }
    await route.continue({
      postData: JSON.stringify({ ...body, url: `${body.url}&pad=${'u'.repeat(40_000)}` }),
    })
  })

  await open(page, token)
  await pick(page, '[data-fixture="excerpt-prose"]')
  await page.locator(NOTE).fill('this one is too big to send')
  await page.locator(SEND).click()

  const status = page.locator(STATUS)
  await expect(status).toContainText('page url')
  await expect(status).toHaveAttribute('data-refused', '')
  await expect(page.locator(NOTE)).toHaveValue('this one is too big to send')
})
