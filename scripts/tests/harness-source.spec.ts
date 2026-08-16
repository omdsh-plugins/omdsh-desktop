/**
 * What the application may call itself: the rule `check:harness-pin` enforces
 * so an artifact's name always says which runtime is inside it.
 */

import { describe, expect, it } from 'vitest'
import { versionNamesRelease } from '../harness-source.ts'

describe('versionNamesRelease', () => {
  it('accepts the release itself, which is the normal case', () => {
    expect(versionNamesRelease('0.1.0-rc.6', '0.1.0-rc.6')).toBe(true)
    expect(versionNamesRelease('0.2.0', '0.2.0')).toBe(true)
  })

  it('rejects a different release, which is the drift it exists to catch', () => {
    expect(versionNamesRelease('0.1.0-rc.5', '0.1.0-rc.6')).toBe(false)
    expect(versionNamesRelease('0.1.0-rc.6', '0.1.0-rc.5')).toBe(false)
  })

  it('accepts a build suffix, which is a rebuild of the same release', () => {
    expect(versionNamesRelease('0.1.0-rc.6+1', '0.1.0-rc.6')).toBe(true)
    expect(versionNamesRelease('0.1.0-rc.6+12', '0.1.0-rc.6')).toBe(true)
  })

  it('rejects a suffix that would SORT, which is a claim this application cannot make', () => {
    expect(versionNamesRelease('0.1.0-rc.6.1', '0.1.0-rc.6')).toBe(false)
    expect(versionNamesRelease('0.1.0-rc.7', '0.1.0-rc.6')).toBe(false)
  })

  it('rejects a build suffix that is not a number', () => {
    expect(versionNamesRelease('0.1.0-rc.6+', '0.1.0-rc.6')).toBe(false)
    expect(versionNamesRelease('0.1.0-rc.6+beta', '0.1.0-rc.6')).toBe(false)
  })

  it('reads the release literally, so its dots match nothing else', () => {
    expect(versionNamesRelease('0X1Y0-rc.6', '0.1.0-rc.6')).toBe(false)
  })

  it('rejects a version that merely starts with the release', () => {
    expect(versionNamesRelease('0.1.0-rc.60', '0.1.0-rc.6')).toBe(false)
  })
})
