/**
 * Persisted window geometry.
 *
 * The state file is a durable boundary written by a previous run and possibly
 * a previous version, and the display layout it was written on may no longer
 * exist, so every field is validated and every restored position is checked
 * against the current displays before it is used.
 * @module @omdsh-plugins/omdsh-desktop/window-state
 */

/** A rectangle in screen coordinates. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Restored geometry; an absent position asks the window manager to place the window. */
export interface WindowGeometry {
  width: number
  height: number
  x?: number
  y?: number
}

/** Geometry for a first run. */
export const DEFAULT_GEOMETRY: WindowGeometry = { width: 1280, height: 860 }

/** Smallest window the harness UI is usable in. */
export const MIN_WIDTH = 720
export const MIN_HEIGHT = 520

/** Visible overlap a restored window needs with some display to count as reachable. */
const MIN_VISIBLE_OVERLAP = 80

/**
 * Whether two rectangles overlap by at least {@link MIN_VISIBLE_OVERLAP} on both axes.
 * @param a - the first rectangle.
 * @param b - the second rectangle.
 * @returns true when the overlap is large enough to grab.
 */
function overlaps(a: Rect, b: Rect): boolean {
  const horizontal = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return horizontal >= MIN_VISIBLE_OVERLAP && vertical >= MIN_VISIBLE_OVERLAP
}

/**
 * Read a number from parsed JSON.
 * @param value - the parsed field.
 * @returns the number, or `undefined` when the field is not a finite number.
 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Validate stored geometry against the current display layout.
 *
 * A stored size is clamped to the usable minimum. A stored position is kept
 * only while it still lands on a display: a window restored onto a monitor
 * that is no longer attached would open off-screen with no way to reach it.
 * @param stored - the parsed contents of the state file, in any shape.
 * @param displays - work areas of the currently attached displays.
 * @returns geometry safe to open a window with.
 */
export function normalizeGeometry(stored: unknown, displays: readonly Rect[]): WindowGeometry {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_GEOMETRY
  const record = stored as Record<string, unknown>
  const width = Math.max(MIN_WIDTH, finiteNumber(record.width) ?? DEFAULT_GEOMETRY.width)
  const height = Math.max(MIN_HEIGHT, finiteNumber(record.height) ?? DEFAULT_GEOMETRY.height)
  const x = finiteNumber(record.x)
  const y = finiteNumber(record.y)
  if (x === undefined || y === undefined) return { width, height }
  const frame: Rect = { x, y, width, height }
  if (!displays.some(display => overlaps(frame, display))) return { width, height }
  return { width, height, x, y }
}
