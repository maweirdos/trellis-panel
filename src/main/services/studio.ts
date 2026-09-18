import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join, resolve, sep, extname, basename, dirname, relative } from 'path'
import yaml from 'js-yaml'
import type {
  ExtEntry,
  ExtKind,
  FileEntry,
  HookRegistration,
  LifecycleHook,
  PackageEntry,
  PlatformProfile,
  PlatformStatus,
  StudioConfig,
  StudioScan,
  WorkflowInfo,
  WorkflowStructure
} from '../../shared/types'

/**
 * Studio（定制中心）服务 —— 读取/写回 .trellis 与各 AI 平台目录中的
 * workflow、slash 命令、子代理、技能、钩子与 config.yaml。
 * 布局遵循 Trellis 官方文档（docs.trytrellis.app → advanced/*）。
 */

/* ---------------- 平台目录（22 平台） ---------------- */

export const PLATFORMS: PlatformProfile[] = [
  { id: 'claude', name: 'Claude Code', marker: '.claude', installFlag: '—（基础平台）', capabilities: ['commands', 'agents', 'skills', 'hooks', 'workflows'], dirs: ['.claude'], invocationHint: '/trellis:{name}' },
  { id: 'cursor', name: 'Cursor', marker: '.cursor', installFlag: '--cursor', capabilities: ['commands', 'agents', 'skills', 'hooks', 'workflows'], dirs: ['.cursor'], invocationHint: '/trellis-{name}' },
  { id: 'opencode', name: 'OpenCode', marker: '.opencode', installFlag: '--opencode', capabilities: ['commands', 'agents', 'skills', 'hooks', 'workflows'], dirs: ['.opencode'], invocationHint: '/trellis:{name}' },
  { id: 'codex', name: 'Codex', marker: '.codex', installFlag: '--codex', capabilities: ['agents', 'skills', 'hooks', 'workflows'], dirs: ['.codex', '.agents'], invocationHint: '/trellis-{name}（skills）' },
  { id: 'gemini', name: 'Gemini CLI', marker: '.gemini', installFlag: '--gemini', capabilities: ['commands', 'agents', 'skills', 'hooks'], dirs: ['.gemini'], invocationHint: '/trellis:{name}' },
  { id: 'copilot', name: 'GitHub Copilot', marker: '.github/copilot-instructions.md', installFlag: '--copilot', capabilities: ['commands', 'agents', 'skills', 'hooks'], dirs: ['.github'], invocationHint: 'prompt 文件选择器' },
  { id: 'kiro', name: 'Kiro', marker: '.kiro', installFlag: '--kiro', capabilities: ['agents', 'skills'], dirs: ['.kiro'], invocationHint: '@trellis:{name}' },
  { id: 'qoder', name: 'Qoder', marker: '.qoder', installFlag: '--qoder', capabilities: ['commands', 'skills', 'agents'], dirs: ['.qoder'], invocationHint: '/trellis-{name}（CLI）' },
  { id: 'codebuddy', name: 'CodeBuddy', marker: '.codebuddy', installFlag: '--codebuddy', capabilities: ['commands', 'agents', 'skills', 'hooks'], dirs: ['.codebuddy'], invocationHint: '/trellis:{name}' },
  { id: 'droid', name: 'Factory Droid', marker: '.factory', installFlag: '--droid', capabilities: ['commands', 'agents', 'skills', 'hooks'], dirs: ['.factory'], invocationHint: '/trellis:{name}' },
  { id: 'pi', name: 'Pi Agent', marker: '.pi', installFlag: '--pi', capabilities: ['commands', 'agents', 'hooks'], dirs: ['.pi'], invocationHint: '/trellis-{name}' },
  { id: 'omp', name: 'Oh My Pi', marker: '.omp', installFlag: '--omp', capabilities: ['agents', 'skills'], dirs: ['.omp'], invocationHint: '@trellis:{name}' },
  { id: 'kilo', name: 'Kilo', marker: '.kilocode', installFlag: '--kilo', capabilities: ['workflows', 'skills'], dirs: ['.kilocode'], invocationHint: '/{name}.md' },
  { id: 'antigravity', name: 'Antigravity', marker: '.agent', installFlag: '--antigravity', capabilities: ['workflows', 'skills'], dirs: ['.agent'], invocationHint: 'workflow 目录' },
  { id: 'devin', name: 'Devin', marker: '.devin', installFlag: '--devin', capabilities: ['workflows', 'skills'], dirs: ['.devin'], invocationHint: '/trellis-{name}' },
  { id: 'zcode', name: 'ZCode', marker: '.zcode', installFlag: '--zcode', capabilities: ['skills'], dirs: ['.zcode'], invocationHint: 'skill 匹配' },
  { id: 'trae', name: 'Trae', marker: '.trae', installFlag: '--trae', capabilities: ['skills'], dirs: ['.trae'], invocationHint: 'skill 匹配' },
  { id: 'grok', name: 'Grok Build', marker: '.grok', installFlag: '--grok', capabilities: ['skills'], dirs: ['.grok'], invocationHint: 'skill 匹配' },
  { id: 'kimi', name: 'Kimi Code', marker: '.kimi', installFlag: '--kimi', capabilities: ['skills'], dirs: ['.kimi'], invocationHint: 'skill 匹配' },
  { id: 'snow', name: 'Snow CLI', marker: '.snow', installFlag: '--snow', capabilities: ['skills'], dirs: ['.snow'], invocationHint: 'skill 匹配' },
  { id: 'reasonix', name: 'Reasonix', marker: '.reasonix', installFlag: '--reasonix', capabilities: ['skills'], dirs: ['.reasonix'], invocationHint: 'skill 匹配' },
  { id: 'windsurf', name: 'Windsurf（已弃用）', marker: '.windsurf', installFlag: '--windsurf', capabilities: ['skills'], dirs: ['.windsurf'], invocationHint: '—' }
]

