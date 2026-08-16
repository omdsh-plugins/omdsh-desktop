/**
 * The commands a shipped closure needs and pnpm does not leave behind: the
 * `node` the bundled pnpm's own shebang looks for, package-manager commands
 * for git dependency preparation, and the Windows `pnpm.cmd` a cross-built
 * closure never gets.
 */

import { describe, expect, it } from 'vitest'
import { closureShims, launcherFromBin, nodeCommandRelative, npmCommandRelative, patchDirectoryPickerWorkerSource, pnpmCommandRelative, posixNodeShim, posixPackageManagerShim, windowsShim } from '../runtime-closure.ts'

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

  it('uses the shipped pnpm when git preparation falls back to npm', () => {
    const shim = body('win', 'npm.cmd')
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
  it('writes node, pnpm, and the npm compatibility command on Windows', () => {
    expect(closureShims('win', PRODUCT).map(shim => shim.name)).toEqual(['node.cmd', 'pnpm.cmd', 'npm.cmd'])
  })

  it('adds npm on macOS, where pnpm itself already has a runnable symlink', () => {
    expect(closureShims('mac', PRODUCT).map(shim => shim.name)).toEqual(['node', 'npm'])
  })
})

describe('the commands packaging asserts', () => {
  it('names what each platform actually resolves', () => {
    expect(pnpmCommandRelative('win')).toBe('node_modules/.bin/pnpm.cmd')
    expect(pnpmCommandRelative('mac')).toBe('node_modules/.bin/pnpm')
    expect(nodeCommandRelative('win')).toBe('node_modules/.bin/node.cmd')
    expect(nodeCommandRelative('mac')).toBe('node_modules/.bin/node')
    expect(npmCommandRelative('win')).toBe('node_modules/.bin/npm.cmd')
    expect(npmCommandRelative('mac')).toBe('node_modules/.bin/npm')
  })

  it('asserts every shim it writes', () => {
    for (const platform of ['mac', 'win'] as const) {
      const written = new Set(closureShims(platform, PRODUCT).map(shim => `node_modules/.bin/${shim.name}`))
      expect(written.has(nodeCommandRelative(platform))).toBe(true)
      expect(written.has(npmCommandRelative(platform))).toBe(true)
    }
  })
})

describe('posixPackageManagerShim', () => {
  const shim = posixPackageManagerShim(launcherFromBin('mac', PRODUCT), '../pnpm/bin/pnpm.mjs')

  it('forwards npm-compatible git preparation calls to the shipped pnpm', () => {
    expect(shim).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(shim).toContain('"$(dirname "$0")/../pnpm/bin/pnpm.mjs" "$@"')
  })

  it('is executable in the packaged closure', () => {
    expect(closureShims('mac', PRODUCT).find(entry => entry.name === 'npm')?.mode).toBe(0o755)
  })
})

describe('patchDirectoryPickerWorkerSource', () => {
  const publishedWorker = [
    'function readUtf16(koffi, address) {',
    '\tconst bytes = Buffer.from(koffi.view(address, 32768));',
    '\tlet end = 0;',
    '\twhile (end + 1 < bytes.length && bytes[end] !== 0) end += 2;',
    '\treturn bytes.toString("utf16le", 0, end);',
    '}',
    'const post = (message) => {',
    '\tsend(message, () => {',
    '\t\tif (process.connected) process.disconnect();',
    '\t});',
    '};',
    '(async () => {',
    '\ttry {',
    '\t\tpost({',
    '\t\t\tkind: "done"',
    '\t\t});',
    '\t} catch (error) {',
    '\t\tpost({',
    '\t\t\tkind: "error"',
    '\t\t});',
    '\t}',
    '})();',
    '//#endregion',
  ].join('\n')

  it('keeps IPC connected for showing and disconnects only on terminal messages', () => {
    const patched = patchDirectoryPickerWorkerSource(publishedWorker)
    expect(patched).toContain('return koffi.decode.string16(address);')
    expect(patched).not.toContain('koffi.view(address, 32768)')
    expect(patched).toContain('const post = (message, terminal = false) => {')
    expect(patched).toContain('if (terminal && process.connected) process.disconnect();')
    expect(patched.match(/}, true\);/g)).toHaveLength(2)
  })

  it('is idempotent for a closure reused with --skip-deploy', () => {
    const patched = patchDirectoryPickerWorkerSource(publishedWorker)
    expect(patchDirectoryPickerWorkerSource(patched)).toBe(patched)
  })

  it('rejects an unknown upstream lifecycle instead of shipping it unchecked', () => {
    expect(() => patchDirectoryPickerWorkerSource('different worker')).toThrow(/no longer matches/)
  })
})
