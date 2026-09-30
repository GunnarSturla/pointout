import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../../server/parse.js'
import { INSTALLED_DRAIN_BIN } from '../setup.js'
import type { HarnessSetup, Project, SetupItem, SetupPlan } from '../setup.js'
import { SKILL } from './skill.js'

// What "set up" means to Claude Code (spec §18): two hook entries in the
// project's own settings, and the setup skill in the project's skills
// directory. Project-level only, never the user's `~/.claude`: the floor is a
// property of this checkout, and a teammate who clones it gets it by
// committing `.claude/`.

/** The two events the floor rides (spec §15): the next prompt, and turn end. */
const EVENTS = ['UserPromptSubmit', 'Stop'] as const

/**
 * The harness substitutes this in a hook's `args` with the directory the
 * session started in. It is how a checked-in hook names a file without
 * depending on the cwd the hook happens to run in.
 */
const PROJECT_DIR = '${CLAUDE_PROJECT_DIR}'

/**
 * Seconds before the harness gives up on the hook. The drain CLI gives each dev
 * server two seconds; this bounds the whole of it, so a machine with several
 * wedged servers still cannot hold a prompt for long.
 */
const HOOK_TIMEOUT_SECONDS = 10

/** A command hook as the settings file spells one. */
interface CommandHook {
  type: 'command'
  command: string
  args?: string[]
  timeout?: number
}

type HookGroup = { matcher?: string; hooks: unknown[] }
type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> }

export const claudeSetup: HarnessSetup = {
  name: 'Claude Code',

  plan(project: Project): SetupPlan {
    const settings = planSettings(project)
    const skill = planSkill(project)
    return {
      items: [...settings.items, ...skill.items],
      writes: [...settings.writes, ...skill.writes],
    }
  },
}

/**
 * The hook entry, in exec form: with `args` set there is no shell, so a chatty
 * profile cannot prepend a line to the JSON the drain prints, and a path with
 * a space in it is still one argument.
 */
function drainHook({ drainBin }: Project): CommandHook {
  return {
    type: 'command',
    command: 'node',
    args: [`${PROJECT_DIR}/${drainBin}`, 'drain'],
    timeout: HOOK_TIMEOUT_SECONDS,
  }
}

/** A hook this package installed, at whatever path it was installed from. */
function isOurs(hook: unknown): boolean {
  if (typeof hook !== 'object' || hook === null) return false
  const { args } = hook as { args?: unknown }
  return (
    Array.isArray(args) &&
    args.length === 2 &&
    typeof args[0] === 'string' &&
    args[0].endsWith(INSTALLED_DRAIN_BIN) &&
    args[1] === 'drain'
  )
}

function planSettings(project: Project): SetupPlan {
  const path = join(project.root, '.claude', 'settings.json')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  const settings = parseSettings(path, before)
  const hooks = (settings.hooks ??= {})
  const wanted = drainHook(project)

  const items: SetupItem[] = EVENTS.map((event) => {
    const what = `${event} hook (pointout drain)`
    const groups = hookGroups(path, hooks, event)
    const found = groups.flatMap((group) => group.hooks.filter(isOurs))

    if (found.length === 1 && sameHook(found[0], wanted)) {
      return { what, path, action: 'already present' }
    }
    // Ours, but not what this install would write — a package that moved, or
    // a second copy. Every copy goes and one current entry replaces them, so
    // a Pick is never drained by two hooks on one event.
    for (const group of groups) group.hooks = group.hooks.filter((hook) => !isOurs(hook))
    const kept = groups.filter((group) => group.hooks.length > 0)
    hooks[event] = [...kept, { hooks: [wanted] }]
    return { what, path, action: found.length > 0 ? 'updated' : 'wrote' }
  })

  const changed = items.some((item) => item.action !== 'already present')
  return {
    items,
    writes: changed ? [{ path, content: JSON.stringify(settings, null, 2) + '\n' }] : [],
  }
}

function parseSettings(path: string, text: string | null): Settings {
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${path} is not JSON (${(error as Error).message}), so its hooks cannot be ` +
        'added to without losing what is there. Fix it and run init again. ' +
        'Nothing was written.',
      { cause: error },
    )
  }
  if (!isRecord(parsed) || (parsed.hooks !== undefined && !isRecord(parsed.hooks))) {
    throw new Error(
      `${path} is not a settings object with an object of hooks. ` +
        'Nothing was written.',
    )
  }
  return parsed as Settings
}

/** One event's matcher groups, refused rather than guessed at when misshapen. */
function hookGroups(
  path: string,
  hooks: Record<string, unknown>,
  event: string,
): HookGroup[] {
  const groups = hooks[event] ?? []
  const valid =
    Array.isArray(groups) &&
    groups.every((group) => isRecord(group) && Array.isArray(group.hooks))
  if (!valid) {
    throw new Error(
      `${path} has a ${event} entry that is not a list of hook groups. ` +
        'Nothing was written.',
    )
  }
  return groups as HookGroup[]
}

function planSkill(project: Project): SetupPlan {
  const path = join(project.root, '.claude', 'skills', 'pointout', 'SKILL.md')
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null
  const what = 'setup skill'
  if (before === SKILL)
    return { items: [{ what, path, action: 'already present' }], writes: [] }
  // A copy that differs is replaced, and the report says so: the skill's
  // words are part of what keeps a Pick from being taken for approval, and
  // an edited copy is not a version this package can vouch for.
  return {
    items: [{ what, path, action: before === null ? 'wrote' : 'updated' }],
    writes: [{ path, content: SKILL }],
  }
}

/**
 * The same hook, field by field, so an entry whose keys a person reordered is
 * still the one this install would write. A field it does not know — say a
 * `statusMessage` somebody added — makes it a different entry, and it is
 * replaced and reported as updated rather than quietly kept.
 */
function sameHook(found: unknown, wanted: CommandHook): boolean {
  if (!isRecord(found)) return false
  const keys = Object.keys(found).toSorted()
  return (
    JSON.stringify(keys) === JSON.stringify(Object.keys(wanted).toSorted()) &&
    found.type === wanted.type &&
    found.command === wanted.command &&
    found.timeout === wanted.timeout &&
    JSON.stringify(found.args) === JSON.stringify(wanted.args)
  )
}
