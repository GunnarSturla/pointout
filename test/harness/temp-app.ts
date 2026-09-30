import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './dev-server.js'
import type { HarnessServer, StartServerOptions } from './dev-server.js'
import { repoRoot } from './paths.js'

// A throwaway consumer, laid out so root discovery has something to discover:
//
//   <playground>/                    never a git repository
//   <playground>/node_modules/       pointout, linked as an install
//   <playground>/checkout/           the git repository, when one is asked for
//   <playground>/checkout/app/       the Vite root
//   <playground>/<worktree>/         linked worktrees, added on demand
//
// The config is written rather than imported: a test may not import a server
// module, and writing the config is what a consumer does anyway. It is written
// as JavaScript on purpose — it is fixture output imitating what a consumer
// hands to Vite, not source this repository type-checks.

const INDEX_HTML = `<!doctype html>
<html>
  <head><title>temp app</title></head>
  <body><div id="app">temp app</div></body>
</html>
`

/** Whatever `pointout(...)` should be called with in the written config. */
type PluginOptions = Record<string, unknown> | null
/** Consumer-side Vite settings a test needs Vite itself to have. */
type ViteConfig = Record<string, unknown> | null

export interface TempAppOptions {
  /** Make the checkout a git repository. */
  git?: boolean
  pluginOptions?: PluginOptions
  viteConfig?: ViteConfig
}

export interface TempApp {
  playground: string
  checkout: string
  appDir: string
  configFile: string
  /** Rewrite the consumer config, for options only knowable once it exists. */
  writeConfig(options: PluginOptions, vite?: ViteConfig): void
  /** A linked worktree of the checkout, beside it rather than inside it. */
  addWorktree(name: string): string
  /** An unrelated git repository, to prove Candidates do not leak across them. */
  addSiblingRepo(name: string): string
  cleanup(): void
}

export function createTempApp({
  git = false,
  pluginOptions = null,
  viteConfig = null,
}: TempAppOptions = {}): TempApp {
  const playground = realpathSync(mkdtempSync(join(tmpdir(), 'pointout-app-')))
  const checkout = join(playground, 'checkout')
  const appDir = join(checkout, 'app')
  mkdirSync(appDir, { recursive: true })
  mkdirSync(join(playground, 'node_modules'))
  symlinkSync(repoRoot, join(playground, 'node_modules', 'pointout'), 'dir')

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

    writeConfig(options, vite = viteConfig) {
      writeConfig(appDir, options, vite)
    },

    addWorktree(name) {
      const path = join(playground, name)
      run(checkout, 'worktree', 'add', '-q', '-b', name, path)
      return realpathSync(path)
    },

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

/** Options a test passes for the server, with the app supplying root and config. */
type TempServerOptions = Omit<Partial<StartServerOptions>, 'root' | 'configFile'>

/** Start a dev server on a temp app. */
export async function startTempApp(
  app: TempApp,
  options: TempServerOptions = {},
): Promise<HarnessServer> {
  return startServer({ root: app.appDir, configFile: app.configFile, ...options })
}

export interface TempApps {
  /** A temp app, torn down at the end of the test. */
  create(options?: TempAppOptions): TempApp
  /** Another dev server on an app that already exists. */
  serve(app: TempApp, options?: TempServerOptions): Promise<HarnessServer>
  /** The common case: one app, one server on it. */
  start(
    options?: TempServerOptions & { app?: TempAppOptions },
  ): Promise<{ app: TempApp; server: HarnessServer }>
  /** Last opened, first closed, so a server always outlives its app. */
  cleanup(): Promise<void>
}

/**
 * The apps and servers one test file opened, and the one call that shuts them
 * again. A file does `const apps = tempApps()` and `afterEach(apps.cleanup)`.
 */
export function tempApps(): TempApps {
  const teardown: Array<() => void | Promise<void>> = []

  const apps: TempApps = {
    create(options = {}) {
      const app = createTempApp(options)
      teardown.push(() => app.cleanup())
      return app
    },

    async serve(app, options = {}) {
      const server = await startTempApp(app, options)
      teardown.push(() => server.close())
      return server
    },

    async start({ app: appOptions, ...serverOptions } = {}) {
      const app = apps.create(appOptions)
      return { app, server: await apps.serve(app, serverOptions) }
    },

    async cleanup() {
      while (teardown.length) await teardown.pop()!()
    },
  }

  return apps
}

function writeConfig(
  appDir: string,
  pluginOptions: PluginOptions,
  viteConfig: ViteConfig,
) {
  const config = {
    ...viteConfig,
    plugins: `@@plugins@@`,
  }
  writeFileSync(
    join(appDir, 'vite.config.js'),
    [
      "import { pointout } from 'pointout'",
      '',
      'export default ' +
        JSON.stringify(config, null, 2).replace(
          '"@@plugins@@"',
          `[pointout(${pluginOptions ? JSON.stringify(pluginOptions) : ''})]`,
        ),
      '',
    ].join('\n'),
  )
}

function initRepo(path: string) {
  run(path, 'init', '-q', '-b', 'main')
  run(path, 'commit', '-q', '--allow-empty', '-m', 'root')
}

function run(cwd: string, ...args: string[]) {
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
