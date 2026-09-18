import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Workflow,
  SlashSquare,
  Bot,
  Puzzle,
  Webhook,
  Settings2,
  MonitorSmartphone,
  RefreshCw,
  Save,
  Plus,
  Trash2,
  X,
  AlertTriangle,
  FileCode2,
  ChevronRight,
  Layers,
  FolderOpen,
  CheckCircle2
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { fmtBytes, relTime } from '../utils/format'
import type { ExtEntry, ExtKind, StudioScan, WorkflowInfo } from '../../../shared/types'
import type { JSX } from 'react'

type Section = 'workflow' | 'command' | 'agent' | 'skill' | 'hooks' | 'config' | 'platform'

const SECTIONS: Array<{ id: Section; label: string; icon: JSX.Element; hint: string }> = [
  { id: 'workflow', label: '工作流', icon: <Workflow size={15} />, hint: 'workflow.md 与 .trellis/workflows 变体' },
  { id: 'command', label: 'Slash 命令', icon: <SlashSquare size={15} />, hint: '各平台 commands / prompts 目录' },
  { id: 'agent', label: '子代理', icon: <Bot size={15} />, hint: '各平台 agents 目录' },
  { id: 'skill', label: '技能', icon: <Puzzle size={15} />, hint: 'SKILL.md 技能包（含共享层 .agents）' },
  { id: 'hooks', label: '钩子', icon: <Webhook size={15} />, hint: '平台 hooks 注册 + config.yaml 生命周期钩子' },
  { id: 'config', label: 'config.yaml', icon: <Settings2 size={15} />, hint: '团队共享配置（结构化编辑）' },
  { id: 'platform', label: '平台与团队', icon: <MonitorSmartphone size={15} />, hint: '22 平台检测与团队个人配置' }
]

/* ---------------- frontmatter 客户端解析（与主进程保持一致的最小子集） ---------------- */

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string; hasFm: boolean } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) return { data: {}, body: raw, hasFm: false }
  const data: Record<string, string> = {}
  const lines = m[1].split(/\r?\n/)
  let curKey: string | null = null
  let curBlock: string[] = []
  for (const line of lines) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line)
    if (kv) {
      if (curKey) data[curKey] = curBlock.join('\n').trim()
      curKey = kv[1]
      curBlock = kv[2] === '|' || kv[2] === '>' ? [] : [kv[2]]
    } else if (curKey && /^\s+/.test(line)) {
      curBlock.push(line.trim())
    }
  }
  if (curKey) data[curKey] = curBlock.join('\n').trim()
  return { data, body: raw.slice(m[0].length), hasFm: true }
}

function buildFrontmatter(fields: Record<string, string>, keys: string[]): string {
  const lines: string[] = ['---']
  for (const k of keys) {
    const v = (fields[k] ?? '').trim()
    if (!v) continue
    if (v.includes('\n')) {
      lines.push(`${k}: |`)
      for (const l of v.split('\n')) lines.push(`  ${l}`)
    } else {
      lines.push(`${k}: ${v}`)
    }
  }
  lines.push('---', '')
  return lines.join('\n')
}

/* ---------------- 文件编辑抽屉 ---------------- */

function FileEditor({
  path,
  title,
  onClose,
  onSaved,
  validate
}: {
  path: string
  title: string
  onClose: () => void
  onSaved: () => void
  validate?: (raw: string) => string[]
}): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [raw, setRaw] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [mtime, setMtime] = useState<number | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = raw !== null && content !== raw

  useEffect(() => {
    void api.studioRead(path).then((res) => {
      if (res.ok && res.content !== undefined) {
        setRaw(res.content)
        setContent(res.content)
        setMtime(res.mtime)
      } else {
        setError(res.error ?? '读取失败')
      }
    })
  }, [path])

  const warnings = useMemo(() => (validate && content ? validate(content) : []), [content, validate])

  const save = async (): Promise<void> => {
    setSaving(true)
    const res = await api.studioWrite(path, content, mtime)
    setSaving(false)
    if (res.ok) {
      setRaw(content)
      setMtime(Date.now())
      pushToast({ kind: 'success', title: '已保存', body: title })
      onSaved()
    } else {
      setError(res.error ?? '保存失败')
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-ink-900/95 backdrop-blur-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 px-4 py-2.5">
        <FileCode2 size={14} className="text-leaf" />
        <span className="text-xs font-semibold text-mist-100">{title}</span>
        <span className="truncate font-mono text-[10.5px] text-mist-500">{path}</span>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="chip bg-amber-500/15 text-amber-300">未保存</span>}
          <button onClick={save} disabled={!dirty || saving} className="btn-primary disabled:opacity-40">
            <Save size={12} /> 保存
          </button>
          <button onClick={onClose} className="btn-ghost justify-center px-2" title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="border-b border-amber-500/25 bg-amber-500/5 px-4 py-2 text-[11.5px] leading-5 text-amber-300/90">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
            </div>
          ))}
        </div>
      )}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-ink-950 p-4 font-mono text-[12px] leading-5 text-mist-200 outline-none"
      />
    </div>
  )
}

/* ---------------- 工作流编辑器（结构大纲 + 正文） ---------------- */

