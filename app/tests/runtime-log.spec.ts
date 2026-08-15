/** The runtime log file and the in-memory tail the failure surface reads. */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LogTail, openRuntimeLog } from '../src/runtime-log.ts'

describe('LogTail', () => {
  it('splits chunks into lines', () => {
    const tail = new LogTail()
    tail.push('first\nsecond\n')
    expect(tail.read()).toEqual(['first', 'second'])
  })

  it('joins a line split across chunks', () => {
    const tail = new LogTail()
    tail.push('half')
    tail.push('-line\n')
    expect(tail.read()).toEqual(['half-line'])
  })

  it('keeps an unterminated last line, which is where a crash message stops', () => {
    const tail = new LogTail()
    tail.push('done\npartial')
    expect(tail.read()).toEqual(['done', 'partial'])
  })

  it('retains a bounded tail of a long run', () => {
    const tail = new LogTail()
    for (let index = 0; index < 500; index += 1) tail.push(`line ${String(index)}\n`)
    const lines = tail.read()
    expect(lines).toHaveLength(200)
    expect(lines.at(-1)).toBe('line 499')
  })
})

describe('openRuntimeLog', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-log-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('appends output and serves the same content as its tail', async () => {
    const log = openRuntimeLog({ directory, filename: 'runtime.log' })
    log.write('booting\n')
    log.write('serving\n')
    expect(await readFile(log.path, 'utf8')).toBe('booting\nserving\n')
    expect(log.tail()).toEqual(['booting', 'serving'])
  })

  it('truncates on reset, so one file holds one run', async () => {
    const log = openRuntimeLog({ directory, filename: 'runtime.log' })
    log.write('previous run\n')
    log.reset()
    log.write('this run\n')
    expect(await readFile(log.path, 'utf8')).toBe('this run\n')
  })

  it('rotates once the file reaches its bound', async () => {
    const log = openRuntimeLog({ directory, filename: 'runtime.log', maxBytes: 64 })
    log.write('x'.repeat(100))
    log.write('after rotation\n')
    expect(await readFile(log.path, 'utf8')).toBe('after rotation\n')
    expect((await stat(`${log.path}.1`)).size).toBe(100)
  })

  it('creates the log directory it was pointed at', async () => {
    const nested = join(directory, 'Logs', 'DeepSeek Harness')
    const log = openRuntimeLog({ directory: nested, filename: 'runtime.log' })
    log.write('created\n')
    expect(await readFile(log.path, 'utf8')).toBe('created\n')
  })
})
