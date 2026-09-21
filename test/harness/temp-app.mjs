import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './dev-server.mjs'
import { repoRoot } from './paths.mjs'

// A throwaway consumer, laid out so root discovery has something to discover:
//
//   <playground>/                    never a git repository
//   <playground>/node_modules/       vite-agent-inspect, linked as an install
//   <playground>/checkout/           the git repository, when one is asked for
//   <playground>/checkout/app/       the Vite root
//   <playground>/<worktree>/         linked worktrees, added on demand
//
// The config is written rather than imported: a test may not import a server
// module, and writing the config is what a consumer does anyway.

const INDEX_HTML = `<!doctype html>
<html>
  <head><title>temp app</title></head>
  <body><div id="app">temp app</div></body>
</html>
`

/**
 * @param {object} [options]
 * @param {boolean} [options.git] Make the checkout a git repository.
 * @param {object} [options.pluginOptions] Passed to `agentInspect(...)`.
 * @param {object} [options.viteConfig] Merged into the written config, for the
 *   consumer settings a test needs Vite itself to have.
 */
export function createTempApp({ git = false, pluginOptions = null, viteConfig = null } = {}) {
  const playground = realpathSync(mkdtempSync(join(tmpdir(), 'vite-agent-inspect-app-')))
  const checkout = join(playground, 'checkout')
  const appDir = join(checkout, 'app')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(join(playground, 'node_modules'))
  symlinkSync(repoRoot, join(playground, 'node_modules', 'vite-agent-inspect'), 'dir')

  writeFileSync(join(appDir, 'index.html'), INDEX_HTML)
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: 'temp-app', private: true, type: 'module' }, null, 2) + '\n',
  )
  writeConfig(appDir, pluginOptions, viteConfig)

  if (git) initRepo(checkout)

  return {
    playground,
    checkout,
    appDir,
    configFile: join(appDir, 'vite.config.js'),

    /** Rewrite the consumer config, for options only knowable once it exists. */
    writeConfig(options, vite = viteConfig) {
      writeConfig(appDir, options, vite)
    },

    /** A linked worktree of the checkout, beside it rather than inside it. */
    addWorktree(name) {
      const path = join(playground, name)
      run(checkout, 'worktree', 'add', '-q', '-b', name, path)
      return realpathSync(path)
    },

    /** An unrelated git repository, to prove Candidates do not leak across them. */
    addSiblingRepo(name) {
      const path = join(playground, name)
      mkdirSync(path)
      initRepo(path)
      return realpathSync(path)
    },

    cleanup() {
      rmSync(playground, { recursive: true, force: true })
    },
  }
}

/** Start a dev server on a temp app. */
export async function startTempApp(app, options = {}) {
  return startServer({ root: app.appDir, configFile: app.configFile, ...options })
}

/**
 * The apps and servers one test file opened, and the one call that shuts them
 * again. A file does `const apps = tempApps()` and `afterEach(apps.cleanup)`.
 */
export function tempApps() {
  const teardown = []

  return {
    /** A temp app, torn down at the end of the test. */
    create(options = {}) {
      const app = createTempApp(options)
      teardown.push(() => app.cleanup())
      return app
    },

    /** Another dev server on an app that already exists. */
    async serve(app, options = {}) {
      const server = await startTempApp(app, options)
      teardown.push(() => server.close())
      return server
    },

    /** The common case: one app, one server on it. */
    async start({ app: appOptions, ...serverOptions } = {}) {
      const app = this.create(appOptions)
      return { app, server: await this.serve(app, serverOptions) }
    },

    /** Last opened, first closed, so a server always outlives its app. */
    async cleanup() {
      while (teardown.length) await teardown.pop()()
    },
  }
}

function writeConfig(appDir, pluginOptions, viteConfig) {
  const config = {
    ...(viteConfig ?? {}),
    plugins: `@@plugins@@`,
  }
  writeFileSync(
    join(appDir, 'vite.config.js'),
    [
      "import { agentInspect } from 'vite-agent-inspect'",
      '',
      'export default ' +
        JSON.stringify(config, null, 2).replace(
          '"@@plugins@@"',
          `[agentInspect(${pluginOptions ? JSON.stringify(pluginOptions) : ''})]`,
        ),
      '',
    ].join('\n'),
  )
}

function initRepo(path) {
  run(path, 'init', '-q', '-b', 'main')
  run(path, 'commit', '-q', '--allow-empty', '-m', 'root')
}

function run(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
}
