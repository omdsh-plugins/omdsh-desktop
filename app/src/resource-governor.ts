/**
 * Resource policy for the supervised runtime.
 *
 * The runtime holds every session, every tool subprocess, and every plugin the
 * profile mounts, so it is the process whose footprint matters. The shell
 * samples it and applies one rule set, whose first clause is that agent work is
 * never interrupted: a decision to reclaim memory only ever applies to an idle
 * runtime. Resident size comes from `ps` on Unix and from PowerShell
 * `WorkingSet64` on Windows.
 * @module @omdsh-plugins/omdsh-desktop/resource-governor
 */

import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'

/** How often the shell samples the runtime. */
export const SAMPLE_INTERVAL_MS = 30_000

/** Idle time with no window and no running session before the runtime is stopped. */
export const IDLE_SUSPEND_MS = 10 * 60_000

/** Fraction of physical memory the runtime may hold before an idle recycle. */
const RECYCLE_MEMORY_FRACTION = 0.35

/** Lower bound on the recycle threshold, so a small machine does not recycle a healthy runtime. */
const MIN_RECYCLE_BYTES = 2 * 1024 * 1024 * 1024

/** Fraction of physical memory offered to the runtime's V8 old space. */
const HEAP_MEMORY_FRACTION = 0.25

/** Old-space bounds in MiB, keeping the runtime useful on small machines and bounded on large ones. */
const MIN_HEAP_MB = 2048
const MAX_HEAP_MB = 8192

/** One sample of everything the policy reads. */
export interface ResourceSample {
  /** Sessions the runtime reports as running. */
  runningSessions: number
  /** Windows currently open, whether or not they have focus. */
  openWindows: number
  /** Milliseconds since the last moment that had a window or a running session. */
  idleForMs: number
  /** Resident set size of the runtime process, or `undefined` when it could not be read. */
  runtimeRssBytes: number | undefined
  /** Physical memory of the machine. */
  totalMemoryBytes: number
}

/** What the shell does with the runtime after one sample. */
export type ResourceAction =
  /** Leave it alone. */
  | { action: 'none' }
  /** Stop it; the next window start brings it back. */
  | { action: 'suspend' }
  /** Restart it to return its heap to the operating system. */
  | { action: 'recycle'; rssBytes: number }

/** Policy tuning; both bounds are configurable so a deployment can disable either clause. */
export interface ResourcePolicyConfig {
  /** Stop an idle runtime once no window has been open for this long; `undefined` never stops it. */
  idleSuspendMs: number | undefined
  /** Restart an idle runtime holding at least this many bytes; `undefined` never recycles it. */
  recycleRssBytes: number | undefined
}

/**
 * The recycle threshold for a machine.
 * @param totalMemoryBytes - physical memory.
 * @returns the resident-set size at which an idle runtime is recycled.
 */
export function defaultRecycleThreshold(totalMemoryBytes: number): number {
  return Math.max(MIN_RECYCLE_BYTES, Math.floor(totalMemoryBytes * RECYCLE_MEMORY_FRACTION))
}

/**
 * The V8 old-space bound handed to the runtime.
 *
 * The bound exists so a runaway session fails with a heap error the shell can
 * report and restart from, instead of driving the machine into swap.
 * @param totalMemoryBytes - physical memory; defaults to this machine's.
 * @returns the bound in MiB.
 */
export function defaultHeapLimitMb(totalMemoryBytes: number = totalmem()): number {
  const fromMachine = Math.floor((totalMemoryBytes * HEAP_MEMORY_FRACTION) / (1024 * 1024))
  return Math.min(MAX_HEAP_MB, Math.max(MIN_HEAP_MB, fromMachine))
}

/**
 * Decide what to do with the runtime after one sample.
 * @param sample - the current sample.
 * @param config - policy tuning.
 * @returns the action to take.
 */
export function decideResourceAction(sample: ResourceSample, config: ResourcePolicyConfig): ResourceAction {
  // Agent work outranks every reclamation rule: a running turn owns the process.
  if (sample.runningSessions > 0) return { action: 'none' }
  if (config.idleSuspendMs !== undefined && sample.openWindows === 0 && sample.idleForMs >= config.idleSuspendMs) {
    return { action: 'suspend' }
  }
  if (config.recycleRssBytes !== undefined
    && sample.runtimeRssBytes !== undefined
    && sample.runtimeRssBytes >= config.recycleRssBytes) {
    return { action: 'recycle', rssBytes: sample.runtimeRssBytes }
  }
  return { action: 'none' }
}

/** How one platform reports a process's resident set. */
export interface ProcessRssCommand {
  /** Executable that prints the size. */
  file: string
  /** Its arguments; `pid` is already interpolated. */
  args: string[]
  /**
   * Convert that command's stdout into bytes.
   * @param stdout - the command's standard output.
   * @returns resident set size in bytes, or `undefined` when the output is not a number.
   */
  parse: (stdout: string) => number | undefined
}

/**
 * The command that reads one process's resident set on this platform.
 *
 * Unix `ps -o rss=` prints kibibytes. Windows PowerShell `WorkingSet64` is
 * already bytes. The runtime is not an Electron child process, so
 * `app.getAppMetrics()` does not cover it.
 * @param pid - the process to measure.
 * @param platform - the host OS; defaults to this process.
 * @returns the command and the parser for its stdout.
 */
export function processRssCommand(pid: number, platform: NodeJS.Platform = process.platform): ProcessRssCommand {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-Command', `(Get-Process -Id ${String(pid)}).WorkingSet64`],
      parse: (stdout) => {
        const bytes = Number.parseInt(stdout.trim(), 10)
        return Number.isFinite(bytes) ? bytes : undefined
      },
    }
  }
  return {
    file: '/bin/ps',
    args: ['-o', 'rss=', '-p', String(pid)],
    parse: (stdout) => {
      const kibibytes = Number.parseInt(stdout.trim(), 10)
      return Number.isFinite(kibibytes) ? kibibytes * 1024 : undefined
    },
  }
}

/**
 * Read one process's resident set size.
 *
 * @param pid - the process to measure.
 * @returns its resident set size in bytes, or `undefined` when the process is gone or unreadable.
 */
export async function readProcessRss(pid: number): Promise<number | undefined> {
  const command = processRssCommand(pid)
  return new Promise((resolve) => {
    execFile(command.file, command.args, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      resolve(command.parse(stdout))
    })
  })
}
