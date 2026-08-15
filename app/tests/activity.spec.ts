/** Folds over the host and mux frames the desktop shell watches. */

import { describe, expect, it } from 'vitest'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api/events'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import {
  applyHostFrame,
  applyMuxFrame,
  attentionCount,
  EMPTY_ATTENTION_STATE,
  EMPTY_RUN_STATE,
  type RunState,
  type SessionKey,
} from '../src/activity.ts'

/** The frame unions carry branded ids; tests construct them through the frame type itself. */
function hostFrame(frame: HostFrame): HostFrame {
  return frame
}

/**
 * Wrap a mux frame in the narrow server-request form.
 * @param rpcId - the envelope id, which is a question's stable identity.
 * @param payload - the frame.
 * @returns the request.
 */
function muxRequest(rpcId: string, payload: MuxFrame): RpcRequest<MuxFrame> {
  return { rpcId, payload } as RpcRequest<MuxFrame>
}

const sessionA = 'session-a' as SessionKey
const sessionB = 'session-b' as SessionKey

describe('applyHostFrame', () => {
  it('adds a session that started running', () => {
    const next = applyHostFrame(EMPTY_RUN_STATE, hostFrame({ type: 'host/session-status', sessionId: sessionA, running: true }))
    expect([...next.running]).toEqual([sessionA])
  })

  it('removes a session that stopped running', () => {
    const running = applyHostFrame(EMPTY_RUN_STATE, hostFrame({ type: 'host/session-status', sessionId: sessionA, running: true }))
    const next = applyHostFrame(running, hostFrame({ type: 'host/session-status', sessionId: sessionA, running: false }))
    expect([...next.running]).toEqual([])
  })

  it('tracks sessions independently', () => {
    let state: RunState = EMPTY_RUN_STATE
    state = applyHostFrame(state, hostFrame({ type: 'host/session-status', sessionId: sessionA, running: true }))
    state = applyHostFrame(state, hostFrame({ type: 'host/session-status', sessionId: sessionB, running: true }))
    state = applyHostFrame(state, hostFrame({ type: 'host/session-status', sessionId: sessionA, running: false }))
    expect([...state.running]).toEqual([sessionB])
  })

  it('drops a removed session that was still running', () => {
    const running = applyHostFrame(EMPTY_RUN_STATE, hostFrame({ type: 'host/session-status', sessionId: sessionA, running: true }))
    const next = applyHostFrame(running, hostFrame({ type: 'host/session-removed', sessionId: sessionA }))
    expect([...next.running]).toEqual([])
  })

  it('keeps the same fold for a removal it never tracked', () => {
    const next = applyHostFrame(EMPTY_RUN_STATE, hostFrame({ type: 'host/session-removed', sessionId: sessionA }))
    expect(next).toBe(EMPTY_RUN_STATE)
  })

  it('ignores frames outside the running-state vocabulary', () => {
    const next = applyHostFrame(EMPTY_RUN_STATE, hostFrame({ type: 'host/agent-error', sessionId: sessionA, message: 'boom' }))
    expect(next).toBe(EMPTY_RUN_STATE)
  })
})

describe('applyMuxFrame', () => {
  const approvalId = 'approval-1' as Extract<MuxFrame, { type: 'approval/requested' }>['approvalId']

  it('counts an approval request and clears it on resolution', () => {
    const requested = applyMuxFrame(EMPTY_ATTENTION_STATE, muxRequest('rpc-1', {
      type: 'approval/requested', sessionId: sessionA, approvalId, toolName: 'bash',
    }))
    expect(attentionCount(requested)).toBe(1)
    const resolved = applyMuxFrame(requested, muxRequest('rpc-2', {
      type: 'approval/resolved', sessionId: sessionA, approvalId, outcome: 'allow' as never,
    }))
    expect(attentionCount(resolved)).toBe(0)
  })

  it('keys a question by the answerable frame rpcId', () => {
    const requested = applyMuxFrame(EMPTY_ATTENTION_STATE, muxRequest('rpc-question', {
      type: 'question/requested', sessionId: sessionA, questions: [],
    }))
    expect(attentionCount(requested)).toBe(1)
    const resolved = applyMuxFrame(requested, muxRequest('rpc-other', {
      type: 'question/resolved', sessionId: sessionA, questionRpcId: 'rpc-question' as never, outcome: 'answered',
    }))
    expect(attentionCount(resolved)).toBe(0)
  })

  it('keeps the same fold for a resolution it never tracked', () => {
    const next = applyMuxFrame(EMPTY_ATTENTION_STATE, muxRequest('rpc-1', {
      type: 'approval/resolved', sessionId: sessionA, approvalId, outcome: 'allow' as never,
    }))
    expect(next).toBe(EMPTY_ATTENTION_STATE)
  })

  it('ignores the session-event traffic that dominates the stream', () => {
    const next = applyMuxFrame(EMPTY_ATTENTION_STATE, muxRequest('rpc-1', {
      type: 'session/subscribed', sessionId: sessionA, lastSeq: 4,
    }))
    expect(next).toBe(EMPTY_ATTENTION_STATE)
  })

  it('adds approvals and questions to one count', () => {
    let state = applyMuxFrame(EMPTY_ATTENTION_STATE, muxRequest('rpc-a', {
      type: 'approval/requested', sessionId: sessionA, approvalId, toolName: 'bash',
    }))
    state = applyMuxFrame(state, muxRequest('rpc-q', { type: 'question/requested', sessionId: sessionB, questions: [] }))
    expect(attentionCount(state)).toBe(2)
  })
})