/** 共享技能层（agentskills.io 标准）：所有平台都读 */
const SHARED_SKILLS_DIRS = ['.agents/skills']

/* ---------------- 基础工具 ---------------- */

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function entryInfo(dir: string, name: string): FileEntry | null {
  const p = join(dir, name)
  try {
    const st = statSync(p)
    return {
      name,
      path: p,
      kind: st.isDirectory() ? 'dir' : 'file',
      size: st.size,
      mtime: st.mtimeMs,
      ext: st.isDirectory() ? '' : extname(name).toLowerCase()
    }
  } catch {
    return null
  }
}

function listFiles(dir: string, exts?: string[]): FileEntry[] {
  if (!isDir(dir)) return []
  const out: FileEntry[] = []
  for (const name of readdirSync(dir).sort()) {
    const e = entryInfo(dir, name)
    if (!e || e.kind !== 'file') continue
    if (exts && !exts.includes(e.ext)) continue
    out.push(e)
  }
  return out
}

/** 解析 YAML frontmatter；失败时返回原文 body。 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { data: {}, body: raw }
  const data: Record<string, string> = {}
  try {
    const obj = yaml.load(m[1])
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        data[k] = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
      }
    }
  } catch {
    // frontmatter 非法——保留空 data，正文仍可编辑
  }
  return { data, body: raw.slice(m[0].length) }
}

function readText(p: string): string | null {
  try {
    let c = readFileSync(p, 'utf-8')
    if (c.charCodeAt(0) === 0xfeff) c = c.slice(1)
    return c
  } catch {
    return null
  }
}

/* ---------------- 扩展扫描（命令 / 子代理 / 技能） ---------------- */

const COMMAND_DIRS: Array<{ platform: string; dir: string; style: 'flat' | 'nested' | 'hyphen' | 'prompt' | 'toml' | 'workflow'; invocation: string }> = [
  { platform: 'claude', dir: '.claude/commands', style: 'nested', invocation: '/trellis:{name}' },
  { platform: 'cursor', dir: '.cursor/commands', style: 'hyphen', invocation: '/{name}' },
  { platform: 'opencode', dir: '.opencode/commands', style: 'nested', invocation: '/trellis:{name}' },
  { platform: 'codebuddy', dir: '.codebuddy/commands', style: 'nested', invocation: '/trellis:{name}' },
  { platform: 'droid', dir: '.factory/commands', style: 'nested', invocation: '/trellis:{name}' },
  { platform: 'qoder', dir: '.qoder/commands', style: 'hyphen', invocation: '/{name}' },
  { platform: 'pi', dir: '.pi/prompts', style: 'hyphen', invocation: '/{name}' },
  { platform: 'copilot', dir: '.github/prompts', style: 'prompt', invocation: 'prompt 选择器' },
  { platform: 'gemini', dir: '.gemini/commands', style: 'toml', invocation: '/trellis:{name}' },
  { platform: 'devin', dir: '.devin/workflows', style: 'hyphen', invocation: '/{name}' },
  { platform: 'kilo', dir: '.kilocode/workflows', style: 'workflow', invocation: '/{name}.md' },
  { platform: 'antigravity', dir: '.agent/workflows', style: 'workflow', invocation: 'workflow 目录' }
]

const AGENT_DIRS: Array<{ platform: string; dir: string; format: ExtEntry['format'] }> = [
  { platform: 'claude', dir: '.claude/agents', format: 'md' },
  { platform: 'cursor', dir: '.cursor/agents', format: 'md' },
  { platform: 'opencode', dir: '.opencode/agents', format: 'md' },
  { platform: 'gemini', dir: '.gemini/agents', format: 'md' },
  { platform: 'qoder', dir: '.qoder/agents', format: 'md' },
  { platform: 'codebuddy', dir: '.codebuddy/agents', format: 'md' },
  { platform: 'droid', dir: '.factory/droids', format: 'md' },
  { platform: 'pi', dir: '.pi/agents', format: 'md' },
  { platform: 'omp', dir: '.omp/agents', format: 'md' },
  { platform: 'copilot', dir: '.github/agents', format: 'md' },
  { platform: 'codex', dir: '.codex/agents', format: 'toml' },
  { platform: 'kiro', dir: '.kiro/agents', format: 'json' }
]

