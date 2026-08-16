/**
 * Materialize the harness runtime the application embeds.
 *
 * The product ships a self-contained backend: `Resources/backend` is an
 * ordinary `node_modules` tree the Electron binary runs `@deepseek-ai/dsh`'s
 * `lib/bin.js` out of, with no package manager, Node installation, or checkout
 * on the target machine. This module is what produces that tree.
 *
 * It installs OUTSIDE this repository's workspace, and deliberately so. The
 * staging directory is given a `pnpm-workspace.yaml` of its own declaring
 * `packages: []`, which makes it a workspace root with no members: pnpm stops
 * walking up, the desktop workspace's catalog and lockfile never apply, and the
 * closure resolves purely from the registry. That is the same reason
 * `runtime/package.json` restates the harness version literally instead of
 * naming a catalog entry — see this repository's `pnpm-workspace.yaml`, and
 * `pnpm run check:harness-pin`, which proves the two agree.
 *
 * The tree is installed with the hoisted node linker, because it has to survive
 * being copied into an `.app` bundle: pnpm's default layout is a symlink farm
 * pointing into a store that will not be there.
 * @module @omdsh-plugins/omdsh-desktop/scripts/runtime-closure
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { runCommand } from './run-command.ts'

/** The closure's command directory, relative to its root. */
export const CLOSURE_BIN_RELATIVE = 'node_modules/.bin'

/** The published Win32 folder-dialog worker that needs the rc.6 IPC lifecycle fix. */
export const DIRECTORY_PICKER_WORKER_RELATIVE = 'node_modules/@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs'

/**
 * Repair the rc.6 worker's premature IPC disconnect.
 *
 * The worker first posts a non-terminal `showing` message. The published build
 * disconnects after every post, so that first acknowledgement triggers its own
 * disconnect handler and exits the process while the dialog is still open.
 * Keep the channel alive for `showing` and disconnect only after `done` or
 * `error`. Already-fixed input is returned unchanged; unfamiliar input fails
 * loudly so a future upstream rewrite cannot silently reintroduce the broken
 * installer payload.
 * @param source - published `worker.cjs` contents.
 * @returns worker contents with the terminal-message lifecycle applied.
 */
export function patchDirectoryPickerWorkerSource(source: string): string {
  let patched = source
  const unsafeStringDecode = [
    '\tconst bytes = Buffer.from(koffi.view(address, 32768));',
    '\tlet end = 0;',
    '\twhile (end + 1 < bytes.length && bytes[end] !== 0) end += 2;',
    '\treturn bytes.toString("utf16le", 0, end);',
  ].join('\n')
  if (!patched.includes('return koffi.decode.string16(address);')) {
    if (!patched.includes(unsafeStringDecode)) {
      throw new Error('the directory-picker worker no longer matches the reviewed rc.6 string decoder; update its packaging patch')
    }
    // A fixed 32 KiB view can cross the COM allocation's readable pages and
    // fatally abort Electron. Koffi's NUL-terminated decoder reads only the
    // WCHAR string, exactly matching SIGDN_FILESYSPATH's contract.
    patched = patched.replace(unsafeStringDecode, '\treturn koffi.decode.string16(address);')
  }

  if (patched.includes('if (terminal && process.connected) process.disconnect();')) return patched

  const lifecycleReplacements = [
    ['const post = (message) => {', 'const post = (message, terminal = false) => {'],
    ['if (process.connected) process.disconnect();', 'if (terminal && process.connected) process.disconnect();'],
    ['\n\t\t});\n\t} catch (error) {', '\n\t\t}, true);\n\t} catch (error) {'],
    ['\n\t\t});\n\t}\n})();\n//#endregion', '\n\t\t}, true);\n\t}\n})();\n//#endregion'],
  ] as const

  for (const [before, after] of lifecycleReplacements) {
    if (!patched.includes(before)) {
      throw new Error('the directory-picker worker no longer matches the reviewed rc.6 lifecycle; update its packaging patch')
    }
    patched = patched.replace(before, after)
  }
  return patched
}

