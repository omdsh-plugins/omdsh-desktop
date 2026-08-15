/** Requests the local boot surface sends the shell, as they arrive on the wire. */

import { describe, expect, it } from 'vitest'
import { parseBootAction } from '../src/boot-action.ts'

describe('parseBootAction', () => {
  it('reads the actions that carry no parameter', () => {
    expect(parseBootAction('dsh-action:retry')).toEqual({ kind: 'retry' })
    expect(parseBootAction('dsh-action:open-log')).toEqual({ kind: 'open-log' })
    expect(parseBootAction('dsh-action:quit')).toEqual({ kind: 'quit' })
    expect(parseBootAction('dsh-action:cancel-start')).toEqual({ kind: 'cancel-start' })
  })

  it('serves nothing for another scheme or an unknown action', () => {
    expect(parseBootAction('https://example.com/retry')).toBeUndefined()
    expect(parseBootAction('dsh-action:format-disk')).toBeUndefined()
  })
})

