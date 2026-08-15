/**
 * Build the desktop application.
 *
 * The product is self-contained: the Electron shell, the Electron runtime, and
 * a deployed harness closure the shell supervises, with no dependency on a
 * checkout, a Node installation, or a package manager on the target machine.
 * The pipeline deploys that closure, proves it boots when the target is this
 * machine, packs the shell around it, and writes the installer — a disk image
 * on macOS, an NSIS setup on Windows. macOS additionally ad-hoc signs the
 * bundle, which packaging invalidates and Apple silicon requires.
 *
 * Windows can be packed from macOS: optional native packages are prebuilt, and
 * electron-builder's NSIS target does not need Wine. The boot smoke is skipped
 * when the target is not this machine, because a Windows Electron binary cannot
 * run here.
 *
 * Usage: `pnpm run package:desktop [-- --platform mac|win] [--arch arm64|x64]
 * [--out <dir>] [--skip-deploy] [--skip-smoke] [--skip-dmg] [--skip-installer]`
 *
 * Artifacts land in `dist-desktop/dist-mac` or `dist-desktop/dist-win`, one
 * directory per target, unless `--out` names another.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative as relativePath, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { RUNTIME_DIRECTORY, RUNTIME_ENTRY_RELATIVE } from '../app/src/paths.ts'
import { ReadinessScanner } from '../app/src/readiness.ts'
import { localRuntimeLaunch } from '../app/src/runtime-launch.ts'
import { defaultHeapLimitMb } from '../app/src/resource-governor.ts'
import { runCommand } from './run-command.ts'
import { installRuntimeClosure } from './runtime-closure.ts'
import { readRuntimePin } from './runtime-pin.ts'
import { createDiskImage } from './macos-disk-image.ts'

const root = resolve(import.meta.dirname, '..')

/** Diagnostic prefix on this script's logs and errors. */
const PREFIX = 'package-desktop-app'

/** Reverse-DNS bundle id. Unsigned, so it only has to be stable and distinct from the browser launcher's. */
const APP_ID = 'ai.deepseek.dsh.desktop'

/** Bundle, volume, and shortcut name. */
const PRODUCT_NAME = 'DeepSeek Harness'

/** Basename of installers, which carries no spaces. */
const PRODUCT_SLUG = 'DeepSeek-Harness'

/** Workspace directory of the Electron shell; also electron-builder's project directory. */
const DESKTOP_DIR = 'app'

/**
 * Root holding every target's artifacts. Each target gets its own directory
 * under it, because the closure, the packed application, and the installer are
 * all platform-specific and a shared directory would have one build's natives
 * and staged closure standing where the next build looks for its own.
 */
const DEFAULT_OUTPUT = 'dist-desktop'

/** Frontend dist inside the deployed closure; the web bundle refuses to activate without it. */
const RUNTIME_FRONTEND = 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'

/** Build outputs the shell needs before anything is packed. */
const REQUIRED_ARTIFACTS = [`${DESKTOP_DIR}/lib/main.mjs`, `${DESKTOP_DIR}/resources/boot.html`]

/** Icon artwork; electron-builder renders the macOS icon set from this square PNG. */
const MAC_ICON = 'assets/macos-app-icon.png'

/** Windows icon; the filled canvas is committed because packaging has no rasterizer. */
const WIN_ICON = 'assets/windows-app-icon.ico'

/**
 * NSIS include that replaces electron-builder's check for a running
 * application, whose budget and single-process kills this application outlives.
 */
const NSIS_CLOSE_APP_INCLUDE = `${DESKTOP_DIR}/build/close-app-processes.nsh`

/** Oldest macOS the bundle declares support for, matching the browser launcher. */
const MINIMUM_SYSTEM_VERSION = '13.0'

/** How long the closure has to print its URL line before the smoke run fails. */
const SMOKE_TIMEOUT_MS = 180_000

/** Architectures this packager builds for. */
const ARCHES = ['arm64', 'x64'] as const
type Arch = (typeof ARCHES)[number]

