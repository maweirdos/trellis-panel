/** Static design-rule checks for source tokens and shared brand assets. */
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import postcss from 'postcss'

const read = file => readFileSync(file, 'utf8')
const root = 'src/renderer/src/'
const tokens = read(root + 'my/my-tokens.css')
const sources = [...globSync(root + '**/*.{ts,tsx,css}')].map(read).join('\n') + read('tailwind.config.js')
const allowedRoots = new Set([root + 'App.tsx', root + 'daemon/BootstrapGate.tsx'])
for (const file of globSync(root + '**/*.tsx')) {
  if (!allowedRoots.has(file.replace(/\\/g, '/'))) assert.doesNotMatch(read(file), /className=["'][^"']*\bmy-root\b/, `only App and BootstrapGate own typography roots: ${file}`)
}
assert.doesNotMatch(sources, /border-(?:left|inline-start)(?:-color)?\s*:[^;}]*--my-(?:txt|border|bg)-(?:danger|warning|success|info|blue)/, 'severity never uses a colored leading border')
assert.doesNotMatch(sources, /--leaf-|(?:bg|text|border)-leaf\b|@fontsource-variable\/inter/)
assert.doesNotMatch(sources, /(?:text-\[\d+(?:\.\d+)?px\]|rounded-\[\d+(?:\.\d+)?px\])/)
for (const sheet of ['acp/workspace.css', 'my/my-components.css', 'my/my-feedback.css', 'my/my-applications.css', 'git-workspace/git-workspace.css']) {
  assert.doesNotMatch(read(root + sheet), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i, `palette values must come from my-tokens.css: ${sheet}`)
}
const declared = new Set([...sources.matchAll(/(--my-[\w-]+)['"]?\s*:/g)].map(match => match[1]))
for (const [, reference] of sources.matchAll(/var\((--my-[\w-]+)\s*\)/g)) assert.ok(declared.has(reference), `undefined token ${reference}`)
const tokenTree = postcss.parse(tokens)
const base = Object.fromEntries(tokenTree.nodes.find(node => node.type === 'rule' && node.selector.replace(/\s/g, '') === ':root,.my-root').nodes.map(node => [node.prop, node.value]))
const themes = Object.fromEntries(['light', 'dark'].map(theme => {
  const rule = tokenTree.nodes.find(node => node.type === 'rule' && node.selector.includes(`[data-my-theme='${theme}']`))
  return [theme, { ...base, ...Object.fromEntries(rule.nodes.map(node => [node.prop, node.value])) }]
}))
for (const [theme, values] of Object.entries(themes)) {
  const visit = (name, trail = []) => {
    assert.ok(!trail.includes(name), `${theme} circular token ${[...trail, name].join(' -> ')}`)
    for (const [, next] of (values[name] ?? '').matchAll(/var\((--my-[\w-]+)/g)) visit(next, [...trail, name])
  }
  for (const name of Object.keys(values)) visit(name)
}
const markPath = read('resources/brand/mark.svg').match(/<path[^>]+d="([^"]+)"/)[1]
assert.ok(read('src/renderer/public/favicon.svg').includes(markPath), 'favicon derives from the canonical mark')
assert.ok(read('src/renderer/src/my/BrandMark.tsx').includes('resources/brand/mark.svg?url'))
const ico = readFileSync('resources/brand/icon.ico')
const appId = read('electron-builder.yml').match(/^appId:\s*(\S+)/m)[1]
assert.ok(read('src/main/services/window-branding.ts').includes(`APPLICATION_ID = '${appId}'`), 'native taskbar identity matches the packaged application')
assert.equal(ico.readUInt16LE(2), 1)
assert.equal(ico.readUInt16LE(4), 7)
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  const png = readFileSync(`resources/brand/icon-${size}.png`)
  assert.equal(png.readUInt32BE(16), size)
  assert.equal(png.readUInt32BE(20), size)
}
console.log('PASS canonical tokens, dependency graph, no legacy brand, same-source brand assets')