const SKILL_DIRS: Array<{ platform: string | 'shared'; dir: string }> = [
  { platform: 'shared', dir: '.agents/skills' },
  { platform: 'claude', dir: '.claude/skills' },
  { platform: 'cursor', dir: '.cursor/skills' },
  { platform: 'opencode', dir: '.opencode/skills' },
  { platform: 'kiro', dir: '.kiro/skills' },
  { platform: 'qoder', dir: '.qoder/skills' },
  { platform: 'codebuddy', dir: '.codebuddy/skills' },
  { platform: 'copilot', dir: '.github/skills' },
  { platform: 'droid', dir: '.factory/skills' },
  { platform: 'devin', dir: '.devin/skills' },
  { platform: 'kilo', dir: '.kilocode/skills' },
  { platform: 'antigravity', dir: '.agent/skills' },
  { platform: 'zcode', dir: '.zcode/skills' },
  { platform: 'trae', dir: '.trae/skills' },
  { platform: 'grok', dir: '.grok/skills' },
  { platform: 'kimi', dir: '.kimi/skills' },
  { platform: 'snow', dir: '.snow/skills' },
  { platform: 'reasonix', dir: '.reasonix/skills' },
  { platform: 'omp', dir: '.omp/skills' }
]

function invocationFor(style: string, rel: string): string {
  // rel: 相对命令目录的路径，如 trellis/deploy-check.md 或 trellis-deploy-check.md
  const noExt = rel.replace(/\.(md|toml|prompt\.md)$/i, '')
  if (style === 'nested') {
    const parts = noExt.split('/')
    const scope = parts.length > 1 ? parts.slice(0, -1).pop() : null
    const name = parts[parts.length - 1]
    return scope ? `/${scope}:${name}` : `/${name}`
  }
  return `/${noExt}`
}

function scanCommandDirs(root: string, out: ExtEntry[], counts: Map<string, PlatformStatus['counts']>): void {
  const platformName = (id: string): string => PLATFORMS.find((p) => p.id === id)?.name ?? id
  for (const spec of COMMAND_DIRS) {
    const base = join(root, spec.dir)
    if (!isDir(base)) continue
    const walk = (dir: string, rel: string): void => {
      for (const e of listFiles(dir)) {
        const relPath = rel ? `${rel}/${e.name}` : e.name
        const raw = readText(e.path)
        if (raw === null) continue
        const { data } = parseFrontmatter(raw)
        const name =
          spec.style === 'hyphen'
            ? relPath.replace(/^trellis-/, '').replace(/\.(md|toml|prompt\.md)$/i, '')
            : basename(relPath).replace(/\.(md|toml|prompt\.md)$/i, '')
        out.push({
          kind: 'command',
          platform: spec.platform,
          platformName: platformName(spec.platform),
          path: e.path,
          name,
          invocation: invocationFor(spec.style, relPath),
          format: e.ext === '.toml' ? 'toml' : e.name.endsWith('.prompt.md') ? 'md' : 'md',
          frontmatter: data,
          size: e.size,
          mtime: e.mtime
        })
        const c = counts.get(spec.platform)
        if (c) c.commands += 1
      }
      // 子目录（claude/opencode 的 trellis/ 分组）
      for (const name of readdirSync(dir).sort()) {
        const child = join(dir, name)
        if (isDir(child) && !name.startsWith('.')) walk(child, rel ? `${rel}/${name}` : name)
      }
    }
    walk(base, '')
  }
}

function scanAgentDirs(root: string, out: ExtEntry[], counts: Map<string, PlatformStatus['counts']>): void {
  const platformName = (id: string): string => PLATFORMS.find((p) => p.id === id)?.name ?? id
  for (const spec of AGENT_DIRS) {
    const base = join(root, spec.dir)
    for (const e of listFiles(base, ['.md', '.toml', '.json'])) {
      const raw = readText(e.path)
      if (raw === null) continue
      let data: Record<string, string> = {}
      if (spec.format === 'md') {
        data = parseFrontmatter(raw).data
      } else if (spec.format === 'toml') {
        // 极简 TOML 键提取（name/description 单行字符串）
        for (const m of raw.matchAll(/^\s*(\w+)\s*=\s*"([^"]*)"\s*$/gm)) data[m[1]] = m[2]
      } else if (spec.format === 'json') {
        try {
          const obj = JSON.parse(raw)
          if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
              data[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)
            }
          }
        } catch {
          // keep empty
        }
      }
      out.push({
        kind: 'agent',
        platform: spec.platform,
        platformName: platformName(spec.platform),
        path: e.path,
        name: data.name || basename(e.name, extname(e.name)),
        invocation: `Task(subagent_type="${data.name || basename(e.name, extname(e.name))}")`,
        format: spec.format,
        frontmatter: data,
        size: e.size,
        mtime: e.mtime
      })
      const c = counts.get(spec.platform)
      if (c) c.agents += 1
    }
  }
}

