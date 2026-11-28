import { useState, type JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import { SOURCE_PART_BYTES, taskSourceFiles, type TaskSourceFile } from '@shared/task-source-files'
import type { CruxMaterialScope } from '@shared/crux-task-materials'
import { api } from '../../../api'
import { Button, Checkbox, DisclosureGrid } from '../../../my/ui'
import { conversationClient, conversationValue } from '../../../conversations/client'
import type { TaskHandoffSource } from './task-handoff-source'

type Captured = { file: TaskSourceFile; bytes: Uint8Array<ArrayBuffer> }
const sha = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
function encode(part: Uint8Array): string {
  let text = ''
  for (let i = 0; i < part.length; i += 8192) text += String.fromCharCode(...part.subarray(i, i + 8192))
  return btoa(text)
}
export async function capturePostFiles(source: TaskHandoffSource, ids: readonly string[], current: () => boolean): Promise<Captured[]> {
  if (!ids.length) return []
  const client = conversationClient()
  if (!source.conversationId || !client) throw Error('请在原会话中重新打开文件')
  const selected = ids.map(id => source.fileChoices?.find(file => file.fileId === id))
  if (selected.length > 8 || selected.some(file => !file || file.bytes > 16 * 1024 * 1024) ||
      selected.reduce((total, file) => total + (file?.bytes ?? 0), 0) > 32 * 1024 * 1024) throw Error('最多共享 8 份文件，每份 16 MiB，合计 32 MiB')
  const captures: Captured[] = []
  for (const choice of selected) {
    if (!choice || !current()) throw Error('原交接已关闭')
    const bytes = new Uint8Array(conversationValue(await client.readAttachment(source.conversationId, {
      fileId: choice.fileId, expectedRevision: choice.revision, expectedSourceIdentity: choice.sourceIdentity, requirementId: choice.pinned ? source.draftId : undefined
    })))
    if (!current() || bytes.length !== choice.bytes || await sha(bytes) !== choice.revision) throw Error(`「${choice.name}」的原版本不可用`)
    const parts: string[] = []
    for (let start = 0; start < Math.max(1, bytes.length); start += SOURCE_PART_BYTES) parts.push(await sha(bytes.subarray(start, start + SOURCE_PART_BYTES)))
    captures.push({ file: { name: choice.name, bytes: bytes.length, revision: choice.revision, parts }, bytes })
  }
  taskSourceFiles.parse(captures.map(item => item.file))
  return captures
}
export async function sendPostFiles(scope: CruxMaterialScope, sourceId: string, captures: Captured[], current: () => boolean) {
  for (const { file, bytes } of captures) {
    for (const [part, digest] of file.parts.entries()) {
      if (!current() || !api.cruxMaterials) throw Error('原任务不可用，附件待传')
      const result = await api.cruxMaterials.sourcePart({ ...scope, revision: file.revision, sourceId, part,
        data: encode(bytes.subarray(part * SOURCE_PART_BYTES, (part + 1) * SOURCE_PART_BYTES)) })
      if (!result.ok) throw Error(result.error)
      if (result.value.digest !== digest || !current()) throw Error(`「${file.name}」待核对`)
    }
  }
}
export function PostFilePicker({ source, selected, onChange }: {
  source: TaskHandoffSource; selected: readonly string[]; onChange(ids: string[]): void
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!source.fileChoices?.length) return null
  return <div>
    <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="inline-flex cursor-pointer items-center gap-1 text-left transition-colors hover:text-my-primary">
      <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} />
      <span>共享附件{selected.length ? ` · ${selected.length}` : ''}</span>
    </button>
    <DisclosureGrid open={open}>
      <div className="mt-1">
        {source.fileChoices.map(file => <label key={file.fileId} className="flex items-center gap-2 py-1"><Checkbox
          checked={selected.includes(file.fileId)} onChange={checked => onChange(checked ? [...selected, file.fileId] : selected.filter(id => id !== file.fileId))} />
          {file.name}</label>)}
      </div>
    </DisclosureGrid>
  </div>
}
export async function readPostFile(scope: CruxMaterialScope, sourceId: string, file: TaskSourceFile, current: () => boolean) {
  const bytes = new Uint8Array(file.bytes)
  for (const [part, digest] of file.parts.entries()) {
    if (!current() || !api.cruxMaterials) throw Error('当前账号无法打开原附件')
    const reply = await api.cruxMaterials.sourcePart({ ...scope, revision: file.revision, sourceId, part })
    if (!reply.ok) throw Error(reply.error)
    if (reply.value.data === undefined || !current()) throw Error('原任务已变化')
    const chunk = Uint8Array.from(atob(reply.value.data), char => char.charCodeAt(0))
    if (await sha(chunk) !== digest) throw Error('附件分片与共享版本不符')
    bytes.set(chunk, part * SOURCE_PART_BYTES)
  }
  if (await sha(bytes) !== file.revision || !current()) throw Error('附件内容与原版本不符')
  return bytes
}
export function TaskPostFiles({ scope, sourceId, files, current }: {
  scope: CruxMaterialScope; sourceId: string; files: TaskSourceFile[]; current: () => boolean
}): JSX.Element {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function download(file: TaskSourceFile) {
    setBusy(true); setError('')
    try {
      const bytes = await readPostFile(scope, sourceId, file, current)
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '读取附件失败') }
    finally { if (current()) setBusy(false) }
  }
  return <section aria-label="共享附件">{files.map((file, index) => <Button size="sm" variant="ghost" key={index} disabled={busy}
    onClick={() => void download(file)}>{file.name}</Button>)}{error && <p role="alert" className="collab-inline-error">{error}</p>}</section>
}
