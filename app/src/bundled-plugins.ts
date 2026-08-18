/**
 * The plugins this application ships, and how the profile it boots comes to
 * compose them.
 *
 * A freshly installed application would otherwise open a plain harness with no
 * way to reach a second one: installing a plugin is `dsh plugin add` in a
 * terminal, and the machine that just ran an installer has no `dsh` on its
 * `PATH`. The plugin hub is the one plugin that cannot be installed by the
 * mechanism it provides, so it travels with the installer instead.
 *
 * ## Three things have to be true, and shipping the files is only the first
 *
 * The closure carries the package (see `runtime/package.json`), which puts it
 * in the same hoisted `node_modules` as every peer it declares. That much is a
 * dependency entry.
 *
 * The profile has to NAME it: the launcher composes `dsh.profile.bundles`, and
 * the shipped `web` template is two harness bundles the launcher hard-codes.
 * So this module appends to that list.
 *
 * And the rows inside the bundle's patch have to RESOLVE. They do not resolve
 * from the closure: the Loader's `baseUrl` is the profile directory, so a bare
 * specifier is found by Node's walk up from `$DSH_HOME/profiles/<name>/`. What
 * that walk reaches is `$DSH_HOME/profiles/node_modules`, the flat fallback the
 * launcher maintains — one symlink per package in the dsh installation's own
 * dependency closure, which a plugin shipped BESIDE that installation is not
 * in. So this module links it there itself. The launcher only ever adds to
 * that directory (a name it does not know is left alone), so the link stands.
 *
 * ## Shipped bundles stay on; an update is left alone
 *
 * Taking the hub or the mode system out of `dsh.profile.bundles`, or parking
 * either on `dsh.profile.disabled`, is treated as an uninstall or a disable —
 * neither of which they accept. The next launch puts them back on the stack
 * and drops the park mark.
 *
 * An Update through the hub writes the package into the profile as a real
 * dependency. That copy wins the Loader's walk, and this shell must not
 * re-point the fallback symlink at the shipped tree or the next launch would
 * undo the update. The symlink is maintained only while the profile does not
 * already depend on the name.
 * @module @omdsh-plugins/omdsh-desktop/bundled-plugins
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { RUNTIME_PROFILE } from './runtime-launch.ts'

/**
 * The npm scope the bundles this installer carries are published under.
 *
 * Which bundles those are is not a list anywhere: it is whatever
 * `runtime/package.json` depends on in this scope, discovered in the closure
 * at launch. A list here would be a second place to change, and the failure
 * from forgetting it — a package that ships and is never composed — is silent.
 *
 * Today that is the plugin hub and the mode system. Everything past those is
 * a plugin the hub can install, and a plugin frozen into the installer is
 * pinned to this application's release cadence while the packages that
 * depend on it update freely, which is how a shared library and its dependents
 * drift apart. The hub has no dependents, so freezing it costs nothing; the
 * mode system's dependents declare it as `*`, so freezing it does not block
 * them, and an Update through the hub still wins the resolution walk.
 */
export const BUNDLE_SCOPE = '@omdsh-plugins'

/**
 * The plugin that installs the rest. Seeded by this shell, and kept on the
 * composed stack: it cannot be disabled or uninstalled from here.
 */
export const HUB_PACKAGE_NAME = `${BUNDLE_SCOPE}/omdsh-plughub`

/**
 * The mode registry every mode plugin registers into. Seeded by this shell
 * for the same reason the hub is — installing Chat or Code does not bring
 * it — and kept on the composed stack the same way.
 */
export const MODE_PACKAGE_NAME = `${BUNDLE_SCOPE}/omdsh-basemode`

/**
 * Whether a shipped bundle stays on the stack: Disable and Remove are
 * refused, the next launch puts it back, and Update is the one write it
 * still accepts.
 * @param packageName - a bundle this application ships or once offered.
 * @returns true for the hub and the mode system.
 */