function scanSkillDirs(root: string, out: ExtEntry[], counts: Map<string, PlatformStatus['counts']>): void {
  const platformName = (id: string): string => (id === 'shared' ? '共享层 .agents' : PLATFORMS.find((p) => p.id === id)?.name ?? id)
  for (const spec of SKILL_DIRS) {
    const base = join(root, spec.dir)
    if (!isDir(base)) continue
    for (const name of readdirSync(base).sort()) {
      const skillDir = join(base, name)
      if (!isDir(skillDir) || name.startsWith('.')) continue
      const skillFile = join(skillDir, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      const raw = readText(skillFile)
      if (raw === null) continue
      const { data } = parseFrontmatter(raw)
      let st: { size: number; mtimeMs: number }
      try {
        st = statSync(skillFile)
      } catch {
        continue
      }
      out.push({
        kind: 'skill',
        platform: spec.platform,
        platformName: platformName(spec.platform),
        path: skillFile,
        name: data.name || name,
        invocation: spec.platform === 'shared' ? '跨平台自动触发' : 'skill 自动触发',
        format: 'md',
        frontmatter: data,
        size: st.size,
        mtime: st.mtimeMs
      })
      const c = counts.get(spec.platform)
      if (c) c.skills += 1
    }
  }
}

/* ---------------- 钩子扫描 ---------------- */

const HOOK_FILES: Array<{ platform: string; file: string }> = [
  { platform: 'claude', file: '.claude/settings.json' },
  { platform: 'claude', file: '.claude/hooks.json' },
  { platform: 'cursor', file: '.cursor/hooks.json' },
  { platform: 'codebuddy', file: '.codebuddy/settings.json' },
  { platform: 'gemini', file: '.gemini/settings.json' },
  { platform: 'copilot', file: '.github/copilot/hooks.json' }
]

function scanHookRegistrations(root: string, counts: Map<string, PlatformStatus['counts']>): HookRegistration[] {
  const out: HookRegistration[] = []
  const platformName = (id: string): string => PLATFORMS.find((p) => p.id === id)?.name ?? id
  for (const spec of HOOK_FILES) {
    const p = join(root, spec.file)
    const raw = readText(p)
    if (!raw) continue
    let obj: { hooks?: Record<string, unknown> }
    try {
      obj = JSON.parse(raw)
    } catch {
      continue
    }
    const hooks = obj.hooks
    if (!hooks || typeof hooks !== 'object') continue
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups as Array<{ matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }>) {
        const matcher = typeof group?.matcher === 'string' ? group.matcher : '*'
        for (const h of group?.hooks ?? []) {
          if (!h?.command) continue
          out.push({
            platform: spec.platform,
            platformName: platformName(spec.platform),
            file: p,
            event,
            matcher,
            command: h.command,
            timeout: typeof h.timeout === 'number' ? h.timeout : null
          })
          const c = counts.get(spec.platform)
          if (c) c.hooks += 1
        }
      }
    }
  }
  // 脚本型钩子（opencode 插件 / pi 扩展 / 各平台 hooks 目录脚本）
  const scriptCounts: Array<{ platform: string; dir: string }> = [
    { platform: 'claude', dir: '.claude/hooks' },
    { platform: 'cursor', dir: '.cursor/hooks' },
    { platform: 'opencode', dir: '.opencode/hooks' },
    { platform: 'opencode', dir: '.opencode/plugins' },
    { platform: 'codex', dir: '.codex/hooks' },
    { platform: 'gemini', dir: '.gemini/hooks' },
    { platform: 'codebuddy', dir: '.codebuddy/hooks' },
    { platform: 'droid', dir: '.factory/hooks' }
  ]
  for (const s of scriptCounts) {
    const n = listFiles(join(root, s.dir)).length
    if (n > 0) {
      const c = counts.get(s.platform)
      if (c) c.hooks += n
    }
  }
  return out
}

function scanHookScripts(root: string): FileEntry[] {
  const dirs = ['.claude/hooks', '.cursor/hooks', '.opencode/hooks', '.opencode/plugins', '.codex/hooks', '.gemini/hooks', '.codebuddy/hooks', '.factory/hooks', '.pi/extensions']
  const out: FileEntry[] = []
  for (const d of dirs) {
    const base = join(root, d)
    for (const e of listFiles(base, ['.py', '.js', '.ts', '.mjs', '.sh', '.ps1', '.json'])) {
      out.push({ ...e, name: `${d}/${e.name}` })
    }
  }
  return out
}

/* ---------------- Workflow 解析 ---------------- */

