/**
 * Switch where the omdsh bundles this installer carries come from.
 *
 * The desktop application ships more than the harness: the plugin hub travels
 * with it, because a machine that has just run an installer has no `dsh` on
 * its `PATH` and therefore no way to install a first plugin. Which bundles
 * those are is declared once, as the `@omdsh-plugins/*` entries of this
 * repository's catalog, and `runtime/package.json` must name all of them.
 *
 * Two sources, one switch — the same shape `scripts/harness-source.ts` gives
 * the harness release:
 *
 * - **registry** — each bundle is the catalogued published version. This is
 *   what a released artifact ships.
 * - **local** — each bundle is a `link:` to a sibling checkout, so unreleased
 *   plugin work is what the shell composes. pnpm does not install a linked
 *   package's own dependencies, so those checkouts must be installed and built
 *   (`pnpm run build`) first.
 * - **none** — the manifest carries no bundle at all, and a build made from it
 *   ships none. This is what the repository commits while the catalogued
 *   packages are unpublished, and `plugins:none` is how you get back to it.
 *
 * A committed `link:` is not a third mode, it is a bug: pnpm resolves it
 * against the declaring manifest, so `pnpm install` from a clone without the
 * siblings WARNS, exits zero, and leaves a dangling symlink — and packaging
 * then puts that symlink inside the `.app`, where macOS refuses to sign it.
 * {@link check} fails on one for that reason.
 *
 * Packaging is not troubled by a local bundle otherwise: it packs each one into
 * a tarball before staging the closure — see `scripts/bundled-plugins.ts`.
 *
 * Run: `pnpm run plugins:local ..`, `pnpm run plugins:npm`,
 * `pnpm run plugins:none`, or `pnpm run check:plugin-pin`.
 * @module @omdsh-plugins/omdsh-desktop/scripts/plugin-source
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { localPath } from './bundled-plugins.ts'

const root = resolve(import.meta.dirname, '..')

/** Diagnostic prefix on this script's logs and errors. */
const PREFIX = 'plugin-source'

/** The npm scope the bundles this installer carries are published under. */
export const BUNDLE_SCOPE = '@omdsh-plugins'

/** The manifest whose dependencies become the deployed closure. */
const RUNTIME_MANIFEST = join('runtime', 'package.json')

/** A manifest this script rewrites dependencies of. */
interface Manifest {
  dependencies?: Record<string, string>
}

/**
 * Extract the `catalog:` block of `pnpm-workspace.yaml`.
 *
 * Read as text rather than parsed: this repository has no YAML dependency, and
 * the block is a flat map of quoted package names. Taking the block first
 * matters because `allowBuilds` is a flat map of package names too — a
 * document-wide search would read a build decision as a version.
 * @param text - the whole workspace document.
 * @returns the block's lines, without the `catalog:` line itself.
 */
function catalogBlock(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^catalog:\s*$/u.test(line))
  if (start === -1) return []
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    // The block ends at the first line that starts a new top-level key; blank
    // lines and comments inside it are content this loop simply ignores.
    if (/^\S/u.test(line)) break
    block.push(line)
  }
  return block
}

/**
 * The bundles this installer is meant to carry, and the version each is
 * catalogued at.
 * @returns package name to version, in catalog order.
 * @throws Error when the catalog declares none.
 */
async function catalogedBundles(): Promise<Map<string, string>> {
  const text = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const found = new Map<string, string>()
  for (const line of catalogBlock(text)) {
    const match = /^\s+'(@omdsh-plugins\/[^']+)':\s*(\S+)\s*$/u.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) found.set(match[1], match[2])
  }
  if (found.size === 0) {
    throw new Error(`${PREFIX}: pnpm-workspace.yaml catalogs no ${BUNDLE_SCOPE} bundle; there is nothing to ship.`)
  }
  return found
}

/**
 * Read one JSON manifest.
 * @param path - absolute manifest path.
 * @returns the parsed manifest.
 */
async function readManifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, 'utf8')) as Manifest
}

/**
 * Write one JSON manifest back with the repository's formatting.
 * @param path - absolute manifest path.
 * @param manifest - the manifest to serialize.
 */
async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * Render a path with forward slashes, which manifests use on every platform.
 * @param path - a platform-native relative path.
 * @returns the same path with POSIX separators.
 */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

/**
 * Locate one bundle's checkout under a directory of plugin repositories.
 *
 * The directory name is not trusted to be the package name: the manifest is
 * read and its `name` checked, which is also what catches a `--local` pointed
 * at the wrong place — a mistake that would otherwise surface as a build
 * missing files it never names.
 * @param checkouts - directory holding the plugin repositories.
 * @param packageName - the bundle's package name.
 * @returns the absolute checkout directory.
 * @throws Error when no directory there publishes that package.
 */
function findCheckout(checkouts: string, packageName: string): string {
  const candidate = join(checkouts, packageName.slice(BUNDLE_SCOPE.length + 1))
  const manifestPath = join(candidate, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`${PREFIX}: ${candidate} is not a checkout of ${packageName}: package.json is absent.`)
  }
  const name = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }).name
  if (name !== packageName) {
    throw new Error(`${PREFIX}: ${candidate} publishes ${String(name)}, not ${packageName}.`)
  }
  return candidate
}

