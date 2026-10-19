import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startExampleServer } from './dev-server.js'
import type { HarnessServer } from './dev-server.js'
import type { HostName } from './hosts.js'
import { capturedStack, loadCapturedChunks } from './next-frames.js'
import type { CapturedEngine } from './next-frames.js'
import { repoRoot } from './paths.js'

// The three JSX call sites of `OwnerChainDepth.tsx`, as a frame an engine
// would print against what a Host served, so one Owner chain suite can run on
// either Host. Seam 1 has no browser:
//
// - on Vite the frame is read out of the served transform of the fixture,
//   where the JSX runtime call for that tag starts;
// - on Next.js it is the frame a real engine printed against a Turbopack chunk
//   (`test/fixtures/next-frames/`), after the chunks are loaded as a page would.
//
// Either way the frame is a real position in what the Host really served, so
// what a test asserts is that it comes back to the line and column the fixture
// has.

/** The fixture both example apps render, as the repo holds it. */
export const CHAIN_FIXTURE = 'examples/shared/fixtures/OwnerChainDepth.tsx'

/** A call site, named by the tag its JSX creates. */
export type CallSite = 'span' | 'ChainLeaf' | 'ChainMiddle'

/** The two stack grammars: V8's, and the one Gecko and JavaScriptCore share. */
export type Grammar = 'v8' | 'gecko'

export interface Frame {
  url: string
  line: number
  column: number
}

export interface CallSiteBed {
  on: HostName
  server: HarnessServer
  /** Where the JSX that creates `site` sits in what the Host served. */
  frame(site: CallSite, grammar?: Grammar): Frame
  /** Frames of the Host's own React, for the top and the bottom of a stack. */
  runtime: { jsx: Frame; reactDom: Frame }
}

/** Where a call site sits in the fixture's own source, as `line:col`. */
export function originalOf(site: CallSite): string {
  const marker = MARKERS[site]
  const lines = readFileSync(join(repoRoot, CHAIN_FIXTURE), 'utf8').split('\n')
  const index = lines.findIndex((line) => line.includes(marker))
  const line = lines[index]
  if (index === -1 || line === undefined) {
    throw new Error(`the fixture no longer contains ${marker}`)
  }
  return `${index + 1}:${line.indexOf(marker) + 1}`
}

const MARKERS: Record<CallSite, string> = {
  span: '<span data-fixture="chain-leaf">',
  ChainLeaf: '<ChainLeaf />',
  ChainMiddle: '<ChainMiddle />',
}

/** What a bed's server is started with: the pid its preselect matches. */
export interface BedOptions {
  claudePid?: number
}

export async function startCallSiteBed(
  on: HostName,
  options: BedOptions = {},
): Promise<CallSiteBed> {
  return on === 'next' ? nextBed(options) : viteBed(options)
}

async function viteBed(options: BedOptions): Promise<CallSiteBed> {
  const server = await startExampleServer(options)
  // The shared fixtures sit outside the Vite root, so Vite serves them under
  // its own `/@fs/` prefix, by absolute path. The request is what puts the
  // module in the graph with its transform and its map, as a browser would.
  const url = server.url + '/@fs' + join(repoRoot, CHAIN_FIXTURE)
  const transformed = await (await fetch(url)).text()

  const callees: Record<CallSite, string> = {
    span: '_jsxDEV("span"',
    ChainLeaf: '_jsxDEV(ChainLeaf',
    ChainMiddle: '_jsxDEV(ChainMiddle',
  }
  const deps = server.url + '/node_modules/.vite/deps'
  return {
    on: 'vite',
    server,
    frame(site) {
      const lines = transformed.split('\n')
      const index = lines.findIndex((line) => line.includes(callees[site]))
      const line = lines[index]
      if (index === -1 || line === undefined) {
        throw new Error(`the served module no longer calls ${callees[site]}`)
      }
      return { url, line: index + 1, column: line.indexOf(callees[site]) + 1 }
    },
    runtime: {
      jsx: { url: `${deps}/react_jsx-dev-runtime.js?v=abcd1234`, line: 197, column: 25 },
      reactDom: {
        url: `${deps}/react-dom_client.js?v=abcd1234`,
        line: 14142,
        column: 12,
      },
    },
  }
}

async function nextBed(options: BedOptions): Promise<CallSiteBed> {
  const server = await startExampleServer({ ...options, on: 'next' })
  await loadCapturedChunks(server)

  // The captured chain from the picked span upward: each link's stack was
  // taken where its own JSX ran, so the span's link holds the span's call site.
  const engines: Record<Grammar, CapturedEngine> = { v8: 'chromium', gecko: 'firefox' }
  const framesOf = (grammar: Grammar, link: string) =>
    capturedStack(server, engines[grammar], {
      route: '/',
      element: '[data-fixture="chain-leaf"]',
      link,
    })
      .split('\n')
      .map(parseFrame)
      .filter((frame): frame is Frame => frame !== null)

  return {
    on: 'next',
    server,
    frame(site, grammar = 'v8') {
      const app = framesOf(grammar, site)[1]
      if (!app) throw new Error(`the captured ${site} stack has no app frame`)
      return app
    },
    runtime: (() => {
      const [jsx, , reactDom] = framesOf('v8', 'span')
      if (!jsx || !reactDom) throw new Error('the captured span stack is too short')
      return { jsx, reactDom }
    })(),
  }
}

/** One frame line in either grammar, or null for a line that is not one. */
function parseFrame(line: string): Frame | null {
  const found = /(\S+):(\d+):(\d+)\)?$/.exec(line.trim())
  if (!found?.[1]) return null
  const url = found[1].replace(/^.*?(?=https?:\/\/)/, '').replace(/^\(/, '')
  return { url, line: Number(found[2]), column: Number(found[3]) }
}
