import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8')

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

/** One borrow, as its file's header states it. */
interface Borrow {
  file: string
  project: string
  url: string
  version: string
}

/**
 * Every file under src/ whose first line opens a provenance header. The source
 * extensions are TypeScript's, with the JavaScript ones kept so a stray `.js`
 * module could never carry an uncredited borrow.
 */
function borrowingFiles(): Borrow[] {
  const found: Borrow[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx|cts|mts|js|jsx|cjs|mjs)$/.test(entry.name)) {
        const lines = read(path).split('\n')
        if (!lines[0]?.startsWith('// Borrowed:')) continue
        const field = (name: string) =>
          (lines.find((line) => line.startsWith(`// ${name}:`)) ?? '')
            .replace(`// ${name}:`, '')
            .trim()
        const [project = '', url = ''] = field('From').split('—')
        found.push({
          file: path,
          project: project.trim(),
          url: url.trim(),
          version: (field('Version').split('(')[0] ?? '').trim(),
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

  it('name no harness file or config that no longer exists', () => {
    // Ticket 23 renamed all of them. A doc naming a file that is gone sends the
    // next ticket looking for it.
    // File references only: a trailing slash is a directory named in prose, and
    // prose says `src/fixtures/` relative to the example app.
    const named = [
      ...doc.matchAll(/`((?:test|examples|src|docs)\/[\w./-]*\w\.\w+)`/g),
    ].map((match) => match[1] as string)

    expect(named.length).toBeGreaterThan(5)
    for (const path of named) {
      expect(existsSync(join(repoRoot, path)), `${path} is named but missing`).toBe(true)
    }
  })

  it('say how seam 2 is actually booted, and agree with the config', () => {
    expect(doc).toContain('globalSetup')

    // The doc describes it; the config is what does it.
    const playwright = read('playwright.config.ts')
    expect(playwright).toContain('globalSetup')
    expect(playwright).not.toMatch(/^\s*webServer:/m)
  })
})

describe('the packaging conventions', () => {
  const doc = read('docs/agents/packaging.md')

  it('state the extension rule a relative import inside src follows', () => {
    expect(doc).toMatch(/\.js/)
    expect(doc).toMatch(/verbatimModuleSyntax/)
  })

  it('name the build output the package actually ships', () => {
    expect(doc).toContain('dist/')
    expect(doc).toContain('docs/adr/0001-typescript-and-tsc-esm-emit.md')
  })

  it('are reachable from CLAUDE.md, which every ticket reads', () => {
    expect(read('CLAUDE.md')).toContain('docs/agents/packaging.md')
  })
})

describe('the packaging conventions cover the two gates', () => {
  const doc = read('docs/agents/packaging.md')

  it('name the lint and format commands', () => {
    for (const command of ['npm run lint', 'npm run format', 'npm run format:check']) {
      expect(doc).toContain(command)
    }
  })

  it('say the formatter does not touch prose', () => {
    expect(doc).toMatch(/Markdown is excluded/i)
  })

  it('describe both gates and point at the hooks that are them', () => {
    expect(doc).toContain('.claude/hooks/format-file.sh')
    expect(doc).toContain('.claude/hooks/lint-gate.sh')
    expect(doc).toContain('stop_hook_active')
  })
})

describe('ADR-0002', () => {
  const adr = read('docs/adr/0002-oxlint-and-oxfmt.md')

  it('records why oxc rather than ESLint and Prettier', () => {
    expect(adr).toMatch(/## Alternatives/)
    expect(adr).toMatch(/ESLint/)
    expect(adr).toMatch(/Prettier/)
  })

  it('records why the formatter is kept off prose', () => {
    expect(adr).toMatch(/56 prose files|Markdown/)
  })
})

describe('ADR-0001', () => {
  const adr = read('docs/adr/0001-typescript-and-tsc-esm-emit.md')

  it('records the decision, its alternatives and its consequences', () => {
    expect(adr).toMatch(/## Alternatives/)
    expect(adr).toMatch(/## Consequences/)
  })

  it('says what to do about the one project spanning two runtimes', () => {
    expect(adr).toMatch(/DOM/)
    expect(adr).toMatch(/split it/i)
  })
})