/** Operating systems this packager builds for. */
const PLATFORMS = ['mac', 'win'] as const
type Platform = (typeof PLATFORMS)[number]

/**
 * Directories inside the closure that only a build needs, removed so the
 * bundle ships the runtime rather than the material for rebuilding it.
 */
const PRUNE_PATHS = [
  'node_modules/node-pty/deps',
  'node_modules/node-pty/src',
  'node_modules/node-pty/third_party',
  'node_modules/node-pty/binding.gyp',
]

/**
 * Filename suffixes nothing in the closure can load.
 *
 * The closure ships no TypeScript toolchain, so declarations and sources are
 * build material: Node never reads the `types` export condition, and the
 * windows-acl runner reaches its source through `tsx` only when the built
 * `lib/runner.js` is absent, which packaging always provides. Source maps go
 * with them because the sources they point at are gone.
 *
 * Windows installs are paced by per-file work — extraction, and the
 * on-access scan of each written file — far more than by total bytes, so
 * removing files matters even where they are individually small.
 */
const PRUNE_SUFFIXES = ['.map', '.ts', '.mts', '.cts']

/**
 * Documentation stems, matched case-insensitively against a Markdown file's
 * name before its extension, either whole or before a `.`, `-`, or `_`.
 *
 * Markdown outside this list stays: skills and badge bodies are runtime data
 * the harness reads out of the closure, not documentation.
 */
const PRUNE_DOC_STEMS = [
  'readme',
  'changelog',
  'history',
  'contributing',
  'security',
  'code_of_conduct',
  'upgrading',
  'migration',
  'governance',
  'authors',
  'notice',
]

/**
 * Directory names whose subtrees hold runtime data, exempt from documentation
 * pruning. The skill loader reads every `.md` under a skill directory, so a
 * documentation stem there names a skill rather than a document.
 */
const RUNTIME_DATA_DIRECTORIES = ['config', 'assets']

/**
 * Narrow a raw `--arch` value.
 * @param value - the flag value.
 * @returns the architecture.
 */
function parseArch(value: string): Arch {
  if ((ARCHES as readonly string[]).includes(value)) return value as Arch
  throw new Error(`${PREFIX}: --arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(value)}.`)
}

/**
 * Narrow a raw `--platform` value.
 * @param value - the flag value.
 * @returns the packaging platform.
 */
function parsePlatform(value: string): Platform {
  if (value === 'mac' || value === 'darwin' || value === 'macos') return 'mac'
  if (value === 'win' || value === 'win32' || value === 'windows') return 'win'
  throw new Error(`${PREFIX}: --platform must be one of mac, win, got ${JSON.stringify(value)}.`)
}

/**
 * The packaging platform for this machine.
 * @returns mac or win.
 */
function hostPlatform(): Platform {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'win32') return 'win'
  throw new Error(`${PREFIX}: host ${process.platform} cannot package the desktop application.`)
}

/**
 * Default CPU for a target. Windows defaults to x64 even on Apple silicon,
 * which is the machine almost every Windows install is.
 * @param platform - the packaging platform.
 * @returns the architecture.
 */
function defaultArch(platform: Platform): Arch {
  if (platform === 'win') return 'x64'
  return process.arch === 'x64' ? 'x64' : 'arm64'
}

/**
 * Default output directory for a target, one per platform under
 * {@link DEFAULT_OUTPUT}. An explicit `--out` is taken verbatim: a caller
 * naming a directory means that directory, not a parent to nest under.
 * @param platform - the packaging platform.
 * @returns the directory, relative to this repository.
 */
function defaultOutput(platform: Platform): string {
  return join(DEFAULT_OUTPUT, platform === 'mac' ? 'dist-mac' : 'dist-win')
}

/**
 * Optional native packages the target OS loads at runtime, taken from the
 * manifests already in the closure so the versions match what deploy resolved.
 * @param staging - the deployed closure.
 * @param platform - the packaging platform.
 * @param arch - the architecture.
 * @returns `name@version` specs to fetch.
 */
