import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../harness/paths.js'

const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8')

describe('LICENSE-THIRDPARTY', () => {
  it('credits every file that carries a provenance header', () => {
    const borrows = borrowingFiles()

    // The header credits and the entry carries the licence the credit stands
    // on; a borrow that does only one of them is not finished.
    expect(borrows.length).toBeGreaterThan(0)
    expect(uncredited(borrows, read('LICENSE-THIRDPARTY'))).toEqual([])
  })

  it('fails an icon header that no entry credits', () => {
    // The check above, held against a header rather than against today's
    // files, so that it is known to bite. A second icon set is not credited by
    // the first one's entry; and a credited set's entry names each file that
    // holds its artwork, so a new file of it needs its path added there.
    const credits = read('LICENSE-THIRDPARTY')
    const header = (file: string, from: string, version: string): Borrow => {
      const borrow = headerOf(
        file,
        [
          '// Borrowed: icon artwork',
          `// From: ${from}`,
          `// Version: ${version} (2026-09-25)`,
          '// License: MIT — full text in LICENSE-THIRDPARTY',
          '// Changes: none',
          '',
          "const PATH = 'M0 0Z'",
        ].join('\n'),
      )
      if (!borrow) throw new Error(`${file}: the header was not read`)
      return borrow
    }
    const feather = header(
      'src/overlay/other-icons.tsx',
      'Feather — https://github.com/feathericons/feather',
      'v4.29.2',
    )
    const remix = (file: string) =>
      header(file, 'Remix Icon — https://github.com/Remix-Design/remixicon', '4.9.1')

    expect(uncredited([feather], credits)).toHaveLength(1)
    expect(uncredited([remix('src/overlay/other-icons.tsx')], credits)).toHaveLength(1)
    expect(uncredited([remix('src/overlay/icons.tsx')], credits)).toEqual([])
  })

  it('has each borrowing file say where the borrow ends', () => {
    for (const borrow of borrowingFiles()) {
      expect(read(borrow.file)).toContain('end of borrowed code')
    }
  })

  it('enters the five projects the spec plans to borrow code from, and icon sets', () => {
    // Spec §1 names five code borrows, and nothing else is vendored. Written out
    // rather than read off the provenance doc: the list is the contract. Icon
    // artwork is the one other thing that may be taken, credited once per set
    // and marked as a set (docs/agents/provenance.md).
    const entries = thirdPartyEntries()
    expect(
      entries.filter((entry) => !entry.iconSet).map((entry) => entry.project),
    ).toEqual([
      'vite-plugin-herdr',
      'React DevTools',
      'react-grab',
      'click-to-react-component',
      'UI-Locator',
    ])
    expect(
      entries.filter((entry) => entry.iconSet).map((entry) => entry.project),
    ).toEqual(['Remix Icon'])
  })

  it('carries a full licence text in every entry, not a name or a link', () => {
    for (const entry of thirdPartyEntries()) {
      for (const field of ['Source:', 'Version:', 'Used in:', 'Taken:']) {
        expect(entry.text, `${entry.project} has no ${field}`).toContain(field)
      }
      expect(entry.text, `${entry.project} has no copyright line`).toMatch(
        /^Copyright \(c\) /m,
      )
      expect(entry.flowed, `${entry.project} has no warranty disclaimer`).toMatch(
        /PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/,
      )
    }
  })

  it('carries the MIT text in every code borrow', () => {
    for (const entry of thirdPartyEntries().filter((candidate) => !candidate.iconSet)) {
      expect(entry.text, `${entry.project} has no MIT text`).toMatch(/^MIT License$/m)
      expect(entry.flowed, `${entry.project} has no permission notice`).toContain(
        'The above copyright notice and this permission notice shall be included in ' +
          'all copies or substantial portions of the Software.',
      )
      expect(entry.flowed, `${entry.project} has no warranty disclaimer`).toContain(
        'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
      )
    }
  })

  it("carries each icon set's own licence, under the name its headers give it", () => {
    const borrows = borrowingFiles()
    for (const entry of thirdPartyEntries().filter((candidate) => candidate.iconSet)) {
      const names = borrows
        .filter((borrow) => borrow.project === entry.project)
        .map((borrow) => borrow.licence)
      expect(names.length, `${entry.project} is credited by no header`).toBeGreaterThan(0)
      for (const name of names) {
        expect(entry.text.split('\n'), `${entry.project} has no ${name} text`).toContain(
          name,
        )
      }
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

  it('keeps its index in step with the entries', () => {
    // The index is a second copy of what the entries say, for a reader. A copy
    // nothing checks drifts, so every row must name a file its project's entry
    // names, and every file an entry names must have a row.
    const [head = ''] = read('LICENSE-THIRDPARTY').split(/^## Entries$/m)
    const [, index = ''] = head.split(/^## Index$/m)
    const rows = index
      .split('\n')
      .filter((line) => line.startsWith('|') && !/^\|\s*(borrow|---)/.test(line))
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .map(([, , project = '', , file = '']) => ({ project, file }))

    const entries = thirdPartyEntries()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const entry = entries.find((candidate) => candidate.project === row.project)
      expect(entry?.usedIn, `index row for ${row.file}`).toContain(row.file)
    }
    for (const entry of entries) {
      for (const file of entry.usedIn) {
        expect(rows, `${file} has no index row`).toContainEqual({
          project: entry.project,
          file,
        })
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
  /** Marked `Kind: icon set`: icon artwork, credited once for the whole set. */
  iconSet: boolean
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
        iconSet: /^Kind:\s*icon set$/m.test(text),
      }
    })
}

/**
 * Each borrow whose header the licence file does not answer: an entry for its
 * project, with its url and version, naming its file. One line per borrow.
 */
function uncredited(borrows: Borrow[], credits: string): string[] {
  return borrows
    .filter(
      (borrow) =>
        !credits.includes(`## ${borrow.project}`) ||
        !credits.includes(borrow.url) ||
        !credits.includes(borrow.version) ||
        !credits.includes(borrow.file),
    )
    .map((borrow) => `${borrow.file} (${borrow.project})`)
}

/** One borrow, as its file's header states it. */
interface Borrow {
  file: string
  project: string
  url: string
  version: string
  /** The `License:` field's name, before its pointer to LICENSE-THIRDPARTY. */
  licence: string
}

/** The borrow a file's provenance header states, or none if it opens with none. */
function headerOf(file: string, source: string): Borrow | undefined {
  const lines = source.split('\n')
  if (!lines[0]?.startsWith('// Borrowed:')) return undefined
  const field = (name: string) =>
    (lines.find((line) => line.startsWith(`// ${name}:`)) ?? '')
      .replace(`// ${name}:`, '')
      .trim()
  const [project = '', url = ''] = field('From').split('—')
  return {
    file,
    project: project.trim(),
    url: url.trim(),
    version: (field('Version').split('(')[0] ?? '').trim(),
    licence: (field('License').split('—')[0] ?? '').trim(),
  }
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
        const borrow = headerOf(path, read(path))
        if (borrow) found.push(borrow)
      }
    }
  }
  walk('src')
  return found
}

describe('the testing conventions', () => {
  const doc = read('docs/agents/testing.md')

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
})

describe('the README', () => {
  const readme = read('README.md')

  it('never imports the package by its bare name, which has no entry', () => {
    // There is no root entry (ADR-0005): the package's name alone fails with
    // ERR_PACKAGE_PATH_NOT_EXPORTED, so an import a reader copies must name a
    // Connector.
    expect(readme).not.toMatch(/from ['"]@gunnarsturla\/pointout['"]/)
    expect(readme).not.toMatch(/import\(['"]@gunnarsturla\/pointout['"]\)/)
  })

  it('installs each Connector the way its Host takes it', () => {
    expect(readme).toContain("import { pointout } from '@gunnarsturla/pointout/vite'")
    expect(readme).toContain('await import("@gunnarsturla/pointout/vite")')
    expect(readme).toContain("import { withPointout } from '@gunnarsturla/pointout/next'")
    expect(readme).toContain('next dev -H localhost')
    expect(readme).toContain('--connector next|vite')
  })
})
