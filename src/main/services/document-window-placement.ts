/** Electron screen bounds are DIP already, including mixed-DPI displays. */
export interface ReaderWindowBounds { x: number; y: number; width: number; height: number }
export function readerWindowBounds(area: ReaderWindowBounds, anchor: ReaderWindowBounds, retained?: ReaderWindowBounds, cascade = 0): ReaderWindowBounds {
  const margin = 8
  const width = Math.max(1, Math.min(retained?.width ?? 1000, area.width - margin * 2))
  const height = Math.max(1, Math.min(retained?.height ?? 900, area.height - margin * 2))
  const clamp = (value: number, start: number, space: number, size: number): number => Math.round(Math.max(start + margin, Math.min(start + space - size - margin, value)))
  return { width: Math.round(width), height: Math.round(height),
    x: clamp(retained?.x ?? anchor.x + (anchor.width - width) / 2 + cascade, area.x, area.width, width),
    y: clamp(retained?.y ?? anchor.y + (anchor.height - height) / 2 + cascade, area.y, area.height, height) }
}
