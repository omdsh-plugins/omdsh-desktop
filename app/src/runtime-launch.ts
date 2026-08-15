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
 * Port request for the runtime. Zero asks the OS for a free port, which keeps
 * the shell from colliding with a `dsh web` the user started in a terminal.
 */
const RUNTIME_PORT = '0'

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
      'web',
      '--host',
      RUNTIME_HOST,
      '--port',
      RUNTIME_PORT,
    ],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    description: 'this machine',
    explain: exit =>
      `the harness runtime stopped ${String(exit.attempts)} times in a row (${endingCause(exit)})`,
  }
}
