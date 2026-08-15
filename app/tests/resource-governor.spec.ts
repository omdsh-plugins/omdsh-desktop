/** The resource policy: agent work outranks reclamation, and both bounds are optional. */

import { describe, expect, it } from 'vitest'
import {
  decideResourceAction,
  defaultHeapLimitMb,
  defaultRecycleThreshold,
  processRssCommand,
  type ResourceSample,
} from '../src/resource-governor.ts'

const GIB = 1024 * 1024 * 1024

const idle: ResourceSample = {
  runningSessions: 0,
  openWindows: 0,
  idleForMs: 30 * 60_000,
  runtimeRssBytes: 100 * 1024 * 1024,
  totalMemoryBytes: 32 * GIB,
}

const bounds = { idleSuspendMs: 10 * 60_000, recycleRssBytes: 4 * GIB }

describe('decideResourceAction', () => {
  it('stops an idle runtime once no window has been open long enough', () => {
    expect(decideResourceAction(idle, bounds)).toEqual({ action: 'suspend' })
  })

  it('leaves a runtime alone while a session is running, however idle it looks', () => {
    expect(decideResourceAction({ ...idle, runningSessions: 1, runtimeRssBytes: 20 * GIB }, bounds))
      .toEqual({ action: 'none' })
  })

  it('leaves a runtime alone while a window is open', () => {
    expect(decideResourceAction({ ...idle, openWindows: 1 }, bounds)).toEqual({ action: 'none' })
  })

  it('waits out the idle delay before stopping', () => {
    expect(decideResourceAction({ ...idle, idleForMs: 60_000 }, bounds)).toEqual({ action: 'none' })
  })

  it('recycles an idle runtime that crossed the memory threshold', () => {
    const heavy = { ...idle, openWindows: 1, runtimeRssBytes: 5 * GIB }
    expect(decideResourceAction(heavy, bounds)).toEqual({ action: 'recycle', rssBytes: 5 * GIB })
  })

  it('cannot recycle on an unreadable resident size', () => {
    expect(decideResourceAction({ ...idle, openWindows: 1, runtimeRssBytes: undefined }, bounds))
      .toEqual({ action: 'none' })
  })

  it('never stops the runtime when idle suspension is off', () => {
    expect(decideResourceAction(idle, { ...bounds, idleSuspendMs: undefined })).toEqual({ action: 'none' })
  })

  it('never recycles when the memory bound is off', () => {
    const heavy = { ...idle, openWindows: 1, runtimeRssBytes: 9 * GIB }
    expect(decideResourceAction(heavy, { ...bounds, recycleRssBytes: undefined })).toEqual({ action: 'none' })
  })

  it('prefers stopping over recycling when both apply, since a stop reclaims everything', () => {
    expect(decideResourceAction({ ...idle, runtimeRssBytes: 9 * GIB }, bounds)).toEqual({ action: 'suspend' })
  })
})

describe('defaultRecycleThreshold', () => {
  it('scales with the machine', () => {
    expect(defaultRecycleThreshold(64 * GIB)).toBe(Math.floor(64 * GIB * 0.35))
  })

  it('keeps a floor so a small machine does not recycle a healthy runtime', () => {
    expect(defaultRecycleThreshold(4 * GIB)).toBe(2 * GIB)
  })
})

describe('defaultHeapLimitMb', () => {
  it('scales with the machine between its bounds', () => {
    expect(defaultHeapLimitMb(16 * GIB)).toBe(4096)
  })

  it('never drops below the usable floor', () => {
    expect(defaultHeapLimitMb(4 * GIB)).toBe(2048)
  })

  it('never exceeds the ceiling', () => {
    expect(defaultHeapLimitMb(128 * GIB)).toBe(8192)
  })
})

describe('processRssCommand', () => {
  it('reads kibibytes from ps on Unix', () => {
    const command = processRssCommand(42, 'darwin')
    expect(command.file).toBe('/bin/ps')
    expect(command.args).toEqual(['-o', 'rss=', '-p', '42'])
    expect(command.parse('  4096\n')).toBe(4096 * 1024)
  })

  it('reads bytes from PowerShell on Windows', () => {
    const command = processRssCommand(42, 'win32')
    expect(command.file).toBe('powershell.exe')
    expect(command.args).toEqual(['-NoProfile', '-Command', '(Get-Process -Id 42).WorkingSet64'])
    expect(command.parse('4194304\r\n')).toBe(4194304)
  })

  it('treats non-numeric output as unreadable', () => {
    expect(processRssCommand(1, 'linux').parse('rss')).toBeUndefined()
    expect(processRssCommand(1, 'win32').parse('')).toBeUndefined()
  })
})
