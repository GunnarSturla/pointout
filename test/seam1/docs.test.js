import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.mjs'

const read = (path) => readFileSync(join(repoRoot, path), 'utf8')

describe('LICENSE-THIRDPARTY', () => {
  it('exists', () => {
    expect(existsSync(join(repoRoot, 'LICENSE-THIRDPARTY'))).toBe(true)
  })

  it('documents its entry format', () => {
    const text = read('LICENSE-THIRDPARTY')
    expect(text).toMatch(/Entry format/)
    expect(text).toMatch(/## Entries/)
  })

  it('credits every file that carries a provenance header', () => {
    const credits = read('LICENSE-THIRDPARTY')
    const borrows = borrowingFiles()

    // The header credits and the entry carries the licence the credit stands
    // on; a borrow that does only one of them is not finished.
    expect(borrows.length).toBeGreaterThan(0)
    for (const borrow of borrows) {
      expect(credits).toContain(`## ${borrow.project}`)
      expect(credits).toContain(borrow.url)
      expect(credits).toContain(borrow.version)
      expect(credits).toContain(borrow.file)
    }
  })

  it('has each borrowing file say where the borrow ends', () => {
    for (const borrow of borrowingFiles()) {
      expect(read(borrow.file)).toContain('end of borrowed code')
    }
  })
})

/** Every file under src/ whose first line opens a provenance header. */
function borrowingFiles() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (/\.(js|cjs|mjs)$/.test(entry.name)) {
        const lines = read(path).split('\n')
        if (!lines[0]?.startsWith('// Borrowed:')) continue
        const field = (name) =>
          (lines.find((line) => line.startsWith(`// ${name}:`)) ?? '')
            .replace(`// ${name}:`, '')
            .trim()
        const [project, url] = field('From').split('—')
        found.push({
          file: path,
          project: project.trim(),
          url: (url ?? '').trim(),
          version: field('Version').split('(')[0].trim(),
        })
      }
    }
  }
  walk('src')
  return found
}

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
