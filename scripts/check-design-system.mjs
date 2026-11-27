/** Static design-rule checks for source tokens and shared brand assets. */
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import postcss from 'postcss'
import { BRAND_ICON_SIZES, BRAND_ICO_SIZES, BRAND_COMPACT_SIZES, brandMarkSvg, brandTileSvg, validateBrandGeometry } from './brand-asset-source.mjs'

const read = file => readFileSync(file, 'utf8')
const root = 'src/renderer/src/'
const tokens = read(root + 'my/my-tokens.css')
const sources = [...globSync(root + '**/*.{ts,tsx,css}')].map(read).join('\n') + read('tailwind.config.js')
const allowedRoots = new Set([root + 'App.tsx', root + 'daemon/BootstrapGate.tsx', root + 'daemon/QuitDialog.tsx', root + 'daemon/LifecycleDialog.tsx'])
for (const file of globSync(root + '**/*.tsx')) {
  if (!allowedRoots.has(file.replace(/\\/g, '/'))) assert.doesNotMatch(read(file), /className=["'][^"']*\bmy-root\b/, `only App, BootstrapGate, QuitDialog and LifecycleDialog own typography roots: ${file}`)
  assert.doesNotMatch(read(file), /<select\b/, `use theme-aware Select component instead of native select: ${file}`)
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

const radiusNames = new Set(Object.keys(base).filter(name => /^--my-.*radius(?:-|$)/.test(name)))
const functionalRadii = new Set(['--my-radius-none', '--my-radius-full', '--my-radius-round', '--my-radius-composer'])
const resolveRadius = (name, values, trail = []) => {
  assert.ok(!trail.includes(name), `circular radius ${[...trail, name].join(' -> ')}`)
  const value = values[name]?.trim()
  const alias = value?.match(/^var\((--my-[\w-]+)\)$/)
  return alias ? resolveRadius(alias[1], values, [...trail, name]) : value
}
const densityRules = tokenTree.nodes.filter(node => node.type === 'rule' && node.selector.includes('data-my-font-size'))
for (const [theme, values] of Object.entries(themes)) {
  for (const preset of [null, ...densityRules]) {
    const context = { ...values, ...Object.fromEntries((preset?.nodes ?? []).filter(node => node.type === 'decl').map(node => [node.prop, node.value])) }
    const scope = `${theme} ${preset?.selector ?? 'standard'}`
    assert.equal(context['--my-radius-base'], '10px', `single radius source: ${scope}`)
    for (const name of radiusNames) {
      if (!functionalRadii.has(name)) assert.equal(resolveRadius(name, context), '10px', `ordinary radius ${name}: ${scope}`)
    }
    assert.match(resolveRadius('--my-radius-none', context), /^0(?:px)?$/)
    assert.equal(resolveRadius('--my-radius-full', context), '9999px')
    assert.equal(resolveRadius('--my-radius-round', context), '50%')
    assert.equal(resolveRadius('--my-radius-composer', context), '16px')
  }
}
const canonicalRadius = value => /^0(?:px|rem|em|%)?$/.test(value) || value === 'inherit' || radiusNames.has(value.match(/^var\((--my-[\w-]+)\)$/)?.[1])
for (const file of globSync(root + '**/*.css')) {
  const tree = postcss.parse(read(file))
  tree.walkRules(rule => {
    if (!/:(?:hover|focus|focus-within|focus-visible|active)\b/.test(rule.selector)) return
    rule.walkDecls(decl => {
      assert.doesNotMatch(
        decl.prop,
        /^(?:scrollbar-width|scrollbar-gutter|overflow|overflow-x|overflow-y)$/,
        `interactive state must never mutate layout-shifting scroll properties (${decl.prop}): ${file}:${decl.source.start.line} ${rule.selector}`
      )
    })
  })
  tree.walkDecls(declaration => {
    if (/^--my-.*radius(?:-|$)/.test(declaration.prop)) {
      assert.equal(file.replace(/\\/g, '/'), root + 'my/my-tokens.css', `radius tokens belong only in my-tokens.css: ${file}:${declaration.source.start.line} ${declaration.prop}`)
    }
    if (!/^border(?:-[a-z]+)*-radius$/.test(declaration.prop)) return
    assert.ok(postcss.list.space(declaration.value).every(canonicalRadius), `radius must use a canonical token, zero or inherit: ${file}:${declaration.source.start.line} ${declaration.value}`)
  })
}
for (const file of globSync(root + '**/*.{ts,tsx}')) {
  assert.doesNotMatch(read(file), /(?:["'`]--my-[\w-]*radius[\w-]*["'`]\s*:|\.setProperty\(\s*["'`]--my-[\w-]*radius[\w-]*["'`])/, `do not override radius tokens in renderer code: ${file}`)
}
assert.doesNotMatch(sources, /\brounded(?:-[a-z]+)?-\[[^\]]+\]/, 'use shared rounded utilities rather than arbitrary radius classes')
for (const match of sources.matchAll(/\bborderRadius\s*:\s*(?:(-?\d+(?:\.\d+)?)|(["'`])([^"'`]*)\2)/g)) {
  assert.ok(match[1] !== undefined ? Number(match[1]) === 0 : canonicalRadius(match[3]), `inline radius must use a canonical token or zero: ${match[0]}`)
}
const geometry = JSON.parse(read('resources/brand/geometry.json'))
validateBrandGeometry(geometry)
assert.equal(read('resources/brand/mark.svg'), brandMarkSvg(geometry), 'mark derives from canonical geometry')
for (const size of BRAND_COMPACT_SIZES) {
  const file = size === 24 ? 'mark-compact.svg' : `mark-${size}.svg`
  assert.equal(read(`resources/brand/${file}`), brandMarkSvg(geometry, { size, optical: true }), `compact mark derives from canonical geometry: ${size}`)
}
for (const file of ['resources/brand/favicon.svg', 'src/renderer/public/favicon.svg', 'packages/team-web/public/favicon.svg']) {
  assert.equal(read(file), brandTileSvg(geometry, 16), `favicon derives from canonical geometry: ${file}`)
}
assert.doesNotMatch(read('resources/brand/wordmark.svg'), /<(?:script|image|text|foreignObject|font)\b/i, 'wordmark uses only local vector outlines')
assert.ok(read('src/renderer/src/my/BrandMark.tsx').includes('resources/brand/mark.svg?url'))
const ico = readFileSync('resources/brand/icon.ico')
const appId = read('electron-builder.yml').match(/^appId:\s*(\S+)/m)[1]
assert.ok(read('src/main/services/window-branding.ts').includes(`APPLICATION_ID = '${appId}'`), 'native taskbar identity matches the packaged application')
assert.equal(ico.readUInt16LE(2), 1)
assert.equal(ico.readUInt16LE(4), BRAND_ICO_SIZES.length)
let iconOffset = 6 + BRAND_ICO_SIZES.length * 16
for (const [index, size] of BRAND_ICO_SIZES.entries()) {
  const at = 6 + index * 16
  assert.equal(ico[at] || 256, size)
  assert.equal(ico[at + 1] || 256, size)
  assert.equal(ico.readUInt16LE(at + 4), 1)
  assert.equal(ico.readUInt16LE(at + 6), 32)
  assert.equal(ico.readUInt32LE(at + 12), iconOffset)
  const frame = readFileSync(`resources/brand/icon-${size}.png`)
  assert.equal(ico.readUInt32LE(at + 8), frame.length)
  assert.ok(ico.subarray(iconOffset, iconOffset + frame.length).equals(frame), `ICO frame uses canonical ${size}px PNG`)
  iconOffset += frame.length
}
assert.equal(iconOffset, ico.length)
for (const size of BRAND_ICON_SIZES) {
  const png = readFileSync(`resources/brand/icon-${size}.png`)
  assert.equal(png.readUInt32BE(16), size)
  assert.equal(png.readUInt32BE(20), size)
}
console.log('PASS canonical tokens, dependency graph, no legacy brand, same-source brand assets, unified 10px radius')
