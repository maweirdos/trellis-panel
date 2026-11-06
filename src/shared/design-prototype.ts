import { z } from 'zod'
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5'
import { designPagesSchema, designSummarySchema, type DesignPage } from './design-workspace'
import { CREATION_MAX_BODY_BYTES } from './creations'

export const DESIGN_PREVIEW_CHANNEL = 'trellis-design/v1'
export const DESIGN_PREVIEW_CSP = "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; object-src 'none'; worker-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'"

export interface DesignPreviewIdentity { documentId: string; pageId: string; revision: string; nonce: string; frameId?: string }
export interface DesignPageRoute { id: string; title: string }
export const designPrototypeSchema = z.object({
  version: z.literal(1), id: designSummarySchema.shape.id, title: designSummarySchema.shape.title,
  revision: designSummarySchema.shape.revision, pages: designPagesSchema
}).strict()
export type DesignPrototypeBundle = z.infer<typeof designPrototypeSchema>

export function parseDesignPrototype(body: string): DesignPrototypeBundle | null {
  if (body.length > CREATION_MAX_BODY_BYTES || new TextEncoder().encode(body).length > CREATION_MAX_BODY_BYTES) return null
  // Match actual HTML elements, never a script-shaped string in a comment,
  // textarea or another script. Duplicate IDs/attributes cannot select a bundle.
  try {
    let duplicateAttribute = false
    const document = parseHtml(body, { onParseError: error => { if (error.code === 'duplicate-attribute') duplicateAttribute = true } })
    const matches: DefaultTreeAdapterTypes.Element[] = [], pending: DefaultTreeAdapterTypes.Node[] = [document]
    while (pending.length) {
      const node = pending.pop()
      if (!node) continue
      if ('attrs' in node && node.attrs.some(attribute => attribute.name === 'id' && attribute.value === 'trellis-design-bundle')) matches.push(node)
      if ('childNodes' in node) for (const child of node.childNodes) pending.push(child)
      if ('content' in node) pending.push(node.content)
    }
    const element = matches[0]
    if (duplicateAttribute || matches.length !== 1 || element.tagName !== 'script' || element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !element.parentNode || !('tagName' in element.parentNode) || element.parentNode.tagName !== 'body' || element.attrs.length !== 2 || !element.attrs.some(attribute => attribute.name === 'type' && attribute.value === 'application/json')) return null
    const json = element.childNodes.map(node => node.nodeName === '#text' && 'value' in node ? node.value : '').join('')
    const parsed = designPrototypeSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Exact identities only. Ambiguous titles and unrecognized paths never navigate. */
export function resolveDesignPage(target: string, pages: readonly DesignPageRoute[], href = false): string | null {
  if (!target || target.length > 2000) return null
  let name = target
  if (href) {
    if (/^[a-z][a-z\d+.-]*:|^\/\/|[\\\u0000-\u001f]/i.test(name)) return null
    name = name.split(/[?#]/, 1)[0].replace(/^\.\//, '')
    if (name.includes('/') || !/\.html?$/i.test(name)) return null
    try { name = decodeURIComponent(name.replace(/\.html?$/i, '')) } catch { return null }
  }
  const exact = pages.filter(page => page.id === name)
  if (exact.length === 1) return exact[0].id
  const titles = pages.filter(page => page.title === name)
  return titles.length === 1 ? titles[0].id : null
}

// Deliberately plain JavaScript: the exact runtime is embedded in both canvas
// frames and exported prototypes. It has no preload, network or filesystem port.
const previewRuntime = String.raw`function designRuntime(identity, pages, resolvePage) {
  const channel = 'trellis-design/v1';
  let mode = 'interact', picked = null, pickedHTML = '', initialized = false, anchored = false, anchorRequestId = null, canvasWheel = false, pendingWheel = null, wheelFrame = 0;
  const send = (type, values = {}) => parent.postMessage({ channel, ...identity, type, ...values }, '*');
  const allowed = element => element instanceof Element && element !== document.documentElement && !element.closest('script,style,link,meta,head,iframe,object,embed,input,textarea,select,[contenteditable="true"],[data-design-overlay]');
  const selectorFor = element => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) return '';
      const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(sibling => sibling.tagName === node.tagName) : [];
      parts.unshift(tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
      node = node.parentElement;
      if (parts.length > 40) return '';
    }
    return 'html > ' + parts.join(' > ');
  };
  const overlay = document.createElement('div');
  overlay.setAttribute('data-design-overlay', 'true');
  overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;outline:2px solid Highlight;outline-offset:-2px;display:none;';
  const redraw = () => {
    if (!picked || !picked.isConnected || mode !== 'select' && !anchored) { overlay.style.display = 'none'; return; }
    const box = picked.getBoundingClientRect();
    Object.assign(overlay.style, { display: 'block', left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
  };
  const describe = element => {
    if (!allowed(element)) return null;
    const selector = selectorFor(element);
    const html = element.outerHTML;
    if (!selector || selector.length > 2000 || html.length > 16000) return null;
    return { selector, tagName: element.tagName.toLowerCase(), text: (element.textContent || '').slice(0, 4000), outerHTML: html,
      canEditText: element.childElementCount === 0 && !['body','html','svg','path','img','video','audio','canvas'].includes(element.tagName.toLowerCase()),
      hasParent: allowed(element.parentElement), path: selector.split(' > ').slice(-6).join(' > ') };
  };
  const pick = (element, notify = true, restoring = false) => {
    const selection = describe(element);
    if (!selection) { send('notice', { text: '此元素过于复杂，请选择更小的元素或使用助手修改。' }); return false; }
    picked = element; pickedHTML = selection.outerHTML; anchored = restoring; if(!restoring) anchorRequestId=null; redraw(); if (notify) send('selection', { selection }); return true;
  };
  addEventListener('message', event => {
    if (event.source !== parent || !event.data || event.data.channel !== channel) return;
    const data = event.data;
    if (Object.keys(identity).some(key => data[key] !== identity[key])) return;
    if (data.type === 'configure' && ['select','interact','read'].includes(data.mode)) { mode = data.mode; canvasWheel = data.canvasWheel === true; initialized = true; if (mode !== 'select' || !canvasWheel) { pendingWheel = null; if (wheelFrame) cancelAnimationFrame(wheelFrame); wheelFrame = 0; } if (mode !== 'select' && !anchored) picked = null; redraw(); }
    else if (data.type === 'parent' && mode === 'select' && picked) pick(picked.parentElement);
    else if (data.type === 'restore' && initialized && typeof data.requestId === 'string' && data.requestId.length === 36 && typeof data.selector === 'string' && data.selector.length <= 2000 && typeof data.outerHTML === 'string' && data.outerHTML.length <= 16000) {
      let status = 'missing';
      try { const matches=document.querySelectorAll(data.selector); if(matches.length>1) status='ambiguous'; else if(matches.length===1 && matches[0].outerHTML===data.outerHTML && pick(matches[0],data.notify!==false && mode==='select',true)) { status='located'; matches[0].scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}); redraw(); } } catch {}
      anchorRequestId=status==='located'?data.requestId:null;
      if(status!=='located') { picked=null; anchored=false; redraw(); }
      send('restored',{requestId:data.requestId,status});
    }
    else if (data.type === 'clear') { picked = null; anchored = false; anchorRequestId = null; redraw(); }
    else if (data.type === 'locate' && picked) { picked.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); redraw(); }
    else if (data.type === 'validate' && typeof data.requestId === 'string') {
      const valid = Boolean(initialized && mode === 'select' && picked && picked.isConnected && selectorFor(picked) === data.selector && picked.outerHTML === pickedHTML && pickedHTML === data.outerHTML);
      send('validated', { requestId: data.requestId, valid });
    }
  });
  addEventListener('click', event => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || !initialized) { event.preventDefault(); return; }
    if (mode === 'select') { event.preventDefault(); event.stopImmediatePropagation(); pick(element); return; }
    if (mode === 'read') { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const link = element.closest('[data-design-page],a[href]');
    if (!link) return;
    const explicit = link.getAttribute('data-design-page');
    const href = link.getAttribute('href') || '';
    if (explicit === null && href.startsWith('#') && href !== '#back') return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (href === '#back' || explicit === 'back' && !pages.some(page => page.id === 'back' || page.title === 'back')) { send('back'); return; }
    const target = resolvePage(explicit === null ? href : explicit, pages, explicit === null);
    if (target) send('navigate', { target });
    else send('notice', { text: '未找到唯一的目标页面。' });
  }, true);
  // Wheel deltas are input CSS pixels, independent of the iframe's CSS scale.
  // Coalesce per animation frame; the parent maps the last point to its viewport.
  const flushWheel = () => { wheelFrame = 0; if (pendingWheel && initialized && mode === 'select' && canvasWheel) send('wheel', pendingWheel); pendingWheel = null; };
  addEventListener('wheel', event => {
    if (!initialized || mode !== 'select' || !canvasWheel || !event.isTrusted) return;
    if (![event.clientX,event.clientY,event.deltaX,event.deltaY].every(Number.isFinite)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const zoom = event.ctrlKey || event.metaKey;
    if (pendingWheel && pendingWheel.zoom !== zoom) { if (wheelFrame) cancelAnimationFrame(wheelFrame); flushWheel(); }
    const scaleX = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerWidth : 1;
    const scaleY = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const bound = value => Math.max(-4096, Math.min(4096, value));
    pendingWheel = { x: event.clientX, y: event.clientY, deltaX: bound((pendingWheel?.deltaX || 0) + bound(event.deltaX * scaleX)), deltaY: bound((pendingWheel?.deltaY || 0) + bound(event.deltaY * scaleY)), zoom };
    if (!wheelFrame) wheelFrame = requestAnimationFrame(flushWheel);
  }, { capture: true, passive: false });
  addEventListener('submit', event => { event.preventDefault(); }, true);
  history.back = () => { if (mode === 'interact') send('back'); };
  const historyGo = history.go.bind(history);
  history.go = delta => { if (delta === -1) { if (mode === 'interact') send('back'); } else if (delta === 0) historyGo(0); };
  addEventListener('keydown', event => {
    if (event.key === 'Escape' && mode === 'select' && !event.isComposing) { event.preventDefault(); event.stopImmediatePropagation(); picked = null; anchored = false; anchorRequestId = null; redraw(); send('clear'); send('escape'); }
    if (mode === 'select' && event.altKey && event.key === 'ArrowUp' && picked) { event.preventDefault(); pick(picked.parentElement); }
    if (mode === 'read' && ['Enter',' '].includes(event.key)) event.preventDefault();
  }, true);
  addEventListener('scroll', redraw, true); addEventListener('resize', redraw);
  new MutationObserver(() => { if (picked && (!picked.isConnected || picked.outerHTML !== pickedHTML)) { const requestId=anchorRequestId; picked = null; anchored=false; anchorRequestId=null; redraw(); send('clear'); if(requestId) send('restored',{requestId,status:'missing'}); } }).observe(document.documentElement, { subtree:true, childList:true, characterData:true, attributes:true });
  addEventListener('securitypolicyviolation', () => send('notice', { text: '页面包含外部资源；请将资源内嵌后继续。' }));
  const ready = () => { document.documentElement.appendChild(overlay); send('ready'); };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready, { once: true }); else ready();
}`

const scriptJSON = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

export function buildDesignPreviewDocument(page: Pick<DesignPage, 'html'>, identity: DesignPreviewIdentity, pages: readonly DesignPageRoute[]): string {
  const bridge = `(${previewRuntime})(${scriptJSON(identity)},${scriptJSON(pages)},${resolveDesignPage.toString()});`
  // The first CSP is installed before any model-supplied bytes are parsed. A later
  // model meta tag can only make this policy more restrictive.
  const prefix = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${DESIGN_PREVIEW_CSP}"><script>${bridge.replace(/<\/script/gi, '<\\/script')}<\/script></head>`
  return prefix + page.html
}

/** Self-contained export with the same opaque frame, protocol and exact router. */
export function buildDesignPrototype(input: { id: string; title: string; revision: string; pages: readonly DesignPage[] }): string {
  const bundle = designPrototypeSchema.parse({ version: 1, id: input.id, title: input.title, revision: input.revision, pages: input.pages })
  const title = input.title.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value] ?? value)
  const player = String.raw`function prototypeRuntime(bundle,runtime,router,policy){
    const pages=bundle.pages,routes=pages.map(page=>({id:page.id,title:page.title})),channel='trellis-design/v1';
    const frame=document.querySelector('iframe'),select=document.querySelector('select'),back=document.querySelector('button'),status=document.querySelector('#status');
    let active=null,identity=null,history=[],loads=0,ready=false;
    const js=value=>JSON.stringify(value).replace(/</g,'\\u003c');
    for(const page of pages){const option=document.createElement('option');option.value=page.id;option.textContent=page.title;select.appendChild(option)}
    function open(id,push=true){
      const page=pages.find(p=>p.id===id);if(!page)return;if(push&&active)history.push(active.id);
      active=page;identity={documentId:bundle.id,pageId:page.id,revision:bundle.revision,nonce:crypto.randomUUID()};loads=0;ready=false;select.value=id;
      const bridge='('+runtime+')('+js(identity)+','+js(routes)+','+router.toString()+');';
      frame.srcdoc='<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><script>'+bridge.replace(/<\/script/gi,'<\\/script')+'</scr'+'ipt></head>'+page.html;
      back.disabled=!history.length;status.textContent='';
    }
    select.onchange=()=>open(select.value);back.onclick=()=>{const id=history.pop();if(id)open(id,false)};
    frame.onload=()=>{if(++loads>1&&ready){ready=false;frame.srcdoc='';status.textContent='页面离开了原预览，请重新选择页面。'}};
    addEventListener('message',event=>{const m=event.data;if(event.source!==frame.contentWindow||event.origin!=='null'||!m||!active||!identity||m.channel!==channel||Object.keys(identity).some(key=>m[key]!==identity[key]))return;
      if(m.type==='ready'){ready=true;frame.contentWindow.postMessage({channel,...identity,type:'configure',mode:'interact'},'*')}
      else if(!ready)return;
      else if(m.type==='navigate'&&pages.some(p=>p.id===m.target))open(m.target);
      else if(m.type==='back')back.click();else if(m.type==='notice'&&typeof m.text==='string')status.textContent=m.text.slice(0,200)
    });if(pages[0])open(pages[0].id,false);
  }`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-src about:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>html,body{height:100%;margin:0;font:14px system-ui}body{display:flex;flex-direction:column}nav{display:flex;gap:8px;align-items:center;padding:8px;border-bottom:1px solid;flex-wrap:wrap}iframe{flex:1;width:100%;border:0;min-height:0}button,select{font:inherit;padding:6px}span{margin-left:auto}</style></head><body><nav><button id="back" disabled>返回</button><select id="pages" aria-label="页面"></select><span id="status" role="status"></span></nav><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="${title}" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"></iframe><script type="application/json" id="trellis-design-bundle">${scriptJSON(bundle)}<\/script><script>(${player})(JSON.parse(document.getElementById('trellis-design-bundle').textContent),${scriptJSON(previewRuntime)},${resolveDesignPage.toString()},${scriptJSON(DESIGN_PREVIEW_CSP)});<\/script></body></html>`
}
