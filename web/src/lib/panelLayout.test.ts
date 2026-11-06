import { describe, expect, it } from 'vitest'
import { clampRect, COLUMN_W, CONTROLS_W, DOCK_W, GAP, layoutRects, minSize, MIN_VISIBLE, resizeRect } from './panelLayout'

const W = 1600
const H = 900

describe('panel layouts', () => {
  it('free mode asks nothing of the map or the panels', () => {
    const r = layoutRects('free', W, H)
    expect(r.rects).toEqual({})
    expect(r.padding).toEqual({ left: 0, right: 0 })
  })

  it('two panes: one column on the left, layers above dock, filling the height without overlap', () => {
    const { rects, padding } = layoutRects('two', W, H)
    expect(rects.layers!.x).toBe(GAP)
    expect(rects.layers!.w).toBe(COLUMN_W)
    expect(rects.dock!.x).toBe(GAP)
    expect(rects.layers!.y + rects.layers!.h + GAP).toBe(rects.dock!.y) // a gap between them
    expect(rects.dock!.y + rects.dock!.h + GAP).toBe(H) // down to the bottom margin
    expect(padding).toEqual({ left: COLUMN_W + 2 * GAP, right: 0 })
  })

  it('three panes: layers left, dock right with room for the zoom buttons, map between', () => {
    const { rects, padding } = layoutRects('three', W, H)
    expect(rects.layers!.x + rects.layers!.w).toBeLessThan(rects.dock!.x)
    expect(rects.dock!.x + rects.dock!.w + CONTROLS_W + GAP).toBe(W)
    expect(rects.dock!.w).toBe(DOCK_W)
    expect(padding.left).toBe(COLUMN_W + 2 * GAP)
    expect(padding.right).toBe(W - rects.dock!.x + GAP)
  })

  it('legend and toolbar sit in the map area, clear of the columns, anchored to the bottom', () => {
    for (const mode of ['two', 'three'] as const) {
      const { rects, padding } = layoutRects(mode, W, H)
      for (const id of ['legend', 'toolbar'] as const) {
        expect(rects[id]!.h).toBe(0)
        expect(rects[id]!.x).toBeGreaterThanOrEqual(padding.left)
      }
    }
  })

  it('works on a narrower window without negative sizes', () => {
    const { rects } = layoutRects('three', 900, 600)
    for (const r of Object.values(rects)) {
      expect(r!.w).toBeGreaterThanOrEqual(0)
      expect(r!.x).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('clampRect and resizeRect', () => {
  it('keeps a dragged panel reachable', () => {
    const far = clampRect({ x: 5000, y: 5000, w: 300, h: 300 }, W, H, 'dock')
    expect(far.x).toBeLessThanOrEqual(W - MIN_VISIBLE)
    expect(far.y).toBeLessThanOrEqual(H - 30)
    const left = clampRect({ x: -5000, y: -40, w: 300, h: 300 }, W, H, 'dock')
    expect(left.x + left.w).toBeGreaterThanOrEqual(MIN_VISIBLE)
    expect(left.y).toBe(0)
  })

  it('never shrinks a panel below its minimum', () => {
    const r = clampRect({ x: 10, y: 10, w: 50, h: 50 }, W, H, 'layers')
    expect(r.w).toBe(minSize('layers').w)
    expect(r.h).toBe(minSize('layers').h)
  })

  it('leaves automatic-height panels automatic', () => {
    expect(clampRect({ x: 10, y: 10, w: 0, h: -1 }, W, H, 'legend').h).toBe(-1)
    expect(clampRect({ x: 10, y: 0, w: 0, h: 0 }, W, H, 'toolbar').h).toBe(0)
  })

  it('resizes from the corner within limits', () => {
    const start = { x: 100, y: 100, w: 340, h: 400 }
    expect(resizeRect(start, 100, 50, W, H, 'layers')).toMatchObject({ w: 440, h: 450 })
    expect(resizeRect(start, -500, -500, W, H, 'layers')).toMatchObject({ w: minSize('layers').w, h: minSize('layers').h })
    expect(resizeRect(start, 9999, 9999, W, H, 'layers')).toMatchObject({ w: W - 100, h: H - 100 })
  })
})
