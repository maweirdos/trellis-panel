import { useMemo, useState } from 'react'
import { Network, RotateCw } from 'lucide-react'
import { useApp } from '../store'
import { clsx } from 'clsx'
import type { JSX } from 'react'

/**
 * Trellis 工作流架构图 —— 纯 SVG 绘制（无图表库依赖）。
 * 三条泳道：会话层（AI 工具） / 调度层（hooks 与子代理） / 生命周期（任务状态机）。
 * 主链路光点流动动画；节点点击显示细节；叠加当前项目的真实任务状态。
 */

interface GNode {
  id: string
  x: number
  y: number
  w: number
  h: number
  title: string
  sub?: string
  kind: 'tool' | 'hook' | 'file' | 'state' | 'agent'
  detail: { trigger: string; consumer: string; files?: string }
  stateKey?: 'no_task' | 'planning' | 'in_progress' | 'review' | 'completed' | 'archived'
}

interface GEdge {
  from: string
  to: string
  path: string
  label?: string
  main?: boolean
  dashed?: boolean
  delay?: number
}

const W = 1180
const H = 656

const NODES: GNode[] = [
  /* ---- 会话层 ---- */
  { id: 'tool', x: 30, y: 70, w: 150, h: 58, title: 'AI 工具会话', sub: 'Claude / Codex / ZCode', kind: 'tool', detail: { trigger: '开发者启动编码会话', consumer: 'SessionStart hook 自动注入上下文' } },
  { id: 'session-start', x: 230, y: 70, w: 158, h: 58, title: 'SessionStart', sub: '会话上下文注入', kind: 'hook', detail: { trigger: '每次新会话启动', consumer: 'session-start.py：注入 .developer、workflow.md Phase Index、workspace 索引、git log', files: '.claude/hooks/session-start.py' } },
  { id: 'user', x: 438, y: 70, w: 118, h: 58, title: '用户消息', kind: 'tool', detail: { trigger: '每轮对话', consumer: '触发 workflow-state 注入后进入模型' } },
  { id: 'state-inject', x: 606, y: 70, w: 168, h: 58, title: 'workflow-state 注入', sub: 'UserPromptSubmit', kind: 'hook', detail: { trigger: '每轮用户输入', consumer: 'inject-workflow-state.py：按 task.json.status 提取 [workflow-state:*] 块注入', files: '.claude/hooks/inject-workflow-state.py' } },
  { id: 'model', x: 824, y: 70, w: 118, h: 58, title: '模型推理', kind: 'tool', detail: { trigger: '携带注入上下文生成回复', consumer: '按 Phase 步骤执行开发动作' } },
  { id: 'toolcall', x: 992, y: 70, w: 150, h: 58, title: '工具调用', sub: 'Read / Edit / Bash', kind: 'tool', detail: { trigger: '模型执行动作', consumer: 'PreToolUse 拦截 → 工具执行 → PostToolUse 记录' } },

  /* ---- 调度层 ---- */
  { id: 'pretooluse', x: 230, y: 250, w: 158, h: 58, title: 'PreToolUse', sub: 'matcher: Task', kind: 'hook', detail: { trigger: '模型派发子代理之前', consumer: 'inject-subagent-context.py：读取 implement.jsonl / check.jsonl 与 prd.md、design.md 组装子代理提示词', files: '.claude/hooks/inject-subagent-context.py' } },
  { id: 'subagent', x: 438, y: 250, w: 168, h: 58, title: '子代理', sub: 'implement / check', kind: 'agent', detail: { trigger: 'Task(subagent_type="trellis-*")', consumer: '隔离子进程执行实现与检查，结果回传主会话' } },
  { id: 'getctx', x: 656, y: 250, w: 158, h: 58, title: 'get_context.py', sub: '--mode phase', kind: 'file', detail: { trigger: '按需拉取', consumer: '解析 workflow.md，返回 Phase 索引或 #### X.Y 步骤详情', files: '.trellis/scripts/get_context.py' } },
  { id: 'dispatch', x: 864, y: 250, w: 158, h: 58, title: 'Codex 调度', sub: 'dispatch_mode', kind: 'hook', detail: { trigger: 'Codex 平台读取配置', consumer: 'inline（主代理实现）或 sub-agent（implement/check 分发）', files: '.trellis/config.yaml' } },

  /* ---- 生命周期层 ---- */
  { id: 'st-create', x: 30, y: 470, w: 150, h: 54, title: '创建任务', sub: 'after_create', kind: 'state', stateKey: 'no_task', detail: { trigger: 'task.py create / 面板 / Jira 导入', consumer: '写入 .trellis/tasks/<dir>/task.json，触发 after_create 钩子' } },
  { id: 'st-planning', x: 220, y: 470, w: 150, h: 54, title: 'planning', sub: 'after_start', kind: 'state', stateKey: 'planning', detail: { trigger: '任务进入规划', consumer: '产出 prd.md / design.md，触发 after_start 钩子' } },
  { id: 'st-doing', x: 410, y: 470, w: 150, h: 54, title: 'in_progress', sub: 'after_finish', kind: 'state', stateKey: 'in_progress', detail: { trigger: '规划确认后开始实现', consumer: '实现期间 subtasks 勾选推进，状态驱动每轮注入' } },
  { id: 'st-review', x: 600, y: 470, w: 150, h: 54, title: 'review', kind: 'state', stateKey: 'review', detail: { trigger: '实现完成进入评审', consumer: '评审通过 → completed；不通过退回 in_progress' } },
  { id: 'st-done', x: 790, y: 470, w: 150, h: 54, title: 'completed', sub: 'after_finish', kind: 'state', stateKey: 'completed', detail: { trigger: '验收通过', consumer: '写 completedAt，触发 after_finish 钩子' } },
  { id: 'st-archive', x: 980, y: 470, w: 162, h: 54, title: '归档', sub: 'after_archive', kind: 'file', stateKey: 'archived', detail: { trigger: '任务归档', consumer: '目录移入 .trellis/archive/，触发 after_archive 钩子，沉淀进归档知识库' } },

  /* ---- 底座 ---- */
  { id: 'files', x: 220, y: 580, w: 420, h: 54, title: '.trellis/', sub: 'workflow.md · config.yaml · spec/ · workspace/', kind: 'file', detail: { trigger: '所有环节的数据底座', consumer: 'workflow 决定阶段语义；config.yaml 声明钩子与包结构；spec 是团队规范的唯一事实源' } },
  { id: 'spec', x: 690, y: 580, w: 452, h: 54, title: '知识库 MCP', sub: 'kb_search · kb_read · kb_context', kind: 'tool', detail: { trigger: '编码过程按需查询', consumer: 'spec / wiki / 需求 / 归档四库，进程内倒排索引毫秒级检索' } }
]

