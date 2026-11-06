import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5'
import { ident, parse as parseCss, walk, type CssNode } from 'css-tree'
import { DESIGN_GENERATION_PAGE_MAX_BYTES } from './design-generation'

const ASCII_SPACE = /[\t\n\f\r ]/
const URL_ATTRIBUTES = new Set(['src', 'href', 'poster', 'background', 'codebase', 'manifest'])
const CSS_URL_ATTRIBUTES = new Set(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'cursor', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'color-profile', 'shape-inside', 'shape-outside'])
const CSS_IMAGE_FUNCTIONS = new Set(['image', 'image-set', '-webkit-image-set', 'src'])

function deny(reason: string): never {
  // Attribute values and parser diagnostics may contain reflected credentials.
  throw new Error(`Design HTML must be self-contained: ${reason}`)
}

function embeddedUrl(value: string): boolean {
  // URL parsing strips C0/space at the edges and ASCII tabs/newlines, but not NBSP.
  const url = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '')
  return !url || url.startsWith('#') || /^data:/i.test(url)
}

function assertResource(value: string): void {
  if (!embeddedUrl(value)) deny('resource URLs must use inline data or document fragments')
}

function assertNavigation(value: string): void {
  if (embeddedUrl(value)) return
  // A basename is only a route hint. The prototype router still checks the actual design pages.
  const path = value.trim().split(/[?#]/, 1)[0].replace(/^\.\//, '')
  let decoded: string
  try { decoded = decodeURIComponent(path) } catch { deny('invalid design page link') }
  if (!/^[^./\\:\u0000-\u0020][^/\\:\u0000-\u0020]*\.html?$/i.test(decoded)) {
    deny('navigation must target a document fragment or a design page basename')
  }
}

/** Follow WHATWG srcset URL/descriptor boundaries; commas inside data URLs belong to the URL. */
function assertSrcset(value: string): void {
  let position = 0
  while (position < value.length) {
    while (position < value.length && (ASCII_SPACE.test(value[position]) || value[position] === ',')) position++
    const start = position
    while (position < value.length && !ASCII_SPACE.test(value[position])) position++
    const url = value.slice(start, position)
    assertResource(url.replace(/,+$/, ''))
    if (url.endsWith(',')) continue
    // Srcset's "in parens" state ends at the first ')'; it is not a nesting counter.
    let inParens = false
    while (position < value.length) {
      const character = value[position++]
      if (inParens) {
        if (character === ')') inParens = false
      } else if (character === '(') inParens = true
      else if (character === ',') break
    }
  }
}

function assertCss(source: string, context: 'stylesheet' | 'declarationList' | 'value'): void {
  try {
    const ast = parseCss(source, { context, parseCustomProperty: true,
      onParseError: () => deny('CSS could not be fully checked; use supported inline CSS') })
    const functions: string[] = []
    walk(ast, {
      enter(node: CssNode) {
        if (node.type === 'Raw') deny('CSS could not be fully checked; use supported inline CSS')
        if (node.type === 'Atrule' && ident.decode(node.name).toLowerCase() === 'import') {
          deny('CSS imports must be inlined into a style element')
        }
        if (node.type === 'Url') assertResource(node.value)
        if (node.type === 'String' && CSS_IMAGE_FUNCTIONS.has(functions.at(-1) ?? '')) assertResource(node.value)
        if (node.type !== 'Function') return
        const name = ident.decode(node.name).toLowerCase()
        if ((name === 'var' || name === 'attr') && functions.some(parent => CSS_IMAGE_FUNCTIONS.has(parent))) {
          deny('CSS image functions must use literal inline data or fragment URLs')
        }
        // Escaped url() names can parse as a generic function instead of a Url node.
        if (name === 'url') {
          const arguments_ = node.children.toArray()
          if (arguments_.length !== 1 || arguments_[0].type !== 'String') deny('CSS URL could not be fully checked')
          assertResource(arguments_[0].value)
        }
        functions.push(name)
      },
      leave(node: CssNode) { if (node.type === 'Function') functions.pop() }
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Design HTML must be self-contained:')) throw error
    deny('CSS could not be fully checked; use supported inline CSS')
  }
}

function assertElement(element: DefaultTreeAdapterTypes.Element): void {
  const tag = element.tagName.toLowerCase()
  // The preview CSP blocks these elements even with data/fragment sources or inline srcdoc.
  if (tag === 'iframe' || tag === 'object' || tag === 'embed') deny('iframe, object and embed are unsupported in design previews; inline their content')
  const attrs = new Map(element.attrs.filter(attribute => !attribute.namespace && !attribute.prefix).map(attribute => [attribute.name.toLowerCase(), attribute.value]))
  if (tag === 'script' && element.attrs.some(attribute => ['src', 'href'].includes(attribute.name.toLowerCase()))) deny('scripts must be inline')
  if (tag === 'link' && (attrs.get('rel') ?? '').toLowerCase().split(/[\t\n\f\r ]+/).includes('stylesheet')) {
    deny('stylesheets must be inlined into a style element')
  }
  if (tag === 'base' && attrs.has('href')) deny('base URLs are unsupported')
  if (tag === 'meta' && attrs.get('http-equiv')?.trim().toLowerCase() === 'refresh') deny('automatic page refresh is unsupported')
  for (const attribute of element.attrs) {
    const name = attribute.name.toLowerCase(), value = attribute.value
    if (name === 'style') assertCss(value, 'declarationList')
    else if (CSS_URL_ATTRIBUTES.has(name)) assertCss(value, 'value')
    else if (name === 'srcset' || name === 'imagesrcset') assertSrcset(value)
    else if (name === 'ping' || name === 'archive') {
      for (const url of value.split(/[\t\n\f\r ]+/)) assertResource(url)
    } else if (URL_ATTRIBUTES.has(name)) {
      if (name === 'href' && (tag === 'a' || tag === 'area')) assertNavigation(value)
      else assertResource(value)
    } else if (name === 'action' || name === 'formaction') assertNavigation(value)
  }
  if (tag === 'style') {
    const css = element.childNodes.flatMap(node => 'value' in node && node.nodeName === '#text' ? [node.value] : []).join('')
    assertCss(css, 'stylesheet')
  }
  // SVG animation can assign a resource attribute without spelling href/src on the animation itself.
  if (tag === 'animate' || tag === 'set') {
    const target = (attrs.get('attributename') ?? '').toLowerCase().replace(/^xlink:/, '')
    if (URL_ATTRIBUTES.has(target) || CSS_URL_ATTRIBUTES.has(target)) {
      for (const name of ['from', 'to', 'by', 'values']) {
        const value = attrs.get(name)
        if (value === undefined) continue
        for (const item of name === 'values' ? value.split(';') : [value]) {
          if (CSS_URL_ATTRIBUTES.has(target)) assertCss(item, 'value')
          else assertResource(item)
        }
      }
    }
  }
}

/**
 * Validate declared HTML/CSS dependencies and reject unsupported embedded documents/plugins.
 * Does not rewrite source or load resources.
 * Inline scripts and resources constructed at runtime are not statically proven safe;
 * the opaque preview sandbox and its CSP remain the execution boundary.
 */
export function assertDesignHtmlSelfContained(html: string): void {
  if (html.length > DESIGN_GENERATION_PAGE_MAX_BYTES || new TextEncoder().encode(html).length > DESIGN_GENERATION_PAGE_MAX_BYTES) {
    deny('HTML exceeds the 128 KiB page limit')
  }
  // Inspect both script-enabled parsing and noscript fallbacks; neither parser executes code.
  for (const scriptingEnabled of [true, false]) {
    const nodes: DefaultTreeAdapterTypes.Node[] = [parseHtml(html, { scriptingEnabled })]
    for (let node = nodes.pop(); node; node = nodes.pop()) {
      if ('tagName' in node) {
        assertElement(node)
        if ('content' in node) nodes.push(node.content)
      }
      if ('childNodes' in node) nodes.push(...node.childNodes)
    }
  }
}
