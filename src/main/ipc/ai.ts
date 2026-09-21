import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import type { AiConfig, ChatMessage, ModelProvider } from '../../shared/types'
import { aiChat, aiTest, aiTaskPrompt, fetchModelsFromProvider, testSingleModel, enrichModelsWithCatalog } from '../services/ai'
import { aiCommitMsg, aiPrDesc } from '../services/plan'
import { getSettings } from '../services/store'
import { isGitRepo, taskGitInfo } from '../services/git'
import { getProjectRoot, getSnapshot, findTask, flattenSpecNames } from '../state'
import { handle } from './registry'
import { app } from 'electron'

export function registerAiIpc(): void {
  handle(ipcInvoke.ai.chat, (_e, messages: ChatMessage[]) => {
    const cfg = getSettings().ai
    const safe = (Array.isArray(messages) ? messages : [])
      .filter((m) => m && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role))
      .slice(0, 40)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 32_000) }))
    return aiChat(cfg, safe)
  })

  handle(ipcInvoke.ai.test, (_e, cfg: AiConfig) => aiTest(cfg))
  // 发现优先 + models.dev 富化（TPD-012）：缓存 24h，离线自动回退旧缓存
  handle(ipcInvoke.ai['fetch-models'], async (_e, provider: ModelProvider) => {
    const res = await fetchModelsFromProvider(provider)
    if (!res.ok || !res.models) return res
    return { ok: true, models: await enrichModelsWithCatalog(app, res.models) }
  })
  handle(ipcInvoke.ai['test-model'], (_e, provider: ModelProvider, modelId: string) => testSingleModel(provider, modelId))

  handle(ipcInvoke.ai.prdDraft, (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t?.record) return ipcFail(IpcErrorCode.NotFound, '任务不存在')
    const specTitles = flattenSpecNames(getSnapshot()?.spec ?? []).slice(0, 40)
    return aiTaskPrompt(
      getSettings().ai,
      {
        title: t.record.title,
        description: t.record.description,
        notes: t.record.notes,
        subtasks: t.record.subtasks ?? [],
        specTitles,
        devType: t.record.dev_type,
        scope: t.record.scope
      },
      'prd'
    )
  })

  handle(ipcInvoke.ai.summary, (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t?.record) return ipcFail(IpcErrorCode.NotFound, '任务不存在')
    return aiTaskPrompt(
      getSettings().ai,
      {
        title: t.record.title,
        description: t.record.description,
        notes: t.record.notes,
        subtasks: t.record.subtasks ?? [],
        specTitles: [],
        devType: t.record.dev_type,
        scope: t.record.scope
      },
      'summary'
    )
  })

  handle(ipcInvoke.ai.commitMsg, async (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t?.record) return ipcFail(IpcErrorCode.NotFound, '任务不存在')
    const root = getProjectRoot()
    let commits: string[] = []
    if (root && isGitRepo(root)) {
      const info = await taskGitInfo(root, t.dirName, t.record.branch ?? null, t.record.base_branch ?? null)
      commits = info.commits.map((c) => `${c.short} ${c.subject}`)
    }
    return aiCommitMsg(getSettings().ai, { title: t.record.title, description: t.record.description, recentCommits: commits })
  })

  handle(ipcInvoke.ai.prDesc, async (_e, dirName: string) => {
    const t = findTask(String(dirName))
    if (!t?.record) return ipcFail(IpcErrorCode.NotFound, '任务不存在')
    return aiPrDesc(getSettings().ai, {
      title: t.record.title,
      description: t.record.description,
      subtasks: t.record.subtasks ?? []
    })
  })
}