function staysOnStack(packageName: string): boolean {
  return packageName === HUB_PACKAGE_NAME || packageName === MODE_PACKAGE_NAME
}

/** Directory under the Harness home holding every profile, as the launcher names it. */
const PROFILES_DIR = 'profiles'

/** The launcher-maintained flat module fallback, a sibling of every profile. */
const MODULE_FALLBACK_DIR = 'node_modules'

/** Manifest filename in a profile directory and in a package. */
const MANIFEST_FILENAME = 'package.json'

/** Environment variable that overrides the default Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Resolve the Harness home, restating `@deepseek-ai/dsh-home-paths`'s
 * `resolveDshHome` (BSD-3-Clause) rather than depending on it: the shell needs
 * twelve lines of it, and one fewer harness package in `app/package.json` is
 * one fewer thing for `harness:local` to keep in step. An empty or
 * whitespace-only `$DSH_HOME` reads as unset, exactly as upstream — a blank
 * override must never resolve the home to the working directory.
 * @param env - the environment to read, injected for specs.
 * @returns the absolute Harness home.
 */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env[DSH_HOME_ENV]
  const selected = configured !== undefined && configured.trim().length > 0
    ? configured
    : join(homedir(), '.dsh')
  if (selected === '~') return homedir()
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return resolve(join(homedir(), selected.slice(2)))
  return resolve(selected)
}

/** What the seeding step may touch, and how it reports. */
export interface SeedOptions {
  /**
   * Root of the deployed harness closure — the directory whose `node_modules`
   * holds both the launcher and the bundles this application ships.
   */
  readonly runtimeRoot: string
  /** The Harness home whose {@link RUNTIME_PROFILE} profile is seeded. */
  readonly home: string
  /** Bundle names this shell has already offered, as its own store recorded them. */
  readonly offered: readonly string[]
  /** Materialize the profile when it is absent; resolves once the launcher has. */
  readonly initProfile: () => Promise<void>
  /** Diagnostic sink. Every branch says what it did, because none of this is visible. */
  readonly log: (message: string) => void
}

/** What one seeding pass concluded. */
export interface SeedOutcome {
  /** Bundle names this shell has now offered, for the store to remember. */
  readonly offered: readonly string[]
  /** Whether the profile manifest was rewritten. */
  readonly changed: boolean
}

/** The profile-manifest slice this module reasons about; every other field is preserved. */
interface ProfileManifest {
  dependencies?: Readonly<Record<string, unknown>>
  dsh?: { profile?: { bundles?: string[]; disabled?: string[] } & Record<string, unknown> } & Record<string, unknown>
  [key: string]: unknown
}

/**
 * The string names a profile-manifest list still holds, in first-seen order.
 * @param value - a JSON array, or something else.
 * @returns the non-empty strings.
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/**
 * Read one JSON file, or undefined when it is absent, unreadable, or not an
 * object. A manifest this shell cannot parse is one it must not rewrite.
 * @param path - absolute file path.
 * @returns the parsed object, or undefined.
 */
