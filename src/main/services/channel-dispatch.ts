/**
 * T4：只读审阅派发（能力验证切片，06 v2 §2 支柱三）。
 *
 * 合同：
 * - 仅 codex provider + `--sandbox read-only`（--sandbox 为 codex-only；
 *   claude 适配器走 bypassPermissions，提示词写 read-only 不会变只读）。
 * - trellis 子进程 cwd = 目标项目根：channel 项目桶由 CLI 进程 cwd 决定，
 *   与 spawn --cwd 无关——一次对齐（06 v2 channel 铁律 #1）。
 * - 一次性 ephemeral 频道，结束即删；worker 不自动获得全部项目文件，
 *   只投喂任务材料（--file 显式清单）。
 * - 每步失败即停并报告所在阶段；报告要求固定 Markdown 三段（可解析）。
 * - 中止 = Windows taskkill /T 树杀（cmd.exe → trellis.cmd → node 链）。
 */
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import type { TaskInfo } from '../../shared/types'
import { getSettings } from './store'

export interface DispatchPhase {
  key: 'create' | 'spawn' | 'send' | 'wait' | 'collect' | 'cleanup'
  label: string
  detail?: string
}

export interface DispatchResult {
  ok: boolean
  phase?: DispatchPhase['key']
  error?: string
  report?: string
  channel?: string
}

interface StepRun {
  proc: ChildProcess
  aborted: boolean
}

let current: StepRun | null = null

/** 用户中止：杀当前步骤的整棵进程树 */
export function abortDispatch(): void {
  if (!current) return
  current.aborted = true
  const pid = current.proc.pid
  if (pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    } else {
      current.proc.kill('SIGTERM')
    }
  }
}

function quoteArg(a: string): string {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

function step(cwd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const cmdLine = ['trellis', ...args].map(quoteArg).join(' ')
    const proc = spawn(cmdLine, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', PYTHONIOENCODING: 'utf-8' }
    })
    current = { proc, aborted: false }
    let out = ''
    let err = ''
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        if (proc.pid && process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
        } else {
          proc.kill('SIGKILL')
        }
        resolve({ code: -1, out, err: err + '\n[面板] 步骤超时被终止' })
      }
    }, timeoutMs)
    proc.stdout?.on('data', (d: Buffer) => {
      const t = d.toString('utf-8')
      out += t
      stdout += t
    })
    proc.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf-8')
      stderr += d.toString('utf-8')
    })
    proc.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, out, err: `${err}\n[面板] 启动失败：${e.message}` })
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
  })
}

function buildPrompt(task: TaskInfo): string {
  const status = task.record?.status ?? '未知'
  return [
    `请对本任务做只读审阅。你处于 read-only 沙箱：禁止创建、修改、删除任何文件，禁止执行会改状态的命令。`,
    `任务：${task.record?.title ?? task.dirName}（${task.dirName}），记录阶段：${status}。`,
    `随消息附上了任务材料文件。请阅读后，严格按以下 Markdown 结构输出报告，不要输出结构之外的任何内容：`,
    ``,
    `## 审阅结论`,
    `（1-2 句总体判断：材料是否齐备、目标是否清晰、与阶段是否匹配）`,
    ``,
    `## 发现的风险`,
    `- （每条一行：风险点 + 依据文件；无则写"无"）`,
    ``,
    `## 待人工确认`,
    `- （需要人拍板的问题；无则写"无"）`
  ].join('\n')
}

/** 从 `channel messages --raw` 输出提取 reviewer 最后一条消息文本 */
function extractReport(raw: string): string | null {
  // --raw 每行一个 JSON 事件；找 type/kind 为 message 且 payload 带 text 的最后一条
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const obj = JSON.parse(lines[i]) as Record<string, unknown>
      const payload = (obj.payload ?? obj) as Record<string, unknown>
      const text = typeof payload.text === 'string' ? payload.text : typeof payload.message === 'string' ? payload.message : null
      if (text && text.trim()) return text.trim()
    } catch {
      // 非 JSON 行跳过
    }
  }
  return null
}

