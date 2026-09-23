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

  it('enters the five borrows the spec plans, and no other', () => {
    // Spec §1 names five, and nothing else is vendored. Written out rather than
    // read off the provenance doc: the list is the contract.
    expect(thirdPartyEntries().map((entry) => entry.project)).toEqual([
      'vite-plugin-herdr',
      'React DevTools',
      'react-grab',
      'click-to-react-component',
      'UI-Locator',
    ])
  })

  it('carries a full licence text in every entry, not a name or a link', () => {
    for (const entry of thirdPartyEntries()) {
      for (const field of ['Source:', 'Version:', 'Used in:', 'Taken:']) {
        expect(entry.text, `${entry.project} has no ${field}`).toContain(field)
      }
      expect(entry.text, entry.project).toMatch(/^MIT License$/m)
      expect(entry.text, entry.project).toMatch(/^Copyright \(c\) /m)
      expect(entry.flowed, entry.project).toContain(
        'The above copyright notice and this permission notice shall be included in ' +
          'all copies or substantial portions of the Software.',
      )
      expect(entry.flowed, entry.project).toContain(
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
      )
    }
  })

  it('names in each entry only files whose header credits that entry', () => {
    // The other direction from the test above: an entry naming a file that no
    // longer borrows, or that credits someone else, is a credit nobody earned.
    const borrows = borrowingFiles()
    for (const entry of thirdPartyEntries()) {
      expect(entry.usedIn.length, `${entry.project} names no file`).toBeGreaterThan(0)
      for (const file of entry.usedIn) {
        const borrow = borrows.find((candidate) => candidate.file === file)
        expect(borrow, `${file} carries no provenance header`).toBeDefined()
        expect(borrow?.project).toBe(entry.project)
      }
    }
  })
})

/** One `## <project>` section under `## Entries` in LICENSE-THIRDPARTY. */
interface ThirdPartyEntry {
  project: string
  usedIn: string[]
  text: string
  /** The same text with its line breaks taken out. */
  flowed: string
}

function thirdPartyEntries(): ThirdPartyEntry[] {
  const [, entries = ''] = read('LICENSE-THIRDPARTY').split(/^## Entries$/m)
  return entries
    .split(/^## /m)
    .slice(1)
    .map((section) => {
      const [heading = '', ...rest] = section.split('\n')
      const text = rest.join('\n')
      const usedIn = /^Used in:\s*(.+)$/m.exec(text)?.[1] ?? ''
      return {
        project: heading.trim(),
        usedIn: usedIn
          .split(',')
          .map((path) => path.trim())
          .filter(Boolean),
        text,
        flowed: text.replaceAll(/\s+/g, ' '),
      }
    })
}

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

describe('the motion record', () => {
  const doc = read('docs/motion.md')
  /** The same prose with its line breaks taken out: a sentence is a sentence. */
  const flowed = doc.replaceAll(/\s+/g, ' ')

  it('states the opt-in rule and the one place motion may live', () => {
    expect(doc).toContain('@media (prefers-reduced-motion: no-preference)')
    expect(doc).toContain('src/overlay/styles.ts')
    expect(doc).toMatch(/no motion by default/i)
  })

  it('records the morph deviation as pre-registered against the gate', () => {
    // Ticket 09 writes this down before the gate runs, so that ticket 22's run
    // cannot silently reverse a decision made on a built artifact — and so that
    // the decision cannot quietly skip the gate either (spec §9).
    expect(flowed).toContain('review-animations')
    expect(flowed).toMatch(/pre-registered/)
    expect(flowed).toMatch(/deviation/)
    expect(flowed).toMatch(/frequency/)
    expect(flowed).toMatch(/may not silently reverse/)
    expect(flowed).toMatch(/may not skip the gate/)
  })

  it('says the gate has not run, rather than implying an outcome', () => {
    expect(flowed).toMatch(/the gate has \*\*not\*\* run/i)
  })

  it('is reachable from CLAUDE.md, which every ticket reads', () => {
    expect(read('CLAUDE.md')).toContain('docs/motion.md')
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
