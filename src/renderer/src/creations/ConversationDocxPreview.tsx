import { useEffect, useRef, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import type { ConversationFile } from '@shared/private-conversations'
import { Button } from '../my/ui'
import { useMy } from '../my/store'
import './conversation-table-preview.css'
import './conversation-docx-preview.css'

type Data = { name: string; revision: string; html: string; locator: string }
type Props = {
  file: ConversationFile
  load: (operationId: string, current: () => boolean) => Promise<Data>
  validate: (locator: string, current: () => boolean) => Promise<void>
  cancel: (operationId: string) => void
  release: (locator: string) => void
  onClose: () => void
  onOpen: () => void
}
type State = { kind: 'loading' } | { kind: 'ready'; html: string } | { kind: 'error'; message: string }

export default function ConversationDocxPreview({ file, load, validate, cancel, release, onClose, onOpen }: Props): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const theme = useMy(value => value.theme), density = useMy(value => value.fontSize)
  const heading = useRef<HTMLHeadingElement>(null)
  const refs = useRef({ load, validate, cancel, release }); refs.current = { load, validate, cancel, release }
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => {
    let live = true, checking = false, locator: string | undefined, timer = 0, deadline = 0, validationTimeout = 0
    const operationId = crypto.randomUUID(), owned = refs.current
    const current = (): boolean => live
    const stop = (): void => {
      if (!live) return
      live = false; window.clearInterval(timer); window.clearTimeout(deadline); window.clearTimeout(validationTimeout)
      owned.cancel(operationId)
      if (locator) owned.release(locator)
    }
    const fail = (message: string): void => { if (live) { stop(); setState({ kind: 'error', message }) } }
    setState({ kind: 'loading' })
    deadline = window.setTimeout(() => fail('DOCX 预览超时，请使用系统打开。'), 20_000)
    void owned.load(operationId, current).then(value => {
      if (!live) { if (value.locator) owned.release(value.locator); return }
      locator = value.locator
      if (!locator || value.name !== file.name || value.revision !== file.revision || typeof value.html !== 'string' || new TextEncoder().encode(value.html).length > 2 * 1024 * 1024) throw new Error('原文件或预览结果无效，请重新选择。')
      window.clearTimeout(deadline); setState({ kind: 'ready', html: value.html })
    }).catch(error => fail(error instanceof Error ? error.message : '无法预览 DOCX。'))
    timer = window.setInterval(() => {
      if (!live || !locator || checking) return
      checking = true
      validationTimeout = window.setTimeout(() => fail('无法及时核实原文件，请重新选择。'), 15_000)
      void owned.validate(locator, current).catch(error => fail(error instanceof Error ? error.message : '原文件或会话已不可用。')).finally(() => { checking = false; window.clearTimeout(validationTimeout) })
    }, 30_000)
    return stop
  }, [file.id, file.revision, file.sourceIdentity, attempt])
  const fontSize = density === 'small' ? 13 : density === 'large' ? 15 : 14
  const colorScheme = theme === 'dark' ? 'dark' : 'light'
  const document = state.kind === 'ready' ? `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html{color-scheme:${colorScheme}}body{font:${fontSize}px/1.6 system-ui,sans-serif;color:CanvasText;background:Canvas;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid GrayText;padding:.4em .65em;text-align:left;vertical-align:top}h1,h2,h3,h4,h5,h6{line-height:1.2}</style></head><body>${state.html}</body></html>` : ''
  return <section className="conversation-table-preview" aria-labelledby="conversation-docx-heading">
    <div className="flex flex-wrap items-center gap-2"><h2 ref={heading} id="conversation-docx-heading" tabIndex={-1} className="my-item-title min-w-0 flex-1 break-all">{file.name}</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="关闭 DOCX 预览"><X size={14} />关闭</Button></div>
    <p className="my-item-description">内容预览，可能缺失图片、页眉页脚及版式。</p>
    {state.kind === 'loading' && <p role="status" className="my-item-description">正在读取 DOCX…</p>}
    {state.kind === 'error' && <div role="alert" className="flex flex-wrap items-center gap-2 text-my-sm text-my-danger-text">{state.message}<Button size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button></div>}
    {state.kind === 'ready' && <iframe className="conversation-docx-preview-frame" title={`${file.name} 内容预览`} sandbox="" srcDoc={document} />}
    <div><Button size="sm" variant="ghost" onClick={onOpen}>系统打开</Button></div>
  </section>
}
