import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.mjs'

const read = (path) => readFileSync(join(repoRoot, path), 'utf8')

describe('LICENSE-THIRDPARTY', () => {
  it('exists', () => {
    expect(existsSync(join(repoRoot, 'LICENSE-THIRDPARTY'))).toBe(true)
  })

  it('documents its entry format and carries no entries yet', () => {
    const text = read('LICENSE-THIRDPARTY')
    expect(text).toMatch(/Entry format/)
    expect(text).toMatch(/## Entries/)
    expect(text).toMatch(/None yet/)
  })
})

describe('the provenance header format', () => {
  const doc = read('docs/agents/provenance.md')

  it('names every field a borrowing file must carry', () => {
    for (const field of ['Borrowed:', 'From:', 'Version:', 'License:', 'Changes:']) {
      expect(doc).toContain(field)
    }
  })

  it('requires the LICENSE-THIRDPARTY entry alongside the header', () => {
    expect(doc).toContain('LICENSE-THIRDPARTY')
  })
})

describe('the testing conventions', () => {
  const doc = read('docs/agents/testing.md')

  it('state the no-server-module-imports rule', () => {
    expect(doc).toMatch(/No test imports a server module/)
  })

  it('name the four harness overrides', () => {
    for (const name of [
      'VITE_AGENT_INSPECT_REGISTRY_DIR',
      'VITE_AGENT_INSPECT_SOCKET_DIR',
      'PATH',
      'CLAUDE_PID',
    ]) {
      expect(doc).toContain(name)
    }
  })

  it('are reachable from CLAUDE.md, which every ticket reads', () => {
    const claudeMd = read('CLAUDE.md')
    expect(claudeMd).toContain('docs/agents/testing.md')
    expect(claudeMd).toContain('docs/agents/provenance.md')
  })
})
