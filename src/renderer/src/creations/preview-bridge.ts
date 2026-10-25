import type {
  PreviewAnchorStatus,
  PreviewBox,
  PreviewContext,
  PreviewInteraction,
  PreviewMarker,
  PreviewMode,
  PreviewTarget
} from '@shared/creation-preview'

export const PREVIEW_CHANNEL = 'creation-preview/v1'
export const PREVIEW_CSP = "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; media-src 'none'; object-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"
export const PREVIEW_LIMITS = {
  text: 500,
  selector: 500,
  stableId: 500,
  fields: 12,
  fieldValue: 128,
  location: 300,
  markers: 120,
  markerId: 256,
  markerLabel: 24,
  viewport: 16_384,
  scroll: 10_000_000,
  bodyBytes: 256 * 1024
} as const

interface PreviewTheme {
  colorScheme: 'light' | 'dark'
  accent: string
  onAccent: string
  surface: string
  ink: string
  font: string
  fontSize: string
  radius: string
  markerSize: string
  stroke: string
  space: string
}

export interface PreviewConfiguration {
  channel: typeof PREVIEW_CHANNEL
  nonce: string
  type: 'configure'
  mode: PreviewMode
  target: PreviewTarget | null
  markers: PreviewMarker[]
  requestId: number
  theme: PreviewTheme
}

export type PreviewMessage =
  | { type: 'selection'; target: PreviewTarget }
  | { type: 'interaction'; event: PreviewInteraction }
  | { type: 'anchor-status'; requestId: number; status: PreviewAnchorStatus }

