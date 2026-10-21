import { create } from 'zustand'
import { useApp } from '../store'
import { projectRootKey } from '../my/navigation'

export interface KnowledgeRequestDraft {
  id: string
  root: string
  title: string
  description: string
  intent?: 'discussion'
  source: { kind: 'manual' } | { kind: 'jira'; key: string; url: string; instanceId: string; issueId?: number | null }
}
interface RequestIntakeState {
  draft: KnowledgeRequestDraft | null
  stage: (input: Omit<KnowledgeRequestDraft, 'id'>) => boolean
  clear: (id: string) => void
}

export const useKnowledgeRequest = create<RequestIntakeState>((set, get) => ({
  draft: null,
  stage: (input) => {
    if (!input.title.trim() || projectRootKey(input.root) !== projectRootKey(useApp.getState().snapshot?.meta.root)) return false
    observeRoot()
    set({ draft: { ...input, id: crypto.randomUUID() } })
    useApp.getState().setPage('acp')
    return true
  },
  clear: (id) => { if (get().draft?.id === id) set({ draft: null }) }
}))

let observingRoot = false
function observeRoot(): void {
  if (observingRoot) return
  observingRoot = true
  useApp.subscribe((state, previous) => {
    if (projectRootKey(state.snapshot?.meta.root) !== projectRootKey(previous.snapshot?.meta.root)) {
      const id = useKnowledgeRequest.getState().draft?.id
      if (id) useKnowledgeRequest.getState().clear(id)
    }
  })
}

export function requirementsDraftText(draft: KnowledgeRequestDraft): string {
  if (draft.intent === 'discussion') return `${draft.description || draft.title}\n\n请按需检索本项目知识，标明实际来源和缺少的依据。`
  const source = draft.source.kind === 'jira' ? `Jira ${draft.source.key}\n实例：${draft.source.instanceId}\n链接：${draft.source.url}${draft.source.issueId ? `\n工单 ID：${draft.source.issueId}` : ''}` : '用户手动提出的需求'
  return `请和我一起讨论、澄清以下产品需求。按需检索本项目知识，结合实际来源核对规则、冲突和缺少的依据。关键问题明确后，可以问我要不要整理成需求文档；我提出或同意整理时，请结合相关讨论和资料，用项目工作流工具直接生成并保存完整文档，告诉我保存结果。若我要求发布知识库或交给开发，继续通过工作流工具完成对应步骤；只有缺少必要业务信息或目标不明确时才追问。保留未决问题，区分讨论结论和已核实事实；交接到开发规划不代表开始代码实施。\n\n需求：${draft.title}\n\n${draft.description}\n\n原始来源（不代表已验证事实）：\n${source}`
}
