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
 * The application's own version is part of the same pin. It names the harness
 * release inside it, `harness:npm` sets it, and `check:harness-pin` fails when
 * it drifts — so switching the release is one command rather than one command
 * plus a manifest edit somebody has to remember.
 *
 * Run: `pnpm run harness:local ../../deepseek-harness`, `pnpm run harness:npm`,
 * or `pnpm run check:harness-pin` to prove the pinned versions agree.
 * @module @omdsh-plugins/omdsh-desktop/scripts/harness-source
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

/** Where a package's published versions are read from. */
const REGISTRY = 'https://registry.npmjs.org'

/** How long the registry has to answer before the command gives up. */
const REGISTRY_TIMEOUT_MS = 15_000

/**
 * Order two releases the way semver does, so an update is never a downgrade.
 *
 * Hand-rolled rather than depended on, for the reason everything else here is:
 * this repository ships an application, and a build-time dependency to compare
 * two strings it already owns is a poor trade. The rules it implements are the
 * ones these versions actually use — numeric release parts, then an optional
 * dot-separated prerelease whose numeric identifiers compare numerically, and
 * where HAVING a prerelease sorts before not having one (`0.1.0-rc.6` is
 * behind `0.1.0`). Build metadata is ignored, which is what makes
 * `0.1.0-rc.6+1` neither ahead of nor behind `0.1.0-rc.6`.
 * @param left - one version.
 * @param right - the other.
 * @returns negative when left is older, positive when newer, zero when equal.
 */
export function compareReleases(left: string, right: string): number {
  const parse = (version: string): { release: number[]; pre: string[] } => {
    const [core = ''] = version.split('+')
    const dash = core.indexOf('-')
    const release = (dash === -1 ? core : core.slice(0, dash)).split('.').map(part => Number(part) || 0)
    return { release, pre: dash === -1 ? [] : core.slice(dash + 1).split('.') }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.release.length, b.release.length); index += 1) {
    const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0)
    if (difference !== 0) return difference
  }
  // A release with a prerelease is BEHIND the same release without one.
  if (a.pre.length === 0 !== (b.pre.length === 0)) return a.pre.length === 0 ? 1 : -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const one = a.pre[index]
    const other = b.pre[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const numeric = /^\d+$/u.test(one) && /^\d+$/u.test(other)
    if (numeric) return Number(one) - Number(other)
    return one < other ? -1 : 1
  }
  return 0
}

/**
 * Every version one package has published.
 *
 * The whole list, never the `latest` tag. `@deepseek-ai/dsh-host-apiproxy`
 * publishes `0.1.0-rc.6` while its `latest` still points at `0.0.1-rc.1`, so a
 * command that trusted the tag would answer that this application must
 * downgrade its API client by a minor version to stay in step. What matters is
 * whether a version EXISTS, and for the harness itself, which of them is
 * newest.
 * @param name - the package.
 * @returns its published versions, unordered.
 * @throws Error when the registry cannot be read.
 */