export async function runReadonlyReview(
  root: string,
  task: TaskInfo,
  emit: (p: DispatchPhase) => void
): Promise<DispatchResult> {
  const name = `tp-review-${task.dirName}`
  const files: string[] = []
  for (const f of ['prd.md', 'design.md', 'implement.md']) {
    if (existsSync(join(task.path, f))) files.push(relative(root, join(task.path, f)).replace(/\\/g, '/'))
  }
  const timeoutMin = 20
  const ms = timeoutMin * 60 * 1000

  emit({ key: 'create', label: '创建临时频道', detail: name })
  let r = await step(root, ['channel', 'create', name, '--ephemeral', '--by', 'panel', '--task', relative(root, task.path).replace(/\\/g, '/')], 60_000)
  if (r.code !== 0) return { ok: false, phase: 'create', error: `创建频道失败：${r.err.trim().slice(-400) || `exit ${r.code}`}`, channel: name }

  emit({ key: 'spawn', label: '拉起只读 worker', detail: 'codex · sandbox read-only' })
  const spawnArgs = ['channel', 'spawn', name, '--provider', 'codex', '--sandbox', 'read-only', '--as', 'reviewer', '--cwd', root, '--timeout', `${timeoutMin}m`]
  // 账号默认模型不可用时（400 not supported）在设置中指定派单模型
  const model = getSettings().dispatch?.codexModel?.trim()
  if (model) spawnArgs.push('--model', model)
  for (const f of files) spawnArgs.push('--file', f)
  r = await step(root, spawnArgs, 120_000)
  if (r.code !== 0) {
    await step(root, ['channel', 'rm', name], 15_000)
    return { ok: false, phase: 'spawn', error: `拉起 worker 失败（确认 codex CLI 已安装登录；若报模型不支持，到 设置→派单 填写账号可用的模型）：${r.err.trim().slice(-400) || `exit ${r.code}`}`, channel: name }
  }

  emit({ key: 'send', label: '发送审阅指令', detail: `${files.length} 个材料文件` })
  // 多行 prompt 走 --text-file（send 的文件参数；--message-file 是 channel run 的参数，send 不认）
  const promptPath = join(tmpdir(), `${name}-prompt.md`)
  try {
    writeFileSync(promptPath, buildPrompt(task), 'utf-8')
    r = await step(root, ['channel', 'send', name, '--as', 'panel', '--to', 'reviewer', '--text-file', promptPath, '--delivery-mode', 'requireRunningWorker'], 60_000)
  } finally {
    try {
      rmSync(promptPath, { force: true })
    } catch {
      // 临时文件清理尽力而为
    }
  }
  if (r.code !== 0) {
    await step(root, ['channel', 'rm', name], 15_000)
    return { ok: false, phase: 'send', error: `发送失败：${r.err.trim().slice(-400) || `exit ${r.code}`}`, channel: name }
  }

  emit({ key: 'wait', label: '等待审阅完成', detail: `最长 ${timeoutMin} 分钟` })
  r = await step(root, ['channel', 'wait', name, '--as', 'panel', '--from', 'reviewer', '--kind', 'turn_finished', '--timeout', `${timeoutMin}m`], ms + 60_000)
  if (r.code !== 0) {
    await step(root, ['channel', 'rm', name], 15_000)
    return { ok: false, phase: 'wait', error: `等待失败或超时：${r.err.trim().slice(-400) || `exit ${r.code}`}`, channel: name }
  }

  emit({ key: 'collect', label: '收取报告' })
  r = await step(root, ['channel', 'messages', name, '--from', 'reviewer', '--kind', 'message', '--last', '1', '--raw'], 60_000)
  const report = r.code === 0 ? extractReport(r.out) : null
  if (!report) {
    await step(root, ['channel', 'rm', name], 15_000)
    return { ok: false, phase: 'collect', error: `未能解析报告（messages exit ${r.code}）：${(r.err || r.out).trim().slice(-300)}`, channel: name }
  }

  emit({ key: 'cleanup', label: '清理临时频道' })
  await step(root, ['channel', 'rm', name], 15_000)
  return { ok: true, report, channel: name }
}


