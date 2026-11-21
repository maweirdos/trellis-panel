import { components, coreIds as sourceCoreIds, displayGrid, rx, shapes, size, viewBox } from '../../../../../resources/brand/geometry.json'

export type BrandMotionState = 'observe' | 'c' | 'loading' | 'waiting'
interface Point { x: number; y: number }
interface Cell { id: string; row: number; col: number; members: string[] }
interface Unit {
  id: string
  clockwiseIndex: number
  children: Cell[]
  loadingCenter: Point
  waitingCenter: Point
  loadingSize: number
  waitingSize: number
}
interface Geometry {
  viewBox: number[]
  size: number
  rx: number
  coreIds: string[]
  shapes: { observer: Record<string, Point>; c: Record<string, Point> }
  components: Unit[]
  displayGrid: { loadingGap: number; waitingGap: number }
}
export const geometry: Geometry = {
  viewBox, size, rx, coreIds: sourceCoreIds,
  shapes: { observer: shapes.observer, c: shapes.c },
  components, displayGrid
}
export const coreIds = new Set(geometry.coreIds)

interface PixelTarget extends Point { sx: number; sy: number; visible: boolean }

function compactCell(unit: Unit, cell: Cell, state: 'loading' | 'waiting', size: number): PixelTarget {
  const scale = size / geometry.viewBox[2]
  const opticalScale = Math.min(1.3, 24 / size)
  const center = state === 'loading' ? unit.loadingCenter : unit.waitingCenter
  const originX = geometry.viewBox[0] + geometry.viewBox[2] / 2
  const originY = geometry.viewBox[1] + geometry.viewBox[3] / 2
  const parentSize = (state === 'loading' ? unit.loadingSize : unit.waitingSize) * opticalScale * scale
  // An odd parent extent leaves one whole CSS pixel between equal square children.
  const side = Math.max(1, Math.round((parentSize - 1) / 2))
  const extent = side * 2 + 1
  const left = Math.round((originX + (center.x - originX) * opticalScale) * scale - extent / 2)
  const top = Math.round((originY + (center.y - originY) * opticalScale) * scale - extent / 2)
  return {
    x: (left + cell.col * (side + 1) + side / 2) / scale,
    y: (top + cell.row * (side + 1) + side / 2) / scale,
    sx: side / (geometry.size * scale),
    sy: side / (geometry.size * scale),
    visible: true
  }
}

export function pixelTarget(id: string, unit: Unit, cell: Cell, state: BrandMotionState, size: number): PixelTarget {
  if (state === 'observe' || state === 'c') {
    return { ...geometry.shapes[state === 'observe' ? 'observer' : 'c'][id], sx: 1, sy: 1, visible: true }
  }
  const visible = id === cell.members[0]
  if (size <= 24) return { ...compactCell(unit, cell, state, size), visible }
  const center = state === 'loading' ? unit.loadingCenter : unit.waitingCenter
  const parentSize = state === 'loading' ? unit.loadingSize : unit.waitingSize
  const gap = state === 'loading' ? geometry.displayGrid.loadingGap : geometry.displayGrid.waitingGap
  const side = (parentSize - gap) / 2
  return {
    x: center.x - parentSize / 2 + cell.col * (side + gap) + side / 2,
    y: center.y - parentSize / 2 + cell.row * (side + gap) + side / 2,
    sx: side / geometry.size,
    sy: side / geometry.size,
    visible
  }
}