function WorkflowEditor({ wf, onClose, onSaved }: { wf: WorkflowInfo; onClose: () => void; onSaved: () => void }): JSX.Element {
  return (
    <div className="absolute inset-0 z-30 flex bg-ink-900/95 backdrop-blur-sm">
      <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-ink-700 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Layers size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">结构大纲</span>
        </div>
        <div className="mb-3 flex flex-wrap gap-1">
          {wf.structure.states.map((s) => (
            <span key={s} className="chip bg-sky-500/15 font-mono text-[10px] text-sky-300">
              {s}
            </span>
          ))}
          {wf.structure.platforms.map((p) => (
            <span key={p} className="chip bg-violet-500/15 text-[10px] text-violet-300">
              {p}
            </span>
          ))}
        </div>
        {!wf.structure.hasPhaseIndex && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] leading-4 text-amber-300">
            缺少 Phase Index——SessionStart 将无法注入阶段概览
          </div>
        )}
        {wf.structure.phases.length === 0 && <div className="text-[11px] text-mist-500">未解析到 Phase</div>}
        {wf.structure.phases.map((p) => (
          <div key={p.title} className="mb-2.5">
            <div className="text-[11.5px] font-medium text-mist-200">{p.title}</div>
            <div className="ml-2 mt-0.5 space-y-0.5 border-l border-ink-600 pl-2">
              {p.steps.length === 0 && <div className="text-[10.5px] text-mist-600">（无 #### X.Y 步骤）</div>}
              {p.steps.map((s) => (
                <div key={s} className="font-mono text-[10.5px] text-mist-400">
                  {s}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <FileEditor path={wf.path} title={`workflow：${wf.name}`} onClose={onClose} onSaved={onSaved} validate={validateWorkflow} />
      </div>
    </div>
  )
}

function validateWorkflow(raw: string): string[] {
  const warnings: string[] = []
  if (!/^## Phase Index\s*$/m.test(raw)) warnings.push('缺少 "## Phase Index" 节——SessionStart 将无法注入阶段概览')
  if (!/^## Phase 1/m.test(raw)) warnings.push('缺少 "## Phase 1: …" 标题——阶段边界解析要求该精确标题')
  // 仅整行独立的标签才算结构（说明文字/表格里的内联提及不算，与 trellis 解析器一致）
  const lines = raw.split(/\r?\n/).map((l) => l.trim())
  const states = [...new Set(lines.map((l) => /^\[workflow-state:([\w-]+)\]$/.exec(l)?.[1]).filter(Boolean) as string[])]
  for (const s of states) {
    const open = lines.filter((l) => l === `[workflow-state:${s}]`).length
    const close = lines.filter((l) => l === `[/workflow-state:${s}]`).length
    if (open !== close) warnings.push(`workflow-state 标签不配对：${s}（开 ${open} / 闭 ${close}）`)
  }
  const opens = lines.filter((l) => /^\[[A-Za-z0-9_,\s*\-]+\]$/.test(l) && !l.includes('workflow-state'))
  const closes = lines.filter((l) => /^\[\/[A-Za-z0-9_,\s*\-]+\]$/.test(l) && !l.includes('workflow-state'))
  if (opens.length !== closes.length) warnings.push(`平台路由标签可能不配对（开 ${opens.length} / 闭 ${closes.length}）`)
  return warnings
}

/* ---------------- 扩展（命令/子代理/技能）编辑器 ---------------- */

const FM_KEYS: Record<ExtKind, string[]> = {
  command: [],
  agent: ['name', 'description', 'tools', 'model'],
  skill: ['name', 'description']
}

function ExtensionEditor({ ext, onClose, onSaved }: { ext: ExtEntry; onClose: () => void; onSaved: () => void }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [raw, setRaw] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [body, setBody] = useState('')
  const [mtime, setMtime] = useState<number | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [editingRaw, setEditingRaw] = useState(false)

  useEffect(() => {
    void api.studioRead(ext.path).then((res) => {
      if (res.ok && res.content !== undefined) {
        setRaw(res.content)
        setMtime(res.mtime)
        if (ext.format === 'md') {
          const { data, body: b } = parseFrontmatter(res.content)
          setFields(data)
          setBody(b)
        } else {
          setBody(res.content)
        }
      } else {
        setError(res.error ?? '读取失败')
      }
    })
  }, [ext.path, ext.format])

  const dirty = useMemo(() => {
    if (raw === null) return false
    if (editingRaw || ext.format !== 'md') return body !== raw
    const fmKeys = FM_KEYS[ext.kind]
    return buildFrontmatter(fields, fmKeys) + body !== raw
  }, [raw, body, fields, editingRaw, ext.format, ext.kind])

  const save = async (): Promise<void> => {
    const content = editingRaw || ext.format !== 'md' ? body : buildFrontmatter(fields, FM_KEYS[ext.kind]) + body
    const res = await api.studioWrite(ext.path, content, mtime)
    if (res.ok) {
      setRaw(content)
      setMtime(Date.now())
      pushToast({ kind: 'success', title: '已保存', body: ext.name })
      onSaved()
    } else {
      setError(res.error ?? '保存失败')
    }
  }

  const remove = async (): Promise<void> => {
    const res = await api.studioDeleteFile(ext.path)
    if (res.ok) {
      pushToast({ kind: 'success', title: '已删除', body: ext.name })
      onSaved()
      onClose()
    } else {
      setError(res.error ?? '删除失败')
    }
  }

  const fmKeys = FM_KEYS[ext.kind]

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-ink-900/95 backdrop-blur-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 px-4 py-2.5">
        <span className="chip bg-leaf-dim/20 text-[10.5px] text-leaf-soft">{ext.platformName}</span>
        <span className="text-xs font-semibold text-mist-100">{ext.name}</span>
        {ext.invocation && <span className="font-mono text-[10.5px] text-mist-500">{ext.invocation}</span>}
        <div className="ml-auto flex items-center gap-2">
          {ext.format === 'md' && (
            <button onClick={() => setEditingRaw((v) => !v)} className="btn-ghost text-[11px]">
              {editingRaw ? '表单模式' : '原文模式'}
            </button>
          )}
          <button onClick={remove} className="btn-ghost justify-center px-2 text-rose-300" title="删除文件">
            <Trash2 size={13} />
          </button>
          <button onClick={save} disabled={!dirty} className="btn-primary disabled:opacity-40">
            <Save size={12} /> 保存
          </button>
          <button onClick={onClose} className="btn-ghost justify-center px-2" title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-300">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {editingRaw || ext.format !== 'md' ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            className="h-full min-h-[320px] w-full resize-none rounded-lg border border-ink-600 bg-ink-950 p-3 font-mono text-[12px] leading-5 text-mist-200 outline-none"
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {fmKeys.map((k) => (
              <label key={k} className="block">
                <span className="mb-1 block font-mono text-[11px] text-mist-400">{k}</span>
                {k === 'description' ? (
                  <textarea
                    value={fields[k] ?? ''}
                    onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
                    rows={3}
                    className="field w-full resize-y font-mono text-[12px]"
                    placeholder={ext.kind === 'skill' ? '写触发条件而非技能身份——平台据此自动触发' : '主会话据此决定何时派生该子代理'}
                  />
                ) : (
                  <input
                    value={fields[k] ?? ''}
                    onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
                    className="field w-full font-mono text-[12px]"
                    placeholder={k === 'tools' ? 'Read, Write, Edit, Bash, Glob, Grep' : k === 'model' ? '（留空继承会话模型）' : ''}
                  />
                )}
              </label>
            ))}
            <label className="block flex-1">
              <span className="mb-1 block font-mono text-[11px] text-mist-400">正文（系统提示词 / 指令）</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                spellCheck={false}
                rows={18}
                className="w-full resize-y rounded-lg border border-ink-600 bg-ink-950 p-3 font-mono text-[12px] leading-5 text-mist-200 outline-none"
              />
            </label>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 页面 ---------------- */

export function StudioPage(): JSX.Element {
  const snapshot = useApp((s) => s.snapshot)!
  const pushToast = useApp((s) => s.pushToast)
  const [scan, setScan] = useState<StudioScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('workflow')
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [editingWf, setEditingWf] = useState<WorkflowInfo | null>(null)
  const [editingExt, setEditingExt] = useState<ExtEntry | null>(null)
  const [query, setQuery] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    const res = await api.studioScan()
    if (res.ok && res.scan) setScan(res.scan)
    else setError(res.error ?? '扫描失败')
  }, [])

  useEffect(() => {
    void reload()
  }, [reload, snapshot?.meta.root])

  const extSection = section === 'command' || section === 'agent' || section === 'skill'

  const extensions = useMemo(() => {
    if (!scan || !extSection) return []
    const kind = section as ExtKind
    let list = scan.extensions.filter((e) => e.kind === kind)
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      list = list.filter((e) => `${e.name} ${e.platformName} ${e.path}`.toLowerCase().includes(q))
    }
    return list.sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name))
  }, [scan, section, query, extSection])

  if (error && !scan) {
    return (
      <div className="grid h-full place-items-center">
        <div className="text-center text-xs text-mist-500">
          {error}
          <button onClick={() => void reload()} className="btn-ghost mt-3 justify-center">
            <RefreshCw size={12} /> 重试
          </button>
        </div>
      </div>
    )
  }
  if (!scan) {
    return <div className="grid h-full place-items-center text-xs text-mist-500">正在扫描定制资源…</div>
  }

  const createExt = async (kind: ExtKind): Promise<void> => {
    const platform = prompt(`要在哪个平台创建？可选：\n${scan.platforms.map((p) => p.id).join(', ')}`, kind === 'skill' ? 'shared' : 'claude')
    if (!platform) return
    const name = prompt('名称（字母/数字/下划线/连字符）：')
    if (!name) return
    const res = await api.studioCreateExtension(kind, platform.trim(), name.trim())
    if (res.ok) {
      pushToast({ kind: 'success', title: '已创建', body: res.path ?? '' })
      await reload()
    } else {
      pushToast({ kind: 'error', title: '创建失败', body: res.error })
    }
  }

  return (
    <div className="flex h-full min-w-0 animate-fade-in">
      {/* 左侧子导航 */}
      <div className="flex w-48 shrink-0 flex-col border-r border-ink-700 bg-ink-850/40">
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="text-[13px] font-semibold text-mist-100">定制中心</span>
          <button onClick={() => void reload()} className="btn-ghost ml-auto justify-center px-1.5" title="重新扫描">
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="space-y-0.5 p-2 pt-0">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setSection(s.id)
                setQuery('')
              }}
              title={s.hint}
              className={clsx(
                'flex w-full items-center gap-2 rounded-lg px-2.5 py-[7px] text-left text-[12px] transition-colors',
                section === s.id ? 'bg-leaf-dim/15 font-medium text-leaf-soft' : 'text-mist-300 hover:bg-ink-700/50 hover:text-mist-100'
              )}
            >
              <span className={section === s.id ? 'text-leaf' : 'text-mist-400'}>{s.icon}</span>
              {s.label}
              <ChevronRight size={12} className="ml-auto text-mist-600" />
            </button>
          ))}
        </div>
        <div className="mt-auto border-t border-ink-700 p-3 text-[10.5px] leading-4 text-mist-600">
          布局遵循 Trellis 官方文档：workflow 变体放 <code>.trellis/workflows/</code>，技能共享层 <code>.agents/skills/</code>。
        </div>
      </div>

      {/* 右侧内容 */}
      <div className="relative min-w-0 flex-1 overflow-y-auto">
        {section === 'workflow' && <WorkflowSection scan={scan} onEdit={setEditingWf} onChanged={reload} />}
        {extSection && (
          <ExtSection
            kind={section as ExtKind}
            extensions={extensions}
            query={query}
            setQuery={setQuery}
            onEdit={setEditingExt}
            onCreate={createExt}
          />
        )}
        {section === 'hooks' && <HooksSection scan={scan} onOpenFile={setEditingPath} onChanged={reload} />}
        {section === 'config' && <ConfigSection scan={scan} onChanged={reload} />}
        {section === 'platform' && <PlatformSection scan={scan} />}

        {editingPath && <FileEditor path={editingPath} title={editingPath.split(/[\\/]/).slice(-2).join('/')} onClose={() => setEditingPath(null)} onSaved={reload} />}
        {editingWf && <WorkflowEditor wf={editingWf} onClose={() => setEditingWf(null)} onSaved={reload} />}
        {editingExt && <ExtensionEditor ext={editingExt} onClose={() => setEditingExt(null)} onSaved={reload} />}
      </div>
    </div>
  )
}