async function publishedVersions(name: string): Promise<string[]> {
  const url = `${REGISTRY}/${name.replace('/', '%2F')}`
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`${PREFIX}: could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`${PREFIX}: ${url} answered ${String(response.status)}.`)
  const document = await response.json() as { versions?: Record<string, unknown> }
  const versions = Object.keys(document.versions ?? {})
  if (versions.length === 0) throw new Error(`${PREFIX}: ${name} publishes no versions.`)
  return versions
}

/** Manifests whose version tracks the harness release, nearest the artifact first. */
const VERSIONED_MANIFESTS = ['app/package.json', 'package.json'] as const

/**
 * Whether the application may call itself this, given the release it ships.
 *
 * The version names the harness inside, because that is the question a person
 * holding the artifact has: `DeepSeek-Harness-0.1.0-rc.6-arm64.dmg` says which
 * runtime it is. Anything else has to be looked up.
 *
 * A `+<n>` build suffix is allowed and nothing else is. It is what a
 * desktop-only rebuild of the SAME harness is called — today's shims changed
 * the shell without touching the runtime — and semver ignores build metadata
 * for precedence, which is exactly right: `0.1.0-rc.6+1` is not a newer
 * release, it is the same one built again. A suffix that sorted would be a
 * claim this application is not entitled to make.
 * @param version - the manifest's version.
 * @param release - the harness release the catalog pins.
 * @returns true when the version names that release.
 */
export function versionNamesRelease(version: string, release: string): boolean {
  return version === release || new RegExp(`^${release.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\+\\d+$`, 'u').test(version)
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
  // The version comes with the pin rather than after it: switching the release
  // this application ships IS the occasion for its own version to change, and
  // a step somebody has to remember separately is the step that drifts.
  for (const manifest of VERSIONED_MANIFESTS) await setVersion(join(root, manifest), version)
  console.log(`${PREFIX}: building against the published ${HARNESS_PACKAGE}@${version}, and calling itself that`)
  console.log(`${PREFIX}: run 'pnpm install'.`)
}

/**
 * Rewrite one catalog entry in `pnpm-workspace.yaml`.
 *
 * Text surgery for the reason the catalog is read that way: the file is this
 * repository's own settings plus its comments explaining them, and rewriting it
 * through a YAML serializer to change two version strings would reformat the
 * explanations along with them.
 * @param name - the catalogued package.
 * @param version - the version to record.
 */
async function setCatalogVersion(name: string, version: string): Promise<void> {
  const path = join(root, 'pnpm-workspace.yaml')
  const text = await readFile(path, 'utf8')
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`^(\\s+'${escaped}':\\s*)(\\S+)(\\s*)$`, 'mu')
  if (!pattern.test(text)) throw new Error(`${PREFIX}: pnpm-workspace.yaml catalog does not pin ${name}.`)
  await writeFile(path, text.replace(pattern, `$1${version}$3`))
}

/**
 * Move to the newest harness the registry has, or report that one exists.
 *
 * The two catalogued packages move together or not at all. The harness decides
 * WHICH release that is; the API client only has to have published the same
 * one, and it is checked rather than assumed — a shell built against a client
 * from a different release is the kind of mismatch that compiles and then
 * misbehaves at a seam.
 *
 * Never a downgrade. `latest` is not consulted for either package, so a
 * mis-tagged upstream cannot walk this application backwards, and a pin that
 * is already ahead of everything published is reported rather than rewritten.
 * @param apply - false to report only, which is what a scheduled check wants.
 * @throws Error when the registry disagrees with itself or cannot be read.
 */
async function useLatest(apply: boolean): Promise<void> {
  const current = await catalogVersion(HARNESS_PACKAGE)
  const newest = (await publishedVersions(HARNESS_PACKAGE))
    .reduce((best, candidate) => (compareReleases(candidate, best) > 0 ? candidate : best))

  if (compareReleases(newest, current) <= 0) {
    console.log(`${PREFIX}: ${HARNESS_PACKAGE}@${current} is the newest published release; nothing to do.`)
    return
  }

  if (!(await publishedVersions(APIPROXY_PACKAGE)).includes(newest)) {
    throw new Error(
      `${PREFIX}: ${HARNESS_PACKAGE}@${newest} is published but ${APIPROXY_PACKAGE}@${newest} is not, `
      + 'and this application needs both at one release. Wait for it, or pin by hand if the mismatch is deliberate.',
    )
  }

  if (!apply) {
    throw new Error(`${PREFIX}: ${HARNESS_PACKAGE}@${newest} is published and this repository ships ${current}; run 'pnpm run harness:latest'.`)
  }

  for (const name of [HARNESS_PACKAGE, APIPROXY_PACKAGE]) await setCatalogVersion(name, newest)
  console.log(`${PREFIX}: moved the catalog from ${current} to ${newest}`)
  // The rest is what `harness:npm` already does — the runtime pin and the
  // application's own version — so it is called rather than repeated.
  await useRegistry()
}

/**
 * Prove the two manifests `harness:local` rewrites are both back on the pin.
 *
 * The two halves are held to DIFFERENT standards, and deliberately so.
 *
 * `runtime/package.json` is a deploy root: the packaging pipeline installs its
 * closure and nobody else ever resolves it, so a `link:` there is reported and
 * passes — the check exists to catch a drifted version, not to forbid local
 * development.
 *
 * `app/package.json` is source that `tsc` compiles. A `link:` committed there
 * is the silent failure CONVENTIONS rule 8 describes: pnpm resolves it against
 * the declaring manifest, so on any other machine it becomes a dangling
 * symlink, `install` reports success, and the build dies with TS2307 on every
 * harness import. That one fails.
 */
async function check(): Promise<void> {
  const app = await readManifest(join(root, 'app', 'package.json'))
  const apiproxy = app.devDependencies?.[APIPROXY_PACKAGE]
  if (apiproxy === undefined) throw new Error(`${PREFIX}: app/package.json does not depend on ${APIPROXY_PACKAGE}.`)
  if (apiproxy.startsWith('link:')) {
    throw new Error(
      `${PREFIX}: app/package.json links ${APIPROXY_PACKAGE} to a local checkout (${apiproxy}); `
      + "run 'pnpm run harness:npm' before committing.",
    )
  }

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
  console.log(`${PREFIX}: runtime and catalog both pin ${HARNESS_PACKAGE}@${version}, and app is on the catalog.`)

  // The version is checked last so a drifted PIN is reported first: a version
  // that names the wrong release is a symptom of that, and fixing the pin fixes
  // both.
  for (const manifest of VERSIONED_MANIFESTS) {
    const declared = (await readManifest(join(root, manifest)) as Manifest & { version?: string }).version
    if (declared === undefined) throw new Error(`${PREFIX}: ${manifest} declares no version.`)
    if (!versionNamesRelease(declared, version)) {
      throw new Error(
        `${PREFIX}: ${manifest} is ${declared} but this application ships ${HARNESS_PACKAGE}@${version}; `
        + `the artifact's name is what tells somebody which runtime is inside it. `
        + `Run 'pnpm run harness:npm' to set it, or name it ${version}+<n> for a rebuild of the same release.`,
      )
    }
  }
  console.log(`${PREFIX}: the application calls itself ${String((await readManifest(join(root, VERSIONED_MANIFESTS[0])) as Manifest & { version?: string }).version)}.`)
}

/**
 * Rewrite one manifest's version, leaving a build suffix behind.
 * @param path - absolute manifest path.
 * @param version - the release to name.
 */
async function setVersion(path: string, version: string): Promise<void> {
  const manifest = await readManifest(path) as Manifest & { version?: string }
  if (manifest.version === version) return
  manifest.version = version
  await writeManifest(path, manifest)
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

// Only when this file IS the program. A spec importing it for
// `versionNamesRelease` would otherwise run the CLI, which parses no flags and
// throws — the module would be untestable, and the rule it enforces is exactly
// the part worth a test.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: {
      local: { type: 'boolean', default: false },
      npm: { type: 'boolean', default: false },
      latest: { type: 'boolean', default: false },
      outdated: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  })

  if (values.check) await check()
  else if (values.outdated) await useLatest(false)
  else if (values.latest) await useLatest(true)
  else if (values.npm) await useRegistry()
  else if (values.local) {
    const checkout = positionals[0]
    if (checkout === undefined) throw new Error(`${PREFIX}: --local needs the path to a harness checkout.`)
    await useLocal(checkout)
  }
  else throw new Error(`${PREFIX}: pass --local <checkout>, --npm, --latest, --outdated, or --check.`)
}