export function parseWorkflowStructure(raw: string): WorkflowStructure {
  const lines = raw.split(/\r?\n/)
  const structure: WorkflowStructure = { hasPhaseIndex: false, phases: [], states: [], platforms: [], lineCount: lines.length }
  let curPhase: { title: string; steps: string[] } | null = null
  for (const line of lines) {
    if (/^## Phase Index\s*$/.test(line)) {
      structure.hasPhaseIndex = true
      continue
    }
    const phase = /^##\s+(Phase\s*\d+[^#]*)\s*$/.exec(line)
    if (phase) {
      curPhase = { title: phase[1].trim(), steps: [] }
      structure.phases.push(curPhase)
      continue
    }
    if (/^##\s+/.test(line)) curPhase = null
    if (curPhase) {
      const step = /^####\s+(\d+\.\d+\.?.*)$/.exec(line)
      if (step) curPhase.steps.push(step[1].trim())
    }
    // 仅整行独立的标签才算结构（说明文字/表格里的内联提及不算，与 trellis 解析器一致）
    const stateTag = /^\s*\[workflow-state:([\w-]+)\]\s*$/.exec(line)
    if (stateTag && !structure.states.includes(stateTag[1])) structure.states.push(stateTag[1])
    const tag = /^\[([A-Za-z0-9_,\s*\-]+)\]\s*$/.exec(line.trim())
    if (tag && !line.includes('[workflow-state')) {
      for (const p of tag[1].split(',')) {
        const name = p.trim().replace(/\*$/, '')
        if (name && !structure.platforms.includes(name)) structure.platforms.push(name)
      }
    }
  }
  return structure
}

export function validateWorkflow(raw: string): string[] {
  const warnings: string[] = []
  const st = parseWorkflowStructure(raw)
  if (!st.hasPhaseIndex) warnings.push('缺少 "## Phase Index" 节——SessionStart 将无法注入阶段概览')
  if (!/^## Phase 1/m.test(raw)) warnings.push('缺少 "## Phase 1: …" 标题——阶段边界解析要求该精确标题')
  const lines = raw.split(/\r?\n/).map((l) => l.trim())
  for (const s of st.states) {
    const open = lines.filter((l) => new RegExp(`^\\[workflow-state:${s}\\]$`).test(l)).length
    const close = lines.filter((l) => new RegExp(`^\\[/workflow-state:${s}\\]$`).test(l)).length
    if (open !== close) warnings.push(`workflow-state 标签不配对：${s}（开 ${open} / 闭 ${close}）`)
  }
  const opens = lines.filter((l) => /^\[[A-Za-z0-9_,\s*\-]+\]$/.test(l) && !l.includes('workflow-state'))
  const closes = lines.filter((l) => /^\[\/[A-Za-z0-9_,\s*\-]+\]$/.test(l) && !l.includes('workflow-state'))
  if (opens.length !== closes.length) warnings.push(`平台路由标签可能不配对（开 ${opens.length} / 闭 ${closes.length}）`)
  if (st.phases.length > 0) {
    const noSteps = st.phases.filter((p) => p.steps.length === 0)
    if (noSteps.length === st.phases.length) warnings.push('所有 Phase 都没有 "#### X.Y" 步骤——get_context.py --mode phase 将无步骤可取')
  }
  return warnings
}

function scanWorkflows(root: string): WorkflowInfo[] {
  const out: WorkflowInfo[] = []
  const trellis = join(root, '.trellis')

  // task.json 中的 workflow pin 计数
  const pins = new Map<string, Array<{ dirName: string; title: string }>>()
  const tasksRoot = join(trellis, 'tasks')
  if (isDir(tasksRoot)) {
    for (const name of readdirSync(tasksRoot).sort()) {
      const dir = join(tasksRoot, name)
      if (!isDir(dir) || name.startsWith('.')) continue
      const raw = readText(join(dir, 'task.json'))
      if (!raw) continue
      try {
        const obj = JSON.parse(raw)
        if (typeof obj?.workflow === 'string' && obj.workflow) {
          const list = pins.get(obj.workflow) ?? []
          list.push({ dirName: name, title: String(obj.title ?? name) })
          pins.set(obj.workflow, list)
        }
      } catch {
        // skip
      }
    }
  }

  const push = (p: string, scope: 'global' | 'saved'): void => {
    const raw = readText(p)
    if (raw === null) return
    let st: { size: number; mtimeMs: number }
    try {
      st = statSync(p)
    } catch {
      return
    }
    const id = scope === 'global' ? 'workflow' : basename(p, '.md')
    out.push({
      id,
      name: scope === 'global' ? '全局 workflow.md' : id,
      path: p,
      scope,
      size: st.size,
      mtime: st.mtimeMs,
      structure: parseWorkflowStructure(raw),
      warnings: validateWorkflow(raw),
      pinnedTasks: pins.get(id) ?? []
    })
  }

  const globalFile = join(trellis, 'workflow.md')
  if (existsSync(globalFile)) push(globalFile, 'global')
  const savedDir = join(trellis, 'workflows')
  if (isDir(savedDir)) {
    for (const e of listFiles(savedDir, ['.md'])) push(e.path, 'saved')
  }
  return out
}

/* ---------------- config.yaml / .developer ---------------- */

function readConfigDoc(root: string): Record<string, unknown> {
  const p = join(root, '.trellis', 'config.yaml')
  const raw = readText(p)
  if (!raw) return {}
  try {
    const obj = yaml.load(raw)
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function readConfig(root: string): StudioConfig {
  const doc = readConfigDoc(root)
  const hooksRaw = (doc.hooks ?? {}) as Record<string, unknown>
  const lifecycleEvents: LifecycleHook['event'][] = ['after_create', 'after_start', 'after_finish', 'after_archive']
  const packages: Record<string, PackageEntry> = {}
  if (doc.packages && typeof doc.packages === 'object') {
    for (const [k, v] of Object.entries(doc.packages as Record<string, unknown>)) {
      if (v && typeof v === 'object') {
        const e = v as Record<string, unknown>
        packages[k] = {
          path: typeof e.path === 'string' ? e.path : undefined,
          type: typeof e.type === 'string' ? e.type : undefined,
          git: typeof e.git === 'boolean' ? e.git : undefined
        }
      } else if (typeof v === 'string') {
        packages[k] = { path: v }
      }
    }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  return {
    session_commit_message: typeof doc.session_commit_message === 'string' ? doc.session_commit_message : null,
    session_auto_commit: typeof doc.session_auto_commit === 'boolean' ? doc.session_auto_commit : null,
    max_journal_lines: num(doc.max_journal_lines),
    default_workflow: typeof doc.default_workflow === 'string' ? doc.default_workflow : null,
    default_package: typeof doc.default_package === 'string' ? doc.default_package : null,
    packages,
    codex_dispatch_mode: typeof doc.codex === 'object' && doc.codex !== null && typeof (doc.codex as Record<string, unknown>).dispatch_mode === 'string'
      ? (doc.codex as Record<string, unknown>).dispatch_mode as string
      : null,
    lifecycleHooks: lifecycleEvents.map((event) => ({ event, command: typeof hooksRaw[event] === 'string' ? (hooksRaw[event] as string) : '' })),
    exists: existsSync(join(root, '.trellis', 'config.yaml'))
  }
}

/** 设置 config.yaml 中的点路径键（保留未知键），整体回写 YAML。 */
export function setConfigKeys(root: string, patch: Record<string, unknown>): void {
  const p = join(root, '.trellis', 'config.yaml')
  let doc: Record<string, unknown> = {}
  const raw = readText(p)
  if (raw) {
    try {
      const obj = yaml.load(raw)
      if (obj && typeof obj === 'object') doc = obj as Record<string, unknown>
    } catch (e) {
      throw new Error(`config.yaml 解析失败：${(e as Error).message}`)
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    const parts = key.split('.')
    let cur = doc
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i]
      if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}
      cur = cur[k] as Record<string, unknown>
    }
    if (value === null || value === '' || value === undefined) delete cur[parts[parts.length - 1]]
    else cur[parts[parts.length - 1]] = value
  }
  writeFileSync(p, yaml.dump(doc, { indent: 2, lineWidth: 120, noRefs: true }), 'utf-8')
}

function readDeveloper(root: string): { raw: string | null; name: string | null; workflow: string | null } {
  const raw = readText(join(root, '.trellis', '.developer'))
  if (raw === null) return { raw: null, name: null, workflow: null }
  const get = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(raw)
    return m ? m[1] : null
  }
  return { raw, name: get('name'), workflow: get('workflow') }
}

/* ---------------- 写路径白名单 ---------------- */

const WRITE_EXACT = new Set(['.trellis/workflow.md', '.trellis/config.yaml', '.trellis/.developer'])
const WRITE_PREFIXES = ['.trellis/workflows/', '.claude/', '.cursor/', '.opencode/', '.codex/', '.agents/', '.gemini/', '.kiro/', '.qoder/', '.codebuddy/', '.github/prompts/', '.github/agents/', '.github/skills/', '.github/copilot/', '.factory/', '.pi/', '.omp/', '.devin/', '.kilocode/', '.agent/', '.trae/', '.zcode/', '.grok/', '.kimi/', '.snow/', '.reasonix/', '.windsurf/']

/** Studio 允许读取的范围（比写更宽：整棵 .trellis + 平台目录） */
export function isStudioReadable(root: string, absPath: string): boolean {
  const rel = relative(resolve(root), resolve(absPath))
  if (!rel || rel.startsWith('..')) return false
  const norm = rel.split(sep).join('/')
  if (norm.startsWith('.trellis/')) return true
  return WRITE_PREFIXES.some((p) => norm.startsWith(p))
}

function assertStudioWritable(root: string, absPath: string): void {
  const rel = relative(resolve(root), resolve(absPath))
  if (rel.startsWith('..') || !rel) throw new Error('路径超出项目范围')
  const norm = rel.split(sep).join('/')
  if (WRITE_EXACT.has(norm)) return
  if (WRITE_PREFIXES.some((p) => norm.startsWith(p))) return
  throw new Error(`定制中心不允许写 ${norm} —— 仅开放 workflow / config / 平台目录`)
}

/* ---------------- 总扫描 ---------------- */

export function scanStudio(root: string): StudioScan {
  const counts = new Map<string, PlatformStatus['counts']>()
  for (const p of PLATFORMS) counts.set(p.id, { commands: 0, agents: 0, skills: 0, hooks: 0 })

  const extensions: ExtEntry[] = []
  scanCommandDirs(root, extensions, counts)
  scanAgentDirs(root, extensions, counts)
  scanSkillDirs(root, extensions, counts)

  const platforms: PlatformStatus[] = PLATFORMS.map((p) => ({
    ...p,
    detected: existsSync(join(root, p.marker)),
    counts: counts.get(p.id) ?? { commands: 0, agents: 0, skills: 0, hooks: 0 }
  }))

  const dev = readDeveloper(root)
  return {
    platforms,
    extensions,
    hookRegistrations: scanHookRegistrations(root, counts),
    hookScripts: scanHookScripts(root),
    workflows: scanWorkflows(root),
    chain: {
      developerName: dev.name,
      developerWorkflow: dev.workflow,
      configDefault: readConfig(root).default_workflow,
      globalExists: existsSync(join(root, '.trellis', 'workflow.md'))
    },
    config: readConfig(root),
    developerRaw: dev.raw,
    scannedAt: Date.now()
  }
}

/* ---------------- 读写 ---------------- */

const MAX_TEXT_BYTES = 5 * 1024 * 1024

export function studioReadText(root: string, absPath: string): { ok: boolean; error?: string; content?: string; mtime?: number } {
  if (!isStudioReadable(root, absPath)) return { ok: false, error: '路径不在定制中心范围内' }
  const p = resolve(absPath)
  let st
  try {
    st = statSync(p)
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  if (st.isDirectory()) return { ok: false, error: '目标是目录' }
  if (st.size > MAX_TEXT_BYTES) return { ok: false, error: '文件超过 5MB' }
  const content = readText(p)
  if (content === null) return { ok: false, error: '读取失败' }
  return { ok: true, content, mtime: st.mtimeMs }
}

export function studioWriteText(
  root: string,
  absPath: string,
  content: string,
  expectedMtime?: number
): { ok: boolean; error?: string; conflict?: boolean } {
  try {
    assertStudioWritable(root, absPath)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const p = resolve(absPath)
  if (expectedMtime !== undefined) {
    try {
      const st = statSync(p)
      if (Math.abs(st.mtimeMs - expectedMtime) > 50) {
        return { ok: false, conflict: true, error: '文件已被外部修改（可能是 trellis update 或 AI 工具），请刷新后重试' }
      }
    } catch {
      // 新文件——允许
    }
  }
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content, 'utf-8')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function studioDelete(root: string, absPath: string): { ok: boolean; error?: string } {
  try {
    assertStudioWritable(root, absPath)
    const p = resolve(absPath)
    const st = statSync(p)
    if (st.isDirectory()) rmSync(p, { recursive: true })
    else rmSync(p)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function setDeveloperFile(root: string, content: string): void {
  writeFileSync(join(root, '.trellis', '.developer'), content.endsWith('\n') ? content : content + '\n', 'utf-8')
}

/* ---------------- 跨平台同步 ---------------- */

export interface SyncResult {
  written: string[]
  skipped: Array<{ platform: string; reason: string }>
}

/**
 * 把一个命令/子代理/技能同步到缺失的平台（内容原样复制，路径按各平台布局适配）。
 * 命令：nested 风格（claude 系 trellis/{name}.md）↔ hyphen 风格（trellis-{name}.md）互转；
 *       gemini 目标转成 TOML prompt。子代理仅在格式相同（md/toml/json）时同步。
 */
export function syncExtensionToPlatforms(
  root: string,
  sourcePath: string,
  targets: string[]
): SyncResult {
  const counts = new Map<string, PlatformStatus['counts']>()
  for (const p of PLATFORMS) counts.set(p.id, { commands: 0, agents: 0, skills: 0, hooks: 0 })
  const entries: ExtEntry[] = []
  scanCommandDirs(root, entries, counts)
  scanAgentDirs(root, entries, counts)
  scanSkillDirs(root, entries, counts)
  const src = entries.find((e) => e.path === resolve(sourcePath))
  if (!src) return { written: [], skipped: [{ platform: '—', reason: '源文件不存在或不在扫描范围内' }] }
  const raw = readText(src.path) ?? ''

  const written: string[] = []
  const skipped: SyncResult['skipped'] = []

  for (const target of targets) {
    try {
      let dest: string | null = null
      let content = raw
      if (src.kind === 'command') {
        const spec = COMMAND_DIRS.find((c) => c.platform === target)
        if (!spec) {
          skipped.push({ platform: target, reason: '该平台无命令目录' })
          continue
        }
        const base = join(root, spec.dir)
        if (spec.style === 'hyphen') dest = join(base, `trellis-${src.name}.md`)
        else if (target === 'gemini') {
          dest = join(base, 'trellis', `${src.name}.toml`)
          content = `prompt = """\n${raw.replace(/"""/g, '""')}"""\n`
        } else dest = join(base, 'trellis', `${src.name}.md`)
      } else if (src.kind === 'agent') {
        const spec = AGENT_DIRS.find((c) => c.platform === target)
        if (!spec) {
          skipped.push({ platform: target, reason: '该平台无子代理目录' })
          continue
        }
        if (spec.format !== src.format) {
          skipped.push({ platform: target, reason: `格式不同（源 ${src.format} / 目标 ${spec.format}），请手动适配` })
          continue
        }
        const ext = spec.format === 'toml' ? '.toml' : spec.format === 'json' ? '.json' : '.md'
        dest = join(root, spec.dir, `${src.name}${ext}`)
      } else {
        const spec = SKILL_DIRS.find((c) => c.platform === target)
        if (!spec) {
          skipped.push({ platform: target, reason: '该平台无技能目录' })
          continue
        }
        dest = join(root, spec.dir, src.name, 'SKILL.md')
      }
      if (!dest) continue
      if (existsSync(dest)) {
        skipped.push({ platform: target, reason: `已存在（${basename(dest)}），跳过以免覆盖` })
        continue
      }
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, content, 'utf-8')
      written.push(dest)
    } catch (e) {
      skipped.push({ platform: target, reason: (e as Error).message })
    }
  }
  return { written, skipped }
}

/* ---------------- 模板与创建 ---------------- */

const WORKFLOW_TEMPLATE = (id: string): string => `# ${id}

由 Trellis Panel 创建的 workflow 变体。请保留解析器契约：
"## Phase Index"、"## Phase N: …"、"#### X.Y" 步骤、[workflow-state:*] 配对标签。

## Phase Index

Phase 1: Plan — 理解需求，产出 prd.md / design.md
Phase 2: Execute — 实现、自测
Phase 3: Finish — 评审、归档、更新 spec

[workflow-state:no_task]
当前没有活动任务。用 task.py create 创建任务，或让用户指定要继续的任务。
[/workflow-state:no_task]

[workflow-state:planning]
进入规划：阅读 .trellis/spec/ 相关规范，产出 PRD 与设计草稿，等待用户确认后再进入实现。
[/workflow-state:planning]

[workflow-state:in_progress]
按已确认的 PRD 实施。小步提交，随时更新 task.json 的 subtasks 进度。
[/workflow-state:in_progress]

[workflow-state:completed]
任务已完成：归档任务目录，检查 spec 是否需要沉淀更新。
[/workflow-state:completed]

## Phase 1: Plan

#### 1.1 Understand the requirement
阅读任务目录中的 prd.md / description，检索 .trellis/spec/ 中相关规范，列出实现要点与风险。

#### 1.2 Write the design
输出 design.md（涉及模块、接口、数据流），经用户确认后进入 Phase 2。

## Phase 2: Execute

#### 2.1 Implement
按 design.md 实施；每完成一个子任务勾选 task.json 的 subtasks。

#### 2.2 Self-check
运行测试与类型检查，修复到绿灯后再请求评审。

## Phase 3: Finish

#### 3.1 Review & archive
汇总变更，归档任务，判断是否需要更新 .trellis/spec/。
`

const COMMAND_TEMPLATE = (name: string): string => `# ${name}

一句话描述这个命令做什么。

## Steps

1. 读取所需上下文（如 \`.trellis/spec/...\`、task.json）
2. 按顺序执行
3. 按下面格式输出结果

## Output

- 结论：
- 明细：
- 风险与建议：
`

const AGENT_TEMPLATE = (name: string): string => `---
name: ${name}
description: |
  用触发条件描述该子代理何时被派生（主会话据此决策），例如：
  "Use when the current task needs …"
tools: Read, Write, Edit, Bash, Glob, Grep
---

# ${name}

你是 ${name} 子代理。职责：

1. …
2. …

## 流程

1. 读取上下文：…
2. 执行：…
3. 输出固定格式报告：…
`

const SKILL_TEMPLATE = (name: string): string => `---
name: ${name}
description: |
  Use when … （写触发条件而非技能身份——平台据此自动触发）
---

# ${name}

## 触发确认

先用自己的话复述触发条件，确认与用户意图匹配，否则先询问。

## 需要读取

- …

## 步骤

1. …

## 输出格式

固定结构，保证多次调用结果一致。
`

export function createWorkflow(root: string, id: string): { ok: boolean; error?: string; path?: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, error: 'workflow id 仅允许字母、数字、下划线、连字符' }
  const dir = join(root, '.trellis', 'workflows')
  const p = join(dir, `${id}.md`)
  if (existsSync(p)) return { ok: false, error: `workflow ${id} 已存在` }
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(p, WORKFLOW_TEMPLATE(id), 'utf-8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function createExtension(
  root: string,
  kind: ExtKind,
  platform: string,
  name: string
): { ok: boolean; error?: string; path?: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return { ok: false, error: '名称仅允许字母、数字、下划线、连字符' }
  const targets: Record<ExtKind, Record<string, string>> = {
    command: {
      claude: '.claude/commands/trellis',
      cursor: '.cursor/commands',
      opencode: '.opencode/commands/trellis',
      codebuddy: '.codebuddy/commands/trellis',
      droid: '.factory/commands/trellis',
      qoder: '.qoder/commands',
      pi: '.pi/prompts',
      gemini: '.gemini/commands/trellis'
    },
    agent: {
      claude: '.claude/agents',
      cursor: '.cursor/agents',
      opencode: '.opencode/agents',
      gemini: '.gemini/agents',
      qoder: '.qoder/agents',
      codebuddy: '.codebuddy/agents',
      droid: '.factory/droids',
      pi: '.pi/agents'
    },
    skill: {
      shared: '.agents/skills',
      claude: '.claude/skills',
      cursor: '.cursor/skills',
      opencode: '.opencode/skills',
      zcode: '.zcode/skills',
      kiro: '.kiro/skills',
      qoder: '.qoder/skills'
    }
  }
  const relBase = targets[kind][platform]
  if (!relBase) return { ok: false, error: `平台 ${platform} 暂不支持在此创建 ${kind}` }
  const p =
    kind === 'skill'
      ? join(root, relBase, name, 'SKILL.md')
      : join(root, relBase, `${name}${kind === 'command' && platform === 'gemini' ? '.toml' : '.md'}`)
  if (existsSync(p)) return { ok: false, error: `文件已存在：${basename(p)}` }
  const template = kind === 'command' ? COMMAND_TEMPLATE(name) : kind === 'agent' ? AGENT_TEMPLATE(name) : SKILL_TEMPLATE(name)
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, template, 'utf-8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