async function targetNativeSpecs(staging: string, platform: Platform, arch: Arch): Promise<string[]> {
  const needle = `${platform === 'mac' ? 'darwin' : 'win32'}-${arch}`
  const specs: string[] = []
  for (const relative of ['node_modules/koffi/package.json', 'node_modules/sharp/package.json', 'node_modules/node-addon-require-builtin/package.json']) {
    const manifestPath = join(staging, relative)
    if (!existsSync(manifestPath)) continue
    const manifest = await readJson(manifestPath)
    const optionals = manifest.optionalDependencies
    if (optionals === undefined || typeof optionals !== 'object' || optionals === null) continue
    for (const [name, version] of Object.entries(optionals)) {
      if (typeof version === 'string' && name.includes(needle)) specs.push(`${name}@${version}`)
    }
  }
  return specs
}

/**
 * Destination directory for one npm package name under the closure.
 * @param staging - the deployed closure.
 * @param name - bare package name, including scope.
 * @returns the directory `node_modules` will use for it.
 */
function nativePackageDir(staging: string, name: string): string {
  return join(staging, 'node_modules', ...name.split('/'))
}

/**
 * Fetch the target OS's optional native packages into a closure that was
 * deployed on this machine. `pnpm deploy` installs the host's optionals even
 * when `supportedArchitectures` is set, so a Windows closure built on macOS
 * would otherwise ship darwin `koffi` and `sharp`.
 * @param staging - the deployed closure.
 * @param platform - the packaging platform.
 * @param arch - the architecture.
 */
