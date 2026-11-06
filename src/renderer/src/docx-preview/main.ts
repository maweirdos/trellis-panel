import DOMPurify from 'dompurify'
import ConvertWorker from './convert-worker?worker&inline'
import { DocxPreviewLimitError, isDocxPreviewErrorCode, type DocxPreviewErrorCode } from '../../../shared/docx-preview'

if (DOMPurify.version !== '3.4.17') throw new Error('DOCX preview requires the pinned DOMPurify version')

type Input = { id: string; bytes: Uint8Array }
type Output = { id: string; ok: true; html: string } | { id: string; ok: false; code: DocxPreviewErrorCode }
declare global { interface Window { docxPreview: { receive(callback: (input: Input) => void): void; complete(output: Output): void } } }

window.docxPreview.receive(input => {
  let worker: Worker
  const failure = (code: DocxPreviewErrorCode = 'invalid-document'): void => { worker?.terminate(); window.docxPreview.complete({ id: input.id, ok: false, code }) }
  try {
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length) throw new DocxPreviewLimitError('invalid-document')
    if (input.bytes.length > 8 * 1024 * 1024) throw new DocxPreviewLimitError('input-limit')
    worker = new ConvertWorker()
    worker.onerror = () => failure()
    worker.onmessage = (event: MessageEvent<unknown>) => {
      try {
        const result = event.data as { ok?: unknown; html?: unknown; code?: unknown }
        if (result?.ok === false) { failure(isDocxPreviewErrorCode(result.code) ? result.code : 'invalid-document'); return }
        if (result?.ok !== true || typeof result.html !== 'string') throw new Error('invalid-output')
        if (new TextEncoder().encode(result.html).length > 2 * 1024 * 1024) throw new DocxPreviewLimitError('html-size-limit')
        const fragment = DOMPurify.sanitize(result.html, { RETURN_DOM_FRAGMENT: true,
          ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 's', 'u', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'blockquote'],
          ALLOWED_ATTR: ['colspan', 'rowspan'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false })
        const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ALL)
        let nodes = 0, text = 0
        while (walker.nextNode()) {
          if (++nodes > 20_000) throw new DocxPreviewLimitError('node-count-limit')
          if ((text += walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode.textContent?.length ?? 0 : 0) > 1024 * 1024) throw new DocxPreviewLimitError('text-size-limit')
        }
        const container = document.createElement('div'); container.appendChild(fragment)
        const html = container.innerHTML
        if (new TextEncoder().encode(html).length > 2 * 1024 * 1024) throw new DocxPreviewLimitError('output-size-limit')
        worker.terminate(); window.docxPreview.complete({ id: input.id, ok: true, html })
      } catch (error) { failure(error instanceof DocxPreviewLimitError ? error.code : 'invalid-document') }
    }
    const bytes = input.bytes.slice().buffer
    worker.postMessage(bytes, [bytes])
  } catch (error) { failure(error instanceof DocxPreviewLimitError ? error.code : 'invalid-document') }
})