/**
 * Apply and verify the Windows folder-dialog lifecycle repair in a staged
 * runtime closure.
 * @param staging - closure root.
 * @param prefix - diagnostic prefix for packaging failures.
 */
export async function patchDirectoryPickerWorker(staging: string, prefix: string): Promise<void> {
  const path = join(staging, DIRECTORY_PICKER_WORKER_RELATIVE)
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(`${prefix}: the deployed closure is missing ${DIRECTORY_PICKER_WORKER_RELATIVE}.`, { cause: error })
  }
  const patched = patchDirectoryPickerWorkerSource(source)
  if (patched !== source) await writeFile(path, patched)
}

/** The pnpm entry inside the closure, relative to {@link CLOSURE_BIN_RELATIVE}. */
const PNPM_ENTRY_FROM_BIN = { win: '..\\pnpm\\bin\\pnpm.mjs', mac: '../pnpm/bin/pnpm.mjs' } as const

/**
 * The application binary, relative to the closure's `.bin`.
 *
 * Four levels of `..` on both platforms — `.bin` → `node_modules` → `backend`
 * → `Resources` — and then they diverge: `electron-builder` puts the Windows
 * executable at the root it lands in, and the macOS one under `MacOS/` inside
 * `Contents`. Fixed by that layout rather than discovered, because the shims
 * are written into the staged closure before the closure is copied into it.
 * @param platform - the packaging platform.
 * @param productName - the product name both artifacts are built around.
 * @returns the relative path, in that platform's separators.
 */
export function launcherFromBin(platform: 'mac' | 'win', productName: string): string {
  return platform === 'win'
    ? `..\\..\\..\\..\\${productName}.exe`
    : `../../../../MacOS/${productName}`
}

/** One command written into a staged closure. */
interface ClosureShim {
  /** Filename inside `.bin`. */
  readonly name: string
  /** File contents. */
  readonly body: string
  /** File mode; the POSIX shims have to be executable. */
  readonly mode: number
}

/**
 * The POSIX `node` shim: a shell script, because the thing that looks `node`
 * up is a `#!/usr/bin/env node` line and what it finds has to be executable.
 * @param launcher - the application binary, relative to `.bin`.
 * @returns the script.
 */
export function posixNodeShim(launcher: string): string {
  return [
    '#!/bin/sh',
    '# Generated by scripts/runtime-closure.ts. The bundle ships no node; the',
    '# runtime is this application run with ELECTRON_RUN_AS_NODE, and so is this.',
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `exec "$(dirname "$0")/${launcher}" "$@"`,
    '',
  ].join('\n')
}

/**
 * A Windows command shim that runs one script under the application binary.
 * @param launcher - the application binary, relative to `.bin`.
 * @param script - the script to run, relative to `.bin`; omitted for `node`,
 * whose arguments already name one.
 * @returns the shim, CRLF-terminated as a batch file should be.
 */