async function installTargetNatives(staging: string, platform: Platform, arch: Arch): Promise<void> {
  const os = platform === 'mac' ? 'darwin' : 'win32'
  if (process.platform === os && process.arch === arch) return
  const specs = await targetNativeSpecs(staging, platform, arch)
  if (specs.length === 0) {
    throw new Error(`${PREFIX}: no optional native packages matching ${os}-${arch} in the deployed closure.`)
  }
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-desktop-natives-'))
  try {
    for (const spec of specs) {
      const name = spec.slice(0, spec.lastIndexOf('@'))
      const dest = nativePackageDir(staging, name)
      await runCommand({
        label: `pack ${spec}`,
        command: 'npm',
        args: ['pack', spec, '--pack-destination', tmp],
        cwd: tmp,
        prefix: PREFIX,
        dryRun: false,
      })
      const tarballs = (await readdir(tmp)).filter(entry => entry.endsWith('.tgz'))
      if (tarballs.length !== 1 || tarballs[0] === undefined) {
        throw new Error(`${PREFIX}: npm pack ${spec} produced ${String(tarballs.length)} tarball(s).`)
      }
      await mkdir(dest, { recursive: true })
      const tar = spawnSync('tar', ['-xzf', join(tmp, tarballs[0]), '-C', dest, '--strip-components', '1'], { encoding: 'utf8' })
      if (tar.status !== 0) {
        throw new Error(`${PREFIX}: extracting ${tarballs[0]} failed\n${tar.stdout}${tar.stderr}`)
      }
      await rm(join(tmp, tarballs[0]), { force: true })
      console.log(`${PREFIX}: installed ${spec}`)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * Drop optional native packages that belong to another OS or CPU.
 * @param staging - the deployed closure.
 * @param platform - the packaging platform.
 * @param arch - the architecture.
 */
async function pruneForeignNatives(staging: string, platform: Platform, arch: Arch): Promise<void> {
  const keep = `${platform === 'mac' ? 'darwin' : 'win32'}-${arch}`
  const parents = [
    join(staging, 'node_modules/@koromix'),
    join(staging, 'node_modules/@img'),
    join(staging, 'node_modules'),
  ]
  for (const parent of parents) {
    if (!existsSync(parent)) continue
    for (const entry of await readdir(parent)) {
      const isNative = entry.startsWith('koffi-')
        || entry.startsWith('sharp-')
        || entry.startsWith('sharp-libvips-')
        || entry.startsWith('node-addon-require-builtin-')
      if (!isNative) continue
      if (entry.includes(keep)) continue
      await rm(join(parent, entry), { recursive: true, force: true })
    }
  }
}

/**
 * Whether this machine can boot the target Electron / closure pair.
 * @param platform - the packaging platform.
 * @param arch - the architecture.
 * @returns true only when both match the host.
 */
function canSmoke(platform: Platform, arch: Arch): boolean {
  const host = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : undefined
  return host === platform && (process.arch === 'x64' || process.arch === 'arm64') && process.arch === arch
}

/**
 * `node-pty` prebuild directory name for a target.
 * @param platform - the packaging platform.
 * @param arch - the architecture.
 * @returns the directory under `prebuilds/`.
 */
function ptyPrebuild(platform: Platform, arch: Arch): string {
  return `${platform === 'mac' ? 'darwin' : 'win32'}-${arch}`
}

/**
 * Native trees the shipped closure must contain. Missing ones mean the
 * Windows (or foreign-arch) optional packages never installed.
 * @param platform - the packaging platform.
 * @param arch - the architecture.
 * @returns paths relative to the closure root.
 */
function nativeMarkers(platform: Platform, arch: Arch): string[] {
  const os = platform === 'mac' ? 'darwin' : 'win32'
  return [
    `node_modules/node-pty/prebuilds/${os}-${arch}`,
    `node_modules/@koromix/koffi-${os}-${arch}`,
    `node_modules/@img/sharp-${os}-${arch}`,
  ]
}

/**
 * electron-builder's `--x64` / `--arm64` flag.
 * @param arch - the architecture.
 * @returns the flag.
 */
function archFlag(arch: Arch): string {
  return arch === 'x64' ? '--x64' : '--arm64'
}

/**
 * Read one JSON manifest.
 * @param path - absolute path.
 * @returns the parsed object.
 */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

/**
 * Number of files in a directory tree, which is what paces a Windows install.
 * @param directory - the tree to count.
 * @returns its file count.
 */
async function treeFileCount(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += 1
  }
  return total
}

/**
 * Total size of a directory tree.
 * @param directory - the tree to measure.
 * @returns its size in bytes.
 */
async function treeSize(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    try {
      total += (await stat(join(entry.parentPath, entry.name))).size
    } catch {
      // A file removed between listing and measuring contributes nothing.
    }
  }
  return total
}

/**
 * Whether one Markdown file is documentation rather than runtime data.
 * @param name - the file's basename.
 * @param directory - the absolute directory holding it.
 * @param staging - the deployed closure, which bounds the directory walk.
 * @returns true when the file is documentation and can be dropped.
 */
function isPrunableDocument(name: string, directory: string, staging: string): boolean {
  const lowered = name.toLowerCase()
  if (!lowered.endsWith('.md')) return false
  const stem = lowered.slice(0, -'.md'.length)
  const isDocumentStem = PRUNE_DOC_STEMS.some(doc =>
    stem === doc || doc.length < stem.length && stem.startsWith(doc) && '.-_'.includes(stem[doc.length] ?? ''))
  if (!isDocumentStem) return false
  const inside = relativePath(staging, directory)
  return !inside.split(sep).some(segment => RUNTIME_DATA_DIRECTORIES.includes(segment))
}

/**
 * Remove every empty directory under one tree, deepest first so a directory
 * emptied by its own children goes in the same pass.
 * @param root - the tree to compact.
 */
async function removeEmptyDirectories(root: string): Promise<void> {
  const directories: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) directories.push(join(entry.parentPath, entry.name))
  }
  directories.sort((left, right) => right.split(sep).length - left.split(sep).length)
  for (const directory of directories) {
    try {
      await rmdir(directory)
    } catch {
      // The directory still holds something, so it stays; nothing else removes directories here.
    }
  }
}

