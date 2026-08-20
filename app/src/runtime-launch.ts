/**
 * The command lines the harness runtime is launched with, and what each one
 * means once it is running: how the address it reports becomes an address this
 * shell can reach, and how a launch that ended is explained.
 *
 * There is one definition, and the packaging smoke boots the deployed closure
 * through it to prove the shipped application will: a smoke that launched it
 * differently would prove nothing about the launch that ships.
 * @module @omdsh-plugins/omdsh-desktop/runtime-launch
 */


/** Loopback host the runtime binds; the desktop shell never serves a network. */
const RUNTIME_HOST = '127.0.0.1'

/**
 * The profile every launch of this shell composes.
 *
 * Named once because two invocations reach for it: the launch below, and the
 * one-shot initialization the bundled-plugin seeding runs first. A seeding
 * that prepared a different profile than the one that boots would be
 * invisible until somebody looked.
 */
export const RUNTIME_PROFILE = 'web'

/**
 * Port request for the runtime. Zero asks the OS for a free port, which keeps
 * the shell from colliding with a `dsh web` the user started in a terminal.
 */
const RUNTIME_PORT = '0'

/**
 * Keep the runtime from handing its URL to the system browser.
 *
 * `dsh --profile web` opens the default browser once the server is up. That
 * is the right default in a terminal; this shell already owns the window that
 * shows the same origin, so a second tab would only duplicate it.
 */
const RUNTIME_NO_OPEN = '--no-open'

/**
 * Node flags the runtime needs under Electron's Node.
 *
 * Cordis reaches Node's internal ES module loader either through this flag or
 * through the `node-addon-require-builtin` addon. That addon reads V8 embedder
 * data whose layout Electron does not share, so it fails to load there and the
 * flag is the only route left; without it the HMR service refuses to start and
 * takes the boot with it.
 */
const RUNTIME_NODE_FLAGS: readonly string[] = ['--expose-internals']

/**
 * Environment shared by every invocation of the packaged launcher.
 *
 * The runtime closure already pins and ships the pnpm version that plugin
 * installs must use. A git-hosted plugin can declare another version in its
 * `packageManager` field, and pnpm otherwise downloads and re-executes that
 * version while preparing the package. Besides bypassing the reviewed runtime
 * closure, that bootstrap cannot reliably materialize its package-manager
 * store when Node is the Electron executable. `pmOnFail=ignore` keeps both the
 * outer install and every nested `pnpm install` on the shipped pnpm.
 */
const RUNTIME_ENV: Readonly<Record<string, string>> = {
  ELECTRON_RUN_AS_NODE: '1',
  pnpm_config_pm_on_fail: 'ignore',
}

/** How one ended launch is described to the person who started it. */
interface RuntimeExit {
  /** Exit code, or `null` when a signal ended it. */
  exitCode: number | null
  /** The signal that ended it, when one did. */
  signal: NodeJS.Signals | null
  /** Tail of everything the launch printed. */
  output: string
  /** Consecutive failed starts this exit completes. */
  attempts: number
}

/**
 * One prepared launch of the runtime.
 *
 * The interface used to describe a launch that could serve from somewhere
 * else: an stdin pipe a remote script closed to stop, an address that might
 * come back `unusable`, a progress note read out of a provisioning run. Remote
 * launching is gone — {@link localRuntimeLaunch} is the only implementation,
 * and it answered `'ignore'`, `false`, always-ready and nothing to those. What
 * remains is what a launch on this machine actually varies.
 */
export interface RuntimeLaunch {
  /** Executable to spawn. */
  command: string
  /** Its complete argument vector. */
  args: readonly string[]
  /** Environment entries this launch adds to the shell's own launch environment. */
  env: Readonly<Record<string, string>>
  /** Name of what is being reached, for the log and the boot surface. */
  description: string
  /**
   * Explain a launch that ended without being asked to.
   * @param exit - how it ended and what it printed.
   * @returns the complete reason, as the boot surface shows it.
   */
  explain: (exit: RuntimeExit) => string
}

/**
 * Describe how one ended process ended.
 * @param exit - the exit facts.
 * @returns a phrase naming the code or the signal.
 */
function endingCause(exit: RuntimeExit): string {
  return exit.exitCode === null
    ? `signal ${exit.signal ?? 'unknown'}`
    : `exit code ${String(exit.exitCode)}`
}

/**
 * Plan the launch of a runtime on this machine.
 * @param options - the launcher to run and the heap to give it.
 * @param options.entry - absolute path of the `dsh` launcher.
 * @param options.nodePath - Node-capable binary to run it with.
 * @param options.maxOldSpaceMb - V8 old-space bound in MiB.
 * @returns the prepared launch.
 */
export function localRuntimeLaunch(options: {
  entry: string
  nodePath: string
  maxOldSpaceMb: number
}): RuntimeLaunch {
  return {
    command: options.nodePath,
    args: [
      ...RUNTIME_NODE_FLAGS,
      `--max-old-space-size=${String(options.maxOldSpaceMb)}`,
      options.entry,
      '--profile',
      RUNTIME_PROFILE,
      '--host',
      RUNTIME_HOST,
      '--port',
      RUNTIME_PORT,
      RUNTIME_NO_OPEN,
    ],
    env: RUNTIME_ENV,
    description: 'this machine',
    explain: exit =>
      `the harness runtime stopped ${String(exit.attempts)} times in a row (${endingCause(exit)})`,
  }
}

/** One short-lived invocation of the runtime that is not a supervised launch. */
export interface RuntimeCommand {
  /** Executable to spawn. */
  command: string
  /** Its complete argument vector. */
  args: readonly string[]
  /** Environment entries this invocation adds to the shell's own. */
  env: Readonly<Record<string, string>>
}

/**
 * Plan the invocation that materializes {@link RUNTIME_PROFILE} on disk.
 *
 * The shell seeds the profile it is about to boot with the plugins this
 * application ships, and seeding means editing that profile's manifest — so
 * the manifest has to exist first. Creating it here would mean this repository
 * carrying its own copy of the launcher's profile template: the manifest, the
 * empty user patch layer, and the pnpm settings out-of-tree plugins are
 * installed under. A copy that drifted would be silent, and the pnpm settings
 * are the half that matters — a profile initialized without them installs
 * plugins with a different linker and auto-installed peers.
 *
 * `--dump-default-config` prints the profile's bundle layers and exits, and it
 * resolves the profile to do so, which initializes it exactly as a boot would.
 * The output is discarded; the directory it left behind is the point. It costs
 * roughly a third of a second and runs only when the profile is absent.
 * @param options - the launcher to run and the Node-capable binary to run it with.
 * @param options.entry - absolute path of the `dsh` launcher.
 * @param options.nodePath - Node-capable binary to run it with.
 * @returns the prepared invocation.
 */
export function profileInitCommand(options: { entry: string; nodePath: string }): RuntimeCommand {
  return {
    command: options.nodePath,
    args: [...RUNTIME_NODE_FLAGS, options.entry, '--profile', RUNTIME_PROFILE, '--dump-default-config'],
    env: RUNTIME_ENV,
  }
}