export function windowsShim(launcher: string, script?: string): string {
  const target = script === undefined ? '' : ` "%~dp0${script}"`
  return [
    '@ECHO off',
    'REM Generated by scripts/runtime-closure.ts. The bundle ships no node, and a',
    'REM closure cross-built from macOS carries POSIX symlinks Windows cannot run.',
    'SETLOCAL',
    'SET "ELECTRON_RUN_AS_NODE=1"',
    `"%~dp0${launcher}"${target} %*`,
    'ENDLOCAL & EXIT /B %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

/**
 * A POSIX command shim that runs one package-manager entry under the
 * application binary.
 * @param launcher - the application binary, relative to `.bin`.
 * @param script - the package-manager script, relative to `.bin`.
 * @returns the executable shell script.
 */
export function posixPackageManagerShim(launcher: string, script: string): string {
  return [
    '#!/bin/sh',
    '# Generated by scripts/runtime-closure.ts. Git dependency preparation may',
    '# ask for npm even though the bundle deliberately ships one package manager.',
    'ELECTRON_RUN_AS_NODE=1',
    'export ELECTRON_RUN_AS_NODE',
    `exec "$(dirname "$0")/${launcher}" "$(dirname "$0")/${script}" "$@"`,
    '',
  ].join('\n')
}

/**
 * The commands a shipped closure needs and pnpm does not leave behind.
 *
 * ## The application ships no `node`, and the bundled pnpm needs one
 *
 * `Resources/backend/node_modules/pnpm/bin/pnpm.mjs` begins
 * `#!/usr/bin/env node`, and pnpm's own launcher `exec node` a second time
 * after that. The bundle carries no `node`: the runtime is this application's
 * Electron binary run with `ELECTRON_RUN_AS_NODE`, which is the whole reason
 * it carries one Node and not two. So on a machine that has never installed
 * Node — the machine this installer exists to serve — the shipped pnpm cannot
 * start, and `dsh plugin` fails with `env: node: No such file or directory`
 * before it has done anything.
 *
 * A `node` shim answers both lookups at once, and only for the child that gets
 * this directory in front of its `PATH` — `omdsh-plughub` puts it there for
 * the `dsh plugin` it spawns and for nothing else, and only when the inherited
 * `PATH` did not already carry a working pnpm. A machine with its own Node
 * keeps using it.
 *
 * ## Git preparation may ask for npm even when a package declares pnpm
 *
 * pnpm chooses the command used to prepare a git dependency from lockfiles,
 * not from the dependency's `packageManager` field. A source tree with a
 * `prepare` script but no committed lockfile therefore falls back to
 * `npm install` and `npm run prepare`. The application intentionally carries
 * pnpm only, so an `npm` compatibility command forwards those standard calls
 * to the shipped pnpm. Without it, only those lockfile-less git plugins fail
 * with "npm is not recognized" on a clean machine.
 *
 * ## Windows needs the pnpm command written too
 *
 * pnpm creates `.bin` entries for the platform it installs ON, not the one it
 * installs FOR: a Windows closure cross-built from macOS gets POSIX symlinks
 * and no `.cmd` at all. Windows cannot execute one, and the hub will not even
 * look at it — its search asks for `pnpm.cmd`, `pnpm.exe`, or `pnpm.bat` on
 * `win32`. macOS needs no equivalent: the symlink pnpm left is runnable the
 * moment `node` resolves.
 *
 * ## What this does not fix
 *
 * The nested install still honors the git package's own `allowBuilds` policy.
 * If that package forgets to allow one of its build dependencies, packaging
 * must fail rather than silently widening its supply-chain permissions. The
 * package has to correct that policy (and should commit its lockfile so pnpm
 * is selected without this compatibility path at all).
 *
 * @param platform - the packaging platform.
 * @param productName - the product name the artifact is built around.
 * @returns the shims to write.
 */
export function closureShims(platform: 'mac' | 'win', productName: string): ClosureShim[] {
  const launcher = launcherFromBin(platform, productName)
  if (platform === 'win') {
    return [
      { name: 'node.cmd', body: windowsShim(launcher), mode: 0o644 },
      { name: 'pnpm.cmd', body: windowsShim(launcher, PNPM_ENTRY_FROM_BIN.win), mode: 0o644 },
      { name: 'npm.cmd', body: windowsShim(launcher, PNPM_ENTRY_FROM_BIN.win), mode: 0o644 },
    ]
  }
  return [
    { name: 'node', body: posixNodeShim(launcher), mode: 0o755 },
    { name: 'npm', body: posixPackageManagerShim(launcher, PNPM_ENTRY_FROM_BIN.mac), mode: 0o755 },
  ]
}

/**
 * The command a `dsh plugin` install resolves `pnpm` through on one platform.
 * Packaging asserts it, because it went missing once already without a sign.
 * @param platform - the packaging platform.
 * @returns the path, relative to the closure root.
 */
export function pnpmCommandRelative(platform: 'mac' | 'win'): string {
  return `${CLOSURE_BIN_RELATIVE}/${platform === 'win' ? 'pnpm.cmd' : 'pnpm'}`
}

/**
 * The `node` command the shipped pnpm resolves through, relative to the
 * closure root.
 * @param platform - the packaging platform.
 * @returns the path.
 */
export function nodeCommandRelative(platform: 'mac' | 'win'): string {
  return `${CLOSURE_BIN_RELATIVE}/${platform === 'win' ? 'node.cmd' : 'node'}`
}

/**
 * The npm compatibility command used by lockfile-less git package preparation.
 * @param platform - the packaging platform.
 * @returns the path, relative to the closure root.
 */
export function npmCommandRelative(platform: 'mac' | 'win'): string {
  return `${CLOSURE_BIN_RELATIVE}/${platform === 'win' ? 'npm.cmd' : 'npm'}`
}

/**
 * Write the commands a shipped closure needs into a staged one.
 * @param options - the closure, the platform, and the product it is built around.
 * @param options.staging - the deployed closure.
 * @param options.platform - the packaging platform.
 * @param options.productName - the product name.
 * @param options.prefix - diagnostic prefix.
 * @param options.dryRun - report what would happen and change nothing.
 * @returns nothing; the commands are on disk beside the closure's others.
 */
export async function writeClosureShims(options: {
  staging: string
  platform: 'mac' | 'win'
  productName: string
  prefix: string
  dryRun: boolean
}): Promise<void> {
  const shims = closureShims(options.platform, options.productName)
  const directory = join(options.staging, CLOSURE_BIN_RELATIVE)
  if (options.dryRun) {
    for (const shim of shims) console.log(`${options.prefix}: would write ${join(directory, shim.name)}`)
    return
  }
  await mkdir(directory, { recursive: true })
  for (const shim of shims) {
    await writeFile(join(directory, shim.name), shim.body, { mode: shim.mode })
  }
  console.log(
    `${options.prefix}: wrote ${shims.map(shim => shim.name).join(', ')} into the closure, `
    + 'which is how the shipped package-manager paths run on a machine with no Node',
  )
}


/** Name of the synthesized deploy root. It is private and never published. */
const CLOSURE_NAME = 'omdsh-runtime-closure'

/** Version of the synthesized deploy root. Nothing reads it; pnpm requires one. */
const CLOSURE_VERSION = '0.0.1'

/**
 * Which dependencies of the closure may run an install script.
 *
 * pnpm 10+ blocks every install and build script until it is reviewed, and the
 * staging root gets no say from this repository's own `pnpm-workspace.yaml` —
 * it is a separate workspace by construction. So the review travels here.
 *
 * Narrower than the desktop workspace's list, because this is the RUNTIME's
 * closure rather than the shell's: `electron` and `esbuild` are the shell's
 * build-time dependencies and never appear here. `node-addon-require-builtin`
 * reaches the closure but is left unlisted, which denies it, exactly as the
 * workspace denies it.
 */
const CLOSURE_ALLOW_BUILDS: Readonly<Record<string, boolean>> = {
  // Restores the executable bit on the macOS spawn helper, which the
  // persistent-terminal tools need in the shipped closure.
  '@deepseek-ai/dsh-subprocess-local': true,
  // JSONL durability calls MoveFileExW with write-through publication on Windows.
  koffi: true,
  // The persistent PTY backend, including ConPTY on Windows.
  'node-pty': true,
  // Pulled in by an optional LLM API backend; its lifecycle scripts are no-ops
  // the runtime does not need.
  '@google/genai': false,
  protobufjs: false,
}

/** What a closure install needs to know. */
export interface InstallRuntimeClosureOptions {
  /** Directory to materialize the closure in. Replaced wholesale. */
  readonly staging: string
  /** The dependency map to install, as the runtime pin records it. */
  readonly dependencies: Readonly<Record<string, string>>
  /** pnpm settings the staged install must carry, when the pin sets any. */
  readonly pnpm?: Readonly<Record<string, unknown>>
  /** Directory the install must never write into or delete: the repository. */
  readonly protect: string
  /** Diagnostic prefix on this step's logs and errors. */
  readonly prefix: string
  /** Report what would happen and change nothing. */
  readonly dryRun: boolean
}

/**
 * The staging root's workspace file.
 *
 * Written as text rather than through a YAML serializer: this repository has no
 * YAML dependency, the document is three fixed keys, and every value in it is
 * either a boolean or a quoted package name.
 * @param allowBuilds - the reviewed build-script decisions.
 * @returns the document.
 */
function workspaceDocument(allowBuilds: Readonly<Record<string, boolean>>): string {
  const entries = Object.entries(allowBuilds)
    .map(([name, allowed]) => `  '${name}': ${String(allowed)}`)
    .join('\n')
  return [
    '# Generated by scripts/runtime-closure.ts. `packages: []` is what makes this',
    '# directory a workspace root of its own, so the install resolves from the',
    '# registry rather than through the desktop workspace above it.',
    'packages: []',
    'allowBuilds:',
    entries,
    '# Every dependency here is pinned to one release this repository chooses',
    "# deliberately, so pnpm's release-age gate has nothing left to protect.",
    'minimumReleaseAge: 0',
    '',
  ].join('\n')
}

/**
 * Refuse a staging directory that would take the repository with it.
 *
 * The install replaces `staging` wholesale, so a path that contains the
 * repository — or is it — turns one packaging run into data loss.
 * @param staging - the directory about to be replaced.
 * @param protect - the directory that must survive.
 * @param prefix - diagnostic prefix.
 * @throws Error when the staging directory is unsafe.
 */
function assertSafeStaging(staging: string, protect: string, prefix: string): void {
  const target = resolve(staging)
  const guarded = resolve(protect)
  if (target === guarded || guarded.startsWith(`${target}${sep}`)) {
    throw new Error(`${prefix}: refusing to stage the closure at ${target}, which contains ${guarded}.`)
  }
}

/**
 * Install the harness closure into the staging directory.
 * @param options - where to put it and what to put there.
 * @returns nothing; the closure is on disk at `options.staging`.
 * @throws Error when the staging directory is unsafe or the install fails.
 */
export async function installRuntimeClosure(options: InstallRuntimeClosureOptions): Promise<void> {
  assertSafeStaging(options.staging, options.protect, options.prefix)

  const manifest = {
    name: CLOSURE_NAME,
    version: CLOSURE_VERSION,
    private: true,
    type: 'module',
    dependencies: options.dependencies,
    ...options.pnpm !== undefined && { pnpm: options.pnpm },
  }

  if (options.dryRun) {
    console.log(`${options.prefix}: would stage the closure at ${options.staging}`)
    for (const [name, range] of Object.entries(options.dependencies)) {
      console.log(`${options.prefix}:   ${name}@${range}`)
    }
    return
  }

  // Replaced rather than updated: a closure carrying a previous run's pruned
  // tree, or a previous target's natives, is not the closure this pin names.
  await rm(options.staging, { recursive: true, force: true })
  await mkdir(options.staging, { recursive: true })
  await writeFile(join(options.staging, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  await writeFile(join(options.staging, 'pnpm-workspace.yaml'), workspaceDocument(CLOSURE_ALLOW_BUILDS))

  await runCommand({
    label: 'deploy the harness closure',
    command: 'pnpm',
    // `--prod` because the closure runs the harness rather than building it,
    // and `--node-linker=hoisted` because the tree is about to be copied into
    // an application bundle, where a symlink into pnpm's store resolves to
    // nothing.
    args: ['install', '--prod', '--node-linker=hoisted'],
    cwd: options.staging,
    prefix: options.prefix,
    dryRun: false,
  })
}
