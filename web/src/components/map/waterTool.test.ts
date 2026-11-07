import { describe, expect, it } from 'vitest'
import { nearestRiver } from './waterTool'

const segs = [
  { x0: 85, y0: 23, x1: 86, y1: 23, name: 'Damodar' },
  { x0: 85, y0: 24, x1: 86, y1: 24, name: 'Barakar' },
]

describe('nearestRiver', () => {
  it('names the river within reach', () => {
    expect(nearestRiver(segs, 85.5, 23.002, 400)).toBe('Damodar')
    expect(nearestRiver(segs, 85.5, 23.998, 400)).toBe('Barakar')
  })

  it('returns nothing when no river is close enough', () => {
    expect(nearestRiver(segs, 85.5, 23.5, 400)).toBeNull()
  })

  it('measures to the segment, not only to its ends', () => {
    expect(nearestRiver(segs, 85.5, 23.003, 400)).toBe('Damodar') // 330 m from the line, far from either end
  })
})
