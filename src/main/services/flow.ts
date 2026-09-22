import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { getSettings } from './store'
import { aiChat } from './ai'
import { GatewayManager } from './gateway/manager'
import type { FlowDef, FlowSummary } from '../../shared/types'

/**
 * AI 工作流（Flow）：.trellis/flows/<id>.flow.json。
 * 自然语言 → AI 生成 Flow DSL（阶段 / 子代理 / 工具 / 门禁 / 钩子）→ 保存 → 运行时执行。
 * 设计借鉴 subagent 编排系统的核心概念，但面向不懂编程的用户：JSON、中文步骤名、一键运行。
 */

function flowsDir(root: string): string {
  return join(root, '.trellis', 'flows')
}

export function listFlows(root: string): FlowSummary[] {
  const dir = flowsDir(root)
  const out: FlowSummary[] = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.flow.json')) continue
    try {
      const def = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as FlowDef
      if (!def?.id || !Array.isArray(def.phases)) continue
      out.push(summarize(def, join(dir, name)))
    } catch {
      // 单个损坏文件跳过
    }
  }
  return out
}

function summarize(def: FlowDef, path: string): FlowSummary {
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    phaseCount: def.phases.length,
    stepCount: def.phases.reduce((n, p) => n + p.steps.length, 0),
    inputNames: (def.inputs ?? []).map((i) => i.name),
    updatedAt: def.updatedAt ?? 0,
    path
  }
}