/** Self-contained: this exact validator also runs inside the opaque child. */
function createPreviewProtocol(limits: typeof PREVIEW_LIMITS) {
  const sensitive = /pass(?:word|phrase)?|pwd|token|secret|auth|credential|session|cookie|csrf|api[\s_\-]*key|credit|card|cvv|cvc|ssn|private|otp|verification|one[\s_\-]*time/i
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  const hasKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key))
  const isText = (value: unknown, max: number = limits.text, selector = false): value is string =>
    typeof value === 'string' && value.length <= max && !(selector ? /[<\u0000-\u001f]/ : /[<>\u0000-\u001f]/).test(value)
  const number = (value: unknown, max: number, min = 0): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
  const isId = (value: unknown): value is number => number(value, Number.MAX_SAFE_INTEGER) && Number.isInteger(value)
  const cleanText = (value: string, max: number = limits.text): string => value.replace(/[<>\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  const isSensitiveValue = (value: string) => /(?:bearer\s|eyJ[A-Za-z0-9_-]{12,}|[A-Za-z0-9_\-]{32,}|[?&#](?:token|key|secret|auth|session)=)/i.test(value)
  const isSafeLocation = (value: unknown, hash = false): value is string =>
    isText(value, limits.location) && !/[?=]/.test(value) && !sensitive.test(value) && (value === '' || (hash ? value.startsWith('#') : value.startsWith('/') && !value.startsWith('//')))

  function readBox(value: unknown): PreviewBox | null {
    if (!isRecord(value) || !hasKeys(value, ['x', 'y', 'width', 'height'])) return null
    const { x, y, width, height } = value
    return number(x, 1) && number(y, 1) && number(width, 1) && number(height, 1) && x + width <= 1.000001 && y + height <= 1.000001
      ? { x, y, width, height } : null
  }

  function readContext(value: unknown): PreviewContext | null {
    if (!isRecord(value) || !hasKeys(value, ['route', 'hash', 'scroll', 'viewport', 'fields'])) return null
    const { route, hash, scroll, viewport, fields } = value
    const result: PreviewContext = {}
    if (route !== undefined) { if (!isSafeLocation(route)) return null; result.route = route }
    if (hash !== undefined) { if (!isSafeLocation(hash, true)) return null; result.hash = hash }
    if (scroll !== undefined) {
      if (!isRecord(scroll) || !hasKeys(scroll, ['x', 'y']) || !number(scroll.x, limits.scroll) || !number(scroll.y, limits.scroll)) return null
      result.scroll = { x: scroll.x, y: scroll.y }
    }
    if (viewport !== undefined) {
      if (!isRecord(viewport) || !hasKeys(viewport, ['width', 'height']) || !number(viewport.width, limits.viewport, 1) || !number(viewport.height, limits.viewport, 1) || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) return null
      result.viewport = { width: viewport.width, height: viewport.height }
    }
    if (fields !== undefined) {
      if (!Array.isArray(fields) || fields.length > limits.fields) return null
      result.fields = []
      for (const field of fields) {
        if (!isRecord(field) || !hasKeys(field, ['selector', 'name', 'value'])) return null
        if (field.selector !== undefined && (!isText(field.selector, limits.selector, true) || !field.selector)) return null
        if (!isText(field.value, limits.fieldValue) || !(field.selector || field.name)) return null
        if (field.name !== undefined && !isText(field.name)) return null
        if (sensitive.test(field.selector + ' ' + (field.name ?? '')) || isSensitiveValue(field.value)) return null
        result.fields.push({ ...(typeof field.selector === 'string' ? { selector: field.selector } : {}), ...(typeof field.name === 'string' ? { name: field.name } : {}), value: field.value })
      }
    }
    return result
  }

  function readTarget(value: unknown): PreviewTarget | null {
    if (!isRecord(value) || value.kind !== 'web' || !hasKeys(value, ['kind', 'stableId', 'selector', 'tag', 'role', 'name', 'text', 'selectedText', 'box', 'context', 'state', 'screenshotRefs'])) return null
    const result: PreviewTarget = { kind: 'web' }
    for (const key of ['stableId', 'selector', 'tag', 'role', 'name', 'text', 'selectedText'] as const) {
      const item = value[key]
      if (item === undefined) continue
      const max = key === 'selector' ? limits.selector : key === 'stableId' ? limits.stableId : limits.text
      if (!isText(item, max, key === 'selector')) return null
      if (key === 'tag' && !/^[a-z][a-z0-9-]{0,63}$/.test(item)) return null
      result[key] = item
    }
    if (value.box !== undefined) {
      const box = readBox(value.box)
      if (!box) return null
      result.box = box
    }
    if (value.context !== undefined) {
      const context = readContext(value.context)
      if (!context) return null
      result.context = context
    }
    if (value.state !== undefined) {
      if (typeof value.state !== 'string' || !['default', 'hover', 'focus', 'disabled', 'expanded', 'selected'].includes(value.state)) return null
      result.state = value.state as PreviewTarget['state']
    }
    if (value.screenshotRefs !== undefined) {
      if (!Array.isArray(value.screenshotRefs) || value.screenshotRefs.length > 4 || !value.screenshotRefs.every((item) => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item))) return null
      result.screenshotRefs = value.screenshotRefs
    }
    return result.stableId || result.selector || result.role || result.name || result.text || result.box ? result : null
  }

  function readChildMessage(value: unknown, nonce: string): PreviewMessage | null {
    if (!isRecord(value) || value.channel !== 'creation-preview/v1' || value.nonce !== nonce) return null
    if (value.type === 'selection' && hasKeys(value, ['channel', 'nonce', 'type', 'target'])) {
      const target = readTarget(value.target)
      return target ? { type: 'selection', target } : null
    }
    if (value.type === 'anchor-status' && hasKeys(value, ['channel', 'nonce', 'type', 'requestId', 'status']) && isId(value.requestId)) {
      if (value.status === 'located' || value.status === 'missing' || value.status === 'ambiguous') return { type: 'anchor-status', status: value.status, requestId: value.requestId }
    }
    if (value.type === 'interaction' && hasKeys(value, ['channel', 'nonce', 'type', 'event']) && isRecord(value.event) && hasKeys(value.event, ['kind', 'tag', 'markerId'])) {
      const { kind, tag, markerId } = value.event
      if (typeof kind !== 'string' || !['ready', 'click', 'change', 'escape', 'marker-click', 'resource-blocked', 'navigation-blocked'].includes(kind)) return null
      if (tag !== undefined && (typeof tag !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(tag))) return null
      if (markerId !== undefined && (!isText(markerId, limits.markerId) || !markerId)) return null
      if ((kind === 'marker-click') !== (markerId !== undefined)) return null
      return { type: 'interaction', event: { kind: kind as PreviewInteraction['kind'], ...(typeof tag === 'string' ? { tag } : {}), ...(typeof markerId === 'string' ? { markerId } : {}) } }
    }
    return null
  }

  function readConfiguration(value: unknown, nonce: string): PreviewConfiguration | null {
    if (!isRecord(value) || !hasKeys(value, ['channel', 'nonce', 'type', 'mode', 'target', 'markers', 'requestId', 'theme']) || value.channel !== 'creation-preview/v1' || value.nonce !== nonce || value.type !== 'configure' || !isId(value.requestId)) return null
    if (value.mode !== 'browse' && value.mode !== 'annotate') return null
    const target = value.target === null ? null : readTarget(value.target)
    if (value.target !== null && !target) return null
    if (!Array.isArray(value.markers) || value.markers.length > limits.markers) return null
    const markers: PreviewMarker[] = []
    for (const item of value.markers) {
      if (!isRecord(item) || !hasKeys(item, ['id', 'label', 'target']) || !isText(item.id, limits.markerId) || !item.id || !isText(item.label, limits.markerLabel)) return null
      const markerTarget = readTarget(item.target)
      if (!markerTarget || markers.some((marker) => marker.id === item.id)) return null
      markers.push({ id: item.id, label: item.label, target: markerTarget })
    }
    const theme = value.theme
    const keys = ['colorScheme', 'accent', 'onAccent', 'surface', 'ink', 'font', 'fontSize', 'radius', 'markerSize', 'stroke', 'space'] as const
    if (!isRecord(theme) || !hasKeys(theme, [...keys]) || (theme.colorScheme !== 'light' && theme.colorScheme !== 'dark')) return null
    const nextTheme: PreviewTheme = { colorScheme: theme.colorScheme, accent: '', onAccent: '', surface: '', ink: '', font: '', fontSize: '', radius: '', markerSize: '', stroke: '', space: '' }
    for (const key of keys) {
      const item = theme[key]
      if (typeof item !== 'string' || item.length > 256 || /[<>;{}\u0000-\u001f]|url\s*\(/i.test(item)) return null
      if (key !== 'colorScheme') nextTheme[key] = item
    }
    return { channel: 'creation-preview/v1', nonce, type: 'configure', mode: value.mode, target, markers, requestId: value.requestId, theme: nextTheme }
  }
  return { readTarget, readChildMessage, readConfiguration, cleanText, isSafeLocation, sensitive, isSensitiveValue }
}

const protocol = createPreviewProtocol(PREVIEW_LIMITS)

export function parsePreviewTarget(value: unknown): PreviewTarget | null {
  return protocol.readTarget(value)
}

/** A WindowProxy, a nonce, and null origin are all mandatory, including after reload. */
export function parsePreviewMessage(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, frameWindow: Window | null, nonce: string): PreviewMessage | null {
  if (!frameWindow || event.source !== frameWindow || event.origin !== 'null' || !/^[a-f0-9]{48}$/.test(nonce)) return null
  return protocol.readChildMessage(event.data, nonce)
}

export function createPreviewNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (value) => value.toString(16).padStart(2, '0')).join('')
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

export function buildPreviewDocument(body: string, nonce: string): string {
  if (!/^[a-f0-9]{48}$/.test(nonce)) throw new Error('Invalid preview document nonce')
  if (body.length > PREVIEW_LIMITS.bodyBytes || new TextEncoder().encode(body).length > PREVIEW_LIMITS.bodyBytes) throw new Error('Preview exceeds 256 KiB')
  const plainText = !/<(?:!doctype\b|[a-z][a-z0-9:-]*(?:\s|\/?>))/i.test(body)
  const content = plainText ? `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;font:inherit">${escapeText(body)}</pre>` : body
  const sdk = `;(${previewSdk.toString()})(${scriptJson({ nonce, limits: PREVIEW_LIMITS, plainText })},(${createPreviewProtocol.toString()}));`.replace(/<\/script/gi, '<\\/script')
  // A complete outer document puts this policy BEFORE every authored token, even malformed HTML.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>${sdk}</script><style>:where(html){color-scheme:light;background:Canvas;color:CanvasText}</style></head><body>${content}</body></html>`
}

export function readPreviewTheme(element: Element): PreviewTheme {
  const style = getComputedStyle(element)
  const token = (name: string) => style.getPropertyValue(name).trim()
  return {
    colorScheme: element.closest('[data-my-theme]')?.getAttribute('data-my-theme') === 'dark' || (!element.closest('[data-my-theme]') && document.documentElement.classList.contains('dark')) ? 'dark' : 'light',
    accent: token('--my-label-indigo-bg-strong'), onAccent: token('--my-txt-on-color'), surface: token('--my-bg-surface-1'), ink: token('--my-txt-primary'),
    font: style.fontFamily, fontSize: style.fontSize, radius: token('--my-radius-sm'), markerSize: token('--my-space-24'),
    stroke: token('--my-space-2'), space: token('--my-space-4')
  }
}

export function validatePreviewConfiguration(value: PreviewConfiguration): PreviewConfiguration | null {
  return protocol.readConfiguration(value, value.nonce)
}

/** No imports, host objects, credentials, execution commands, DOM dumps, or external assets. */
function previewSdk(config: { nonce: string; limits: typeof PREVIEW_LIMITS; plainText: boolean }, protocolFactory: typeof createPreviewProtocol): void {
  const { nonce, limits } = config
  const rules = protocolFactory(limits)
  const parentWindow = window.parent
  const send = parentWindow.postMessage.bind(parentWindow)
  const nativeEvent = Event
  const nativeSetters = {
    input: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set,
    checked: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set,
    select: Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set,
    textarea: Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  }
  let mode: PreviewMode = 'browse'
  let requestId = -1
  let restoreEpoch = 0
  let raf = 0
  let isDirty = true
  let isReady = false
  let isConfigured = false
  let isRestoring = false
  let isBlockedReported = false
  let selectionTimer = 0
  let selected: { target: PreviewTarget; element: Element | null } | null = null
  let lastStatus: PreviewAnchorStatus | null = null
  let hovered: Element | null = null
  let overlay: HTMLDivElement | null = null
  let shadow: ShadowRoot | null = null
  let hoverBox: HTMLDivElement | null = null
  let selectedBox: HTMLDivElement | null = null
  let pending: PreviewConfiguration | null = null
  const markers = new Map<string, { marker: PreviewMarker; button: HTMLButtonElement; element: Element | null }>()

  function post(message: PreviewMessage): void {
    // '*' addresses ONLY this document's parent; every payload carries this document's nonce.
    send({ channel: 'creation-preview/v1', nonce, ...message }, '*')
  }
  function interaction(event: PreviewInteraction): void { post({ type: 'interaction', event }) }
  function block(event?: Event): void {
    if (event?.cancelable) event.preventDefault()
    event?.stopImmediatePropagation()
  }
  function blockedResource(): void {
    if (isBlockedReported) return
    isBlockedReported = true
    interaction({ kind: 'resource-blocked' })
  }
  function privateElement(element: Element): boolean {
    if (element.closest('[data-preview-private],[data-private],input[type="password"],input[type="hidden"],input[type="file"]')) return true
    let current: Element | null = element
    for (let depth = 0; current && depth < 16; depth++, current = current.parentElement) {
      const hint = [current.id, current.getAttribute('name'), current.getAttribute('autocomplete'), current.getAttribute('aria-label')].filter(Boolean).join(' ')
      if (rules.sensitive.test(hint)) return true
    }
    return false
  }
  function isVisible(element: Element): boolean {
    if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"]') || privateElement(element)) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
  }
  function textOf(element: Element): string {
    if (['BODY', 'HTML', 'INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || privateElement(element)) return ''
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        return !parent || parent.closest('script,style,noscript,template,input,textarea,select,[hidden],[aria-hidden="true"],[contenteditable]') || privateElement(parent)
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      }
    })
    let text = '', steps = 0
    while (text.length < limits.text && steps++ < 120) {
      const node = walker.nextNode()
      if (!node) break
      text += ' ' + (node.textContent ?? '').slice(0, limits.text - text.length)
    }
    return rules.cleanText(text)
  }
  function roleOf(element: Element): string {
    const explicit = element.getAttribute('role')
    if (explicit) return rules.cleanText(explicit, 64)
    const tag = element.tagName.toLowerCase()
    if (tag === 'a' && element.hasAttribute('href')) return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    if (tag === 'textarea') return 'textbox'
    if (element instanceof HTMLSelectElement) return element.multiple ? 'listbox' : 'combobox'
    if (element instanceof HTMLInputElement) return ({ checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', button: 'button', submit: 'button', reset: 'button' })[element.type] ?? 'textbox'
    return ''
  }
  function nameOf(element: Element): string {
    if (privateElement(element)) return ''
    const explicit = element.getAttribute('aria-label') || element.getAttribute('alt')
    if (explicit) return rules.cleanText(explicit)
    const labelled = element.getAttribute('aria-labelledby')?.split(/\s+/).slice(0, 4).map((id) => {
      const label = document.getElementById(id)
      return label ? textOf(label) : ''
    }).join(' ')
    if (labelled) return rules.cleanText(labelled)
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      return rules.cleanText(Array.from(element.labels ?? []).slice(0, 4).map(textOf).join(' ') || element.getAttribute('placeholder') || '')
    }
    return textOf(element)
  }
  function all(selector: string): Element[] {
    try {
      const elements = document.querySelectorAll(selector)
      return elements.length > 1200 ? [] : Array.from(elements).filter((element) => element !== overlay)
    }
    catch { return [] } // Stale/invalid authored selectors resolve to missing.
  }
  function selectorOf(element: Element): string {
    const stable = element.getAttribute('data-preview-id')
    if (stable && stable.length <= limits.stableId && !/[<>\u0000-\u001f]/.test(stable)) {
      const selector = `[data-preview-id="${CSS.escape(stable)}"]`
      if (all(selector).length === 1) return selector
    }
    if (element.id && element.id.length <= limits.stableId && !/[<>\u0000-\u001f]/.test(element.id)) {
      const selector = '#' + CSS.escape(element.id)
      if (all(selector).length === 1) return selector
    }
    const parts: string[] = []
    let current: Element | null = element
    for (let depth = 0; current && current !== document.documentElement && depth < 12; depth++) {
      const tag = current.tagName.toLowerCase()
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) return ''
      const sameTag = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling.tagName === current?.tagName)
      parts.unshift(`${tag}:nth-of-type(${sameTag.indexOf(current) + 1})`)
      const selector = parts.join(' > ')
      if (selector.length > limits.selector) return ''
      if (all(selector).length === 1 && all(selector)[0] === element) return selector
      current = current.parentElement
    }
    return ''
  }
  function meaningful(element: Element | null): Element | null {
    if (!element || element === overlay || element.closest('script,style,head,noscript,template') || privateElement(element)) return null
    const semantic = element.closest('button,a[href],input,select,textarea,label,summary,[role],[data-preview-id],h1,h2,h3,h4,h5,h6,p,li,td,th,img,figure')
    const result = semantic && semantic !== document.body ? semantic : element
    return result !== document.body && result !== document.documentElement && isVisible(result) && !privateElement(result) ? result : null
  }
  function normalizedBox(rect: DOMRect): PreviewBox {
    const width = Math.max(1, innerWidth), height = Math.max(1, innerHeight)
    const x = Math.max(0, Math.min(1, rect.left / width)), y = Math.max(0, Math.min(1, rect.top / height))
    return { x, y, width: Math.max(0, Math.min(1, rect.right / width) - x), height: Math.max(0, Math.min(1, rect.bottom / height) - y) }
  }
  function fieldAllowed(element: Element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
    if (privateElement(element) || element.closest('[autocomplete="off"]') || !isVisible(element)) return false
    if (element instanceof HTMLSelectElement) return !element.multiple
    if (element instanceof HTMLInputElement && ['checkbox', 'radio', 'range', 'number', 'date', 'month', 'week', 'time', 'color'].includes(element.type)) return true
    return ((element instanceof HTMLInputElement && element.type === 'text') || element instanceof HTMLTextAreaElement) && element.getAttribute('data-preview-state') === 'true'
  }
  function captureContext(): PreviewContext {
    const fields: NonNullable<PreviewContext['fields']> = []
    for (const element of all('input,select,textarea')) {
      if (fields.length >= limits.fields) break
      if (!fieldAllowed(element)) continue
      const selector = selectorOf(element)
      const value = element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type) ? String(element.checked) : element.value
      const name = rules.cleanText(element.getAttribute('name') ?? '')
      if (!selector || rules.sensitive.test(selector + ' ' + name) || value.length > limits.fieldValue || /[<>\u0000-\u001f]/.test(value) || rules.isSensitiveValue(value)) continue
      fields.push({ selector, ...(name ? { name } : {}), value })
    }
    const route = rules.isSafeLocation(location.pathname) ? location.pathname : '/'
    const hash = rules.isSafeLocation(location.hash, true) ? location.hash : ''
    return { route, hash, scroll: { x: Math.min(limits.scroll, Math.max(0, scrollX)), y: Math.min(limits.scroll, Math.max(0, scrollY)) }, viewport: { width: Math.max(1, Math.min(limits.viewport, innerWidth)), height: Math.max(1, Math.min(limits.viewport, innerHeight)) }, fields }
  }
  function capture(element: Element, selectedText?: string): PreviewTarget | null {
    const stable = element.getAttribute('data-preview-id') || element.id
    const target: PreviewTarget = {
      kind: 'web', selector: selectorOf(element), tag: element.tagName.toLowerCase(), role: roleOf(element), name: nameOf(element), text: textOf(element),
      box: normalizedBox(element.getBoundingClientRect()), context: captureContext(),
      ...(stable && stable.length <= limits.stableId && !/[<>\u0000-\u001f]/.test(stable) ? { stableId: stable } : {}),
      ...(selectedText ? { selectedText: rules.cleanText(selectedText) } : {})
    }
    return rules.readTarget(target)
  }
  function identity(element: Element, target: PreviewTarget, strong = false): boolean {
    if (!isVisible(element) || (target.tag && element.tagName.toLowerCase() !== target.tag) || (target.role && roleOf(element) !== target.role)) return false
    if (strong) return true
    if (target.name && nameOf(element) !== target.name) return false
    if (target.text && !textOf(element).includes(target.text)) return false
    return Boolean(target.name || target.text || target.tag || target.role)
  }
  function resolve(target: PreviewTarget): { status: PreviewAnchorStatus; element: Element | null } {
    if (target.context && ((target.context.route !== undefined && target.context.route !== captureRoute()) || (target.context.hash !== undefined && target.context.hash !== captureHash()))) return { status: 'missing', element: null }
    if (target.stableId) {
      const escaped = CSS.escape(target.stableId)
      const candidates = all(`[data-preview-id="${escaped}"],[id="${escaped}"]`)
      if (candidates.length > 1) return { status: 'ambiguous', element: null }
      if (candidates.length === 1) return identity(candidates[0], target, true) ? { status: 'located', element: candidates[0] } : { status: 'missing', element: null }
    }
    if (target.selector) {
      const candidates = all(target.selector).filter((element) => identity(element, target))
      if (candidates.length > 1) return { status: 'ambiguous', element: null }
      if (candidates.length === 1) return { status: 'located', element: candidates[0] }
    }
    // Coordinates alone never bind to whichever element happens to occupy the old pixel.
    if (!target.name && !target.text) return { status: 'missing', element: null }
    const candidates = all(target.tag || 'button,a,input,select,textarea,p,li,td,th,h1,h2,h3,h4,h5,h6,label,img,[role],[data-preview-id]')
      .filter((element) => identity(element, target))
    return candidates.length === 1 ? { status: 'located', element: candidates[0] } : { status: candidates.length > 1 ? 'ambiguous' : 'missing', element: null }
  }
  function captureRoute(): string { return rules.isSafeLocation(location.pathname) ? location.pathname : '/' }
  function captureHash(): string { return rules.isSafeLocation(location.hash, true) ? location.hash : '' }
  function status(value: PreviewAnchorStatus): void {
    if (lastStatus !== value) { lastStatus = value; post({ type: 'anchor-status', requestId, status: value }) }
  }
  function position(box: HTMLElement | null, element: Element | null): void {
    if (!box) return
    if (!element || !isVisible(element)) { box.hidden = true; return }
    const rect = element.getBoundingClientRect()
    const left = Math.max(0, rect.left), top = Math.max(0, rect.top), right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom)
    box.hidden = right <= left || bottom <= top
    if (!box.hidden) Object.assign(box.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: bottom - top + 'px' })
  }
  function draw(): void {
    raf = 0
    if (!isReady) return
    if (selected && isDirty && isConfigured && !isRestoring) {
      const result = resolve(selected.target)
      selected.element = result.element
      status(result.status)
    }
    position(selectedBox, selected?.element ?? null)
    position(hoverBox, mode === 'annotate' ? hovered : null)
    for (const item of markers.values()) {
      if (isDirty || !item.element?.isConnected) item.element = resolve(item.marker.target).element
      const element = item.element
      item.button.hidden = !element || !isVisible(element)
      if (!element || item.button.hidden) continue
      const rect = element.getBoundingClientRect()
      item.button.hidden = rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth
      if (!item.button.hidden) Object.assign(item.button.style, { left: Math.max(0, Math.min(innerWidth - item.button.offsetWidth, rect.right - item.button.offsetWidth / 2)) + 'px', top: Math.max(0, Math.min(innerHeight - item.button.offsetHeight, rect.top - item.button.offsetHeight / 2)) + 'px' })
    }
    isDirty = false
  }
  function schedule(dirty = false): void {
    isDirty ||= dirty
    if (!raf && isReady) raf = requestAnimationFrame(draw)
  }
  function selectionText(): { element: Element; text: string } | null {
    const selection = getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null
    const start = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement
    const end = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentElement
    if (!(start instanceof Element) || !(end instanceof Element) || privateElement(start) || privateElement(end)) return null
    const element = meaningful(start)
    const text = rules.cleanText(selection.toString())
    return element && text ? { element, text } : null
  }
  function select(element: Element, text?: string): void {
    const target = capture(element, text)
    if (!target) return
    restoreEpoch++
    isRestoring = false
    selected = { element, target }
    post({ type: 'selection', target })
    schedule()
  }
  function restoreFields(context: PreviewContext): void {
    for (const field of context.fields ?? []) {
      const candidates = field.selector ? all(field.selector) : field.name ? all(`[name="${CSS.escape(field.name)}"]`) : []
      const element = candidates[0]
      if (candidates.length !== 1 || !element || !fieldAllowed(element) || (field.name !== undefined && element.getAttribute('name') !== field.name)) continue
      let didChange = false
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
        if (field.value !== 'true' && field.value !== 'false') continue
        const checked = field.value === 'true'
        if (element.checked !== checked) { nativeSetters.checked?.call(element, checked); didChange = true }
      } else {
        if (element instanceof HTMLSelectElement && !Array.from(element.options).some((option) => option.value === field.value && !option.disabled)) continue
        if (element.value !== field.value) {
          const setter = element instanceof HTMLSelectElement ? nativeSetters.select : element instanceof HTMLTextAreaElement ? nativeSetters.textarea : nativeSetters.input
          setter?.call(element, field.value)
          didChange = true
        }
      }
      if (didChange) { element.dispatchEvent(new nativeEvent('input', { bubbles: true })); element.dispatchEvent(new nativeEvent('change', { bubbles: true })) }
    }
  }
  async function locate(target: PreviewTarget, epoch: number): Promise<void> {
    const context = target.context
    if (context?.route !== undefined && context.route !== captureRoute()) { isRestoring = false; status('missing'); return }
    if (context?.hash !== undefined && context.hash !== captureHash()) location.hash = context.hash
    // Route handlers and native field events may render a conditional target.
    await new Promise<void>((done) => requestAnimationFrame(() => done()))
    if (epoch !== restoreEpoch) return
    if (context) restoreFields(context)
    for (let attempt = 0; attempt < 7; attempt++) {
      if (epoch !== restoreEpoch) return
      if ((innerWidth < 1 || innerHeight < 1) && attempt < 6) {
        await new Promise<void>((done) => setTimeout(done, 70))
        continue
      }
      const result = resolve(target)
      if (result.status === 'ambiguous' || result.element || attempt === 6) {
        isRestoring = false
        selected = { target, element: result.element }
        status(result.status)
        if (result.element) {
          if (context?.scroll) window.scrollTo({ left: context.scroll.x, top: context.scroll.y, behavior: 'instant' })
          const rect = result.element.getBoundingClientRect()
          if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) result.element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        }
        schedule()
        return
      }
      await new Promise<void>((done) => setTimeout(done, 70))
    }
  }
  function configure(value: PreviewConfiguration): void {
    if (!isReady) { pending = value; return }
    isConfigured = true
    mode = value.mode
    if (overlay) for (const [key, item] of Object.entries(value.theme)) overlay.style.setProperty('--preview-' + key, item)
    if (config.plainText) Object.assign(document.documentElement.style, {
      colorScheme: value.theme.colorScheme, color: value.theme.ink, backgroundColor: value.theme.surface,
      fontFamily: value.theme.font, fontSize: value.theme.fontSize
    })
    const ids = new Set(value.markers.map((marker) => marker.id))
    for (const [id, item] of markers) if (!ids.has(id)) { item.button.remove(); markers.delete(id) }
    for (const marker of value.markers) {
      const existing = markers.get(marker.id)
      if (existing) { existing.marker = marker; existing.button.textContent = marker.label; existing.button.setAttribute('aria-label', '批注 ' + marker.label); continue }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'marker'
      button.textContent = marker.label
      button.setAttribute('aria-label', '批注 ' + marker.label)
      button.addEventListener('click', (event) => { block(event); interaction({ kind: 'marker-click', markerId: marker.id }) })
      shadow?.append(button)
      markers.set(marker.id, { marker, button, element: null })
    }
    if (requestId !== value.requestId) {
      requestId = value.requestId
      lastStatus = null
      restoreEpoch++
      isRestoring = Boolean(value.target)
      selected = value.target ? { target: value.target, element: null } : null
      if (value.target) void locate(value.target, restoreEpoch)
    }
    if (mode !== 'annotate') hovered = null
    schedule(true)
  }

  // Install guards before any authored HTML/scripts. No blocked URL or script text is reported.
  document.addEventListener('securitypolicyviolation', blockedResource, true)
  const showPicker = HTMLInputElement.prototype.showPicker
  if (showPicker) HTMLInputElement.prototype.showPicker = function () {
    if (this.type === 'file') { blockedResource(); return }
    showPicker.call(this)
  }
  const navigation = (window as Window & { navigation?: EventTarget }).navigation
  navigation?.addEventListener('navigate', (event: Event) => {
    const next = event as Event & { destination?: { sameDocument?: boolean } }
    if (!next.destination?.sameDocument) { block(event); interaction({ kind: 'navigation-blocked' }) }
  })
  window.addEventListener('message', (event) => {
    if (event.source !== parentWindow) return
    const value = rules.readConfiguration(event.data, nonce)
    if (value) configure(value)
  })
  window.addEventListener('click', (event) => {
    if (event.composedPath().includes(overlay as EventTarget)) return
    const raw = event.target instanceof Element ? event.target : null
    const file = raw?.closest('input[type="file"]')
    if (file) { block(event); blockedResource(); return }
    if (mode === 'annotate') {
      block(event)
      clearTimeout(selectionTimer)
      const selection = selectionText(), element = selection?.element ?? meaningful(raw)
      if (element) queueMicrotask(() => select(element, selection?.text))
      return
    }
    const anchor = raw?.closest('a[href],area[href]')
    if (anchor) {
      const href = anchor.getAttribute('href') ?? ''
      if (!href.startsWith('#')) { block(event); interaction({ kind: 'navigation-blocked' }); return }
      // srcdoc otherwise resolves fragment-only links against its embedding page's base URL.
      event.preventDefault()
      const previousHash = location.hash
      queueMicrotask(() => {
        if (location.hash !== previousHash) return
        location.hash = href
        try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start', behavior: 'instant' }) }
        catch { /* A malformed fragment still remains a local hash. */ }
      })
    }
    if (raw) interaction({ kind: 'click', tag: raw.tagName.toLowerCase() })
  }, true)
  window.addEventListener('auxclick', (event) => {
    if (mode === 'annotate' || (event.target instanceof Element && event.target.closest('a[href]'))) block(event)
  }, true)
  window.addEventListener('submit', (event) => { block(event); interaction({ kind: 'navigation-blocked' }) }, true)
  window.addEventListener('drop', (event) => { if (event.dataTransfer?.files.length) { block(event); blockedResource() } }, true)
  window.addEventListener('change', (event) => {
    if (mode === 'browse' && event.target instanceof Element && !privateElement(event.target)) interaction({ kind: 'change', tag: event.target.tagName.toLowerCase() })
  }, true)
  window.addEventListener('pointerover', (event) => {
    if (mode !== 'annotate' || event.composedPath().includes(overlay as EventTarget)) return
    hovered = meaningful(event.target instanceof Element ? event.target : null)
    schedule()
  }, true)
  window.addEventListener('pointerout', (event) => { if (!event.relatedTarget) { hovered = null; schedule() } }, true)
  window.addEventListener('focusin', (event) => {
    if (mode === 'annotate' && !event.composedPath().includes(overlay as EventTarget)) { hovered = meaningful(event.target instanceof Element ? event.target : null); schedule() }
  }, true)
  window.addEventListener('pointerup', () => {
    if (mode !== 'annotate') return
    clearTimeout(selectionTimer)
    selectionTimer = window.setTimeout(() => { const selection = selectionText(); if (selection && mode === 'annotate') select(selection.element, selection.text) }, 0)
  }, true)
  window.addEventListener('keydown', (event) => {
    if (event.isComposing || mode !== 'annotate') return
    if (event.key === 'Escape') { block(event); clearTimeout(selectionTimer); hovered = null; schedule(); interaction({ kind: 'escape' }); return }
    if ((event.key === 'Enter' || event.key === ' ') && !event.composedPath().includes(overlay as EventTarget)) {
      const element = meaningful(event.target instanceof Element ? event.target : null)
      if (element) { block(event); select(element) }
    }
  }, true)
  window.addEventListener('scroll', () => schedule(), { capture: true, passive: true })
  window.addEventListener('resize', () => schedule(), { passive: true })
  window.addEventListener('hashchange', () => schedule(true))
  window.addEventListener('pagehide', () => { restoreEpoch++; clearTimeout(selectionTimer); cancelAnimationFrame(raf) }, { once: true })

  function ready(): void {
    overlay = document.createElement('div')
    overlay.setAttribute('data-preview-overlay', '')
    overlay.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;display:block!important;'
    shadow = overlay.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = `:host{color:var(--preview-ink);font-family:var(--preview-font);font-size:var(--preview-fontSize)}[hidden]{display:none!important}.outline{position:fixed;box-sizing:border-box;border:var(--preview-stroke) solid var(--preview-accent);border-radius:var(--preview-radius);pointer-events:none}.hover{border-style:dashed}.marker{all:initial;position:fixed;box-sizing:border-box;display:grid;place-items:center;min-width:var(--preview-markerSize);height:var(--preview-markerSize);padding:0 var(--preview-space);border:var(--preview-stroke) solid var(--preview-surface);border-radius:9999px;background:var(--preview-accent);color:var(--preview-onAccent);font:600 var(--preview-fontSize)/1 var(--preview-font);cursor:pointer;pointer-events:auto;white-space:nowrap}.marker:hover{filter:brightness(.9)}.marker:active{filter:brightness(.8)}.marker:focus-visible{outline:var(--preview-stroke) solid var(--preview-accent);outline-offset:var(--preview-stroke)}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`
    hoverBox = document.createElement('div')
    hoverBox.className = 'outline hover'
    hoverBox.hidden = true
    selectedBox = document.createElement('div')
    selectedBox.className = 'outline selected'
    selectedBox.hidden = true
    shadow.append(style, hoverBox, selectedBox)
    document.documentElement.append(overlay)
    isReady = true
    new ResizeObserver(() => schedule()).observe(document.documentElement)
    new MutationObserver(() => schedule(true)).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['id', 'class', 'role', 'aria-label', 'aria-labelledby', 'hidden', 'style', 'open', 'data-preview-id'] })
    if (pending) { const value = pending; pending = null; configure(value) }
    interaction({ kind: 'ready' })
  }
  document.addEventListener('DOMContentLoaded', ready, { once: true })
  document.currentScript?.remove()
}
