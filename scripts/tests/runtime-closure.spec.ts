/**
 * The commands a shipped closure needs and pnpm does not leave behind: the
 * `node` the bundled pnpm's own shebang looks for, and the Windows `pnpm.cmd`
 * a cross-built closure never gets.
 */

import { describe, expect, it } from 'vitest'
import { closureShims, launcherFromBin, nodeCommandRelative, pnpmCommandRelative, posixNodeShim, windowsShim } from '../runtime-closure.ts'

const PRODUCT = 'DeepSeek Harness'

/** The one shim body a platform writes under the given name. */
function body(platform: 'mac' | 'win', name: string): string {
  const shim = closureShims(platform, PRODUCT).find(entry => entry.name === name)
  if (shim === undefined) throw new Error(`no ${name} shim for ${platform}`)
  return shim.body
}

describe('launcherFromBin', () => {
  it('climbs out of the closure to the executable electron-builder writes', () => {
    expect(launcherFromBin('win', PRODUCT)).toBe('..\\..\\..\\..\\DeepSeek Harness.exe')
    expect(launcherFromBin('mac', PRODUCT)).toBe('../../../../MacOS/DeepSeek Harness')
  })

  it('uses each platform\'s own separators, because each shim is that platform\'s script', () => {
    expect(launcherFromBin('win', PRODUCT)).not.toContain('/')
    expect(launcherFromBin('mac', PRODUCT)).not.toContain('\\')
  })
})

describe('posixNodeShim', () => {
  const shim = posixNodeShim(launcherFromBin('mac', PRODUCT))

  it('is an executable script, because a shebang lookup runs what it finds', () => {
    expect(shim.startsWith('#!/bin/sh\n')).toBe(true)
    expect(closureShims('mac', PRODUCT)[0]?.mode).toBe(0o755)
  })

  it('runs the application as Node rather than a node.exe the bundle does not ship', () => {
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(shim).toContain('export ELECTRON_RUN_AS_NODE')
  })

  it('resolves the application from its own location, not the caller\'s', () => {
    expect(shim).toContain('"$(dirname "$0")/../../../../MacOS/DeepSeek Harness"')
  })

  it('execs, so the caller sees the application\'s own exit status', () => {
    expect(shim).toContain('exec "')
    expect(shim).toContain('"$@"')
  })
})

describe('windowsShim', () => {
  it('runs the application with no script when it is standing in for node', () => {
    const shim = body('win', 'node.cmd')
    expect(shim).toContain('SET "ELECTRON_RUN_AS_NODE=1"')
    expect(shim).toContain('"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" %*')
  })

  it('names the shipped pnpm when it is standing in for pnpm', () => {
    const shim = body('win', 'pnpm.cmd')
    expect(shim).toContain('"%~dp0..\\pnpm\\bin\\pnpm.mjs"')
  })

  it('quotes the executable, whose name has a space in it', () => {
    const line = body('win', 'node.cmd').split('\r\n').find(entry => entry.startsWith('"%~dp0'))
    expect(line).toContain('DeepSeek Harness.exe"')
  })

  it('propagates the exit code, which is how dsh plugin knows an install failed', () => {
    expect(body('win', 'pnpm.cmd').trimEnd().endsWith('ENDLOCAL & EXIT /B %ERRORLEVEL%')).toBe(true)
  })

  it('is CRLF-terminated, as a batch file has to be', () => {
    const shim = body('win', 'pnpm.cmd')
    expect(shim.endsWith('\r\n')).toBe(true)
    expect(shim.split('\n').every(line => line === '' || line.endsWith('\r'))).toBe(true)
  })

  it('carries no CRLF into the POSIX shim, which sh would read as part of the path', () => {
    expect(windowsShim('x').includes('\r')).toBe(true)
    expect(posixNodeShim('x').includes('\r')).toBe(false)
  })
})

describe('closureShims', () => {
  it('writes node and pnpm on Windows, where pnpm left nothing runnable', () => {
    expect(closureShims('win', PRODUCT).map(shim => shim.name)).toEqual(['node.cmd', 'pnpm.cmd'])
  })

  it('writes only node on macOS, where pnpm\'s own symlink runs once node resolves', () => {
    expect(closureShims('mac', PRODUCT).map(shim => shim.name)).toEqual(['node'])
  })
})

describe('the commands packaging asserts', () => {
  it('names what each platform actually resolves', () => {
    expect(pnpmCommandRelative('win')).toBe('node_modules/.bin/pnpm.cmd')
    expect(pnpmCommandRelative('mac')).toBe('node_modules/.bin/pnpm')
    expect(nodeCommandRelative('win')).toBe('node_modules/.bin/node.cmd')
    expect(nodeCommandRelative('mac')).toBe('node_modules/.bin/node')
  })

  it('asserts every shim it writes', () => {
    for (const platform of ['mac', 'win'] as const) {
      const written = new Set(closureShims(platform, PRODUCT).map(shim => `node_modules/.bin/${shim.name}`))
      expect(written.has(nodeCommandRelative(platform))).toBe(true)
    }
  })
})
