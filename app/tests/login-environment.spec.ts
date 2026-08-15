/** Login-shell environment recovery: when it is needed, how its payload is read, and how it merges. */

import { describe, expect, it } from 'vitest'
import {
  mergeLaunchEnvironment,
  needsLoginEnvironment,
  parseProbeOutput,
} from '../src/login-environment.ts'

describe('needsLoginEnvironment', () => {
  it('asks for a probe when PATH holds only launchd system entries', () => {
    expect(needsLoginEnvironment({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, 'darwin')).toBe(true)
  })

  it('asks for a probe when PATH is absent or empty', () => {
    expect(needsLoginEnvironment({}, 'darwin')).toBe(true)
    expect(needsLoginEnvironment({ PATH: '' }, 'darwin')).toBe(true)
  })

  it('skips the probe once PATH carries a profile entry', () => {
    expect(needsLoginEnvironment({ PATH: '/opt/homebrew/bin:/usr/bin:/bin' }, 'darwin')).toBe(false)
  })

  it('never probes off macOS, where a GUI launch already carries the user PATH', () => {
    expect(needsLoginEnvironment({ PATH: '' }, 'win32')).toBe(false)
    expect(needsLoginEnvironment({}, 'linux')).toBe(false)
  })

  it('ignores empty PATH segments', () => {
    expect(needsLoginEnvironment({ PATH: '/usr/bin::/bin' }, 'darwin')).toBe(true)
  })
})

describe('parseProbeOutput', () => {
  const marker = '__DSH_DESKTOP_ENV__'

  it('reads the payload between the markers', () => {
    const output = `profile banner\n${marker}{"PATH":"/opt/homebrew/bin","EDITOR":"vim"}${marker}`
    expect(parseProbeOutput(output)).toEqual({ PATH: '/opt/homebrew/bin', EDITOR: 'vim' })
  })

  it('rejects output with no markers', () => {
    expect(parseProbeOutput('nvm: command not found')).toBeUndefined()
  })

  it('rejects a payload the shell corrupted', () => {
    expect(parseProbeOutput(`${marker}not json${marker}`)).toBeUndefined()
  })

  it('rejects a payload that is not an object', () => {
    expect(parseProbeOutput(`${marker}["PATH"]${marker}`)).toBeUndefined()
    expect(parseProbeOutput(`${marker}null${marker}`)).toBeUndefined()
  })

  it('drops entries that are not strings', () => {
    expect(parseProbeOutput(`${marker}{"PATH":"/bin","N":3}${marker}`)).toEqual({ PATH: '/bin' })
  })

  it('rejects a single marker, which cannot delimit a payload', () => {
    expect(parseProbeOutput(`${marker}{"PATH":"/bin"}`)).toBeUndefined()
  })
})

describe('mergeLaunchEnvironment', () => {
  it('keeps the inherited environment when no probe ran', () => {
    expect(mergeLaunchEnvironment({ HOME: '/Users/x', PATH: '/usr/bin' }, undefined))
      .toEqual({ HOME: '/Users/x', PATH: '/usr/bin' })
  })

  it('lets the login shell replace the launchd defaults it exists to correct', () => {
    const merged = mergeLaunchEnvironment(
      { HOME: '/Users/x', PATH: '/usr/bin:/bin' },
      { PATH: '/opt/homebrew/bin:/usr/bin:/bin', NVM_DIR: '/Users/x/.nvm' },
    )
    expect(merged).toEqual({
      HOME: '/Users/x',
      PATH: '/opt/homebrew/bin:/usr/bin:/bin',
      NVM_DIR: '/Users/x/.nvm',
    })
  })

  it('drops the launch-mode variables from both sides', () => {
    const merged = mergeLaunchEnvironment(
      { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
      { ELECTRON_NO_ASAR: '1', ELECTRON_RUN_AS_NODE: '1', TERM: 'xterm' },
    )
    expect(merged).toEqual({ PATH: '/usr/bin', TERM: 'xterm' })
  })

  it('drops inherited entries with no value', () => {
    expect(mergeLaunchEnvironment({ PATH: '/usr/bin', EMPTY: undefined }, undefined))
      .toEqual({ PATH: '/usr/bin' })
  })
})
