/**
 * Folds over the two harness streams the desktop shell watches.
 *
 * The host stream says which sessions are running, which is what the shell
 * needs for the Dock badge, sleep prevention, and idle accounting. The mux
 * stream additionally carries the two frames that mean the agent is blocked on
 * the user; the shell only opens it while no window has focus, because a
 * visible window already shows those requests.
 * @module @omdsh-plugins/omdsh-desktop/activity
 */

import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'

/** Session identity, taken from the frame contract rather than restated. */
export type SessionKey = Extract<HostFrame, { type: 'host/session-status' }>['sessionId']

/** Which sessions the runtime reports as running. */
export interface RunState {
  /** Sessions whose most recent status frame said running. */
  running: ReadonlySet<SessionKey>
}

/** Requests waiting on the user, keyed so a resolution can remove exactly one. */
export interface AttentionState {
  /** Approval requests, keyed by approval id. */
  approvals: ReadonlySet<string>
  /** Question requests, keyed by the answerable frame's rpcId. */
  questions: ReadonlySet<string>
}

/** No sessions running. */
export const EMPTY_RUN_STATE: RunState = { running: new Set() }

/** Nothing waiting on the user. */
export const EMPTY_ATTENTION_STATE: AttentionState = { approvals: new Set(), questions: new Set() }

/**
 * Total number of requests waiting on the user.
 * @param state - the attention fold.
 * @returns approvals plus questions.
 */
export function attentionCount(state: AttentionState): number {
  return state.approvals.size + state.questions.size
}

/**
 * Apply one host frame.
 *
 * `HostFrame` is merge-extensible, so an unrecognized type takes the
 * documented default and leaves the fold unchanged.
 * @param state - the current fold.
 * @param frame - the frame to apply.
 * @returns the next fold, or `state` itself when the frame changes nothing.
 */
export function applyHostFrame(state: RunState, frame: HostFrame): RunState {
  switch (frame.type) {
    case 'host/session-status': {
      const running = new Set(state.running)
      if (frame.running) running.add(frame.sessionId)
      else running.delete(frame.sessionId)
      return { running }
    }
    case 'host/session-removed': {
      if (!state.running.has(frame.sessionId)) return state
      const running = new Set(state.running)
      running.delete(frame.sessionId)
      return { running }
    }
    default:
      return state
  }
}

/**
 * Apply one mux frame.
 *
 * Approvals carry their own id. Questions do not: the answerable frame's
 * rpcId is their stable identity, and `question/resolved` echoes it as
 * `questionRpcId`.
 * @param state - the current fold.
 * @param request - the narrow server-request form carrying the frame.
 * @returns the next fold, or `state` itself when the frame changes nothing.
 */
export function applyMuxFrame(state: AttentionState, request: RpcRequest<MuxFrame>): AttentionState {
  const frame = request.payload
  switch (frame.type) {
    case 'approval/requested': {
      const approvals = new Set(state.approvals)
      approvals.add(frame.approvalId)
      return { ...state, approvals }
    }
    case 'approval/resolved': {
      if (!state.approvals.has(frame.approvalId)) return state
      const approvals = new Set(state.approvals)
      approvals.delete(frame.approvalId)
      return { ...state, approvals }
    }
    case 'question/requested': {
      const questions = new Set(state.questions)
      questions.add(request.rpcId)
      return { ...state, questions }
    }
    case 'question/resolved': {
      if (!state.questions.has(frame.questionRpcId)) return state
      const questions = new Set(state.questions)
      questions.delete(frame.questionRpcId)
      return { ...state, questions }
    }
    default:
      return state
  }
}