export function readFlow(root: string, id: string): FlowDef | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null
  const p = join(flowsDir(root), `${id}.flow.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as FlowDef
  } catch {
    return null
  }
}

/** 结构校验：返回用户可读的问题清单（空数组 = 通过） */
export function validateFlow(def: unknown): string[] {
  const problems: string[] = []
  const d = def as Partial<FlowDef> | null
  if (!d || typeof d !== 'object') return ['工作流必须是 JSON 对象']
  if (!d.id || !/^[A-Za-z0-9_-]+$/.test(d.id)) problems.push('id 仅允许字母/数字/下划线/连字符')
  if (!d.name || typeof d.name !== 'string') problems.push('缺少 name')
  if (!Array.isArray(d.phases) || d.phases.length === 0) problems.push('至少需要一个 phase')
  const stepIds = new Set<string>()
  for (const pi of (d.phases ?? []) as unknown as Array<{ id?: string; name?: string; steps?: unknown[] }>) {
    if (!pi?.id || !pi?.name) problems.push('每个 phase 需要 id 与 name')
    for (const raw of pi.steps ?? []) {
      const s = raw as unknown as Record<string, unknown>
      if (!s?.id || !s?.name) {
        problems.push('每个 step 需要 id 与 name')
        continue
      }
      if (stepIds.has(String(s.id))) problems.push(`步骤 id 重复：${s.id}`)
      stepIds.add(String(s.id))
    }
  }
  // gate / tool 引用检查
  for (const pi of (d.phases ?? []) as unknown as Array<{ steps?: unknown[] }>) {
    for (const raw of pi.steps ?? []) {
      const s = raw as unknown as Record<string, unknown>
      if (s.kind === 'gate') {
        const check = s.check as { stepId?: string } | undefined
        if (!check?.stepId || !stepIds.has(check.stepId)) problems.push(`门禁 ${s.id} 引用了不存在的步骤：${check?.stepId}`)
        if (s.onFail === 'goto' && (!s.gotoStepId || !stepIds.has(String(s.gotoStepId)))) problems.push(`门禁 ${s.id} 的 goto 目标不存在`)
        if (s.feedbackTo && !stepIds.has(String(s.feedbackTo))) problems.push(`门禁 ${s.id} 的 feedbackTo 目标不存在`)
      }
      if (s.kind === 'tool') {
        const known = GatewayManager.getStandardTools().map((t) => t.name)
        if (!known.includes(String(s.tool))) problems.push(`工具步骤 ${s.id} 使用了未知工具：${s.tool}（可用：${known.join('、')}）`)
      }
    }
  }
  return problems
}

export function saveFlow(root: string, def: FlowDef): { ok: boolean; error?: string; path?: string } {
  const problems = validateFlow(def)
  if (problems.length > 0) return { ok: false, error: problems.join('；') }
  try {
    const dir = flowsDir(root)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const finalDef = { ...def, updatedAt: Date.now() }
    const p = join(dir, `${def.id}.flow.json`)
    writeFileSync(p, JSON.stringify(finalDef, null, 2), 'utf-8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function deleteFlow(root: string, id: string): { ok: boolean; error?: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, error: '非法 id' }
  try {
    const p = join(flowsDir(root), `${id}.flow.json`)
    if (existsSync(p)) rmSync(p)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/* ---------------- AI 生成（自然语言 → Flow DSL） ---------------- */

const GEN_SYSTEM = `你是工作流设计师。根据用户的自然语言需求，设计一个可执行的多代理工作流（JSON）。

可用工具（tool 步骤与 agent 步骤的 tools 字段可引用）：
{{TOOLS}}

产出 JSON Schema：
{
  "version": 1,
  "id": "英文短id",
  "name": "中文工作流名",
  "description": "一句话说明",
  "inputs": [{ "name": "英文参数名", "label": "中文参数名", "description": "说明", "required": true, "default": "" }],
  "phases": [
    { "id": "p1", "name": "中文阶段名（讲这一段做什么）", "steps": [
      { "kind": "agent", "id": "s1", "name": "中文角色名", "persona": "一句话人设", "instruction": "详细指令，可用 {{input.参数名}} 引用输入", "tools": ["kb_search"], "saveOutputAs": "变量名" },
      { "kind": "tool", "id": "s2", "name": "中文名", "tool": "工具名", "args": { "参数": "值或{{input.x}}" }, "saveOutputAs": "变量名" },
      { "kind": "gate", "id": "s3", "name": "中文名", "check": { "stepId": "s1", "contains": "必须包含的词", "minLength": 100 }, "onFail": "goto", "gotoStepId": "s1", "feedbackTo": "s1", "maxRetries": 1 }
    ] }
  ],
  "hooks": { "onStart": "全局指令（如：全程简体中文）", "onComplete": { "notify": true, "saveNote": false } }
}

设计原则：
1. 面向不懂编程的用户：所有 name 用中文短句说清「这一步为用户做什么」；阶段讲一个完整故事（如「调研背景」「产出结论」）
2. 子代理各司其职：一个步骤只做一件事；需要查证项目事实的 agent 配 tools（kb_search 查知识库、trellis_list_tasks 查任务）
3. 关键产出要设门禁（gate）：如报告类步骤检查 minLength 与 contains；失败 goto 带反馈重试一次
4. 后一步用 {{vars.变量名}} 引用前一步产出，串成流水线
5. inputs 只留真正会变的（如调研主题），能推导的给 default
6. 严格输出 JSON（不要 markdown 代码块、不要解释）`

export async function generateFlow(description: string): Promise<{ ok: boolean; error?: string; def?: FlowDef }> {
  const cfg = getSettings().ai
  if (!cfg.enabled) return { ok: false, error: '应用内 AI 未启用（设置 → AI 模型）' }
  const tools = GatewayManager.getStandardTools()
    .map((t) => `- ${t.name}（${t.description.slice(0, 60)}）参数：${Object.entries(t.parameters).map(([k, v]) => `${k}:${v.type}`).join(',') || '无'}`)
    .join('\n')
  const system = GEN_SYSTEM.replace('{{TOOLS}}', tools)
  const res = await aiChat(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: `我的需求：${description}` }
  ], { temperature: 0.3, maxTokens: 4096 })
  if (!res.ok || !res.content) return { ok: false, error: res.error ?? 'AI 生成失败' }

  // 提取 JSON（容忍模型偶尔包代码块）
  let text = res.content.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, error: 'AI 未返回有效的 JSON 工作流' }
  let def: unknown
  try {
    def = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { ok: false, error: '工作流 JSON 解析失败，请重试或换个描述' }
  }
  const problems = validateFlow(def)
  if (problems.length > 0) {
    return { ok: false, error: `生成的工作流未通过校验：${problems.join('；')}`, def: def as FlowDef }
  }
  return { ok: true, def: def as FlowDef }
}

/* ---------------- 模板库（开箱即用的落地流程） ---------------- */

export function builtinTemplates(): FlowDef[] {
  return [
    {
      version: 1,
      id: 'kb-research',
      name: '项目知识调研',
      description: '给定一个主题，检索五库并汇总成一份带来源的调研简报',
      inputs: [{ name: 'topic', label: '调研主题', description: '想了解的主题，例如「这个项目的发布流程」', required: true }],
      phases: [
        {
          id: 'p1',
          name: '检索项目知识',
          steps: [
            {
              kind: 'agent',
              id: 's1',
              name: '资料调研员',
              persona: '你是项目资料调研员，善于用检索工具全面收集信息并归纳。',
              instruction: '围绕主题「{{input.topic}}」，用 kb_search 在知识库中做多角度检索（至少 2 次、换不同关键词），必要时用 kb_read_doc 读原文。整理出 5~10 条关键信息，每条注明来源标题。',
              tools: ['kb_search', 'kb_read_doc'],
              saveOutputAs: 'research'
            }
          ]
        },
        {
          id: 'p2',
          name: '汇总并产出简报',
          steps: [
            {
              kind: 'agent',
              id: 's2',
              name: '简报撰写员',
              persona: '你是简报撰写员，把调研素材整理成清晰易读的中文简报，面向不懂编程的读者。',
              instruction: '基于以下调研素材写出简报：\n{{vars.research}}\n\n要求：先给 3 句话结论；再分「现状」「关键细节」「建议下一步」三节；保留来源标题。全程简体中文。'
            },
            {
              kind: 'gate',
              id: 'g1',
              name: '简报质量检查',
              check: { stepId: 's2', minLength: 200 },
              onFail: 'goto',
              gotoStepId: 's2',
              feedbackTo: 's2',
              maxRetries: 1
            }
          ]
        }
      ],
      hooks: { onStart: '全程简体中文，结论先行。', onComplete: { notify: true, saveNote: true } }
    },
    {
      version: 1,
      id: 'project-health',
      name: '项目健康巡检',
      description: '扫描任务与规范，输出项目当前状态、停滞预警与行动建议',
      inputs: [],
      phases: [
        {
          id: 'p1',
          name: '收集项目现状',
          steps: [
            { kind: 'tool', id: 't1', name: '读取任务清单', tool: 'trellis_list_tasks', args: {}, saveOutputAs: 'tasks' },
            { kind: 'tool', id: 't2', name: '读取规范清单', tool: 'trellis_list_specs', args: {}, saveOutputAs: 'specs' }
          ]
        },
        {
          id: 'p2',
          name: '诊断并给出建议',
          steps: [
            {
              kind: 'agent',
              id: 's1',
              name: '项目诊断师',
              persona: '你是项目管理诊断师，擅长从任务清单发现停滞、堆积与风险。',
              instruction: '根据任务清单：\n{{vars.tasks}}\n\n与规范清单：\n{{vars.specs}}\n\n输出诊断报告：1) 一句话总评；2) 任务分布统计（按状态）；3) 停滞/风险预警（指出具体任务名）；4) 3 条可执行建议。面向不懂编程的负责人，简体中文。'
            }
          ]
        }
      ],
      hooks: { onComplete: { notify: true } }
    },
    {
      version: 1,
      id: 'doc-review',
      name: '文档评审',
      description: '对一篇知识库文档做独立评审：挑问题、提改进，产出修订建议',
      inputs: [{ name: 'docTitle', label: '文档标题或关键词', description: '要评审的文档标题（或其中的关键词）', required: true }],
      phases: [
        {
          id: 'p1',
          name: '定位并阅读文档',
          steps: [
            {
              kind: 'agent',
              id: 's1',
              name: '文档检索员',
              persona: '你是文档检索员，快速定位目标文档并取回全文。',
              instruction: '用 kb_search 检索「{{input.docTitle}}」找到最相关的文档，然后用 kb_read_doc 读取全文。输出：文档标题、路径与全文内容。',
              tools: ['kb_search', 'kb_read_doc'],
              saveOutputAs: 'doc'
            }
          ]
        },
        {
          id: 'p2',
          name: '独立评审并汇总',
          steps: [
            {
              kind: 'agent',
              id: 's2',
              name: '独立评审员',
              persona: '你是独立评审员，第一次看到这份文档。你的职责是挑毛病而不是夸奖：找缺失、找矛盾、找读者会问但文中没有答案的问题。',
              instruction: '评审以下文档：\n{{vars.doc}}\n\n输出：1) 三个最值得改的问题（按影响排序）；2) 每个问题的具体修改建议；3) 一句话总体评价。简体中文。'
            }
          ]
        }
      ],
      hooks: { onStart: '评审视角：为读者挑毛病，不为作者找借口。', onComplete: { notify: true, saveNote: true } }
    }
  ]
}

/** 模板一键落地为可编辑工作流 */
export function installTemplate(root: string, def: FlowDef): { ok: boolean; error?: string } {
  const existing = readFlow(root, def.id)
  if (existing) return { ok: false, error: `工作流 ${def.id} 已存在` }
  const res = saveFlow(root, { ...def, createdAt: Date.now() })
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

export function flowMtime(root: string, id: string): number | null {
  const p = join(flowsDir(root), `${id}.flow.json`)
  try {
    return statSync(p).mtimeMs
  } catch {
    return null
  }
}
