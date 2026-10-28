import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileText, Plus, MessageSquare, ArrowUpRight, Copy, RefreshCw } from 'lucide-react'
import { type TeamProject, type TeamSession, type TeamMaterialVersion, type TeamPublishedDocument, teamMaterialVersionSchema, teamPublishedDocumentSchema, teamFeedbackSchema, TEAM_MAX_DOCUMENT_BYTES } from './contracts'
import { digest, request, verifyDocument } from './client'
import { usePage, useQuery, useWrite } from './hooks'
import { Empty, ErrorLine, Modal, Notice, Pager, kindName, time, visibilityName } from './ui'

type Selection = { materialId: string; version: number }
const safeLink = (url: string): boolean => /^https?:\/\//i.test(url)
const markdownComponents: import('react-markdown').Components = {
  a: ({ href, children }) => safeLink(href ?? '') ? <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={12} /></a> : <span title="该链接未作为在线资源发布">{children}</span>,
  img: ({ alt }) => <span className="unpublished-image">图像：{alt || '未命名'}（图像附件尚未发布）</span>
}
export function Documents({ project, session, authEpoch }: { project: TeamProject; session: TeamSession; authEpoch: number }) {
  const scope = `${session.person.userId}:${project.projectId}:${authEpoch}`
  const materials = usePage(scope, `/api/materials?projectId=${project.projectId}`, teamMaterialVersionSchema)
  const [selection, select] = useState<Selection | null>(null), [publish, setPublish] = useState<TeamPublishedDocument | 'new' | null>(null)
  useEffect(() => { if (!selection && materials.items[0]) select({ materialId: materials.items[0].materialId, version: materials.items[0].version }) }, [selection, materials.items])
  const selected = selection ?? (materials.items[0] ? { materialId: materials.items[0].materialId, version: materials.items[0].version } : null)
  const selectedKey = selected ? `${scope}:${selected.materialId}:${selected.version}` : scope + ':empty'
  const document = useQuery(selectedKey, async (signal) => {
    const value = await request(`/api/materials/${selected!.materialId}/versions/${selected!.version}`, teamPublishedDocumentSchema, { signal, notifyDenied: false })
    if (value.material.projectId !== project.projectId || value.material.materialId !== selected!.materialId || value.material.version !== selected!.version) throw Error('文档不属于所选工作区或版本')
    await verifyDocument(value.text, value.material.bodyDigest, value.material.byteLength)
    return value
  }, Boolean(selected), 30_000)
  const latest = materials.items.find((item) => item.materialId === selected?.materialId)
  return <div className="document-workspace">
    <aside className="document-list"><div className="pane-caption"><span>已发布资料</span><button type="button" className="icon" aria-label="刷新资料列表" disabled={materials.loading} onClick={materials.refresh}><RefreshCw size={15} /></button></div>
      {materials.items.map((item) => <button type="button" className={'document-row' + (item.materialId === selected?.materialId ? ' selected' : '')} key={item.materialId} onClick={() => select({ materialId: item.materialId, version: item.version })}>
        <FileText size={17} /><span><strong>{item.title}</strong><small>{kindName(item.kind)} · v{item.version} · {visibilityName(item.visibility)}</small></span>
      </button>)}
      {!materials.loading && !materials.items.length && !materials.error && <Empty title={materials.more ? '当前页暂无可见资料' : '还没有发布资料'}>{materials.more ? '还有后续页面，继续加载以核对可见资料。' : '发布后的固定版本会出现在这里。'}</Empty>}
      <Pager page={materials} /><button type="button" className="new-document" onClick={() => setPublish('new')}><Plus size={15} />发布文本资料</button>
    </aside>
    <section className="document-main" aria-label="固定版本阅读区">
      {document.error && <Notice>读取或授权核对失败：{document.error}。{document.value && '当前保留的是上次已读取版本，请恢复连接后核对。'}</Notice>}
      {!document.value ? document.loading ? <Empty title="正在读取固定版本…" /> : <Empty title="选择一份资料">查看发布内容、版本来源与相关反馈。</Empty> : <>
        <header className="document-heading"><div><div className="eyebrow">{kindName(document.value.material.kind)} <span>· {visibilityName(document.value.material.visibility)}</span></div><h1>{document.value.material.title}</h1><p>发布于 {time(document.value.material.createdAt)} · 当前阅读 v{document.value.material.version}</p></div><div className="document-actions"><Versions key={scope + document.value.material.materialId} material={document.value.material} select={select} />{document.value.material.ownerId === session.person.userId && <button type="button" onClick={() => setPublish(document.value!)}>发布下一版</button>}</div></header>
        {latest && latest.version > document.value.material.version && <Notice>列表已有 v{latest.version}，你正在阅读的 v{document.value.material.version} 保持不变。<button type="button" onClick={() => select({ materialId: latest.materialId, version: latest.version })}>查看新版</button></Notice>}
        <Reader key={selectedKey} document={document.value} scope={scope} />
      </>}
    </section>
    {publish && <Publish key={publish === 'new' ? 'new' : publish.material.materialId + publish.material.version} project={project} initial={publish === 'new' ? null : publish} onClose={() => setPublish(null)} onDone={(item) => { setPublish(null); materials.refresh(); select({ materialId: item.materialId, version: item.version }) }} />}
  </div>
}
function Versions({ material, select }: { material: TeamMaterialVersion; select: (selection: Selection) => void }) {
  const versions = usePage(material.materialId, `/api/materials/${material.materialId}/versions`, teamMaterialVersionSchema)
  const options = new Map([[material.version, material], ...versions.items.map((item) => [item.version, item] as const)])
  return <div className="version-select"><label>阅读版本<select aria-label="阅读版本" value={material.version} onChange={(event) => select({ materialId: material.materialId, version: Number(event.target.value) })}>{[...options.values()].sort((a, b) => b.version - a.version).map((item) => <option key={item.version} value={item.version}>v{item.version} · {time(item.createdAt)}</option>)}</select></label><Pager page={versions} /></div>
}
function Reader({ document: doc, scope }: { document: TeamPublishedDocument; scope: string }) {
  const [raw, setRaw] = useState(false), [quote, setQuote] = useState<{ text: string; start: number; end: number } | null>(null), [feedback, setFeedback] = useState(''), [saved, setSaved] = useState(false)
  const source = useRef<HTMLTextAreaElement>(null)
  const comments = usePage(`${scope}:${doc.material.materialId}:${doc.material.version}`, `/api/materials/${doc.material.materialId}/feedback?version=${doc.material.version}`, teamFeedbackSchema)
  const write = useWrite('/api/feedback', teamFeedbackSchema, doc.material.projectId, () => { setSaved(true); setFeedback(''); setQuote(null); comments.refresh() })
  return <div className="reading-layout"><article className="reading-paper">
    <div className="reading-tools"><button type="button" aria-pressed={raw} onClick={() => setRaw((old) => !old)}>{raw ? '返回排版阅读' : '选择原文批注'}</button><details><summary>版本来源</summary><p>SHA-256 <code>{doc.material.bodyDigest}</code></p><p>UTF-8 {doc.material.byteLength.toLocaleString()} 字节 · 发布者 {doc.material.authorId}</p><pre>{JSON.stringify(doc.material.source, null, 2)}</pre><p>固定发布记录不代表业务确认、反馈已接入或测试通过。</p></details></div>
    {raw ? <><p className="subtle">在原文中选择一段文字，再点“引用所选文字”。批注将保留在 v{doc.material.version}。</p><textarea ref={source} className="source-reader" aria-label="用于批注的固定版本原文" readOnly value={doc.text} /><button type="button" onClick={() => { const element = source.current; if (!element || element.selectionStart === element.selectionEnd) return; const start = element.selectionStart, end = element.selectionEnd; if (end - start > 4000) { setQuote(null); return }; setQuote({ text: doc.text.slice(start, end), start, end }); setSaved(false) }}><Copy size={14} />引用所选文字（最多 4000 字）</button></> : <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>{doc.text}</ReactMarkdown></div>}
  </article><aside className="feedback-pane"><div className="pane-caption"><span><MessageSquare size={15} />版本反馈</span><small>v{doc.material.version}</small></div>
    <form onSubmit={(event) => { event.preventDefault(); setSaved(false); void write.submit({ feedbackId: crypto.randomUUID(), materialId: doc.material.materialId, version: doc.material.version, body: feedback, ...(quote ? { quote: quote.text, anchor: { start: quote.start, end: quote.end } } : {}) }) }}>
      {quote && <blockquote><p>{quote.text}</p><button type="button" disabled={write.busy || write.uncertain} onClick={() => setQuote(null)}>移除引用</button></blockquote>}
      <label>给这份版本留下反馈<textarea aria-label="反馈内容" rows={4} maxLength={20_000} required disabled={write.busy || write.uncertain} value={feedback} onChange={(event) => { setFeedback(event.target.value); setSaved(false) }} placeholder="描述需要澄清或调整的地方…" /></label><button type="submit" className="primary" disabled={write.busy || !feedback.trim()}>{write.busy ? '正在记录…' : write.uncertain ? '以原操作标识重试' : '记录反馈'}</button>
      <ErrorLine>{write.error}</ErrorLine>{write.uncertain && <Notice>结果尚未确认。保留了原操作标识，可在顶部核对；重试使用同一内容。</Notice>}{saved && <Notice>反馈已记录，尚未接入开发。</Notice>}
    </form><div className="feedback-list">{comments.items.map((item) => <article className="feedback-item" key={item.feedbackId}><header><strong>{item.authorId === doc.material.authorId ? '发布者' : '工作区成员'}</strong><small>{time(item.createdAt)}</small></header>{item.quote && <blockquote>{item.quote}</blockquote>}<p>{item.body}</p><span className="tag">已记录 · 尚未接入</span></article>)}{!comments.loading && !comments.items.length && !comments.error && <p className="subtle">当前版本还没有反馈。</p>}<Pager page={comments} /></div>
  </aside></div>
}
function Publish({ project, initial, onClose, onDone }: { project: TeamProject; initial: TeamPublishedDocument | null; onClose: () => void; onDone: (result: TeamMaterialVersion) => void }) {
  const [title, setTitle] = useState(initial?.material.title ?? ''), [body, setBody] = useState(initial?.text ?? ''), [kind, setKind] = useState(initial?.material.kind ?? 'product-requirement'), [visibility, setVisibility] = useState(initial?.material.visibility ?? 'personal')
  const materialId = useRef(initial?.material.materialId ?? crypto.randomUUID()), sourceId = useRef(crypto.randomUUID())
  const [stage, setStage] = useState<'edit' | 'review'>('edit'), [previewDigest, setDigest] = useState('')
  const write = useWrite('/api/materials', teamMaterialVersionSchema, project.projectId, onDone)
  const bytes = new TextEncoder().encode(body).byteLength, locked = write.busy || write.uncertain
  return <Modal title={initial ? `发布下一版 · 当前 v${initial.material.version}` : '发布文本资料'} onClose={onClose} wide>
    <Notice>发布的是本次明确选择的文本版本。文中本地图片和文件不会自动上传。</Notice>
    <form onSubmit={(event) => { event.preventDefault(); if (stage === 'edit') { void digest(body).then((value) => { setDigest(value); setStage('review') }); return }; void write.submit({ materialId: materialId.current, projectId: project.projectId, title, kind, visibility, text: body, expectedVersion: initial?.material.version ?? null, expectedDigest: previewDigest, source: { kind: 'authored', sourceId: sourceId.current, version: previewDigest } }) }}>
      <fieldset disabled={locked || stage === 'review'}><label>标题<input value={title} maxLength={300} required onChange={(event) => setTitle(event.target.value)} /></label><div className="form-row"><label>资料类型<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>{['product-requirement', 'trellis-prd', 'design', 'spec', 'code', 'feedback', 'other'].map((value) => <option key={value} value={value}>{kindName(value)}</option>)}</select></label><label>可见范围<select value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}>{['personal', 'project', 'team'].map((value) => <option key={value} value={value}>{visibilityName(value)}</option>)}</select></label></div><label>正文（Markdown）<textarea aria-label="发布正文" className="publish-body" rows={12} value={body} required onChange={(event) => setBody(event.target.value)} /></label></fieldset>
      <p className="subtle">{bytes.toLocaleString()} / {TEAM_MAX_DOCUMENT_BYTES.toLocaleString()} UTF-8 字节 · 工作区 {project.name}</p>
      {stage === 'review' && <Notice>即将发布到“{visibilityName(visibility)}”，{initial ? `基于 v${initial.material.version} 创建下一版` : '创建 v1'}。旧版本与反馈保留。<details><summary>核对内容摘要</summary><code>{previewDigest}</code></details></Notice>}
      <ErrorLine>{write.error}</ErrorLine>{write.uncertain && <Notice>发布结果尚未确认，当前内容已锁定。顶部可核对原操作；重试不会生成新标识。</Notice>}
      <div className="dialog-actions">{stage === 'review' && <button type="button" disabled={locked} onClick={() => setStage('edit')}>返回修改</button>}<button className="primary" type="submit" disabled={write.busy || !title.trim() || !body.trim() || bytes > TEAM_MAX_DOCUMENT_BYTES}>{write.busy ? '正在发布…' : write.uncertain ? '以原操作标识重试' : stage === 'edit' ? '核对发布内容' : '确认发布此版本'}</button></div>
    </form>
  </Modal>
}
