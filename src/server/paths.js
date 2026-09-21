import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

// Every path this plugin compares goes through here first. The dev server's own
// cwd is the shell's, not a session's, and a registry entry's cwd is whatever
// the developer happened to `cd` into, so nothing is ever compared raw (spec §2).
//
// Normalization resolves symlinks as well as the worktree, because git reports
// real paths: on macOS a session in /tmp/x and a checkout at /private/tmp/x are
// the same checkout, and comparing the two spellings would offer no Candidate
// at all while cheerfully reporting a readable registry.

/** Cache per input path: one `git` subprocess per distinct path, ever. */
const worktreeRoots = new Map()

/**
 * The git worktree root containing `path`, or the real path itself when it is
 * not in a repository. A linked worktree normalizes to the worktree, not to the
 * main checkout — which is what keeps a Pick about one worktree out of a
 * session working in another.
 */
export function normalizeToWorktreeRoot(path) {
  return lookUp(path).root
}

/**
 * The repo root, computed once at `configResolved` and used for rendering paths
 * and for cwd routing alike.
 *
 * @param {string} viteRoot
 * @param {string} [override] The `root` option a normal consumer never sets.
 * @returns {{ root: string, method: 'option' | 'git' | 'vite-root' }}
 */
export function discoverRepoRoot(viteRoot, override) {
  // The override says which root, not which spelling of it: it still has to
  // come out in the same normal form every cwd is compared in.
  if (override) return { root: realPath(resolve(override)), method: 'option' }

  const { root, fromGit } = lookUp(viteRoot)
  return { root, method: fromGit ? 'git' : 'vite-root' }
}

function lookUp(path) {
  const key = resolve(path)
  const cached = worktreeRoots.get(key)
  if (cached) return cached

  const toplevel = gitToplevel(key)
  const entry = { root: toplevel ?? realPath(key), fromGit: toplevel !== null }
  worktreeRoots.set(key, entry)
  return entry
}

function gitToplevel(cwd) {
  try {
    const output = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const line = output.trim()
    return line ? resolve(line) : null
  } catch {
    // Not a repository, no git on PATH, or the path is gone. All the same here:
    // there is no worktree root to be had, and the caller says so out loud.
    return null
  }
}

function realPath(path) {
  try {
    return realpathSync(path)
  } catch {
    // A path that is not there resolves to itself: it will match nothing, which
    // is the right answer, rather than throwing on a registry entry gone stale.
    return path
  }
}
