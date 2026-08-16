/**
 * The two rules that keep the harness pin honest: what the application may
 * call itself, and which of two releases is newer — the second being what
 * stops `harness:latest` from ever walking backwards.
 */

import { describe, expect, it } from 'vitest'
import { compareReleases, versionNamesRelease } from '../harness-source.ts'

/** The newest of a list, exactly as `useLatest` picks it. */
function newest(versions: readonly string[]): string {
  return versions.reduce((best, candidate) => (compareReleases(candidate, best) > 0 ? candidate : best))
}

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

describe('compareReleases', () => {
  it('orders the release parts numerically, not as text', () => {
    expect(compareReleases('0.2.0', '0.10.0')).toBeLessThan(0)
    expect(compareReleases('1.0.0', '0.9.9')).toBeGreaterThan(0)
  })

  it('orders prerelease numbers numerically, which string order gets wrong', () => {
    expect(compareReleases('0.1.0-rc.2', '0.1.0-rc.10')).toBeLessThan(0)
    expect(compareReleases('0.1.0-rc.6', '0.1.0-rc.5')).toBeGreaterThan(0)
  })

  it('puts a prerelease behind the release it leads to', () => {
    expect(compareReleases('0.1.0-rc.6', '0.1.0')).toBeLessThan(0)
    expect(compareReleases('0.1.0', '0.1.0-rc.6')).toBeGreaterThan(0)
  })

  it('treats a longer prerelease as later than its own prefix', () => {
    expect(compareReleases('0.1.0-rc', '0.1.0-rc.1')).toBeLessThan(0)
  })

  it('ignores build metadata, so a rebuild is neither ahead nor behind', () => {
    expect(compareReleases('0.1.0-rc.6+1', '0.1.0-rc.6')).toBe(0)
    expect(compareReleases('0.1.0-rc.6+2', '0.1.0-rc.6+1')).toBe(0)
  })

  it('picks the newest of a real published list, which is not its last entry', () => {
    // The order npm answers with, for `@deepseek-ai/dsh` as it stands.
    expect(newest(['0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.5', '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6']))
      .toBe('0.1.0-rc.6')
  })

  it('refuses to call an older release newer, which is what blocks a downgrade', () => {
    // `@deepseek-ai/dsh-host-apiproxy` tags 0.0.1-rc.1 as `latest` while
    // publishing 0.1.0-rc.6, so a command trusting that tag would move
    // backwards. Ordering is what makes that impossible.
    expect(compareReleases('0.0.1-rc.1', '0.1.0-rc.6')).toBeLessThan(0)
  })
})
