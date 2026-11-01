import type { JSX } from 'react'
import { Archive, ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { MarkdownView } from '../components/MarkdownView'
import { useChatEntries } from '../chat/useChatEntries'
import { Button } from '../my/ui'
import { ConnectionNotice } from '../acp/ConnectionNotice'
import { readArchive, useConversations } from './workspace'

const openArchiveDocument = async (): Promise<boolean> => { throw new Error('此旧问答未记录文件工作目录，请从原文件位置打开。') }

function ArchiveBranches({ archiveId, ids, index, loading }: { archiveId: string; ids?: string[]; index?: number; loading: boolean }): JSX.Element | null {
  if (!ids || ids.length < 2) return null
  const position = index ?? 0
  return <div className="flex items-center gap-1 text-my-xs text-my-tertiary" role="group" aria-label="只读历史分支"><Button size="sm" variant="ghost" aria-label="查看上一历史分支" disabled={loading || position <= 0} onClick={() => { const target = ids[position - 1]; if (target) void readArchive(archiveId, target) }}><ChevronLeft size={12} /></Button><span className="tabular-nums">{position + 1} / {ids.length}</span><Button size="sm" variant="ghost" aria-label="查看下一历史分支" disabled={loading || position >= ids.length - 1} onClick={() => { const target = ids[position + 1]; if (target) void readArchive(archiveId, target) }}><ChevronRight size={12} /></Button></div>
}

export function ConversationArchive({ id }: { id: string }): JSX.Element {
  const read = useConversations((state) => state.archiveReads[id])
  const entries = useChatEntries(read?.value?.messages ?? [])
  return <div className="acp-transcript my-scrollbar" role="region" aria-label="旧问答只读记录" tabIndex={0}><div className="my-conversation-column acp-transcript-content">
    <p className="private-archive-notice my-item-description"><Archive size={14} />旧问答只读归档 · 保留原有消息与当前分支</p>
    {read?.loading && !read.value && <p role="status" className="my-activity-note"><Loader2 size={14} className="animate-spin" />正在读取历史…</p>}
    {read?.error && <div className="acp-history-note"><ConnectionNotice message={read.error} /><Button size="sm" variant="ghost" onClick={() => void readArchive(id, read.branchId)}><RefreshCw size={13} />重试读取</Button></div>}
    {read?.loading && read.value && <p className="my-activity-note" role="status">正在读取历史分支…</p>}
    {entries.map((item) => item.kind === 'user' ? <div key={item.key} className="acp-turn-start flex justify-end"><div className="acp-user-message max-w-[88%]">{item.images?.map((image, index) => <img key={index} src={`data:${image.mediaType};base64,${image.dataBase64}`} alt="历史图片附件" className="private-archive-image" />)}<div className="acp-user-bubble acp-chat-copy whitespace-pre-wrap break-words">{item.content}</div><ArchiveBranches archiveId={id} ids={item.siblingIds} index={item.siblingIndex} loading={Boolean(read?.loading)} /></div></div> : <article key={item.key} className="private-archive-answer my-chat-prose acp-chat-copy">
      {item.reasoning && <details className="private-archive-process"><summary className="my-item-description">思考记录</summary><div className="my-scrollbar"><MarkdownView content={item.reasoning} onOpenDocumentLink={openArchiveDocument} /></div></details>}
      {item.toolOps?.map((tool, index) => <details key={`${tool.toolName}:${index}`} className="private-archive-process"><summary className="my-item-description">{tool.toolName} · {tool.status}</summary><pre className="my-scrollbar">{tool.argsSummary}</pre></details>)}
      <MarkdownView content={item.content} onOpenDocumentLink={openArchiveDocument} />
      <ArchiveBranches archiveId={id} ids={item.siblingIds} index={item.siblingIndex} loading={Boolean(read?.loading)} />
    </article>)}
    {!read?.loading && read?.value && !entries.length && <p className="my-activity-note">此历史记录没有消息。</p>}
  </div></div>
}
