/** Readiness detection over runtime output that arrives in arbitrary chunks. */

import { describe, expect, it } from 'vitest'
import { ReadinessScanner } from '../src/readiness.ts'

describe('ReadinessScanner', () => {
  it('reports the URL from a whole line', () => {
    const scanner = new ReadinessScanner()
    expect(scanner.push('dsh web: http://127.0.0.1:5321\n')).toBe('http://127.0.0.1:5321')
    expect(scanner.url).toBe('http://127.0.0.1:5321')
  })

  it('joins a line split across chunks', () => {
    const scanner = new ReadinessScanner()
    expect(scanner.push('boot noise\ndsh web: http')).toBeUndefined()
    expect(scanner.push('://127.0.0.1:41234\n')).toBe('http://127.0.0.1:41234')
  })

  it('stops at the loopback URL when a LAN address follows it', () => {
    const scanner = new ReadinessScanner()
    expect(scanner.push('dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)\n'))
      .toBe('http://127.0.0.1:3080')
  })

  it('ignores everything after the first report', () => {
    const scanner = new ReadinessScanner()
    scanner.push('dsh web: http://127.0.0.1:1\n')
    expect(scanner.push('dsh web: http://127.0.0.1:2\n')).toBeUndefined()
    expect(scanner.url).toBe('http://127.0.0.1:1')
  })

  it('keeps the scan window bounded while no line arrives', () => {
    const scanner = new ReadinessScanner()
    for (let index = 0; index < 40; index += 1) expect(scanner.push('x'.repeat(4096))).toBeUndefined()
    // The retained tail still joins with a line that arrives afterwards.
    expect(scanner.push('\ndsh web: http://127.0.0.1:9\n')).toBe('http://127.0.0.1:9')
  })

  it('does not match a line that only mentions the runtime', () => {
    const scanner = new ReadinessScanner()
    expect(scanner.push('starting dsh web: soon\n')).toBeUndefined()
  })
})
