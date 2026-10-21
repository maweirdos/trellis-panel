/** 规划工作台：Jira/需求 → KB → AI 计划 → 任务落库 */
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { ipcInvoke } from '../../shared/ipc-channels'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { aiPlanTask, aiSplitEpic } from '../services/plan'
import { getSettings } from '../services/store'
import {
  getProjectRoot,
  getSnapshot,
  findTask,
  sendSnapshot,
  createTaskRecord,
  slugifyTitle
} from '../state'
import { handle } from './registry'

export function registerPlanningIpc(): void {
  handle(ipcInvoke.ai.plan, (_e, input: { title: string; description: string; jiraKey?: string; jiraUrl?: string }) => {
    const root = getProjectRoot()
    if (!root) return { ...noProject(), sources: [], contextChars: 0 }
    return aiPlanTask(root, getSettings().ai, {
      title: String(input?.title ?? ''),
      description: String(input?.description ?? ''),
      jiraKey: input?.jiraKey ? String(input.jiraKey) : undefined,
      jiraUrl: input?.jiraUrl ? String(input.jiraUrl) : undefined
    })
  })

  handle(ipcInvoke.task.createFromPlan, (_e, input) => {
    // 创建合同（PF-04/VF02）：确认的计划必须真实落盘为任务材料——
    // task.json + prd.md（需求说明/子任务/待确认问题），界面只宣称实际写出的文件。
    const title = String(input?.title ?? '')
    const subtasks = Array.isArray(input?.subtasks) ? (input.subtasks as unknown[]).map((s) => String(s)) : []
    const questions = Array.isArray(input?.questions)
      ? (input.questions as unknown[]).map((q) => String(q)).filter((q) => q.trim() !== '')
      : []
    const prdSections: string[] = [`# ${title}`, '']
    prdSections.push('> 来源：AI 规划工作台（人工确认后创建）')
    if (input?.jiraKey) prdSections.push(`> Jira：${String(input.jiraKey)}${input?.jiraUrl ? ` · ${String(input.jiraUrl)}` : ''}`)
    prdSections.push('', '## 需求说明', '', String(input?.description ?? '').trim() || '（待补充）', '')
    if (subtasks.length > 0) {
      prdSections.push('## 子任务', '', ...subtasks.map((s) => (s.trim().startsWith('-') ? s : `- [ ] ${s}`)), '')
    }
    if (questions.length > 0) {
      prdSections.push('## 待确认问题（AI 标注的信息缺口，开工前先澄清）', '', ...questions.map((q) => `- [ ] ${q}`), '')
    }
    return createTaskRecord({
      dirName: slugifyTitle(title),
      title,
      description: String(input?.description ?? ''),
      status: 'planning',
      priority: String(input?.priority ?? 'P2'),
      assignee: getSnapshot()?.meta.developer ?? '',
      origin: 'plan',
      jiraKey: input?.jiraKey ? String(input.jiraKey) : undefined,
      jiraUrl: input?.jiraUrl ? String(input.jiraUrl) : undefined,
      subtasks,
      workflow: typeof input?.workflow === 'string' && input.workflow ? input.workflow : null,
      devType: typeof input?.devType === 'string' && input.devType ? input.devType : null,
      scope: typeof input?.scope === 'string' && input.scope ? input.scope : null,
      branch: typeof input?.branch === 'string' && input.branch ? input.branch : null,
      prdContent: prdSections.join('\n')
    })
  })

  /* 交接出口已收敛（F03/PF-08）：计划完成页改走 task:handoffBuild（handoff.ts
   * 确定性交接包，默认只核对与阅读）；旧 plan.ts handoffTexts 的"完成后更新
   * task.json 状态"越权指引与平台硬编码一并移除。 */

  handle(ipcInvoke.ai.splitEpic, async (_e, dirName: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    const t = findTask(String(dirName))
    if (!t?.record) return ipcFail(IpcErrorCode.NotFound, `任务不存在: ${dirName}`)
    let prd: string | null = null
    try {
      prd = readFileSync(join(t.path, 'prd.md'), 'utf-8')
    } catch {
      // 无 PRD 也能按描述拆分
    }
    const res = await aiSplitEpic(getSettings().ai, { title: t.record.title, description: t.record.description, prd })
    if (!res.ok || !res.children) return res
    const created: string[] = []
    const errors: string[] = []
    for (const c of res.children) {
      const r = createTaskRecord({
        dirName: slugifyTitle(c.title),
        title: c.title,
        description: c.description,
        status: 'planning',
        priority: t.record.priority,
        assignee: getSnapshot()?.meta.developer ?? '',
        origin: 'panel',
        subtasks: c.subtasks
      })
      if (r.ok && r.dirName) {
        try {
          const jp = join(root, '.trellis', 'tasks', r.dirName, 'task.json')
          const rec = JSON.parse(readFileSync(jp, 'utf-8'))
          rec.parent = t.dirName
          writeFileSync(jp, JSON.stringify(rec, null, 2) + '\n', 'utf-8')
        } catch {
          // parent 引用写失败不影响目录创建
        }
        created.push(r.dirName)
      } else {
        errors.push(`${c.title}：${r.ok ? '未知错误' : r.error}`)
      }
    }
    if (created.length > 0) sendSnapshot()
    return { ok: created.length > 0, error: errors.length ? errors.join('；') : undefined, created }
  })
}
