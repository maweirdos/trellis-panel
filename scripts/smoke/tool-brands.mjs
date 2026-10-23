/** Offline brand provenance/alias checks and real Chromium rendering of every asset. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { load as loadYaml } from 'js-yaml'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-tool-brands-'))
const outputIndex = process.argv.indexOf('--output')
const output = resolve(outputIndex < 0 ? join(directory, 'evidence') : process.argv[outputIndex + 1])
mkdirSync(output, { recursive: true })
const absolute = (path) => resolve(path).replaceAll('\\', '/')
const assetsRoot = resolve('src/renderer/src/assets/tool-brands')
const manifest = JSON.parse(readFileSync(join(assetsRoot, 'provenance.json'), 'utf8'))
const require = createRequire(import.meta.url)

// Use the packager's own glob matcher; artwork imports do not carry adjacent notices.
const { Minimatch } = createRequire(require.resolve('app-builder-lib/package.json'))('minimatch')
const noticesRoot = resolve('resources/licenses/tool-brands')
const noticeFiles = readdirSync(assetsRoot).filter(file => /^(?:LICENSE\..+|NOTICE\..+|provenance\.json)$/.test(file)).sort()
assert.deepEqual(readdirSync(noticesRoot).sort(), [...noticeFiles, 'README.md'].sort(), 'distributed notice inventory stays synchronized')
for (const file of noticeFiles) {
  assert.deepEqual(readFileSync(join(noticesRoot, file)), readFileSync(join(assetsRoot, file)), `distributed bytes ${file}`)
}
const distributedReadme = readFileSync(join(noticesRoot, 'README.md'), 'utf8')
assert.ok(distributedReadme.endsWith(readFileSync(join(assetsRoot, 'README.md'), 'utf8')), 'distributed source README stays synchronized')
assert.ok(distributedReadme.includes('resources/licenses/**') && /no\s+stated license/.test(distributedReadme), 'distribution README identifies package inclusion and website-license facts')
const websiteAssets = manifest.assets.filter(asset => !asset.repository)
assert.equal(websiteAssets.length, 4)
assert.ok(websiteAssets.every(asset => asset.license === 'LicenseRef-Upstream-Trademark'), 'website assets have no inferred open license')
const packageFiles = loadYaml(readFileSync('electron-builder.yml', 'utf8')).files
assert.ok(Array.isArray(packageFiles) && packageFiles.every(pattern => typeof pattern === 'string'), 'package file rules use understood string globs')
for (const file of [...noticeFiles, 'README.md']) {
  const path = `resources/licenses/tool-brands/${file}`
  assert.ok(packageFiles.some(pattern => !pattern.startsWith('!') && new Minimatch(pattern, { dot: true }).match(path))
    && !packageFiles.some(pattern => pattern.startsWith('!') && new Minimatch(pattern.slice(1), { dot: true }).match(path)), `installer includes ${file}`)
}
console.log(`Brand distribution notices: ${noticeFiles.length + 1} files match source and existing package inputs; 4 website licenses remain unstated.`)
if (process.argv.includes('--notices-only')) process.exit(0)

await build({ entryPoints: ['src/shared/tool-brands.ts'], outfile: join(directory, 'registry.cjs'), bundle: true, platform: 'node', format: 'cjs' })
const { TOOL_BRANDS, getToolBrand } = require(join(directory, 'registry.cjs'))
assert.equal(TOOL_BRANDS.length, manifest.assets.length)
assert.deepEqual(new Set(readdirSync(assetsRoot).filter((file) => /\.(svg|png)$/.test(file))), new Set(TOOL_BRANDS.map((brand) => brand.assetKey)))
const aliases = new Set()
const svgSources = []
for (const brand of TOOL_BRANDS) {
  for (const alias of [brand.id, ...brand.aliases]) {
    assert.equal(aliases.has(alias), false, `duplicate alias ${alias}`)
    aliases.add(alias)
    assert.equal(getToolBrand(` ${alias.toUpperCase()} `)?.id, brand.id)
  }
  const provenance = manifest.assets.find((entry) => entry.id === brand.id)
  assert.ok(provenance, `provenance ${brand.id}`)
  assert.equal(provenance.assetKey, brand.assetKey)
  assert.equal(provenance.mode, brand.mode)
  const asset = readFileSync(join(assetsRoot, brand.assetKey))
  assert.equal(createHash('sha256').update(asset).digest('hex'), provenance.sha256, `hash ${brand.id}`)
  assert.equal(asset.length, provenance.bytes)
  assert.ok(readFileSync(join(assetsRoot, provenance.licenseFile), 'utf8').length > 100)
  if (provenance.repository) {
    assert.match(provenance.commit, /^[a-f0-9]{40}$/)
    assert.ok(provenance.sourceUrl.includes(provenance.commit))
  } else {
    assert.equal(provenance.license, 'LicenseRef-Upstream-Trademark')
    assert.match(provenance.retrievedAt, /^\d{4}-\d{2}-\d{2}$/)
  }
  if (brand.assetKey.endsWith('.png')) {
    assert.equal(asset.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.ok(asset.readUInt32BE(16) > 0 && asset.readUInt32BE(20) > 0)
  } else {
    const svg = asset.toString('utf8')
    assert.doesNotMatch(svg, /<(?:script|foreignObject|iframe|image|animate\w*|set)\b|<!ENTITY|@import|javascript:|\son\w+\s*=/i)
    if (/prefers-color-scheme/i.test(svg)) {
      // Factory's original wrapper declares filter:none identically for both schemes.
      // Keep the original bytes while rejecting artwork whose appearance depends on OS theme.
      const rules = [...svg.matchAll(/@media\s*\(prefers-color-scheme:\s*(?:light|dark)\)\s*\{\s*:root\s*\{([^}]*)\}\s*\}/gi)]
      assert.equal(rules.length, (svg.match(/prefers-color-scheme/gi) ?? []).length, `theme rules understood: ${brand.id}`)
      assert.ok(rules.every((rule) => rule[1].replace(/\s/g, '') === 'filter:none;'), `artwork independent of OS theme: ${brand.id}`)
    }
    for (const reference of svg.matchAll(/(?:\b(?:xlink:)?href\s*=\s*['"]([^'"]*)['"]|url\(\s*['"]?([^)'"\s]+))/gi)) {
      assert.ok((reference[1] ?? reference[2]).startsWith('#'), `external content in ${brand.id}`)
    }
    svgSources.push({ id: brand.id, svg })
  }
}
assert.equal(getToolBrand('copilot')?.id, 'github-copilot')
assert.notEqual(getToolBrand('devin')?.id, getToolBrand('windsurf')?.id)
assert.notEqual(getToolBrand('codex')?.assetKey, getToolBrand('claude-code')?.assetKey)
assert.notEqual(getToolBrand('zcode')?.assetKey, getToolBrand('codex')?.assetKey)
for (const unknown of [undefined, '', 'panel', 'custom-engine', 'openai', 'anthropic', 'z.ai', 'microsoft-copilot', 'prefix-codex-suffix', 'toString', ...manifest.unverified]) {
  assert.equal(getToolBrand(unknown), undefined, `neutral ${unknown}`)
}

const fixture = `import React from '${absolute('node_modules/react/index.js')}';
import {createRoot} from '${absolute('node_modules/react-dom/client.js')}';
import {flushSync} from '${absolute('node_modules/react-dom/index.js')}';
import {ToolBrandIcon} from '${absolute('src/renderer/src/components/ToolBrandIcon.tsx')}';
import {TOOL_BRANDS} from '${absolute('src/shared/tool-brands.ts')}';
const root=createRoot(document.getElementById('root'));
window.renderBrands=(dark)=>{document.body.classList.toggle('dark',dark);flushSync(()=>root.render(<main>{TOOL_BRANDS.map(brand=><section data-catalog-brand={brand.id} key={brand.id}><ToolBrandIcon brand={brand.id}/><ToolBrandIcon brand={brand.id} size={32} className="large"/><span>{brand.label}</span></section>)}<section data-catalog-brand="unknown"><ToolBrandIcon brand="custom-engine"/><ToolBrandIcon brand={undefined} size={32}/><span>Unknown / unbound</span></section></main>))};
window.renderBrands(false);`

async function electronChecks() {
  const { app, BrowserWindow } = require('electron')
  const assert = require('node:assert/strict')
  const { readFileSync, writeFileSync } = require('node:fs')
  const { join } = require('node:path')
  const output = process.argv[2]
  const { svgSources, brandCount } = JSON.parse(readFileSync(join(__dirname, 'svg-sources.json'), 'utf8'))
  app.setPath('userData', join(__dirname, 'profile'))
  await app.whenReady()
  const window = new BrowserWindow({ width: 1120, height: 1000, show: false, webPreferences: { contextIsolation: true, sandbox: true } })
  const errors = []
  window.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message) })
  await window.loadFile(join(__dirname, 'index.html'))
  const js = (source) => window.webContents.executeJavaScript(source, true)
  const validated = await js(`(${JSON.stringify(svgSources)}).map(({id,svg})=>{
    const doc=new DOMParser().parseFromString(svg,'image/svg+xml');
    return {id,valid:!doc.querySelector('parsererror')&&doc.documentElement.localName==='svg'};
  })`)
  assert.ok(validated.every((item) => item.valid), 'every SVG parses as SVG')
  const screenshots = []
  for (const dark of [false, true]) {
    await js(`window.renderBrands(${dark})`)
    await js(`Promise.all([...document.images].map(img=>img.decode()))`)
    const metrics = await js(`Promise.all([...document.querySelectorAll('.tool-brand-icon')].map(async icon=>{
      const style=getComputedStyle(icon), bounds=icon.getBoundingClientRect(), mask=icon.querySelector('.tool-brand-icon__mask'), image=icon.querySelector('img');
      if(mask){const asset=new Image();asset.src=getComputedStyle(mask).maskImage.slice(5,-2);await asset.decode()}
      return {brand:icon.dataset.toolBrand,mode:icon.dataset.toolBrandMode,width:bounds.width,height:bounds.height,hidden:icon.getAttribute('aria-hidden')==='true',color:style.color,maskColor:mask&&getComputedStyle(mask).backgroundColor,imageLoaded:!image||image.naturalWidth>0,contain:!image||getComputedStyle(image).objectFit==='contain',local:!image||image.src.startsWith('file:')};
    }))`)
    assert.equal(metrics.length, 2 * (brandCount + 1), 'every known brand plus neutral entry renders at both sizes')
    for (const item of metrics) {
      assert.ok([16, 32].includes(item.width) && item.width === item.height, `${item.brand} square slot`)
      assert.ok(item.hidden && item.imageLoaded && item.contain && item.local, `${item.brand} decorative/local/loaded/contained`)
      if (item.mode === 'mask') assert.equal(item.maskColor, item.color, `${item.brand} theme inheritance`)
    }
    assert.equal(metrics.filter((item) => item.brand === 'unknown').length, 2)
    await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const name = `tool-brands-${dark ? 'dark' : 'light'}.png`
    writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
    screenshots.push(name)
  }
  assert.deepEqual(errors, [])
  writeFileSync(join(output, 'report.json'), JSON.stringify({ result: 'passed', brands: brandCount, svgAssets: validated.length, screenshots, checks: ['explicit aliases and neutral unknowns', 'manifest bytes/hash/license/pins', 'safe SVG markup and parsing', 'all image/mask files decode offline', '16/32 square slots', 'decorative accessibility', 'light/dark currentColor masks', 'no OS theme dependencies in image assets'] }, null, 2))
  console.log('Brand catalog Chromium checks passed: ' + output)
  app.exit(0)
}

writeFileSync(join(directory, 'entry.tsx'), fixture)
await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'renderer.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', nodePaths: [absolute('node_modules')], alias: { '@shared': absolute('src/shared') }, loader: { '.svg': 'file', '.png': 'file' }, assetNames: 'assets/[name]-[hash]' })
writeFileSync(join(directory, 'svg-sources.json'), JSON.stringify({ svgSources, brandCount: TOOL_BRANDS.length }))
writeFileSync(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><style>body{margin:0;padding:24px;background:#fff;color:#222;font:13px system-ui}.dark{background:#181818;color:#eee}main{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}section{display:flex;align-items:center;gap:8px;height:76px}section span:last-child{line-height:1.4}section .large{margin-left:2px}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
writeFileSync(join(directory, 'main.cjs'), `(${electronChecks.toString()})().catch(error=>{console.error(error);require('electron').app.exit(1)});setTimeout(()=>{console.error('brand catalog UI timed out');require('electron').app.exit(1)},30000)`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  const result = await promisify(execFile)(require('electron'), [join(directory, 'main.cjs'), output, '--no-sandbox'], { env, windowsHide: true, timeout: 40000, maxBuffer: 1024 * 1024 })
  process.stdout.write(result.stdout)
  console.log(`Brand catalog: ${TOOL_BRANDS.length} brands, ${aliases.size - TOOL_BRANDS.length} explicit aliases; provenance and assets passed.`)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
}
