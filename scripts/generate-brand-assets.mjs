import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRAND_ICON_SIZES, BRAND_ICO_SIZES, BRAND_COMPACT_SIZES, brandMarkSvg, brandTileSvg, validateBrandGeometry } from './brand-asset-source.mjs'

// Assets are checked in. Regeneration accepts a local sharp installation without adding a runtime dependency.
const require = createRequire(import.meta.url)
const sharpPath = process.argv[2] || 'sharp'
const sharp = require(sharpPath)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const geometry = JSON.parse(await readFile(resolve(root, 'resources/brand/geometry.json'), 'utf8'))
validateBrandGeometry(geometry)
const output = resolve(root, 'resources/brand')
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'mark.svg'), brandMarkSvg(geometry))
for (const size of BRAND_COMPACT_SIZES) {
  await writeFile(resolve(output, size === 24 ? 'mark-compact.svg' : `mark-${size}.svg`), brandMarkSvg(geometry, { size, optical: true }))
}
const tile = brandTileSvg(geometry, 16)
await writeFile(resolve(output, 'favicon.svg'), tile)
for (const directory of ['src/renderer/public', 'packages/team-web/public']) {
  await mkdir(resolve(root, directory), { recursive: true })
  await writeFile(resolve(root, directory, 'favicon.svg'), tile)
}
const png = async (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
for (const size of BRAND_ICON_SIZES) {
  await writeFile(resolve(output, `icon-${size}.png`), await png(brandTileSvg(geometry, size), size))
}
for (const [name, color] of [['light', '#ffffff'], ['dark', '#1a1c1f']]) {
  await writeFile(resolve(output, `tray-${name}.png`), await png(brandMarkSvg(geometry, { size: 32, optical: true, color }), 32))
}
// PNG-compressed ICO entries are supported by Windows/Electron; all frames render from the same SVG.
const sizes = BRAND_ICO_SIZES
const frames = await Promise.all(sizes.map(size => readFile(resolve(output, `icon-${size}.png`))))
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
frames.forEach((frame, i) => {
  const at = 6 + i * 16
  header[at] = sizes[i] === 256 ? 0 : sizes[i]
  header[at + 1] = header[at]
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(frame.length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += frame.length
})
await writeFile(resolve(output, 'icon.ico'), Buffer.concat([header, ...frames]))
console.log(`Generated same-source Crux vectors, ${BRAND_ICON_SIZES.length} PNG sizes, transparent tray marks and ${sizes.length}-frame ICO`)