function readJsonObject(path: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

/**
 * Whether a directory holds a package that declares a profile patch layer.
 *
 * Both halves matter. The launcher throws when a listed bundle cannot be
 * resolved, and throws again when a resolved one declares no `dsh.bundle` — so
 * appending a name that fails either test does not degrade the application, it
 * stops it booting. This is the check that keeps a shipped plugin from being
 * able to do that.
 * @param dir - candidate package directory.
 * @returns true when the directory holds a usable bundle.
 */
function isBundleDirectory(dir: string): boolean {
  const manifest = readJsonObject(join(dir, MANIFEST_FILENAME))
  if (manifest === undefined) return false
  const dsh = manifest['dsh']
  if (typeof dsh !== 'object' || dsh === null) return false
  const bundle = (dsh as Record<string, unknown>)['bundle']
  return typeof bundle === 'object' && bundle !== null
}

/**
 * The bundles this build ships: every package in {@link BUNDLE_SCOPE} that the
 * closure carries and that declares a profile patch layer.
 *
 * Sorted, so the order bundles are appended to a profile is the same on every
 * machine and every launch — a patch layer's position decides which rows it
 * can override, and a set that composed in readdir order would be a different
 * tree on two machines with the same installer.
 * @param runtimeRoot - root of the deployed closure.
 * @returns the package names, sorted; empty when this build ships none.
 */
export function discoverBundledPlugins(runtimeRoot: string): string[] {
  const scopeDir = join(runtimeRoot, MODULE_FALLBACK_DIR, BUNDLE_SCOPE)
  let entries: string[]
  try {
    entries = readdirSync(scopeDir)
  } catch {
    // No closure, or a closure carrying none of these: a checkout run before
    // its first install looks exactly like this.
    return []
  }
  return entries
    .filter(entry => isBundleDirectory(join(scopeDir, entry)))
    .map(entry => `${BUNDLE_SCOPE}/${entry}`)
    .sort()
}

/**
 * Every directory a bundle name could resolve from, nearest first — the two
 * `node_modules` trees the launcher's walk reaches from a profile, plus the
 * closure this application ships.
 * @param options - the closure root and Harness home.
 * @param options.runtimeRoot - root of the deployed closure.
 * @param options.home - the Harness home.
 * @param profileDir - the profile directory.
 * @param packageName - the bundle's package name.
 * @returns candidate package directories.
 */
function resolutionCandidates(
  options: { runtimeRoot: string; home: string }, profileDir: string, packageName: string,
): string[] {
  const segments = packageName.split('/')
  return [
    join(profileDir, MODULE_FALLBACK_DIR, ...segments),
    join(options.home, PROFILES_DIR, MODULE_FALLBACK_DIR, ...segments),
    join(options.runtimeRoot, MODULE_FALLBACK_DIR, ...segments),
  ]
}

/**
 * Point the flat module fallback at this application's copy of a bundle.
 *
 * Maintained on every launch rather than once: the link names a path inside
 * the application, and replacing the application replaces what stands there.
 * A real directory at that path is somebody else's — pnpm's, after an install
 * through the hub — and is left exactly as it is.
 * @param home - the Harness home.
 * @param packageName - the bundle's package name.
 * @param target - absolute directory the link should name.
 * @param log - diagnostic sink.
 * @returns nothing; the link is on disk, or the reason it is not was logged.
 */
function linkIntoModuleFallback(home: string, packageName: string, target: string, log: (message: string) => void): void {
  const link = join(home, PROFILES_DIR, MODULE_FALLBACK_DIR, ...packageName.split('/'))
  mkdirSync(dirname(link), { recursive: true })
  try {
    const stat = lstatSync(link, { throwIfNoEntry: false })
    if (stat !== undefined) {
      if (!stat.isSymbolicLink()) {
        log(`desktop: ${link} is not a symlink; leaving ${packageName} to whatever owns it\n`)
        return
      }
      if (readlinkSync(link) === target) return
      // unlink removes the reparse point itself on Windows too, where rmSync
      // would treat a junction as a directory and refuse.
      unlinkSync(link)
    }
    symlinkSync(target, link, 'junction')
    log(`desktop: linked ${packageName} into the profile module fallback\n`)
  } catch (error) {
    log(`desktop: could not link ${packageName} into the profile module fallback: ${String(error)}\n`)
  }
}

/**
 * Offer this application's bundles to the profile it is about to boot.
 *
 * Fail-soft throughout: every branch that cannot proceed leaves the profile as
 * it found it and says so. A shell that refused to start because a plugin
 * could not be seeded would have traded the whole application for one tab.
 * @param options - the closure, the home, what has already been offered, and the sinks.
 * @returns what was offered and whether the manifest changed.
 */
export async function seedBundledPlugins(options: SeedOptions): Promise<SeedOutcome> {
  const profileDir = join(options.home, PROFILES_DIR, RUNTIME_PROFILE)
  const manifestPath = join(profileDir, MANIFEST_FILENAME)

  if (!existsSync(manifestPath)) {
    await options.initProfile()
    if (!existsSync(manifestPath)) {
      options.log(`desktop: the ${RUNTIME_PROFILE} profile did not initialize; shipping no bundled plugins\n`)
      return { offered: options.offered, changed: false }
    }
  }

  const manifest = readJsonObject(manifestPath) as ProfileManifest | undefined
  if (manifest === undefined) {
    options.log(`desktop: ${manifestPath} is unreadable; leaving it alone\n`)
    return { offered: options.offered, changed: false }
  }

  const bundles = stringList(manifest.dsh?.profile?.bundles)
  const disabledList = stringList(manifest.dsh?.profile?.disabled)
  const disabled = new Set(disabledList)
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  const offered = new Set(options.offered)
  let changed = false

  // Every bundle this shell has ever offered is revisited, not just the ones
  // this build ships: an application replaced by one carrying fewer of them
  // leaves rows behind that no longer resolve, and those rows are fatal.
  const names = [...new Set([...discoverBundledPlugins(options.runtimeRoot), ...options.offered])].sort()
  if (names.length === 0) options.log(`desktop: this build ships no ${BUNDLE_SCOPE} bundles\n`)

  for (const packageName of names) {
    const shipped = join(options.runtimeRoot, MODULE_FALLBACK_DIR, ...packageName.split('/'))
    if (dependencies.has(packageName)) {
      options.log(`desktop: ${packageName} is a profile dependency; leaving the installed copy in place\n`)
    } else if (isBundleDirectory(shipped)) {
      linkIntoModuleFallback(options.home, packageName, shipped, options.log)
    }

    const resolvable = resolutionCandidates(options, profileDir, packageName).some(isBundleDirectory)
    const listed = bundles.indexOf(packageName)

    if (!resolvable) {
      // The listed name would stop the launcher dead, and this shell is the
      // only thing that knows the package left with an application it
      // replaced. Dropping the row costs a plugin; leaving it costs the boot.
      if (listed !== -1) {
        bundles.splice(listed, 1)
        changed = true
        options.log(`desktop: ${packageName} no longer resolves; dropped it from the profile\n`)
      }
      continue
    }

    if (listed !== -1) {
      offered.add(packageName)
      if (staysOnStack(packageName) && disabled.has(packageName)) {
        disabled.delete(packageName)
        changed = true
        options.log(`desktop: ${packageName} cannot be disabled; putting it back on the stack\n`)
      }
      continue
    }
    if (disabled.has(packageName) && !staysOnStack(packageName)) {
      offered.add(packageName)
      options.log(`desktop: ${packageName} is disabled; leaving it off the stack\n`)
      continue
    }
    // Not parked, not listed: an uninstall, which a shipped bundle cannot
    // be. The hub and the mode system look the same when someone parked
    // them. Put it back. The first offer of a fresh profile is the same write.
    bundles.push(packageName)
    const unparked = staysOnStack(packageName) && disabled.delete(packageName)
    offered.add(packageName)
    changed = true
    options.log(unparked
      ? `desktop: ${packageName} cannot be disabled; putting it back on the stack\n`
      : `desktop: added ${packageName} to the ${RUNTIME_PROFILE} profile\n`)
  }

  if (!changed) return { offered: [...offered], changed: false }

  const nextDisabled = disabledList.filter(name => disabled.has(name))
  const profile = { ...manifest.dsh?.profile, bundles }
  if (nextDisabled.length === 0) delete profile.disabled
  else profile.disabled = nextDisabled
  const next: ProfileManifest = {
    ...manifest,
    dsh: { ...manifest.dsh, profile },
  }
  try {
    writeFileSync(manifestPath, `${JSON.stringify(next, undefined, 2)}\n`)
  } catch (error) {
    options.log(`desktop: could not write ${manifestPath}: ${String(error)}\n`)
    return { offered: options.offered, changed: false }
  }
  return { offered: [...offered], changed: true }
}
