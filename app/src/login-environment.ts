/**
 * Login-shell environment recovery.
 *
 * A Finder launch inherits launchd's environment, whose `PATH` is the four
 * system directories and nothing else. The runtime this shell supervises runs
 * the user's tools — `git`, `rg`, language toolchains — from whatever the
 * user's shell profile puts on `PATH`, so the shell recovers that environment
 * once at startup and hands it to the runtime process.
 * @module @omdsh-plugins/omdsh-desktop/login-environment
 */

import { spawn } from 'node:child_process'

/** `PATH` entries launchd hands a GUI application; a `PATH` inside this set carries no user profile. */
const LAUNCHD_PATH_ENTRIES: ReadonlySet<string> = new Set(['/usr/bin', '/bin', '/usr/sbin', '/sbin'])

/**
 * Variables that describe how this process was launched. The runtime child
 * gets its own values for these, so carrying them across would make the child
 * inherit the shell's execution mode.
 */
const LAUNCH_ONLY_KEYS: ReadonlySet<string> = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_NO_ASAR',
])

/** Delimiter framing the probe's payload, so shell-profile banners stay outside it. */
const MARKER = '__DSH_DESKTOP_ENV__'

/** Probe body: the child prints its own environment, which the login shell has finished composing. */
const PROBE_SCRIPT = 'process.stdout.write(JSON.stringify(process.env))'

/** How long the login shell may take before the shell gives up and keeps the inherited environment. */
const PROBE_TIMEOUT_MS = 5_000

/** Inputs {@link readLoginShellEnvironment} needs from the running application. */
export interface LoginProbeOptions {
  /** Login shell to run, normally `$SHELL`. */
  shell: string
  /** Node-capable binary the probe runs; the Electron binary in `ELECTRON_RUN_AS_NODE` mode. */
  nodePath: string
  /** Environment the probe starts from. */
  env: NodeJS.ProcessEnv
  /** Probe budget; defaults to {@link PROBE_TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Whether the inherited environment lacks a user profile and is worth probing for.
 *
 * The probe exists for macOS Finder launches, which inherit launchd's four
 * system directories as `PATH`. Windows Explorer and a Linux desktop session
 * already hand the user environment to a GUI application, so they never probe.
 * @param env - the inherited environment.
 * @param platform - the host OS; defaults to this process.
 * @returns true when this is macOS and `PATH` is absent or holds only launchd's system entries.
 */
export function needsLoginEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'darwin') return false
  const path = env.PATH
  if (path === undefined || path === '') return true
  return path.split(':').filter(entry => entry !== '').every(entry => LAUNCHD_PATH_ENTRIES.has(entry))
}

/**
 * Quote one value for the single-quoted shell string the probe is assembled from.
 * @param value - the raw string.
 * @returns the quoted form.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

/**
 * Extract the probe payload from the login shell's combined output.
 * @param output - everything the login shell wrote to stdout.
 * @returns the parsed environment, or `undefined` when the payload is absent or malformed.
 */
export function parseProbeOutput(output: string): Record<string, string> | undefined {
  const start = output.indexOf(MARKER)
  const end = output.lastIndexOf(MARKER)
  if (start === -1 || end <= start) return undefined
  const payload = output.slice(start + MARKER.length, end)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    // A profile that writes between the markers breaks the payload; the caller
    // keeps the inherited environment, which is the same outcome as no probe.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

/**
 * Run the user's login shell and read the environment it composes.
 *
 * The shell runs interactive **and** login (`-ilc`) because profile files split
 * across both modes, and its own output is framed by markers so a profile that
 * prints a banner does not corrupt the payload.
 * @param options - shell, probe binary, starting environment, and budget.
 * @returns the recovered environment, or `undefined` when the probe failed, timed out, or produced nothing usable.
 */
export async function readLoginShellEnvironment(options: LoginProbeOptions): Promise<Record<string, string> | undefined> {
  const command = `printf %s ${shellQuote(MARKER)}; ${shellQuote(options.nodePath)} -e ${shellQuote(PROBE_SCRIPT)}; printf %s ${shellQuote(MARKER)}`
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(options.shell, ['-ilc', command], {
        env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      // An unusable $SHELL is a machine fact, not a shell failure: keep the
      // inherited environment rather than refusing to start.
      resolve(undefined)
      return
    }
    let output = ''
    let settled = false
    const finish = (value: Record<string, string> | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(undefined)
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
    })
    child.once('error', () => {
      finish(undefined)
    })
    child.once('close', () => {
      finish(parseProbeOutput(output))
    })
  })
}

/**
 * Compose the environment the runtime process starts from.
 * @param inherited - the environment this shell was launched with.
 * @param login - the recovered login-shell environment, if the probe produced one.
 * @returns the merged environment, with launch-mode variables removed.
 */
export function mergeLaunchEnvironment(
  inherited: NodeJS.ProcessEnv,
  login: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !LAUNCH_ONLY_KEYS.has(key)) merged[key] = value
  }
  // The login shell is the authority on the user's tooling: its values replace
  // the launchd defaults they exist to correct.
  for (const [key, value] of Object.entries(login ?? {})) {
    if (!LAUNCH_ONLY_KEYS.has(key)) merged[key] = value
  }
  return merged
}