export interface PlannerInput {
  title: string
  requirement: string
}

export interface PlannerResult {
  ok: boolean
  phase?: DispatchPhase['key']
  error?: string
  report?: string
  channel?: string
}

/**
 * T4 扩展：AI 起草任务。planner worker（.trellis/agents/planner.md，codex +
 * workspace-write）在项目内走官方流程：task.py create + 写 prd.md。
 * 面板不直接建任务——写入由有工作流身份的 worker 完成（06 v2 支柱三）。
 */
export async function runPlannerDispatch(
  root: string,
  input: PlannerInput,
  emit: (p: DispatchPhase) => void
): Promise<PlannerResult> {
  const name = `tp-plan-${Date.now().toString(36)}`
  const timeoutMin = 15
  const ms = timeoutMin * 60 * 1000

  emit({ key: 'create', label: '创建临时频道', detail: name })
  let r = await step(root, ['channel', 'create', name, '--ephemeral', '--by', 'panel'], 60_000)
  if (r.code !== 0) return { ok: false, phase: 'create', error: `创建频道失败：${r.err.trim().slice(-400) || `exit ${r.code}`}`, channel: name }

  emit({ key: 'spawn', label: '拉起 planner worker', detail: 'codex · workspace-write · 官方 planner 档案' })
  r = await step(root, ['channel', 'spawn', name, '--agent', 'planner', '--provider', 'codex', '--sandbox', 'workspace-write', '--as', 'planner', '--cwd', root, '--timeout', `${timeoutMin}m`], 120_000)
  if (r.code !== 0) {
    await step(root, ['channel', 'rm', name], 15_000)
    return { ok: false, phase: 'spawn', error: `拉起 planner 失败（需 .trellis/agents/planner.md 与 codex CLI）：${r.err.trim().slice(-400) || `exit ${r.code}`}`, channel: name }
  }

  emit({ key: 'send', label: '发送需求', detail: input.title })
  const promptPath = join(tmpdir(), `${name}-prompt.md`)
  const prompt = [
    `请为以下需求起草 Trellis 任务（按你的角色规则：task.py create 官方流程 + 仅写 prd.md + 不实施）：`,
    ``,
    `标题：${input.title}`,
    `需求：${input.requirement}`
  ].join('\n')
  try {
    writeFileSync(promptPath, prompt, 'utf-8')
    r = await step(root, ['channel', 'send', name, '--as', 'panel', '--to', 'planner', '--text-file', promptPath, '--delivery-mode', 'requireRunningWorker'], 60_000)
  } finally {
    try {
      rmSync(promptPath, { force: true })
    } catch {
      // best-effort
    }
  }
  if (r.code !== 0) {
    await step(root, ['channel', 'rm', name], 15_000)
    return { ok: false, phase: 'send', error: `发送失败：${r.err.trim().slice(-400) || `exit ${r.code}`}`, channel: name }
  }

  emit({ key: 'wait', label: '等待起草完成', detail: `最长 ${timeoutMin} 分钟` })
  r = await step(root, ['channel', 'wait', name, '--as', 'panel', '--from', 'planner', '--kind', 'turn_finished', '--timeout', `${timeoutMin}m`], ms + 60_000)
  if (r.code !== 0) {
    await step(root, ['channel', 'rm', name], 15_000)
    return { ok: false, phase: 'wait', error: `等待失败或超时：${r.err.trim().slice(-400) || `exit ${r.code}`}`, channel: name }
  }

  emit({ key: 'collect', label: '收取起草报告' })
  r = await step(root, ['channel', 'messages', name, '--from', 'planner', '--kind', 'message', '--last', '1', '--raw'], 60_000)
  const report = r.code === 0 ? extractReport(r.out) : null
  emit({ key: 'cleanup', label: '清理临时频道' })
  await step(root, ['channel', 'rm', name], 15_000)
  if (!report) {
    return { ok: false, phase: 'collect', error: `未能解析起草报告：${(r.err || r.out).trim().slice(-300)}`, channel: name }
  }
  return { ok: true, report, channel: name }
}
