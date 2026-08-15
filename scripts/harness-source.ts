/**
 * Switch which harness the desktop application builds and runs against.
 *
 * Two sources, one switch:
 *
 * - **registry** (default) — `runtime/package.json` pins one published release
 *   and `app` resolves the API client from the same catalog version. This is
 *   what a packaged artifact ships and what CI reproduces.
 * - **local** — both point at a sibling harness checkout through `link:`
 *   specifiers, so unreleased work in that checkout is what the shell
 *   supervises and bundles. pnpm does not install a linked package's own
 *   dependencies, so the checkout must have been installed and built itself.
 *
 * Run: `pnpm run harness:local ../../deepseek-harness`, `pnpm run harness:npm`,
 * or `pnpm run check:harness-pin` to prove the pinned versions agree.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/** Diagnostic prefix on this script's logs and errors. */
const PREFIX = 'harness-source'

/** The release the runtime manifest pins, and the app's API-client dependency. */
const HARNESS_PACKAGE = '@deepseek-ai/dsh'

/** The API client the shell bundles; its version tracks the runtime release. */
const APIPROXY_PACKAGE = '@deepseek-ai/dsh-host-apiproxy'

/** Directory inside a harness checkout that publishes {@link HARNESS_PACKAGE}. */
const HARNESS_CLI_DIRECTORY = join('apps', 'cli')

/** Directory inside a harness checkout that publishes {@link APIPROXY_PACKAGE}. */
const HARNESS_APIPROXY_DIRECTORY = join('packages', 'host', 'apiproxy')

/** A manifest this script rewrites one dependency of. */
interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
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
 * Read the version the workspace catalog pins for one package.
 * @param name - the catalogued package name.
 * @returns the pinned version.
 * @throws Error when the catalog does not pin it.
 */
async function catalogVersion(name: string): Promise<string> {
  const text = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
  // Only regex metacharacters are escaped: a package name's `@`, `-`, and `/`
  // carry no meaning in a pattern, and escaping them is an error in unicode mode.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(`^\\s+'${escaped}':\\s*(\\S+)\\s*$`, 'mu').exec(text)
  if (match?.[1] === undefined) throw new Error(`${PREFIX}: pnpm-workspace.yaml catalog does not pin ${name}.`)
  return match[1]
}

/**
 * Point both manifests at a sibling harness checkout.
 * @param checkout - path to the harness checkout, absolute or relative to the repository root.
 */
async function useLocal(checkout: string): Promise<void> {
  const absolute = resolve(root, checkout)
  for (const directory of [HARNESS_CLI_DIRECTORY, HARNESS_APIPROXY_DIRECTORY]) {
    if (!existsSync(join(absolute, directory, 'package.json'))) {
      throw new Error(`${PREFIX}: ${absolute} is not a harness checkout: ${directory}/package.json is absent.`)
    }
  }
  // pnpm resolves a `link:` specifier against the manifest that declares it,
  // so each manifest needs the path from its own directory, not from the root.
  const runtimeLink = `link:${toPosix(relative(join(root, 'runtime'), join(absolute, HARNESS_CLI_DIRECTORY)))}`
  const appLink = `link:${toPosix(relative(join(root, 'app'), join(absolute, HARNESS_APIPROXY_DIRECTORY)))}`
  await setDependency(join(root, 'runtime', 'package.json'), 'dependencies', HARNESS_PACKAGE, runtimeLink)
  await setDependency(join(root, 'app', 'package.json'), 'devDependencies', APIPROXY_PACKAGE, appLink)
  console.log(`${PREFIX}: building against the checkout at ${absolute}`)
  console.log(`${PREFIX}: run 'pnpm install'; that checkout must be installed and built (\`pnpm run build\`) for its lib/ to resolve.`)
}

/** Point both manifests back at the catalogued published release. */
async function useRegistry(): Promise<void> {
  const version = await catalogVersion(HARNESS_PACKAGE)
  await setDependency(join(root, 'runtime', 'package.json'), 'dependencies', HARNESS_PACKAGE, version)
  await setDependency(join(root, 'app', 'package.json'), 'devDependencies', APIPROXY_PACKAGE, 'catalog:')
  console.log(`${PREFIX}: building against the published ${HARNESS_PACKAGE}@${version}`)
  console.log(`${PREFIX}: run 'pnpm install'.`)
}

/**
 * Prove the runtime manifest and the catalog pin the same release.
 *
 * A checkout switched to a local harness is reported as such and passes: the
 * check exists to catch a drifted version, not to forbid local development.
 */
async function check(): Promise<void> {
  const runtime = await readManifest(join(root, 'runtime', 'package.json'))
  const pinned = runtime.dependencies?.[HARNESS_PACKAGE]
  if (pinned === undefined) throw new Error(`${PREFIX}: runtime/package.json does not depend on ${HARNESS_PACKAGE}.`)
  if (pinned.startsWith('link:')) {
    console.log(`${PREFIX}: runtime is linked to a local harness (${pinned}); version pinning does not apply.`)
    return
  }
  const version = await catalogVersion(HARNESS_PACKAGE)
  if (pinned !== version) {
    throw new Error(`${PREFIX}: runtime/package.json pins ${pinned} but the catalog pins ${version}; they must name one release.`)
  }
  console.log(`${PREFIX}: runtime and catalog both pin ${HARNESS_PACKAGE}@${version}.`)
}

/**
 * Rewrite one dependency entry in place, failing loud when it is absent.
 * @param path - absolute manifest path.
 * @param field - the dependency field holding it.
 * @param name - the package to repoint.
 * @param specifier - its new specifier.
 */
async function setDependency(path: string, field: 'dependencies' | 'devDependencies', name: string, specifier: string): Promise<void> {
  const manifest = await readManifest(path)
  const entries = manifest[field]
  if (entries?.[name] === undefined) {
    throw new Error(`${PREFIX}: ${path} has no ${field} entry for ${name}.`)
  }
  entries[name] = specifier
  await writeManifest(path, manifest)
}

/**
 * Render a path with forward slashes, which manifests use on every platform.
 * @param path - a platform-native relative path.
 * @returns the same path with POSIX separators.
 */
function toPosix(path: string): string {
  return path.split('\\').join('/')
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter(argument => argument !== '--'),
  options: {
    local: { type: 'boolean', default: false },
    npm: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

if (values.check) await check()
else if (values.npm) await useRegistry()
else if (values.local) {
  const checkout = positionals[0]
  if (checkout === undefined) throw new Error(`${PREFIX}: --local needs the path to a harness checkout.`)
  await useLocal(checkout)
}
else throw new Error(`${PREFIX}: pass --local <checkout>, --npm, or --check.`)
