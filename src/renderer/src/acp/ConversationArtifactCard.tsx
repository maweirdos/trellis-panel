import type { JSX } from 'react'
import { ArrowUpRight, FileText } from 'lucide-react'
import type { ConversationArtifact } from './artifacts'

const availabilityLabel = { present: '任务材料', readable: '文件可读', missing: '文件已移除', unreadable: '暂不可读' }

export function ConversationArtifactCard({ artifact, onOpen, selected = false }: {
  artifact: ConversationArtifact
  onOpen: (artifact: ConversationArtifact) => void
  selected?: boolean
}): JSX.Element {
  return (
    <button type="button" onClick={() => onOpen(artifact)} aria-pressed={selected}
      className="acp-artifact flex w-full items-center gap-3 rounded-my-lg border border-my-line bg-my-layer-1 px-3 py-2.5 text-left transition-colors hover:bg-my-layer-1-hover"
      title={`${artifact.relativePath} · 打开当前文件`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-my-md bg-my-accent-subtle text-my-accent-text"><FileText size={16} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-my-sm font-medium text-my-primary">{artifact.label}</span>
        <span className="mt-0.5 block truncate text-my-xs text-my-secondary">{availabilityLabel[artifact.availability]} · {artifact.taskDir}</span>
      </span>
      {artifact.change === 'change' && <span className="my-chip bg-my-accent-subtle text-my-accent-text">已更新</span>}
      <ArrowUpRight size={14} className="shrink-0 text-my-icon-secondary" />
    </button>
  )
}