/**
 * Remove the build-only material and every foreign-platform native prebuild
 * from the deployed closure.
 * @param staging - the deployed closure.
 * @param platform - the packaging platform.
 * @param arch - the architecture being packaged.
 */
async function pruneClosure(staging: string, platform: Platform, arch: Arch): Promise<void> {
  const before = await treeSize(staging)
  const beforeFiles = await treeFileCount(staging)
  for (const relative of PRUNE_PATHS) await rm(join(staging, relative), { recursive: true, force: true })
  const prebuilds = join(staging, 'node_modules/node-pty/prebuilds')
  if (existsSync(prebuilds)) {
    const keep = ptyPrebuild(platform, arch)
    for (const entry of await readdir(prebuilds)) {
      if (entry !== keep) await rm(join(prebuilds, entry), { recursive: true, force: true })
    }
  }
  for (const entry of await readdir(staging, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const prunable = PRUNE_SUFFIXES.some(suffix => entry.name.endsWith(suffix))
      || isPrunableDocument(entry.name, entry.parentPath, staging)
    if (prunable) await rm(join(entry.parentPath, entry.name), { force: true })
  }
  await removeEmptyDirectories(staging)
  const after = await treeSize(staging)
  const afterFiles = await treeFileCount(staging)
  console.log(`${PREFIX}: pruned the closure from ${formatMib(before)} to ${formatMib(after)}`)
  console.log(`${PREFIX}: pruned the closure from ${String(beforeFiles)} to ${String(afterFiles)} files`)
}

/**
 * Render a byte count for logs.
 * @param bytes - the count.
 * @returns the count in MiB, one decimal.
 */
function formatMib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * Boot the deployed closure exactly as the shipped shell will, and prove it
 * serves the UI.
 *
 * This is the packaging gate that a static check cannot replace: peers missing
 * from the deploy root, a vendored package the overrides left behind, and a
 * frontend dist that never got built all surface only when the tree boots.
 * @param staging - the deployed closure.
 * @param electronBinary - the Electron binary, run in Node mode.
 */
async function smokeClosure(staging: string, electronBinary: string): Promise<void> {
  const entry = join(staging, RUNTIME_ENTRY_RELATIVE)
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-smoke-'))
  console.log(`${PREFIX}: smoke: booting the closure under ${electronBinary}`)
  const launch = localRuntimeLaunch({ entry, nodePath: electronBinary, maxOldSpaceMb: defaultHeapLimitMb() })
  const child = spawn(launch.command, [...launch.args], {
    cwd: home,
    env: { ...process.env, ...launch.env, DSH_HOME: home },
    // The local launch ignores stdin; naming it here keeps the pipes typed.
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const exited = new Promise<void>((resolveExit) => { child.once('exit', () => { resolveExit() }) })
  try {
    const scanner = new ReadinessScanner()
    const url = await new Promise<string>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${PREFIX}: the closure did not report a URL within ${String(SMOKE_TIMEOUT_MS)}ms:\n${output}`))
      }, SMOKE_TIMEOUT_MS)
      const consume = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        output += text
        const found = scanner.push(text)
        if (found === undefined) return
        clearTimeout(timer)
        resolvePromise(found)
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`${PREFIX}: the closure exited with code ${String(code)} before serving:\n${output}`))
      })
    })
    const response = await probeLoopback(url).catch((error: unknown) => {
      const state = child.exitCode === null ? 'still running' : `exited with code ${String(child.exitCode)}`
      throw new Error(`${PREFIX}: ${url} did not answer (${error instanceof Error ? error.message : String(error)}); the runtime is ${state}:\n${output}`)
    })
    if (response.status !== 200 || !response.body.includes('id="root"')) {
      throw new Error(`${PREFIX}: ${url} answered ${String(response.status)} without the application shell.`)
    }
    console.log(`${PREFIX}: smoke: ${url} served the application shell`)
  } finally {
    child.kill('SIGTERM')
    // The runtime disposes its plugin tree on the signal; removing its home
    // underneath that teardown would report failures the packaging did not cause.
    await exited
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * Refuse to package a shell bundle older than the source it was built from.
 *
 * The bundle, not the sources, is what runs in the application, so a stale one
 * ships behavior nobody wrote and no later step can detect — the packaging
 * smoke boots the runtime closure, which the shell bundle is not part of.
 */
async function assertShellBundleCurrent(): Promise<void> {
  const bundle = (await stat(join(root, DESKTOP_DIR, 'lib/main.mjs'))).mtimeMs
  const sources = join(root, DESKTOP_DIR, 'src')
  for (const entry of await readdir(sources, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if ((await stat(join(entry.parentPath, entry.name))).mtimeMs <= bundle) continue
    throw new Error(`${PREFIX}: ${DESKTOP_DIR}/lib/main.mjs is older than ${entry.name} — run 'pnpm run build' first.`)
  }
}

/**
 * Read one loopback URL.
 *
 * `node:http` rather than `fetch`, because a developer machine commonly
 * exports proxy variables and the check must reach the local runtime rather
 * than whatever a proxy answers for it.
 * @param url - the URL to read.
 * @returns the status and body.
 */
async function probeLoopback(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpGet(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => { resolvePromise({ status: response.statusCode ?? 0, body }) })
    })
    request.once('error', reject)
  })
}

/**
 * Locate the unpacked application electron-builder produced.
 * @param outputDir - electron-builder's output directory.
 * @param platform - the packaging platform.
 * @param arch - the architecture.
 * @returns the `.app` bundle or the `win-unpacked` directory.
 */
async function findPackedApp(outputDir: string, platform: Platform, arch: Arch): Promise<string> {
  if (platform === 'mac') {
    for (const entry of await readdir(outputDir, { withFileTypes: true, recursive: true })) {
      if (entry.isDirectory() && entry.name.endsWith('.app')) return join(entry.parentPath, entry.name)
    }
    throw new Error(`${PREFIX}: no .app bundle under ${outputDir}.`)
  }
  const unpacked = arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`
  const candidate = join(outputDir, unpacked)
  if (existsSync(candidate)) return candidate
  throw new Error(`${PREFIX}: no ${unpacked} directory under ${outputDir}.`)
}

/**
 * Electron `resources` directory inside a packed application.
 * @param appPath - the `.app` bundle or the Windows unpacked directory.
 * @param platform - the packaging platform.
 * @returns the resources directory.
 */
function resourcesDirectory(appPath: string, platform: Platform): string {
  return platform === 'mac' ? join(appPath, 'Contents', 'Resources') : join(appPath, 'resources')
}

/**
 * Apply an ad-hoc signature to the packed macOS bundle.
 *
 * Packaging rewrites the Electron binary's identity and layout, which
 * invalidates the signature it shipped with. On Apple silicon an invalid
 * signature is fatal at launch, so the bundle is re-signed with the ad-hoc
 * identity — enough to run locally, and not a distribution signature.
 * @param appPath - the packed bundle.
 */
function signAdHoc(appPath: string): void {
  const result = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${PREFIX}: codesign exited ${String(result.status)}\n${result.stdout}${result.stderr}`)
  }
  const verify = spawnSync('codesign', ['--verify', '--strict', appPath], { encoding: 'utf8' })
  if (verify.status !== 0) {
    throw new Error(`${PREFIX}: the ad-hoc signature did not verify\n${verify.stdout}${verify.stderr}`)
  }
}

/**
 * electron-builder configuration for one target.
 * @param electronVersion - the Electron version installed in `app`.
 * @param appOutput - electron-builder's output directory.
 * @param platform - the packaging platform.
 * @param arch - the architecture.
 * @returns the configuration object.
 */
function builderConfigObject(
  electronVersion: string,
  appOutput: string,
  platform: Platform,
  arch: Arch,
): Record<string, unknown> {
  const shared = {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    electronVersion,
    // The harness is ES modules with dynamic imports and native addons, and an
    // archive serves neither: Electron's loader cannot import ES modules from
    // inside one, and a native addon has to exist as a file to be loaded.
    asar: false,
    npmRebuild: false,
    buildDependenciesFromSource: false,
    forceCodeSigning: false,
    directories: { output: appOutput },
    files: ['lib/*.mjs', 'resources/**', 'package.json'],
  }
  if (platform === 'mac') {
    return {
      ...shared,
      mac: {
        category: 'public.app-category.developer-tools',
        target: [{ target: 'dir', arch: [arch] }],
        icon: join(root, MAC_ICON),
        minimumSystemVersion: MINIMUM_SYSTEM_VERSION,
        // Signing is this script's own step; electron-builder must not attempt
        // to discover a Developer ID it will not find.
        identity: null,
      },
    }
  }
  return {
    ...shared,
    win: {
      target: [{ target: 'dir', arch: [arch] }],
      icon: join(root, WIN_ICON),
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: PRODUCT_NAME,
      artifactName: `${PRODUCT_SLUG}-\${version}-\${arch}-setup.\${ext}`,
      include: join(root, NSIS_CLOSE_APP_INCLUDE),
    },
  }
}

/** Environment that stops electron-builder looking for a code-signing identity. */
const BUILDER_ENV = { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }

/**
 * Find the NSIS setup electron-builder wrote.
 * @param directory - electron-builder's output directory.
 * @returns the setup path.
 */
async function findSetupExe(directory: string): Promise<string> {
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('-setup.exe')) return join(entry.parentPath, entry.name)
  }
  throw new Error(`${PREFIX}: no NSIS -setup.exe under ${directory}.`)
}

/** Run the pipeline. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter(arg => arg !== '--'),
    options: {
      platform: { type: 'string' },
      arch: { type: 'string' },
      out: { type: 'string' },
      'skip-deploy': { type: 'boolean', default: false },
      'skip-smoke': { type: 'boolean', default: false },
      'skip-dmg': { type: 'boolean', default: false },
      'skip-installer': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const platform = values.platform === undefined ? hostPlatform() : parsePlatform(values.platform)
  const arch = values.arch === undefined ? defaultArch(platform) : parseArch(values.arch)
  if (platform === 'mac' && process.platform !== 'darwin') {
    throw new Error(`${PREFIX}: macOS builds on macOS only, ran on ${process.platform}.`)
  }
  if (platform === 'win' && process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(`${PREFIX}: Windows builds on macOS or Windows, ran on ${process.platform}.`)
  }

  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!existsSync(join(root, artifact))) throw new Error(`${PREFIX}: missing ${artifact} — run 'pnpm run build' first.`)
  }
  if (platform === 'win' && !existsSync(join(root, NSIS_CLOSE_APP_INCLUDE))) {
    throw new Error(`${PREFIX}: missing ${NSIS_CLOSE_APP_INCLUDE}, which the NSIS setup needs to close a running application.`)
  }
  await assertShellBundleCurrent()

  const outputDir = resolve(root, values.out ?? defaultOutput(platform))
  const staging = join(outputDir, 'runtime')
  const appOutput = join(outputDir, 'app')
  await mkdir(outputDir, { recursive: true })

  const desktopRequire = createRequire(join(root, DESKTOP_DIR, 'package.json'))
  const electronBinary = desktopRequire('electron') as string
  const electronVersion = (await readJson(join(root, DESKTOP_DIR, 'node_modules/electron/package.json'))).version
  const version = (await readJson(join(root, DESKTOP_DIR, 'package.json'))).version

  if (values['skip-deploy']) console.log(`${PREFIX}: reusing the closure at ${staging} (--skip-deploy)`)
  else {
    const pin = await readRuntimePin(root)
    console.log(`${PREFIX}: embedding the harness runtime ${pin.release}`)
    await installRuntimeClosure({
      staging,
      dependencies: pin.dependencies,
      ...pin.pnpm !== undefined && { pnpm: pin.pnpm },
      protect: root,
      prefix: PREFIX,
      dryRun: false,
    })
    await pruneClosure(staging, platform, arch)
  }
  await installTargetNatives(staging, platform, arch)
  await pruneForeignNatives(staging, platform, arch)
  for (const required of [RUNTIME_ENTRY_RELATIVE, RUNTIME_FRONTEND]) {
    if (!existsSync(join(staging, required))) throw new Error(`${PREFIX}: the deployed closure is missing ${required}.`)
  }
  for (const marker of nativeMarkers(platform, arch)) {
    if (!existsSync(join(staging, marker))) {
      throw new Error(`${PREFIX}: the deployed closure is missing ${marker}; pnpm did not install ${platform}/${arch} native packages.`)
    }
  }

  if (values['skip-smoke']) console.log(`${PREFIX}: skipping the closure boot smoke (--skip-smoke)`)
  else if (!canSmoke(platform, arch)) {
    console.log(`${PREFIX}: skipping the closure boot smoke (${platform}-${arch} cannot run on ${process.platform}-${process.arch})`)
  }
  else await smokeClosure(staging, electronBinary)

  const builderConfig = join(outputDir, 'electron-builder.json')
  await writeFile(builderConfig, `${JSON.stringify(builderConfigObject(String(electronVersion), appOutput, platform, arch), undefined, 2)}\n`)

  const builder = join(root, DESKTOP_DIR, 'node_modules/.bin/electron-builder')
  await runCommand({
    label: 'electron-builder',
    command: builder,
    // Never publish: the build runs with CI set, which electron-builder
    // otherwise reads as a request to upload the artifact.
    args: [platform === 'mac' ? '--mac' : '--win', '--dir', archFlag(arch), '--publish', 'never', '--config', builderConfig],
    cwd: join(root, DESKTOP_DIR),
    prefix: PREFIX,
    dryRun: false,
    extraEnv: BUILDER_ENV,
  })

  const appPath = await findPackedApp(appOutput, platform, arch)
  // The closure is staged after packing, not through electron-builder's
  // resource copying, which applies its own filters to the tree it copies and
  // dropped the closure's `node_modules` on the way in. Signing follows on
  // macOS, so the staged bytes are covered by the signature.
  const staged = join(resourcesDirectory(appPath, platform), RUNTIME_DIRECTORY)
  await rm(staged, { recursive: true, force: true })
  await cp(staging, staged, { recursive: true, preserveTimestamps: true })
  if (!existsSync(join(staged, RUNTIME_ENTRY_RELATIVE))) throw new Error(`${PREFIX}: staging the closure did not produce ${RUNTIME_ENTRY_RELATIVE}.`)
  if (platform === 'mac') signAdHoc(appPath)
  console.log(`${PREFIX}: app: ${appPath} (${formatMib(await treeSize(appPath))})`)

  if (platform === 'mac') {
    if (values['skip-dmg']) return
    const dmgPath = join(outputDir, `${PRODUCT_SLUG}-${String(version)}-${arch}.dmg`)
    await createDiskImage({ appPath, volumeName: PRODUCT_NAME, dmgPath })
    console.log(`${PREFIX}: dmg: ${dmgPath} (${formatMib((await stat(dmgPath)).size)})`)
    return
  }
  if (values['skip-installer']) return
  await runCommand({
    label: 'nsis',
    command: builder,
    args: ['--prepackaged', appPath, '--win', 'nsis', archFlag(arch), '--publish', 'never', '--config', builderConfig],
    cwd: join(root, DESKTOP_DIR),
    prefix: PREFIX,
    dryRun: false,
    extraEnv: BUILDER_ENV,
  })
  const produced = await findSetupExe(appOutput)
  const setupPath = join(outputDir, `${PRODUCT_SLUG}-${String(version)}-${arch}-setup.exe`)
  if (produced !== setupPath) await rename(produced, setupPath)
  console.log(`${PREFIX}: setup: ${setupPath} (${formatMib((await stat(setupPath)).size)})`)
}

await main()
