import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { exampleAppRoot } from '../harness/paths.mjs'

describe('the CommonJS entry', () => {
  it('refuses, and names the workaround', () => {
    const require = createRequire(import.meta.url)
    let message = ''
    try {
      require('vite-agent-inspect')
      throw new Error('require() of the package was expected to throw')
    } catch (error) {
      message = String(error.message)
    }

    expect(message).toMatch(/ESM-only/)
    expect(message).toContain('defineConfig(async () =>')
    expect(message).toContain('await import("vite-agent-inspect")')
  })
})

describe('the production build', () => {
  const outDir = join(exampleAppRoot, 'dist')
  let output = ''

  beforeAll(async () => {
    rmSync(outDir, { recursive: true, force: true })
    await build({
      root: exampleAppRoot,
      configFile: join(exampleAppRoot, 'vite.config.js'),
      logLevel: 'warn',
    })
    output = readAll(outDir)
  })

  it('emitted something to read', () => {
    expect(output.length).toBeGreaterThan(0)
    expect(output).toContain('Nested owner chain')
  })

  it('carries no Overlay code', () => {
    expect(output).not.toContain('virtual:vite-agent-inspect/overlay')
    expect(output).not.toContain('__viteAgentInspect')
  })

  it('carries no /__agent string', () => {
    expect(output).not.toContain('/__agent')
  })
})

function readAll(dir) {
  let text = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) text += readAll(full)
    else text += readFileSync(full, 'utf8')
  }
  return text
}
