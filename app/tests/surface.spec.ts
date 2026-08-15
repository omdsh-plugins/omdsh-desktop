/** What one window shows, given the condition of the connection it serves from. */

import { describe, expect, it } from 'vitest'
import { surfaceFor } from '../src/surface.ts'

describe('surfaceFor', () => {
  it('shows the harness UI of a runtime that is ready', () => {
    expect(surfaceFor({ status: 'ready', url: 'http://127.0.0.1:5321' }))
      .toEqual({ kind: 'app', url: 'http://127.0.0.1:5321' })
  })


  it('carries the reason a start failed, and says nothing about a slow one', () => {
    expect(surfaceFor({ status: 'failed', reason: 'the runtime stopped 3 times in a row' }))
      .toEqual({ kind: 'boot', state: 'failed', note: 'the runtime stopped 3 times in a row' })
    // A start on this machine has no steps to narrate: the runtime is spawned
    // and either reports its URL or exits.
    expect(surfaceFor({ status: 'starting', attempt: 0 }))
      .toEqual({ kind: 'boot', state: 'starting', note: '' })
  })

  it('waits on the boot page while a runtime is between runs', () => {
    expect(surfaceFor({ status: 'restarting', attempt: 1, delayMs: 500 }))
      .toEqual({ kind: 'boot', state: 'restarting', note: '' })
    expect(surfaceFor({ status: 'stopped' }))
      .toEqual({ kind: 'boot', state: 'stopped', note: '' })
  })

  it('treats a runtime nothing has reported yet as one that is not running', () => {
    expect(surfaceFor(undefined)).toEqual({ kind: 'boot', state: 'stopped', note: '' })
  })
})
