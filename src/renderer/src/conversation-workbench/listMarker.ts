const LIST_MARKER_PROBE_TEXT = '0. '
const LIST_MARKER_PROBE_FONT_SIZE = 16
let listMarkerSansEm: string | undefined

/**
 * Ported from t3code@28c58b1 apps/web/src/appearanceFonts.ts: the widest single-digit
 * `ol` marker, measured in the interface font so a multi-digit gutter fits it.
 * Returns em so the value follows the reader's type scale.
 */
export function resolveListMarkerSansEm(fontFamily: string): string | undefined {
  if (listMarkerSansEm !== undefined) return listMarkerSansEm
  try {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return undefined
    context.font = `${LIST_MARKER_PROBE_FONT_SIZE}px ${fontFamily}`
    const width = context.measureText(LIST_MARKER_PROBE_TEXT).width
    if (!(width > 0)) return undefined
    listMarkerSansEm = `${(width / LIST_MARKER_PROBE_FONT_SIZE).toFixed(3)}em`
    return listMarkerSansEm
  } catch {
    return undefined
  }
}