const EDGES: GEdge[] = [
  { from: 'tool', to: 'session-start', path: 'M180,99 H230', main: true },
  { from: 'session-start', to: 'user', path: 'M388,99 H438', main: true, label: '注入' },
  { from: 'user', to: 'state-inject', path: 'M556,99 H606', main: true },
  { from: 'state-inject', to: 'model', path: 'M774,99 H824', main: true },
  { from: 'model', to: 'toolcall', path: 'M942,99 H992', main: true },
  /* 工具调用 → PreToolUse（Task 派发） */
  { from: 'toolcall', to: 'pretooluse', path: 'M1067,128 V212 H309 V250', main: true, label: 'Task 派发' },
  { from: 'pretooluse', to: 'subagent', path: 'M388,279 H438', main: true, label: '注入' },
  /* 子代理结果回传模型 */
  { from: 'subagent', to: 'model', path: 'M522,250 V166 H883 V128', dashed: true, label: '回传' },
  /* get_context 按需 */
  { from: 'getctx', to: 'model', path: 'M735,250 V186 H883 V128', dashed: true, label: '按需' },
  { from: 'model', to: 'dispatch', path: 'M900,128 V222 H943 V250', dashed: true },
  /* 生命周期链 */
  { from: 'st-create', to: 'st-planning', path: 'M180,497 H220', main: true },
  { from: 'st-planning', to: 'st-doing', path: 'M370,497 H410', main: true },
  { from: 'st-doing', to: 'st-review', path: 'M560,497 H600', main: true },
  { from: 'st-review', to: 'st-done', path: 'M750,497 H790', main: true },
  { from: 'st-done', to: 'st-archive', path: 'M940,497 H980', main: true },
  { from: 'st-review', to: 'st-doing', path: 'M640,524 V560 H485 V524', dashed: true, label: '退回' },
  /* 状态驱动注入 */
  { from: 'st-doing', to: 'state-inject', path: 'M485,470 V214 H690 V128', dashed: true, label: '状态驱动' }
]

const LANE_LABELS: Array<{ y: number; text: string }> = [
  { y: 46, text: '会话层 · 每轮对话' },
  { y: 226, text: '调度层 · 子代理与上下文' },
  { y: 446, text: '生命周期 · 任务状态机' }
]

const KIND_CLS: Record<GNode['kind'], string> = {
  tool: 'arch-node-tool',
  hook: 'arch-node-hook',
  file: 'arch-node-file',
  state: 'arch-node-state',
  agent: 'arch-node-agent'
}