/* ---------------- 工作流 Tab ---------------- */

function WorkflowSection({
  scan,
  onEdit,
  onChanged
}: {
  scan: StudioScan
  onEdit: (wf: WorkflowInfo) => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [creating, setCreating] = useState(false)
  const [newId, setNewId] = useState('')

  const setConfigDefault = async (id: string): Promise<void> => {
    const res = await api.studioSetConfig({ default_workflow: id || null })
    if (res.ok) {
      pushToast({ kind: 'success', title: id ? `团队默认 workflow → ${id}` : '已清除团队默认' })
      await onChanged()
    } else pushToast({ kind: 'error', title: '写入失败', body: res.error })
  }

  const setDeveloperWorkflow = async (id: string): Promise<void> => {
    let raw = scan.developerRaw ?? `name=${scan.chain.developerName ?? ''}\n`
    if (raw && !raw.endsWith('\n')) raw += '\n'
    if (id) {
      raw = /\nworkflow=.*$/m.test(raw) || raw.startsWith('workflow=')
        ? raw.replace(/(^|\n)workflow=.*$/m, `$1workflow=${id}`)
        : `${raw}workflow=${id}\n`
    } else {
      raw = raw.replace(/(^|\n)workflow=.*$/m, '\n').replace(/\n{2,}/g, '\n')
    }
    const res = await api.studioSetDeveloper(raw)
    if (res.ok) {
      pushToast({ kind: 'success', title: id ? `个人默认 workflow → ${id}` : '已清除个人默认' })
      await onChanged()
    } else pushToast({ kind: 'error', title: '写入失败', body: res.error })
  }

  const removeWf = async (wf: WorkflowInfo): Promise<void> => {
    if (!confirm(`删除 workflow「${wf.name}」？该文件不可恢复。`)) return
    const res = await api.studioDeleteFile(wf.path)
    if (res.ok) {
      pushToast({ kind: 'success', title: '已删除', body: wf.name })
      await onChanged()
    } else pushToast({ kind: 'error', title: '删除失败', body: res.error })
  }

  const create = async (): Promise<void> => {
    const res = await api.studioCreateWorkflow(newId.trim())
    if (res.ok) {
      setCreating(false)
      setNewId('')
      pushToast({ kind: 'success', title: 'workflow 已创建', body: '已生成可编辑副本' })
      await onChanged()
    } else pushToast({ kind: 'error', title: '创建失败', body: res.error })
  }

  const chain = scan.chain
  const totalPins = scan.workflows.reduce((n, w) => n + w.pinnedTasks.length, 0)

  return (
    <div className="space-y-4 p-5">
      {/* 优先级链 */}
      <div className="card p-4">
        <div className="mb-1 flex items-center gap-2">
          <Workflow size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">Workflow 解析优先级</span>
          <span className="text-[10.5px] text-mist-500">从高到低；未设置或无效时向下回退</span>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-4">
          <div className="rounded-lg border border-ink-600 bg-ink-800/60 p-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-leaf-soft/80">1 · 任务 Pin</div>
            <div className="mt-1 text-lg font-bold text-mist-100">{totalPins}</div>
            <div className="text-[10.5px] leading-4 text-mist-500">task.json 的 workflow 字段（随仓库提交）</div>
          </div>
          <div className="rounded-lg border border-ink-600 bg-ink-800/60 p-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-leaf-soft/80">2 · 个人默认</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-sm text-mist-100">{chain.developerWorkflow ?? '—'}</span>
              <select
                value=""
                onChange={(e) => void setDeveloperWorkflow(e.target.value)}
                className="field ml-auto w-28 px-1.5 py-0.5 text-[11px]"
              >
                <option value="">修改…</option>
                <option value="">清除</option>
                {scan.workflows.filter((w) => w.scope === 'saved').map((w) => (
                  <option key={w.id} value={w.id}>{w.id}</option>
                ))}
              </select>
            </div>
            <div className="mt-1 text-[10.5px] leading-4 text-mist-500">.trellis/.developer（gitignored）</div>
          </div>
          <div className="rounded-lg border border-ink-600 bg-ink-800/60 p-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-leaf-soft/80">3 · 团队默认</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-sm text-mist-100">{chain.configDefault ?? '—'}</span>
              <select
                value=""
                onChange={(e) => void setConfigDefault(e.target.value)}
                className="field ml-auto w-28 px-1.5 py-0.5 text-[11px]"
              >
                <option value="">修改…</option>
                <option value="">清除</option>
                {scan.workflows.filter((w) => w.scope === 'saved').map((w) => (
                  <option key={w.id} value={w.id}>{w.id}</option>
                ))}
              </select>
            </div>
            <div className="mt-1 text-[10.5px] leading-4 text-mist-500">config.yaml 的 default_workflow</div>
          </div>
          <div className="rounded-lg border border-ink-600 bg-ink-800/60 p-3">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-leaf-soft/80">4 · 全局回退</div>
            <div className="mt-1 flex items-center gap-2">
              <span className={clsx('text-sm', chain.globalExists ? 'text-emerald-300' : 'text-rose-300')}>
                {chain.globalExists ? 'workflow.md ✓' : '缺失'}
              </span>
            </div>
            <div className="mt-1 text-[10.5px] leading-4 text-mist-500">.trellis/workflow.md（零配置兜底）</div>
          </div>
        </div>
      </div>

      {/* 新建 */}
      <div className="flex items-center gap-2">
        {creating ? (
          <>
            <input autoFocus value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="workflow id（如 review-first）" className="field w-64" />
            <button onClick={create} className="btn-primary">
              <Plus size={12} /> 创建
            </button>
            <button onClick={() => setCreating(false)} className="btn-ghost">取消</button>
          </>
        ) : (
          <button onClick={() => setCreating(true)} className="btn-primary">
            <Plus size={12} /> 新建 workflow 变体
          </button>
        )}
      </div>

      {/* workflow 列表 */}
      <div className="grid gap-3 lg:grid-cols-2">
        {scan.workflows.map((wf) => (
          <div key={wf.path} className={clsx('card p-4', wf.scope === 'global' && 'border-leaf-dim/30')}>
            <div className="flex items-center gap-2">
              <span className={clsx('chip text-[10px]', wf.scope === 'global' ? 'bg-leaf-dim/20 text-leaf-soft' : 'bg-ink-750 text-mist-300')}>
                {wf.scope === 'global' ? '全局回退' : '变体'}
              </span>
              <span className="font-mono text-xs font-semibold text-mist-100">{wf.name}</span>
              {wf.pinnedTasks.length > 0 && (
                <span className="chip bg-sky-500/15 text-[10px] text-sky-300" title={wf.pinnedTasks.map((t) => t.title).join('\n')}>
                  {wf.pinnedTasks.length} 个任务 pin
                </span>
              )}
              <span className="ml-auto text-[10px] text-mist-600">{fmtBytes(wf.size)} · {relTime(wf.mtime)}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1">
              <span className="chip bg-ink-750 text-[10.5px] text-mist-300">{wf.structure.phases.length} 个 Phase</span>
              <span className="chip bg-ink-750 text-[10.5px] text-mist-300">{wf.structure.phases.reduce((n, p) => n + p.steps.length, 0)} 个步骤</span>
              {wf.structure.states.map((s) => (
                <span key={s} className="chip bg-sky-500/10 font-mono text-[10px] text-sky-300/90">{s}</span>
              ))}
            </div>
            {wf.warnings.length > 0 && (
              <div className="mt-2.5 space-y-1 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2 text-[11px] leading-4 text-amber-300/90">
                {wf.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <button onClick={() => onEdit(wf)} className="btn-outline text-[11px]">
                编辑
              </button>
              <button
                onClick={() => void navigator.clipboard.writeText(`trellis workflow --save ${wf.id}`)}
                className="btn-ghost text-[11px]"
                title="复制同步命令"
              >
                CLI 命令
              </button>
              {wf.scope === 'saved' && (
                <button onClick={() => void removeWf(wf)} className="btn-ghost ml-auto justify-center px-2 text-rose-300" title="删除">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>
        ))}
        {scan.workflows.length === 0 && (
          <div className="card p-6 text-center text-xs text-mist-500">
            未发现任何 workflow 文件——项目可能未运行 trellis init，或使用内置原生 workflow。
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- 扩展 Tab（命令/子代理/技能共用） ---------------- */

function ExtSection({
  kind,
  extensions,
  query,
  setQuery,
  onEdit,
  onCreate
}: {
  kind: ExtKind
  extensions: ExtEntry[]
  query: string
  setQuery: (q: string) => void
  onEdit: (e: ExtEntry) => void
  onCreate: (kind: ExtKind) => void
}): JSX.Element {
  const meta = SECTIONS.find((s) => s.id === kind)!
  const byPlatform = useMemo(() => {
    const m = new Map<string, ExtEntry[]>()
    for (const e of extensions) {
      const list = m.get(e.platformName) ?? []
      list.push(e)
      m.set(e.platformName, list)
    }
    return [...m.entries()]
  }, [extensions])

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-center gap-2">
        <div className="relative">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索名称 / 平台 / 路径…" className="field w-64" />
        </div>
        <span className="text-[11px] text-mist-500">{extensions.length} 个 · {meta.hint}</span>
        <button onClick={() => onCreate(kind)} className="btn-primary ml-auto">
          <Plus size={12} /> 新建
        </button>
      </div>

      {byPlatform.map(([platform, list]) => (
        <div key={platform}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11.5px] font-semibold text-mist-200">{platform}</span>
            <span className="chip bg-ink-750 text-[10px] text-mist-400">{list.length}</span>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {list.map((e) => (
              <button key={e.path} onClick={() => onEdit(e)} className="card p-3 text-left transition-colors hover:border-ink-500">
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs font-medium text-mist-100">{e.name}</span>
                  {e.frontmatter.model && <span className="chip bg-violet-500/15 text-[9.5px] text-violet-300">{e.frontmatter.model}</span>}
                  <span className="ml-auto shrink-0 text-[10px] text-mist-600">{relTime(e.mtime)}</span>
                </div>
                {e.frontmatter.description && (
                  <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-mist-400">{e.frontmatter.description}</div>
                )}
                <div className="mt-2 flex items-center gap-1.5">
                  {e.invocation && <span className="chip bg-leaf-dim/10 font-mono text-[9.5px] text-leaf-soft/80">{e.invocation}</span>}
                  {e.frontmatter.tools && <span className="chip bg-ink-750 text-[9.5px] text-mist-400">{e.frontmatter.tools.split(',').length} 工具</span>}
                  <span className="ml-auto font-mono text-[9.5px] text-mist-600">{fmtBytes(e.size)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
      {extensions.length === 0 && (
        <div className="card p-6 text-center text-xs text-mist-500">
          未发现{meta.label}文件。用「新建」创建，或在项目里运行 <code>trellis init --&lt;platform&gt;</code> 安装平台扩展。
        </div>
      )}
    </div>
  )
}

/* ---------------- 钩子 Tab ---------------- */

function HooksSection({
  scan,
  onOpenFile,
  onChanged
}: {
  scan: StudioScan
  onOpenFile: (path: string) => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [hooks, setHooks] = useState<Record<string, string>>(
    Object.fromEntries(scan.config.lifecycleHooks.map((h) => [h.event, h.command]))
  )
  const [saved, setSaved] = useState(false)

  const saveLifecycle = async (): Promise<void> => {
    const patch: Record<string, unknown> = {}
    for (const [event, cmd] of Object.entries(hooks)) {
      patch[`hooks.${event}`] = cmd.trim() || null
    }
    const res = await api.studioSetConfig(patch)
    if (res.ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      pushToast({ kind: 'success', title: '生命周期钩子已保存', body: '写入 .trellis/config.yaml' })
      await onChanged()
    } else pushToast({ kind: 'error', title: '保存失败', body: res.error })
  }

  const EVENT_LABEL: Record<string, string> = {
    after_create: '任务创建后',
    after_start: '任务开始后',
    after_finish: '任务完成后',
    after_archive: '任务归档后'
  }

  return (
    <div className="space-y-4 p-5">
      {/* 生命周期钩子 */}
      <div className="card p-4">
        <div className="mb-1 flex items-center gap-2">
          <Webhook size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">任务生命周期钩子</span>
          <span className="text-[10.5px] text-mist-500">config.yaml hooks.* · 每条命令收到 TASK_JSON_PATH 环境变量</span>
        </div>
        <div className="mt-3 space-y-2">
          {(['after_create', 'after_start', 'after_finish', 'after_archive'] as const).map((ev) => (
            <div key={ev} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-[11.5px] text-mist-300">{EVENT_LABEL[ev]}</span>
              <input
                value={hooks[ev] ?? ''}
                onChange={(e) => setHooks((h) => ({ ...h, [ev]: e.target.value }))}
                placeholder="如：python scripts/notify.py（留空禁用）"
                className="field flex-1 font-mono text-[11.5px]"
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={saveLifecycle} className="btn-primary">
            <Save size={12} /> 保存
          </button>
          {saved && (
            <span className="flex items-center gap-1 text-[11px] text-emerald-300">
              <CheckCircle2 size={12} /> 已写入
            </span>
          )}
          <span className="ml-auto text-[10.5px] text-mist-600">钩子失败仅警告，不阻塞任务操作</span>
        </div>
      </div>

      {/* 平台 hook 注册 */}
      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Webhook size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">平台 Hook 注册</span>
          <span className="text-[10.5px] text-mist-500">settings.json / hooks.json 中的事件注册</span>
        </div>
        {scan.hookRegistrations.length === 0 ? (
          <div className="text-xs text-mist-500">
            未发现 hook 注册。可点「一键写入 Trellis hooks」（设置 → 桥接），或手动编辑平台 settings.json。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[11.5px]">
              <thead>
                <tr className="border-b border-ink-700 text-[10.5px] uppercase tracking-wide text-mist-500">
                  <th className="py-1.5 pr-3">平台</th>
                  <th className="py-1.5 pr-3">事件</th>
                  <th className="py-1.5 pr-3">Matcher</th>
                  <th className="py-1.5 pr-3">命令</th>
                  <th className="py-1.5 pr-3">超时</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {scan.hookRegistrations.map((h, i) => (
                  <tr key={i} className="border-b border-ink-700/40">
                    <td className="py-1.5 pr-3 text-mist-300">{h.platformName}</td>
                    <td className="py-1.5 pr-3"><span className="chip bg-violet-500/15 text-[10px] text-violet-300">{h.event}</span></td>
                    <td className="py-1.5 pr-3 font-mono text-mist-400">{h.matcher}</td>
                    <td className="max-w-[380px] truncate py-1.5 pr-3 font-mono text-[10.5px] text-mist-300" title={h.command}>{h.command}</td>
                    <td className="py-1.5 pr-3 text-mist-500">{h.timeout != null ? `${h.timeout}s` : '—'}</td>
                    <td className="py-1.5">
                      <button onClick={() => onOpenFile(h.file)} className="btn-ghost justify-center px-1.5" title="编辑注册文件">
                        <FileCode2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 钩子脚本 */}
      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <FileCode2 size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">钩子脚本</span>
          <span className="text-[10.5px] text-mist-500">各平台 hooks / plugins / extensions 目录</span>
        </div>
        {scan.hookScripts.length === 0 ? (
          <div className="text-xs text-mist-500">未发现钩子脚本。</div>
        ) : (
          <div className="grid gap-1.5 md:grid-cols-2">
            {scan.hookScripts.map((f) => (
              <div key={f.path} className="flex items-center gap-2 rounded-lg border border-ink-700 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-mist-300" title={f.path}>{f.name}</span>
                <span className="shrink-0 text-[10px] text-mist-600">{relTime(f.mtime)}</span>
                <button onClick={() => onOpenFile(f.path)} className="btn-ghost justify-center px-1.5" title="查看 / 编辑">
                  <FileCode2 size={12} />
                </button>
                <button onClick={() => void api.revealInExplorer(f.path)} className="btn-ghost justify-center px-1.5" title="在资源管理器显示">
                  <FolderOpen size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- config.yaml Tab ---------------- */

function ConfigSection({ scan, onChanged }: { scan: StudioScan; onChanged: () => Promise<void> }): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const c = scan.config
  const [form, setForm] = useState({
    session_commit_message: c.session_commit_message ?? '',
    session_auto_commit: c.session_auto_commit,
    max_journal_lines: c.max_journal_lines,
    default_workflow: c.default_workflow ?? '',
    default_package: c.default_package ?? '',
    codex_dispatch_mode: c.codex_dispatch_mode ?? ''
  })
  const [packages, setPackages] = useState<Array<{ name: string; path: string; type: string; git: boolean }>>(
    Object.entries(c.packages).map(([name, p]) => ({ name, path: p.path ?? '', type: p.type ?? '', git: p.git ?? false }))
  )
  const [saving, setSaving] = useState(false)

  const save = async (): Promise<void> => {
    setSaving(true)
    const patch: Record<string, unknown> = {
      session_commit_message: form.session_commit_message.trim() || null,
      max_journal_lines: form.max_journal_lines && form.max_journal_lines > 0 ? Math.round(form.max_journal_lines) : null,
      default_workflow: form.default_workflow.trim() || null,
      default_package: form.default_package.trim() || null
    }
    if (form.session_auto_commit !== null) patch.session_auto_commit = form.session_auto_commit
    if (form.codex_dispatch_mode) patch['codex.dispatch_mode'] = form.codex_dispatch_mode
    const pkg: Record<string, { path?: string; type?: string; git?: boolean }> = {}
    for (const p of packages) {
      const name = p.name.trim()
      if (!name) continue
      pkg[name] = {
        ...(p.path.trim() ? { path: p.path.trim() } : {}),
        ...(p.type.trim() ? { type: p.type.trim() } : {}),
        ...(p.git ? { git: true } : {})
      }
    }
    patch.packages = Object.keys(pkg).length ? pkg : null
    const res = await api.studioSetConfig(patch)
    setSaving(false)
    if (res.ok) {
      pushToast({ kind: 'success', title: 'config.yaml 已保存', body: '注意：注释会被重排，键值保留' })
      await onChanged()
    } else pushToast({ kind: 'error', title: '保存失败', body: res.error })
  }

  return (
    <div className="max-w-3xl space-y-4 p-5">
      {!c.exists && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-[11.5px] text-amber-300">
          <AlertTriangle size={13} /> .trellis/config.yaml 不存在——保存时将创建（团队共享文件，建议提交评审）。
        </div>
      )}
      <div className="card space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Settings2 size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">会话与任务</span>
        </div>
        <label className="block">
          <span className="mb-1 block text-[11px] text-mist-400">session_commit_message — journal 自动提交信息</span>
          <input value={form.session_commit_message} onChange={(e) => setForm((f) => ({ ...f, session_commit_message: e.target.value }))} className="field w-full" />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-mist-400">session_auto_commit</span>
            <select
              value={form.session_auto_commit === null ? 'default' : form.session_auto_commit ? 'true' : 'false'}
              onChange={(e) => setForm((f) => ({ ...f, session_auto_commit: e.target.value === 'default' ? null : e.target.value === 'true' }))}
              className="field w-full"
            >
              <option value="default">默认（true）</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-mist-400">max_journal_lines — journal 轮转行数</span>
            <input
              type="number"
              value={form.max_journal_lines ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, max_journal_lines: e.target.value ? Number(e.target.value) : null }))}
              className="field w-full"
              placeholder="2000"
            />
          </label>
        </div>
      </div>

      <div className="card space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Workflow size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">Workflow 与包结构</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] text-mist-400">default_workflow — 团队默认 workflow</span>
            <select value={form.default_workflow} onChange={(e) => setForm((f) => ({ ...f, default_workflow: e.target.value }))} className="field w-full">
              <option value="">（未设置）</option>
              {scan.workflows.filter((w) => w.scope === 'saved').map((w) => (
                <option key={w.id} value={w.id}>{w.id}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] text-mist-400">default_package</span>
            <select value={form.default_package} onChange={(e) => setForm((f) => ({ ...f, default_package: e.target.value }))} className="field w-full">
              <option value="">（未设置）</option>
              {packages.filter((p) => p.name.trim()).map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] text-mist-400">packages — monorepo / submodule / polyrepo 声明</span>
            <button onClick={() => setPackages((p) => [...p, { name: '', path: '', type: '', git: false }])} className="btn-ghost text-[11px]">
              <Plus size={11} /> 添加
            </button>
          </div>
          <div className="space-y-1.5">
            {packages.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input value={p.name} onChange={(e) => setPackages((lst) => lst.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="名称" className="field w-28 text-[11.5px]" />
                <input value={p.path} onChange={(e) => setPackages((lst) => lst.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} placeholder="packages/xxx 路径" className="field flex-1 font-mono text-[11.5px]" />
                <input value={p.type} onChange={(e) => setPackages((lst) => lst.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} placeholder="type（submodule）" className="field w-32 text-[11.5px]" />
                <label className="flex shrink-0 items-center gap-1 text-[11px] text-mist-400">
                  <input type="checkbox" checked={p.git} onChange={(e) => setPackages((lst) => lst.map((x, j) => (j === i ? { ...x, git: e.target.checked } : x)))} /> git
                </label>
                <button onClick={() => setPackages((lst) => lst.filter((_, j) => j !== i))} className="btn-ghost justify-center px-1.5 text-rose-300">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {packages.length === 0 && <div className="text-[11px] text-mist-600">未声明包（单仓项目可留空）</div>}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-[11px] text-mist-400">codex.dispatch_mode — Codex 调度方式</span>
          <select value={form.codex_dispatch_mode} onChange={(e) => setForm((f) => ({ ...f, codex_dispatch_mode: e.target.value }))} className="field w-full md:w-64">
            <option value="">默认（inline）</option>
            <option value="inline">inline — 主 agent 实现</option>
            <option value="sub-agent">sub-agent — trellis-implement / trellis-check 分发</option>
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="btn-primary">
          <Save size={12} /> 保存 config.yaml
        </button>
        <span className="text-[10.5px] text-mist-600">
          不要把 token / API key 写入此文件——它是 git 跟踪的团队共享配置。
        </span>
      </div>
    </div>
  )
}

/* ---------------- 平台 Tab ---------------- */

function PlatformSection({ scan }: { scan: StudioScan }): JSX.Element {
  const detected = scan.platforms.filter((p) => p.detected)
  return (
    <div className="space-y-4 p-5">
      <div className="card p-4">
        <div className="mb-2 flex items-center gap-2">
          <MonitorSmartphone size={14} className="text-leaf" />
          <span className="text-xs font-semibold text-mist-100">平台检测</span>
          <span className="chip bg-leaf-dim/15 text-[10.5px] text-leaf-soft">{detected.length} / {scan.platforms.length} 已安装</span>
          <span className="ml-auto text-[10.5px] text-mist-500">安装命令：trellis init --&lt;platform&gt; · 更新：trellis update</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {scan.platforms.map((p) => (
            <div key={p.id} className={clsx('rounded-lg border p-3', p.detected ? 'border-leaf-dim/30 bg-leaf-dim/5' : 'border-ink-700 bg-ink-800/40 opacity-70')}>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-mist-100">{p.name}</span>
                {p.detected ? (
                  <span className="chip bg-leaf-dim/20 text-[9.5px] text-leaf-soft">已安装</span>
                ) : (
                  <span className="chip bg-ink-750 text-[9.5px] text-mist-500">未安装 · {p.installFlag}</span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {p.capabilities.map((cap) => (
                  <span key={cap} className="chip bg-ink-750 text-[9.5px] text-mist-400">{cap}</span>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-mist-500">
                <span>{p.invocationHint}</span>
                <span className="ml-auto">
                  {p.detected ? `命令 ${p.counts.commands} · 代理 ${p.counts.agents} · 技能 ${p.counts.skills} · 钩子 ${p.counts.hooks}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-2 text-xs font-semibold text-mist-100">团队与个人配置</div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-ink-600 bg-ink-800/50 p-3">
            <div className="mb-1.5 text-[11.5px] font-medium text-mist-200">团队共享（PR 评审协作）</div>
            <ul className="space-y-1 text-[11px] leading-4 text-mist-400">
              <li>· <code>.trellis/spec/</code> —— 规范知识库，像代码一样经 PR 评审</li>
              <li>· <code>.trellis/tasks/</code> —— 任务 JSON，用 --assignee 避免冲突</li>
              <li>· <code>.trellis/config.yaml</code> / <code>workflows/</code> —— 团队默认行为</li>
              <li>· 平台目录（.claude 等）—— hooks / skills / 命令，随仓库分发</li>
            </ul>
          </div>
          <div className="rounded-lg border border-ink-600 bg-ink-800/50 p-3">
            <div className="mb-1.5 text-[11.5px] font-medium text-mist-200">个人隔离（gitignored）</div>
            <ul className="space-y-1 text-[11px] leading-4 text-mist-400">
              <li>· <code>.trellis/.developer</code> —— 本机身份与个人 workflow 偏好{name_ext(scan)}</li>
              <li>· <code>.trellis/workspace/&lt;name&gt;/</code> —— 个人日志与索引</li>
              <li>· <code>.trellis/.runtime/</code> —— 会话运行时（每会话独立活动任务）</li>
            </ul>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-ink-600 bg-ink-800/50 p-3 text-[11px] leading-5 text-mist-400">
          <span className="text-mist-200">新成员加入：</span>
          在已 init 的项目里再跑一次 <code>trellis init</code> → 选「Set up developer identity」写入本机身份；不要选 Full re-initialize（会覆盖团队配置）。
          版本升级用 <code>trellis update</code>（--dry-run 预览 / --migrate 兼容破坏性变更），模板哈希机制会保护本地修改。
        </div>
      </div>
    </div>
  )
}

function name_ext(scan: StudioScan): string {
  return scan.chain.developerName ? `（当前：${scan.chain.developerName}）` : ''
}
