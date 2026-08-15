/** Restored window geometry validated against the displays currently attached. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_GEOMETRY, MIN_HEIGHT, MIN_WIDTH, normalizeGeometry } from '../src/window-state.ts'

const laptop = { x: 0, y: 25, width: 1512, height: 945 }

describe('normalizeGeometry', () => {
  it('falls back to the default for a missing or damaged file', () => {
    expect(normalizeGeometry(undefined, [laptop])).toEqual(DEFAULT_GEOMETRY)
    expect(normalizeGeometry('{}', [laptop])).toEqual(DEFAULT_GEOMETRY)
    expect(normalizeGeometry(null, [laptop])).toEqual(DEFAULT_GEOMETRY)
  })

  it('keeps a position that still lands on a display', () => {
    expect(normalizeGeometry({ x: 100, y: 100, width: 1000, height: 700 }, [laptop]))
      .toEqual({ x: 100, y: 100, width: 1000, height: 700 })
  })

  it('drops a position from a display that is no longer attached', () => {
    expect(normalizeGeometry({ x: 3000, y: 200, width: 1000, height: 700 }, [laptop]))
      .toEqual({ width: 1000, height: 700 })
  })

  it('drops a position that only grazes a display', () => {
    expect(normalizeGeometry({ x: 1502, y: 100, width: 1000, height: 700 }, [laptop]))
      .toEqual({ width: 1000, height: 700 })
  })

  it('keeps a position on a second display', () => {
    const external = { x: 1512, y: 0, width: 2560, height: 1440 }
    expect(normalizeGeometry({ x: 2000, y: 300, width: 1000, height: 700 }, [laptop, external]))
      .toEqual({ x: 2000, y: 300, width: 1000, height: 700 })
  })

  it('clamps a size below the usable minimum', () => {
    expect(normalizeGeometry({ width: 100, height: 50 }, [laptop]))
      .toEqual({ width: MIN_WIDTH, height: MIN_HEIGHT })
  })

  it('rejects non-finite fields rather than opening a window on them', () => {
    expect(normalizeGeometry({ x: Number.NaN, y: 0, width: 900, height: 600 }, [laptop]))
      .toEqual({ width: 900, height: 600 })
    expect(normalizeGeometry({ width: 'wide', height: null }, [laptop])).toEqual(DEFAULT_GEOMETRY)
  })

  it('drops a position when no display is attached', () => {
    expect(normalizeGeometry({ x: 10, y: 10, width: 900, height: 600 }, []))
      .toEqual({ width: 900, height: 600 })
  })
})
