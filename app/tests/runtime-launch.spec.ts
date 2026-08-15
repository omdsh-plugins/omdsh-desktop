/** The launch the shell prepares: the runtime beside the window. */

import { describe, expect, it } from 'vitest'
import { localRuntimeLaunch } from '../src/runtime-launch.ts'

describe('localRuntimeLaunch', () => {
  it('runs the launcher under the given Node with the web profile on loopback', () => {
    const launch = localRuntimeLaunch({ entry: '/app/dsh.js', nodePath: '/bin/electron', maxOldSpaceMb: 2048 })
    expect(launch.command).toBe('/bin/electron')
    expect(launch.args).toContain('/app/dsh.js')
    expect(launch.args).toContain('--max-old-space-size=2048')
    expect(launch.args.slice(-6)).toEqual(['--profile', 'web', '--host', '127.0.0.1', '--port', '0'])
  })

  it('runs it as Node rather than as an Electron shell', () => {
    expect(localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 }).env)
      .toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('reaches the runtime at the address it reported, because it is this machine', () => {
    const launch = localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 })
    expect(launch.address('http://127.0.0.1:5321')).toEqual({ status: 'ready', url: 'http://127.0.0.1:5321' })
  })

  it('has no use for stdin, and is not stopped by closing it', () => {
    const launch = localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 })
    expect(launch.stdin).toBe('ignore')
    expect(launch.stopsOnStdinEnd).toBe(false)
  })

  it('counts repeated failures, which is all a local exit says', () => {
    const launch = localRuntimeLaunch({ entry: 'e', nodePath: 'n', maxOldSpaceMb: 1 })
    expect(launch.explain({ exitCode: 3, signal: null, output: '', attempts: 4 }))
      .toBe('the harness runtime stopped 4 times in a row (exit code 3)')
    expect(launch.explain({ exitCode: null, signal: 'SIGSEGV', output: '', attempts: 2 }))
      .toContain('signal SIGSEGV')
  })
})
