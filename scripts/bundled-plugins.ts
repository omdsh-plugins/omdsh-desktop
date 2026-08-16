/**
 * Turn the omdsh bundles the runtime pin names into something an application
 * bundle can carry.
 *
 * `runtime/package.json` may name a bundle as a `link:` to a sibling checkout
 * — that is what `pnpm run plugins:local` writes, for packaging a build against
 * unreleased plugin work. It is a working-tree state and never a committed one:
 * `scripts/plugin-source.ts` fails `check:plugin-pin` on one, and what the
 * repository commits is the published version `plugins:npm` writes.
 *
 * Packaging still has to handle it, because packaging is exactly what that
 * state is for. pnpm honours the specifier by SYMLINKING the checkout into the
 * closure, and the closure is then copied into an `.app` where that symlink
 * points at a directory on the machine that built it. The result installs,
 * packages, ships, and dies on the user's first boot with
 * `ERR_MODULE_NOT_FOUND`.
 *
 * So a local bundle is packed into a tarball first and installed from that.
 * The closure then holds real files, for the same reason it is installed with
 * the hoisted linker: nothing inside an application bundle may point outside
 * it. `pnpm pack` runs the package's own `prepare`, so what ships is what the
 * checkout builds rather than whatever `lib/` happened to be lying there.
 *
 * A bundle named by version needs none of this and is passed through
 * untouched.
 * @module @omdsh-plugins/omdsh-desktop/scripts/bundled-plugins
 */

import { mkdir, readdir, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BUNDLE_SCOPE } from '../app/src/bundled-plugins.ts'
import { runCommand } from './run-command.ts'

/** The scope prefix a bundle's package name starts with, slash included. */
const SCOPE_PREFIX = `${BUNDLE_SCOPE}/`

/** Specifier prefixes that name a path on this machine rather than a release. */
const LOCAL_PREFIXES = ['link:', 'file:'] as const

/** What packing the local bundles needs to know. */
export interface PackBundlesOptions {
  /** The runtime pin's dependency map. */
  readonly dependencies: Readonly<Record<string, string>>
  /** Directory the pin's relative specifiers resolve against: `runtime/`. */
  readonly manifestDir: string
  /** Directory the tarballs are written under; replaced wholesale. */
  readonly destination: string
  /** Diagnostic prefix on this step's logs and errors. */
  readonly prefix: string
  /** Report what would happen and change nothing. */
  readonly dryRun: boolean
}

/**
 * The local path a specifier names, or undefined when it names a release.
 * @param specifier - the dependency specifier.
 * @returns the path, still relative if the specifier was.
 */
export function localPath(specifier: string): string | undefined {
  const prefix = LOCAL_PREFIXES.find(candidate => specifier.startsWith(candidate))
  return prefix === undefined ? undefined : specifier.slice(prefix.length)
}

/**
 * Every bundle the pin carries, packed or not.
 *
 * The packaging pipeline reports this before it stages anything: shipping no
 * plugin is a legitimate state and also an easy one to reach by accident, and
 * an installer that quietly lacks the hub looks exactly like one that has it
 * until somebody opens Settings.
 * @param dependencies - the pin's dependency map.
 * @returns the package names, sorted.
 */
export function bundleNames(dependencies: Readonly<Record<string, string>>): string[] {
  return Object.keys(dependencies).filter(name => name.startsWith(SCOPE_PREFIX)).sort()
}

/**
 * The bundles that have to be packed: those in {@link BUNDLE_SCOPE} whose
 * specifier names a directory on this machine.
 *
 * A specifier already naming a tarball is left alone — it is what this module
 * produces, so a rerun over its own output is a no-op rather than a repack.
 * @param dependencies - the pin's dependency map.
 * @param manifestDir - directory relative specifiers resolve against.
 * @returns package name to absolute checkout directory.
 */
export function localBundles(
  dependencies: Readonly<Record<string, string>>, manifestDir: string,
): Map<string, string> {
  const found = new Map<string, string>()
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (!name.startsWith(SCOPE_PREFIX)) continue
    const path = localPath(specifier)
    if (path === undefined) continue
    const absolute = resolve(manifestDir, path)
    if (existsSync(absolute) && statSync(absolute).isDirectory()) found.set(name, absolute)
  }
  return found
}

/**
 * Pack every local bundle and rewrite its specifier to the tarball.
 * @param options - the pin, where to write tarballs, and how loud to be.
 * @returns the dependency map to install, with local bundles repointed.
 * @throws Error when a checkout cannot be packed.
 */
export async function packLocalBundles(options: PackBundlesOptions): Promise<Record<string, string>> {
  const bundles = localBundles(options.dependencies, options.manifestDir)
  const dependencies = { ...options.dependencies }
  if (bundles.size === 0) return dependencies

  if (options.dryRun) {
    for (const [name, checkout] of bundles) console.log(`${options.prefix}: would pack ${name} from ${checkout}`)
    return dependencies
  }

  await rm(options.destination, { recursive: true, force: true })
  for (const [name, checkout] of bundles) {
    // One directory per bundle, so the tarball is identified by being the only
    // thing there rather than by predicting the name pnpm gives it.
    const into = join(options.destination, name.slice(SCOPE_PREFIX.length))
    await mkdir(into, { recursive: true })
    await runCommand({
      label: `pack ${name}`,
      command: 'pnpm',
      args: ['pack', '--pack-destination', into],
      cwd: checkout,
      prefix: options.prefix,
      dryRun: false,
    })
    const tarballs = (await readdir(into)).filter(entry => entry.endsWith('.tgz'))
    if (tarballs.length !== 1 || tarballs[0] === undefined) {
      throw new Error(`${options.prefix}: packing ${name} produced ${String(tarballs.length)} tarball(s) in ${into}.`)
    }
    dependencies[name] = `file:${join(into, tarballs[0])}`
    console.log(`${options.prefix}: packed ${name} from ${checkout}`)
  }
  return dependencies
}
