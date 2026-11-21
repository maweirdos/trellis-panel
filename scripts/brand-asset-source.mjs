import assert from 'node:assert/strict'

export const BRAND_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512, 1024]
export const BRAND_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
export const BRAND_COMPACT_SIZE = 24
export const BRAND_COMPACT_SIZES = [16, 20, BRAND_COMPACT_SIZE]

const number = value => Number(value.toFixed(5))

/** Keep generated vectors and platform rasters on the same persistent pixel geometry. */
export function validateBrandGeometry(geometry) {
  assert.deepEqual(geometry.viewBox, [0, 0, 112, 112])
  assert.equal(geometry.pixels.length, 36)
  assert.equal(new Set(geometry.pixels.map(pixel => pixel.id)).size, 36)
  assert.equal(geometry.coreIds.length, 4)
  assert.equal(geometry.components.length, 4)
  const members = []
  for (const component of geometry.components) {
    assert.equal(component.children.length, 4)
    assert.deepEqual(component.children.map(child => child.members.length), [3, 2, 2, 2])
    const children = component.children.flatMap(child => child.members)
    assert.deepEqual([...children].sort(), [...component.members].sort())
    members.push(...children)
  }
  assert.equal(new Set(members).size, 36)
  assert.deepEqual([...members].sort(), geometry.pixels.map(pixel => pixel.id).sort())
  for (const pixel of geometry.pixels) {
    assert.match(pixel.id, /^[a-z0-9-]+$/)
    assert.ok(Number.isFinite(pixel.x) && Number.isFinite(pixel.y))
    assert.deepEqual(geometry.shapes.observer[pixel.id], { x: pixel.x, y: pixel.y })
  }
}

function rectangles(geometry, size, optical) {
  const scale = size / geometry.viewBox[2]
  return geometry.pixels.map(pixel => {
    let x = (pixel.x - geometry.size / 2) * scale
    let y = (pixel.y - geometry.size / 2) * scale
    let width = geometry.size * scale
    let height = width
    let radius = geometry.rx * scale
    if (optical) {
      // One uniform square and a half-pixel pitch retain the internal gaps.
      // Independent edge rounding would merge modules into uneven bars.
      const pitch = Math.ceil((geometry.size + 2.2) * scale * 2) / 2
      width = size === 20 ? 1 : Math.max(1, Math.round(size / 16 * 2) / 2)
      height = width
      x = size / 2 + (pixel.x - 56) * pitch / 10 - width / 2
      y = size / 2 + (pixel.y - 56) * pitch / 10 - width / 2
      if (size <= 20) { x = Math.round(x); y = Math.round(y) }
      radius = 0
    }
    return `<rect data-pixel="${pixel.id}" x="${number(x)}" y="${number(y)}" width="${number(width)}" height="${number(height)}" rx="${number(radius)}"/>`
  }).join('')
}

function svg(body, size, color, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="none" color="${color}" role="img" aria-labelledby="brand-title"><title id="brand-title">${title}</title>${body}</svg>\n`
}

/** Compact optical sizes retain square modules on a destination half-pixel grid. */
export function brandMarkSvg(geometry, { size = 112, optical = false, color = '#242725' } = {}) {
  return svg(`<g fill="currentColor">${rectangles(geometry, size, optical)}</g>`, size, color, 'Crux')
}

export function brandTileSvg(geometry, size = 112) {
  const background = `<rect width="${size}" height="${size}" rx="${number(size / 4)}" fill="#1a1c1f"/>`
  return svg(`${background}<g fill="currentColor">${rectangles(geometry, size, size <= 32)}</g>`, size, '#ffffff', 'Crux')
}
