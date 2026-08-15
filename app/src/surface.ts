/**
 * Which surface one window shows.
 *
 * Every window shows the one runtime beside it, so the decision is a function
 * of that runtime's condition and nothing else.
 * @module @omdsh-plugins/omdsh-desktop/surface
 */

import type { RuntimeState } from './runtime-supervisor.ts'

/** What a window is pointed at. */
export type Surface =
  /** The harness UI, served by a runtime that is ready. */
  | { kind: 'app'; url: string }
  /** The local boot page, in this state, with what else the shell knows. */
  | { kind: 'boot'; state: string; note: string }

/**
 * Decide what a window shows.
 * @param state - the runtime's condition; absent before its first report.
 * @returns the surface to route it to.
 */
export function surfaceFor(state: RuntimeState | undefined): Surface {
  if (state === undefined) return { kind: 'boot', state: 'stopped', note: '' }
  switch (state.status) {
    case 'ready':
      return { kind: 'app', url: state.url }
    case 'failed':
      return { kind: 'boot', state: 'failed', note: state.reason }
    case 'starting':
      return { kind: 'boot', state: 'starting', note: '' }
    case 'restarting':
    case 'stopped':
      return { kind: 'boot', state: state.status, note: '' }
    default:
      return state satisfies never
  }
}
