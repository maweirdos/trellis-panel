import { useEffect, useState, type JSX } from 'react'
import { ExternalLink, File, FileInput, FolderOpen, Loader2, RefreshCw, X } from 'lucide-react'
import type { ConversationFile } from '@shared/private-conversations'
import { Button, Modal } from '../my/ui'
import { ConnectionNotice } from '../acp/ConnectionNotice'
import { useInteractionGuard } from '../utils/interaction-scope'
import { ArtifactDelivery } from './ArtifactDelivery'
import { conversationClient, conversationError, conversationValue } from './client'
import { refreshFiles, useConversations } from './workspace'

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function ConversationFiles({ entryKey, onClose }: { entryKey: string; onClose(): void }): JSX.Element | null {
  const current = useConversations((state) => state.entries[entryKey]), [delivery, setDelivery] = useState<ConversationFile | null>(null)
  const [opening, setOpening] = useState(''), [error, setError] = useState('')
  const canInteract = useInteractionGuard()
  useEffect(() => { void refreshFiles(entryKey) }, [entryKey])
  const conversation = current?.conversation
  if (!current || current.locked) return null
  const open = async (file: ConversationFile, action: 'open' | 'reveal'): Promise<void> => {
    const client = conversationClient()
    if (!client || !conversation || opening || !canInteract()) return
    setOpening(file.id); setError('')
    try { conversationValue(await client.openFile(conversation.id, { fileId: file.id, action })) }
    catch (cause) { if (canInteract()) setError(conversationError(cause)) }
    finally { if (canInteract()) setOpening('') }
  }
  return <>
    <Modal open onClose={onClose} ariaLabel="会话文件" width={680}>
      <div className="private-files-heading"><div><h2 className="my-item-title">会话文件</h2><p className="my-item-description">{conversation?.workspace.kind === 'directory' ? '来自此会话授权的目录' : '来自此会话的独立工作目录'}</p></div><Button size="sm" variant="ghost" disabled={current.filesLoading || !conversation} onClick={() => void refreshFiles(entryKey)} aria-label="刷新会话文件"><RefreshCw size={14} className={current.filesLoading ? 'animate-spin' : ''} /></Button><Button size="sm" variant="ghost" onClick={onClose} aria-label="关闭文件面板"><X size={15} /></Button></div>
      <div className="private-files-body my-scrollbar">
        {(current.fileError || error) && <ConnectionNotice message={error || current.fileError || ''} />}
        {current.filesLoading && !current.filesLoaded && <p className="my-activity-note" role="status"><Loader2 size={14} className="animate-spin" />正在读取文件…</p>}
        {(['input', 'output'] as const).map((kind) => {
          const files = current.files.filter((file) => file.kind === kind)
          return <section key={kind} className="private-file-group"><h3 className="my-item-description">{kind === 'input' ? '输入文件' : conversation?.workspace.kind === 'directory' ? '目录文件' : '产出文件'}</h3>{files.map((file) => <div key={file.id} className="private-file-row"><span className="private-file-icon">{kind === 'input' ? <FileInput size={16} /> : <File size={16} />}</span><div className="private-file-identity"><span className="my-item-title" title={file.relativePath}>{file.name}</span><span className="my-item-description" title={file.relativePath}>{file.relativePath} · {fileSize(file.bytes)}</span></div><div className="private-file-actions"><Button size="sm" variant="ghost" disabled={Boolean(opening)} onClick={() => void open(file, 'open')} aria-label={`打开 ${file.name}`} title="打开文件"><ExternalLink size={14} /></Button><Button size="sm" variant="ghost" disabled={Boolean(opening)} onClick={() => void open(file, 'reveal')} aria-label={`在文件夹中显示 ${file.name}`} title="在文件夹中显示"><FolderOpen size={14} /></Button>{conversation && /\.(md|txt|html|htm)$/i.test(file.name) && file.bytes <= 256 * 1024 && <Button size="sm" variant="outline" onClick={() => setDelivery(file)}>整理为创作</Button>}</div></div>)}{!files.length && !current.filesLoading && <p className="my-item-description private-files-empty">{kind === 'input' ? '尚未添加文件' : conversation?.workspace.kind === 'directory' ? '暂未发现可展示文件' : '暂未发现产出文件'}</p>}</section>
        })}
      </div>
    </Modal>
    {delivery && conversation && <ArtifactDelivery key={`${conversation.id}:${delivery.id}:${delivery.revision}`} conversation={conversation} file={delivery} onClose={() => setDelivery(null)} />}
  </>
}
