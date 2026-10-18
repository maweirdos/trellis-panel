import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Assets are checked in. Regeneration accepts a local sharp installation without adding a runtime dependency.
const require = createRequire(import.meta.url)
const sharpPath = process.argv[2] || 'sharp'
const sharp = require(sharpPath)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(resolve(root, 'resources/brand/mark.svg'), 'utf8')
const glyph = source.replace(/<\/?svg\b[^>]*>/g, '').replace(/<title>.*?<\/title>/s, '').trim()
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" color="#ffffff"><rect width="40" height="40" rx="11" fill="#181818"/><g transform="translate(4 4)">${glyph}</g></svg>`
const output = resolve(root, 'resources/brand')
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'favicon.svg'), tile)
await mkdir(resolve(root, 'src/renderer/public'), { recursive: true })
await writeFile(resolve(root, 'src/renderer/public/favicon.svg'), tile)
const png = async (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await writeFile(resolve(output, `icon-${size}.png`), await png(tile, size))
}
for (const [name, color] of [['light', '#ffffff'], ['dark', '#1a1c1f']]) {
  await writeFile(resolve(output, `tray-${name}.png`), await png(source.replace('<svg ', `<svg color="${color}" `), 32))
}
// PNG-compressed ICO entries are supported by Windows/Electron; all frames render from the same SVG.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const frames = await Promise.all(sizes.map(size => png(tile, size)))
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
console.log('Generated SVG favicon, PNG icons, transparent tray marks and 7-frame ICO from resources/brand/mark.svg')