export function ArchitecturePage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)
  const [selected, setSelected] = useState<GNode | null>(null)
  const [runId, setRunId] = useState(0)

  const currentNode = useMemo(() => {
    if (!snapshot?.meta.currentTask) return null
    const dir = snapshot.meta.currentTask
    const t = snapshot.tasks.find((x) => x.dirName === dir)
    const st = (t?.record?.status ?? 'planning').toLowerCase()
    const key = st === 'planning' ? 'planning' : st === 'in_progress' ? 'in_progress' : st === 'review' ? 'review' : 'completed'
    return { dir, key }
  }, [snapshot])

  const platformText = useMemo(() => {
    const live = snapshot?.meta.platforms.filter((p) => p.detected).map((p) => p.name) ?? []
    return live.length ? live.slice(0, 3).join(' / ') : 'Claude / Codex / ZCode'
  }, [snapshot])

  return (
    <div className="flex h-full min-w-0 animate-fade-in flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-850/40 px-5 py-2.5">
        <Network size={14} className="text-leaf" />
        <span className="text-[13px] font-semibold text-mist-100">Trellis 工作流架构</span>
        <span className="text-[10.5px] text-mist-500">点击节点查看细节</span>
        {currentNode && (
          <span className="chip bg-leaf-dim/15 text-[10.5px] text-leaf-soft">
            当前任务 · {currentNode.dir}
          </span>
        )}
        <button onClick={() => setRunId((r) => r + 1)} className="btn-ghost ml-auto justify-center px-2" title="重放动画">
          <RotateCw size={12} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto p-3">
          <svg key={runId} viewBox={`0 0 ${W} ${H}`} className="arch-svg h-full min-h-[520px] w-full">
            {/* 泳道底 */}
            {LANE_LABELS.map((l) => (
              <g key={l.y}>
                <text x={30} y={l.y} className="arch-lane">{l.text}</text>
                <line x1={140} y1={l.y - 4} x2={W - 30} y2={l.y - 4} className="arch-lane-line" />
              </g>
            ))}

            {/* 边 */}
            {EDGES.map((e, i) => {
              const from = NODES.find((n) => n.id === e.from)!
              const to = NODES.find((n) => n.id === e.to)!
              const active = selected && (selected.id === e.from || selected.id === e.to)
              return (
                <g key={i} className={clsx('arch-edge', active && 'arch-edge-active', e.main && 'arch-edge-main')}>
                  <path d={e.path} fill="none" className={clsx('arch-edge-path', e.dashed && 'arch-edge-dashed')} />
                  {e.main && !e.dashed && (
                    <circle r={3.2} className="arch-flow-dot">
                      <animateMotion dur="3.2s" begin={`${(i % 5) * 0.4}s`} repeatCount="indefinite" path={e.path} />
                    </circle>
                  )}
                  {e.label && (
                    <text
                      x={(from.x + from.w / 2 + to.x + to.w / 2) / 2}
                      y={(from.y + from.h / 2 + to.y + to.h / 2) / 2 - 8}
                      className="arch-edge-label"
                    >
                      {e.label}
                    </text>
                  )}
                </g>
              )
            })}

            {/* 节点 */}
            {NODES.map((n) => {
              const live = currentNode && n.stateKey === currentNode.key
              const dim = selected && selected.id !== n.id
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  onClick={() => setSelected(n)}
                  className={clsx('arch-node cursor-pointer', dim && 'arch-node-dim', live && 'arch-node-live')}
                >
                  <rect width={n.w} height={n.h} rx={10} className={KIND_CLS[n.kind]} />
                  <text x={14} y={n.h / 2 - (n.sub ? 4 : 0)} className="arch-node-title">{n.title}</text>
                  {n.sub && <text x={14} y={n.h / 2 + 14} className="arch-node-sub">{n.sub}</text>}
                  {n.sub && n.sub.length > 30 && null}
                </g>
              )
            })}
          </svg>
        </div>

        {/* 细节面板 */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-ink-700 p-4">
          {selected ? (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-mist-100">{selected.title}</div>
              {selected.sub && <div className="font-mono text-[10.5px] text-mist-500">{selected.sub}</div>}
              <div>
                <div className="text-[10px] uppercase tracking-wider text-mist-600">触发时机</div>
                <div className="mt-1 text-[11.5px] leading-5 text-mist-300">{selected.detail.trigger}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-mist-600">做什么</div>
                <div className="mt-1 text-[11.5px] leading-5 text-mist-300">{selected.detail.consumer}</div>
              </div>
              {selected.detail.files && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-mist-600">实现</div>
                  <code className="mt-1 block break-all font-mono text-[10.5px] text-leaf-soft/90">{selected.detail.files}</code>
                </div>
              )}
              <button onClick={() => setSelected(null)} className="btn-ghost w-full justify-center text-[11px]">关闭</button>
            </div>
          ) : (
            <div className="space-y-3 text-[11px] leading-5 text-mist-500">
              <div className="text-xs font-semibold text-mist-300">图例</div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2"><span className="arch-dot inline-block h-2 w-2 rounded-full bg-sky-400" /> hooks（自动触发）</div>
                <div className="flex items-center gap-2"><span className="arch-dot inline-block h-2 w-2 rounded-full bg-leaf" /> 任务状态机</div>
                <div className="flex items-center gap-2"><span className="arch-dot inline-block h-2 w-2 rounded-full bg-violet-400" /> 子代理 / 调度</div>
                <div className="flex items-center gap-2"><span className="arch-dot inline-block h-2 w-2 rounded-full bg-mist-500" /> 工具 / 文件</div>
              </div>
              <div className="border-t border-ink-700 pt-3">
                实线为每轮必经链路，虚线为按需或回退路径。流动光点表示上下文注入方向。
              </div>
              <div className="border-t border-ink-700 pt-3">
                {snapshot
                  ? '当前项目已接入——进行中的任务会点亮状态机对应节点。'
                  : '打开项目后，进行中的任务会点亮状态机对应节点。'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