/**
 * Point every catalogued bundle at a sibling checkout.
 * @param checkouts - directory holding the plugin repositories, absolute or relative to this repository.
 */
async function useLocal(checkouts: string): Promise<void> {
  const absolute = resolve(root, checkouts)
  const catalog = await catalogedBundles()
  const manifest = await readManifest(join(root, RUNTIME_MANIFEST))
  const dependencies = manifest.dependencies ?? {}
  for (const packageName of catalog.keys()) {
    // pnpm resolves a `link:` against the manifest that declares it, so the
    // path is the one from `runtime/`, not from the repository root.
    const checkout = findCheckout(absolute, packageName)
    dependencies[packageName] = `link:${toPosix(relative(join(root, 'runtime'), checkout))}`
  }
  await writeManifest(join(root, RUNTIME_MANIFEST), { ...manifest, dependencies })
  console.log(`${PREFIX}: shipping the bundle checkouts under ${absolute}`)
  console.log(`${PREFIX}: run 'pnpm install'; each checkout must be installed and built (\`pnpm run build\`) for its lib/ to resolve.`)
}

/** Point every catalogued bundle back at its published version. */
async function useRegistry(): Promise<void> {
  const catalog = await catalogedBundles()
  const manifest = await readManifest(join(root, RUNTIME_MANIFEST))
  const dependencies = manifest.dependencies ?? {}
  for (const [packageName, version] of catalog) dependencies[packageName] = version
  await writeManifest(join(root, RUNTIME_MANIFEST), { ...manifest, dependencies })
  for (const [packageName, version] of catalog) console.log(`${PREFIX}: shipping ${packageName}@${version}`)
  console.log(`${PREFIX}: run 'pnpm install'.`)
}

/** Remove every catalogued bundle from the runtime manifest. */
async function useNothing(): Promise<void> {
  const catalog = await catalogedBundles()
  const manifest = await readManifest(join(root, RUNTIME_MANIFEST))
  const dependencies = { ...manifest.dependencies }
  for (const packageName of catalog.keys()) delete dependencies[packageName]
  await writeManifest(join(root, RUNTIME_MANIFEST), { ...manifest, dependencies })
  console.log(`${PREFIX}: shipping no ${BUNDLE_SCOPE} bundle; a build made from this manifest carries none.`)
  console.log(`${PREFIX}: run 'pnpm install'.`)
}

/**
 * Prove the runtime manifest is in a state that a clone of THIS repository
 * alone can install and package.
 *
 * A local specifier FAILS, and this is the one place `harness-source`'s
 * reasoning about the same manifest does not carry over. There, a `link:` is
 * tolerated in `runtime/package.json` because the registry pin is one command
 * away and is what gets committed. Here the catalogued packages are not
 * published anywhere, so a committed `link:` is not a temporary state somebody
 * will switch back from — it is the only state, and it is one where
 * `pnpm install` from a clone without the sibling checkouts warns, exits zero,
 * and leaves a dangling symlink that packaging carries into the `.app` until
 * codesign rejects the bundle. CONVENTIONS rule 8 names exactly this.
 *
 * An ABSENT bundle passes and is reported. It is the honest pre-publication
 * state: the catalog says what this application intends to carry, the manifest
 * carries what it can, and a build made now ships no bundle rather than a
 * broken one.
 */
async function check(): Promise<void> {
  const catalog = await catalogedBundles()
  const manifest = await readManifest(join(root, RUNTIME_MANIFEST))
  const dependencies = manifest.dependencies ?? {}
  const linked: string[] = []
  const absent: string[] = []
  for (const [packageName, version] of catalog) {
    const pinned = dependencies[packageName]
    if (pinned === undefined) {
      absent.push(packageName)
      continue
    }
    if (localPath(pinned) !== undefined) {
      linked.push(`${packageName} (${pinned})`)
      continue
    }
    if (pinned !== version) {
      throw new Error(
        `${PREFIX}: ${RUNTIME_MANIFEST} pins ${packageName}@${pinned} but the catalog pins ${version}; they must name one release.`,
      )
    }
    console.log(`${PREFIX}: runtime and catalog both pin ${packageName}@${version}.`)
  }
  if (linked.length > 0) {
    throw new Error(
      `${PREFIX}: ${RUNTIME_MANIFEST} names a path on this machine for ${linked.join(', ')}. `
      + "A clone without those checkouts installs it as a dangling symlink and packaging carries it into the .app; "
      + "run 'pnpm run plugins:none' before committing, or 'pnpm run plugins:npm' once the package is published.",
    )
  }
  for (const packageName of absent) {
    console.log(
      `${PREFIX}: ${packageName} is catalogued but not carried, so a build made now ships no plugin. `
      + "Run 'pnpm run plugins:local <checkouts>' to build one that does, or 'pnpm run plugins:npm' once it is published.",
    )
  }
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: {
    local: { type: 'boolean', default: false },
    npm: { type: 'boolean', default: false },
    none: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

if (values.check) await check()
else if (values.npm) await useRegistry()
else if (values.none) await useNothing()
else if (values.local) {
  const checkouts = positionals[0]
  if (checkouts === undefined) throw new Error(`${PREFIX}: --local needs the directory holding the plugin checkouts.`)
  await useLocal(checkouts)
}
else throw new Error(`${PREFIX}: pass --local <checkouts>, --npm, --none, or --check.`)
