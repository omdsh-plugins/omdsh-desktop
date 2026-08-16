/**
 * Which runtime-pin entries the packaging pipeline has to pack, and which it
 * passes straight through.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localBundles, localPath } from '../bundled-plugins.ts'

const HUB = '@omdsh-plugins/omdsh-plughub'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A scratch directory holding a `runtime/` manifest directory and a checkout beside it. */
function layout(): { manifestDir: string; checkout: string } {
  const root = mkdtempSync(join(tmpdir(), 'desktop-pack-'))
  roots.push(root)
  const manifestDir = join(root, 'runtime')
  const checkout = join(root, 'omdsh-plughub')
  mkdirSync(manifestDir, { recursive: true })
  mkdirSync(checkout, { recursive: true })
  return { manifestDir, checkout }
}

describe('localPath', () => {
  it('reads both specifier forms that name a path on this machine', () => {
    expect(localPath('link:../../omdsh-plughub')).toBe('../../omdsh-plughub')
    expect(localPath('file:/tmp/omdsh-plughub-0.1.0.tgz')).toBe('/tmp/omdsh-plughub-0.1.0.tgz')
  })

  it('reads a version as naming no path', () => {
    expect(localPath('0.1.0')).toBeUndefined()
    expect(localPath('^0.1.0')).toBeUndefined()
  })
})

describe('localBundles', () => {
  it('finds a bundle linked to a sibling checkout, resolved from the manifest directory', () => {
    const { manifestDir, checkout } = layout()
    expect(localBundles({ [HUB]: 'link:../omdsh-plughub' }, manifestDir)).toEqual(new Map([[HUB, checkout]]))
  })

  it('leaves a bundle named by version alone', () => {
    const { manifestDir } = layout()
    expect(localBundles({ [HUB]: '0.1.0' }, manifestDir).size).toBe(0)
  })

  it('leaves a specifier that already names a tarball alone, so a rerun repacks nothing', () => {
    const { manifestDir } = layout()
    const tarball = join(manifestDir, 'omdsh-plughub-0.1.0.tgz')
    writeFileSync(tarball, '')
    expect(localBundles({ [HUB]: `file:${tarball}` }, manifestDir).size).toBe(0)
  })

  it('leaves the harness itself alone, whose checkout is a workspace no pack would resolve', () => {
    const { manifestDir, checkout } = layout()
    expect(localBundles({ '@deepseek-ai/dsh': `link:${checkout}` }, manifestDir).size).toBe(0)
  })
})
