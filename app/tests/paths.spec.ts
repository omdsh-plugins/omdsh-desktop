/** Runtime entry resolution for the two layouts the shell runs from. */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRuntimeEntry, resolveRuntimeRoot } from '../src/paths.ts'

describe('resolveRuntimeEntry', () => {
  it('resolves the deployed closure inside an installed application', () => {
    const resourcesPath = join('/Applications', 'DeepSeek Harness.app', 'Contents', 'Resources')
    expect(resolveRuntimeEntry({
      packaged: true,
      resourcesPath,
      appPath: join(resourcesPath, 'app'),
    })).toBe(join(resourcesPath, 'backend', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  })

  it('resolves the installed release of the runtime workspace member in a checkout run', () => {
    expect(resolveRuntimeEntry({
      packaged: false,
      resourcesPath: '/unused',
      appPath: join('/repo', 'app'),
    })).toBe(join('/repo', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  })
})

describe('resolveRuntimeRoot', () => {
  it('names the tree the bundles this application ships are installed beside the launcher in', () => {
    const resourcesPath = join('/Applications', 'DeepSeek Harness.app', 'Contents', 'Resources')
    expect(resolveRuntimeRoot({ packaged: true, resourcesPath, appPath: join(resourcesPath, 'app') }))
      .toBe(join(resourcesPath, 'backend'))
  })

  it('names the runtime workspace member in a checkout run', () => {
    expect(resolveRuntimeRoot({ packaged: false, resourcesPath: '/unused', appPath: join('/repo', 'app') }))
      .toBe(join('/repo', 'runtime'))
  })
})
