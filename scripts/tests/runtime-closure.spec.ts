/**
 * The Windows pnpm shim: the one command in the closure that a cross-built
 * Windows target does not get for free, and that the plugin hub installs
 * through.
 */

import { describe, expect, it } from 'vitest'
import { windowsPnpmShim } from '../runtime-closure.ts'

const shim = windowsPnpmShim('DeepSeek Harness.exe')

describe('windowsPnpmShim', () => {
  it('reaches the application binary rather than a node.exe the bundle does not ship', () => {
    expect(shim).toContain('SET "ELECTRON_RUN_AS_NODE=1"')
    expect(shim).toContain('"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe"')
  })

  it('quotes the executable, whose name has a space in it', () => {
    const line = shim.split('\r\n').find(entry => entry.startsWith('"%~dp0'))
    expect(line).toBeDefined()
    expect(line).toContain('DeepSeek Harness.exe"')
  })

  it('runs the pnpm the closure carries, not one it hopes to find', () => {
    expect(shim).toContain('"%~dp0..\\pnpm\\bin\\pnpm.mjs"')
  })

  it('forwards every argument, because dsh plugin passes a whole pnpm command line', () => {
    expect(shim).toContain(' %*')
  })

  it('propagates the exit code, which is how dsh plugin knows an install failed', () => {
    expect(shim.trimEnd().endsWith('ENDLOCAL & EXIT /B %ERRORLEVEL%')).toBe(true)
  })

  it('is CRLF-terminated, as a batch file has to be', () => {
    expect(shim.endsWith('\r\n')).toBe(true)
    expect(shim.split('\n').every(line => line === '' || line.endsWith('\r'))).toBe(true)
  })

  it('names whichever executable it is given', () => {
    expect(windowsPnpmShim('Other.exe')).toContain('\\Other.exe"')
  })
})
