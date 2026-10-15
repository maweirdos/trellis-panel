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
  CheckCircle2,
  Sparkles
} from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { clsx } from 'clsx'
import { Button, SearchInput } from '../my/ui'
import { fmtBytes, relTime } from '../utils/format'
import { MarkdownView } from '../components/MarkdownView'
import { confirmDialog, promptDialog } from '../components/Dialogs'
import { FlowStudio } from '../components/FlowStudio'
import type { ExtEntry, ExtKind, StudioScan, WorkflowInfo } from '../../../shared/types'
import type { JSX } from 'react'

type Section = 'flow' | 'workflow' | 'command' | 'agent' | 'skill' | 'hooks' | 'config' | 'platform'

const SECTIONS: Array<{ id: Section; label: string; icon: JSX.Element; hint: string }> = [
  { id: 'flow', label: 'AI 工作流', icon: <Sparkles size={15} />, hint: '一句话需求 → AI 设计多代理工作流 → 一键运行' },
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
  validate,
  renderable = false
}: {
  path: string
  title: string
  onClose: () => void
  onSaved: () => void
  validate?: (raw: string) => string[]
  /** markdown 正文：提供 预览 / 编辑 切换（默认预览） */
  renderable?: boolean
}): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [raw, setRaw] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [mtime, setMtime] = useState<number | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [view, setView] = useState<'preview' | 'edit'>(renderable ? 'preview' : 'edit')
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
    <div className="absolute inset-0 z-30 flex flex-col bg-my-canvas">
      <div className="flex shrink-0 items-center gap-2 border-b border-my-line px-4 py-2.5">
        <FileCode2 size={14} className="text-my-accent-text" />
        <span className="text-my-xs font-semibold text-my-primary">{title}</span>
        <span className="truncate font-mono text-my-xs text-my-tertiary">{path}</span>
        <div className="ml-auto flex items-center gap-2">
          {renderable && (
            <div className="flex overflow-hidden rounded-my-md border border-my-line">
              {(
                [
                  ['preview', '预览'],
                  ['edit', '编辑']
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setView(id)}
                  className={clsx(
                    'my-control my-control-sm rounded-none',
                    view === id ? 'bg-my-accent-subtle text-my-accent-text' : 'text-my-tertiary hover:bg-my-layer-1'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {dirty && <span className="my-chip bg-my-warning-subtle text-my-warning-text">未保存</span>}
          <Button variant="primary" onClick={save} disabled={!dirty || saving}>
            <Save size={12} /> 保存
          </Button>
          <Button variant="ghost" title="关闭" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 border-b border-my-line-danger bg-my-danger-subtle px-4 py-2 text-my-xs text-my-danger-text">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="border-b border-my-line-warning bg-my-warning-subtle px-4 py-2 text-my-sm leading-5 text-my-warning-text">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
            </div>
          ))}
        </div>
      )}
      {view === 'preview' && renderable ? (
        <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="mx-auto max-w-[860px]">
            <MarkdownView content={content} />
          </div>
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-my-canvas p-4 font-mono text-my-sm leading-5 text-my-primary outline-none"
        />
      )}
    </div>
  )
}

/* ---------------- 工作流编辑器（结构大纲 + 正文） ---------------- */

function WorkflowEditor({ wf, onClose, onSaved }: { wf: WorkflowInfo; onClose: () => void; onSaved: () => void }): JSX.Element {
  return (
    <div className="absolute inset-0 z-30 flex bg-my-canvas">
      <div className="my-scrollbar flex w-64 shrink-0 flex-col overflow-y-auto border-r border-my-line p-4">
        <div className="mb-3 flex items-center gap-2">
          <Layers size={14} className="text-my-accent-text" />
          <span className="text-my-xs font-semibold text-my-primary">结构大纲</span>
        </div>
        <div className="mb-3 flex flex-wrap gap-1">
          {wf.structure.states.map((s) => (
            <span key={s} className="my-chip bg-my-label-indigo font-mono text-my-2xs text-my-label-indigo-text">
              {s}
            </span>
          ))}
          {wf.structure.platforms.map((p) => (
            <span key={p} className="my-chip bg-my-label-purple text-my-2xs text-my-label-purple-text">
              {p}
            </span>
          ))}
        </div>
        {!wf.structure.hasPhaseIndex && (
          <div className="mb-3 rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-2 text-my-xs leading-4 text-my-warning-text">
            缺少 Phase Index——SessionStart 将无法注入阶段概览
          </div>
        )}
        {wf.structure.phases.length === 0 && <div className="text-my-xs text-my-tertiary">未解析到 Phase</div>}
        {wf.structure.phases.map((p) => (
          <div key={p.title} className="mb-2.5">
            <div className="text-my-sm font-medium text-my-secondary">{p.title}</div>
            <div className="ml-2 mt-0.5 space-y-0.5 border-l border-my-line pl-2">
              {p.steps.length === 0 && <div className="text-my-xs text-my-placeholder">（无 #### X.Y 步骤）</div>}
              {p.steps.map((s) => (
                <div key={s} className="font-mono text-my-xs text-my-tertiary">
                  {s}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <FileEditor path={wf.path} title={`workflow：${wf.name}`} onClose={onClose} onSaved={onSaved} validate={validateWorkflow} renderable />
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
  const [bodyView, setBodyView] = useState<'preview' | 'edit'>('edit')

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
    <div className="absolute inset-0 z-30 flex flex-col bg-my-canvas">
      <div className="flex shrink-0 items-center gap-2 border-b border-my-line px-4 py-2.5">
        <span className="my-chip bg-my-accent-subtle text-my-xs text-my-accent-text">{ext.platformName}</span>
        <span className="text-my-xs font-semibold text-my-primary">{ext.name}</span>
        {ext.invocation && <span className="font-mono text-my-xs text-my-tertiary">{ext.invocation}</span>}
        <div className="ml-auto flex items-center gap-2">
          {ext.format === 'md' && (
            <Button variant="ghost" size="sm" onClick={() => setEditingRaw((v) => !v)}>
              {editingRaw ? '表单模式' : '原文模式'}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-my-danger-text" onClick={remove} title="删除文件">
            <Trash2 size={13} />
          </Button>
          <Button variant="primary" onClick={save} disabled={!dirty}>
            <Save size={12} /> 保存
          </Button>
          <Button variant="ghost" title="关闭" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>
      </div>
      {error && (
        <div className="flex items-center gap-2 border-b border-my-line-danger bg-my-danger-subtle px-4 py-2 text-my-xs text-my-danger-text">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        {editingRaw || ext.format !== 'md' ? (
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
            className="h-full min-h-[320px] w-full resize-none rounded-my-md border border-my-line bg-my-canvas p-3 font-mono text-my-sm leading-5 text-my-primary outline-none"
          />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {fmKeys.map((k) => (
              <label key={k} className="block">
                <span className="mb-1 block font-mono text-my-xs text-my-tertiary">{k}</span>
                {k === 'description' ? (
                  <textarea
                    value={fields[k] ?? ''}
                    onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
                    rows={3}
                    className="w-full resize-y rounded-my-md border border-my-line bg-my-surface-1 px-3 py-2 font-mono text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
                    placeholder={ext.kind === 'skill' ? '写触发条件而非技能身份——平台据此自动触发' : '主会话据此决定何时派生该子代理'}
                  />
                ) : (
                  <input
                    value={fields[k] ?? ''}
                    onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
                    className="my-input font-mono text-my-sm"
                    placeholder={k === 'tools' ? 'Read, Write, Edit, Bash, Glob, Grep' : k === 'model' ? '（留空继承会话模型）' : ''}
                  />
                )}
              </label>
            ))}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-my-xs text-my-tertiary">正文</span>
                <div className="ml-auto flex overflow-hidden rounded-my-md border border-my-line">
                  {(
                    [
                      ['preview', '预览'],
                      ['edit', '编辑']
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setBodyView(id)}
                      className={clsx(
                        'my-control my-control-sm rounded-none',
                        bodyView === id ? 'bg-my-accent-subtle text-my-accent-text' : 'text-my-tertiary hover:bg-my-layer-1'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {bodyView === 'preview' ? (
                <div className="my-scrollbar min-h-0 flex-1 overflow-y-auto rounded-my-md border border-my-line bg-my-canvas p-3">
                  <MarkdownView content={body} />
                </div>
              ) : (
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  spellCheck={false}
                  className="min-h-0 flex-1 resize-none rounded-my-md border border-my-line bg-my-canvas p-3 font-mono text-my-sm leading-5 text-my-primary outline-none"
                />
              )}
            </div>
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
        <div className="text-center text-my-xs text-my-tertiary">
          {error}
          <Button variant="ghost" className="mt-3" onClick={() => void reload()}>
            <RefreshCw size={12} /> 重试
          </Button>
        </div>
      </div>
    )
  }
  if (!scan) {
    return <div className="grid h-full place-items-center text-my-xs text-my-tertiary">正在扫描定制资源…</div>
  }

  const createExt = async (kind: ExtKind): Promise<void> => {
    const platformIds = scan.platforms.map((p) => p.id)
    const platform = await promptDialog({
      title: '选择创建平台',
      label: `可选平台：${platformIds.join(', ')}`,
      placeholder: '输入平台 id',
      defaultValue: kind === 'skill' ? 'shared' : 'claude',
      validator: (v) => (platformIds.includes(v) ? null : `平台必须是：${platformIds.join(', ')}`)
    })
    if (platform === null) return
    const name = await promptDialog({ title: '新建扩展', label: '名称（字母/数字/下划线/连字符）' })
    if (name === null) return
    const res = await api.studioCreateExtension(kind, platform, name)
    if (res.ok) {
      pushToast({ kind: 'success', title: '已创建', body: res.path ?? '' })
      await reload()
    } else {
      pushToast({ kind: 'error', title: '创建失败', body: res.error })
    }
  }

  return (
    <div className="flex h-full min-w-0">
      {/* 左侧子导航 */}
      <div className="flex w-48 shrink-0 flex-col border-r border-my-line">
        <div className="flex items-center px-4 py-3">
          <Button variant="ghost" size="sm" className="ml-auto" title="重新扫描" onClick={() => void reload()}>
            <RefreshCw size={12} />
          </Button>
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
                'flex w-full items-center gap-2 rounded-my-lg px-2.5 py-[7px] text-left text-my-sm transition-colors',
                section === s.id ? 'bg-my-layer-1-selected font-medium text-my-primary' : 'text-my-secondary hover:bg-my-layer-1 hover:text-my-primary'
              )}
            >
              <span className={section === s.id ? 'text-my-accent-text' : 'text-my-tertiary'}>{s.icon}</span>
              {s.label}
              <ChevronRight size={12} className="ml-auto text-my-placeholder" />
            </button>
          ))}
        </div>
        <div className="mt-auto border-t border-my-line p-3 text-my-xs text-my-placeholder">
          布局遵循 Trellis 官方文档
        </div>
      </div>

      {/* 右侧内容 */}
      <div className="my-scrollbar relative min-w-0 flex-1 overflow-y-auto">
        {section === 'flow' && <FlowStudio />}
        {section === 'workflow' && <WorkflowSection scan={scan} onEdit={setEditingWf} onChanged={reload} />}
        {extSection && (
          <ExtSection
            kind={section as ExtKind}
            extensions={extensions}
            query={query}
            setQuery={setQuery}
            onEdit={setEditingExt}
            onCreate={createExt}
            platforms={scan.platforms}
            reload={reload}
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
    const ok = await confirmDialog({
      title: `删除 workflow「${wf.name}」？`,
      message: '该文件不可恢复。',
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
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
      pushToast({ kind: 'success', title: 'Workflow 已创建' })
      await onChanged()
    } else pushToast({ kind: 'error', title: '创建失败', body: res.error })
  }

  const chain = scan.chain
  const totalPins = scan.workflows.reduce((n, w) => n + w.pinnedTasks.length, 0)

  return (
    <div className="space-y-4 p-5">
      {/* 优先级链 */}
      <div className="my-card p-4">
        <div className="mb-1 flex items-center gap-2">
          <Workflow size={14} className="text-my-accent-text" />
          <span className="text-my-xs font-semibold text-my-primary">Workflow 解析优先级</span>
          <span className="text-my-xs text-my-tertiary">自上而下回退</span>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-4">
          <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
            <div className="text-my-xs font-semibold uppercase tracking-wide text-my-accent-text">1 · 任务 Pin</div>
            <div className="mt-1 text-my-lg font-bold text-my-primary">{totalPins}</div>
            <div className="text-my-xs leading-4 text-my-tertiary">task.json 的 workflow 字段（随仓库提交）</div>
          </div>
          <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
            <div className="text-my-xs font-semibold uppercase tracking-wide text-my-accent-text">2 · 个人默认</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-my-sm text-my-primary">{chain.developerWorkflow ?? '—'}</span>
              <select
                value=""
                onChange={(e) => void setDeveloperWorkflow(e.target.value)}
                className="ml-auto h-7 w-28 rounded-my-md border border-my-line bg-my-surface-1 px-1.5 text-my-xs text-my-primary outline-none focus:border-my-line-accent [&>option]:bg-my-layer-2 [&>option]:text-my-primary"
              >
                <option value="">修改…</option>
                <option value="">清除</option>
                {scan.workflows.filter((w) => w.scope === 'saved').map((w) => (
                  <option key={w.id} value={w.id}>{w.id}</option>
                ))}
              </select>
            </div>
            <div className="mt-1 text-my-xs leading-4 text-my-tertiary">.trellis/.developer（gitignored）</div>
          </div>
          <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
            <div className="text-my-xs font-semibold uppercase tracking-wide text-my-accent-text">3 · 团队默认</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-my-sm text-my-primary">{chain.configDefault ?? '—'}</span>
              <select
                value=""
                onChange={(e) => void setConfigDefault(e.target.value)}
                className="ml-auto h-7 w-28 rounded-my-md border border-my-line bg-my-surface-1 px-1.5 text-my-xs text-my-primary outline-none focus:border-my-line-accent [&>option]:bg-my-layer-2 [&>option]:text-my-primary"
              >
                <option value="">修改…</option>
                <option value="">清除</option>
                {scan.workflows.filter((w) => w.scope === 'saved').map((w) => (
                  <option key={w.id} value={w.id}>{w.id}</option>
                ))}
              </select>
            </div>
            <div className="mt-1 text-my-xs leading-4 text-my-tertiary">config.yaml 的 default_workflow</div>
          </div>
          <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
            <div className="text-my-xs font-semibold uppercase tracking-wide text-my-accent-text">4 · 全局回退</div>
            <div className="mt-1 flex items-center gap-2">
              <span className={clsx('text-my-sm', chain.globalExists ? 'text-my-success-text' : 'text-my-danger-text')}>
                {chain.globalExists ? 'workflow.md ✓' : '缺失'}
              </span>
            </div>
            <div className="mt-1 text-my-xs leading-4 text-my-tertiary">.trellis/workflow.md（零配置兜底）</div>
          </div>
        </div>
      </div>

      {/* 新建 */}
      <div className="flex items-center gap-2">
        {creating ? (
          <>
            <input autoFocus value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="workflow id（如 review-first）" className="my-input w-64" />
            <Button variant="primary" onClick={create}>
              <Plus size={12} /> 创建
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>取消</Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={12} /> 新建 Workflow
          </Button>
        )}
      </div>

      {/* workflow 列表 */}
      <div className="grid gap-3 lg:grid-cols-2">
        {scan.workflows.map((wf) => (
          <div key={wf.path} className={clsx('my-card p-4', wf.scope === 'global' && 'border-my-line-accent-subtle')}>
            <div className="flex items-center gap-2">
              <span className={clsx('my-chiptext-my-2xs', wf.scope === 'global' ? 'bg-my-accent-subtle text-my-accent-text' : 'bg-my-layer-2 text-my-secondary')}>
                {wf.scope === 'global' ? '全局回退' : '变体'}
              </span>
              <span className="font-mono text-my-xs font-semibold text-my-primary">{wf.name}</span>
              {wf.pinnedTasks.length > 0 && (
                <span className="my-chip bg-my-label-indigo text-my-2xs text-my-label-indigo-text" title={wf.pinnedTasks.map((t) => t.title).join('\n')}>
                  {wf.pinnedTasks.length} 个任务 pin
                </span>
              )}
              <span className="ml-auto text-my-2xs text-my-placeholder">{fmtBytes(wf.size)} · {relTime(wf.mtime)}</span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1">
              <span className="my-chip bg-my-layer-2 text-my-xs text-my-secondary">{wf.structure.phases.length} 个 Phase</span>
              <span className="my-chip bg-my-layer-2 text-my-xs text-my-secondary">{wf.structure.phases.reduce((n, p) => n + p.steps.length, 0)} 个步骤</span>
              {wf.structure.states.map((s) => (
                <span key={s} className="my-chip bg-my-label-indigo font-mono text-my-2xs text-my-label-indigo-text">{s}</span>
              ))}
            </div>
            {wf.warnings.length > 0 && (
              <div className="mt-2.5 space-y-1 rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-2 text-my-xs leading-4 text-my-warning-text">
                {wf.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {w}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onEdit(wf)}>
                编辑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(`trellis workflow --save ${wf.id}`)}
                title="复制同步命令"
              >
                CLI 命令
              </Button>
              {wf.scope === 'saved' && (
                <Button variant="ghost" size="sm" className="ml-auto text-my-danger-text" onClick={() => void removeWf(wf)} title="删除">
                  <Trash2 size={12} />
                </Button>
              )}
            </div>
          </div>
        ))}
        {scan.workflows.length === 0 && (
          <div className="my-card p-6 text-center text-my-xs text-my-tertiary">
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
  onCreate,
  platforms,
  reload
}: {
  kind: ExtKind
  extensions: ExtEntry[]
  query: string
  setQuery: (q: string) => void
  onEdit: (e: ExtEntry) => void
  onCreate: (kind: ExtKind) => void
  platforms: StudioScan['platforms']
  reload: () => Promise<void>
}): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const [aggMode, setAggMode] = useState(false)
  const [syncing, setSyncing] = useState<string | null>(null)
  const meta = SECTIONS.find((s) => s.id === kind)!
  const capKey = kind === 'command' ? 'commands' : kind === 'agent' ? 'agents' : 'skills'

  const byPlatform = useMemo(() => {
    const m = new Map<string, ExtEntry[]>()
    for (const e of extensions) {
      const list = m.get(e.platformName) ?? []
      list.push(e)
      m.set(e.platformName, list)
    }
    return [...m.entries()]
  }, [extensions])

  /* 聚合视图：同名扩展在支持该能力的平台上的覆盖矩阵 */
  const groups = useMemo(() => {
    if (!aggMode) return []
    const capable = new Set(platforms.filter((p) => p.detected && p.capabilities.includes(capKey)).map((p) => p.id))
    const m = new Map<string, { entries: ExtEntry[]; platforms: Set<string> }>()
    for (const e of extensions) {
      const g = m.get(e.name) ?? { entries: [], platforms: new Set<string>() }
      g.entries.push(e)
      g.platforms.add(e.platform)
      m.set(e.name, g)
    }
    return [...m.entries()]
      .map(([name, g]) => {
        const missing = [...capable].filter((p) => !g.platforms.has(p))
        return { name, entries: g.entries, present: [...g.platforms], missing }
      })
      .sort((a, b) => b.present.length + b.missing.length - (a.present.length + a.missing.length))
  }, [aggMode, extensions, platforms, capKey])

  const syncTo = async (entry: ExtEntry, targets: string[], label: string): Promise<void> => {
    setSyncing(entry.name)
    const res = await api.studioSyncExtension(entry.path, targets)
    setSyncing(null)
    if (res.ok) {
      const skippedNote = res.skipped.map((s) => `${s.platform}：${s.reason}`).join('；')
      pushToast({
        kind: 'success',
        title: label,
        body: `已写入 ${res.written.length} 个平台${skippedNote ? '；跳过 → ' + skippedNote : ''}`
      })
      await reload()
    } else {
      pushToast({ kind: 'error', title: '同步失败', body: res.error })
    }
  }

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-center gap-2">
        <div className="w-64">
          <SearchInput value={query} onChange={setQuery} placeholder="搜索名称 / 平台 / 路径…" />
        </div>
        <span className="text-my-xs text-my-tertiary">{extensions.length} 个</span>
        <button onClick={() => setAggMode((v) => !v)} className={clsx('my-chipborder transition-colors ml-auto', aggMode ? 'border-my-line-accent-subtle text-my-accent-text' : 'border-my-line text-my-tertiary')} title="同名扩展在哪些平台存在/缺失，一键补齐">
          跨平台矩阵{aggMode ? ' 开' : ' 关'}
        </button>
        <Button variant="primary" onClick={() => onCreate(kind)}>
          <Plus size={12} /> 新建
        </Button>
      </div>

      {aggMode && (
        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g.name} className="my-card p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-my-xs font-medium text-my-primary">{g.name}</span>
                {g.present.map((p) => (
                  <span key={p} className="my-chip bg-my-accent-subtle text-my-2xs text-my-accent-text" title={p}>
                    ✓ {p}
                  </span>
                ))}
                {g.missing.map((p) => (
                  <button
                    key={p}
                    onClick={() => void syncTo(g.entries[0], [p], `已同步到 ${p}`)}
                    disabled={syncing === g.name}
                    className="my-chip border border-dashed border-my-line text-my-2xs text-my-tertiary transition-colors hover:border-my-line-accent-subtle hover:text-my-accent-text disabled:opacity-40"
                    title={`把 ${g.name} 补齐到 ${p}`}
                  >
                    + {p}
                  </button>
                ))}
                {g.missing.length > 1 && (
                  <Button variant="outline" size="sm" className="ml-auto" onClick={() => void syncTo(g.entries[0], g.missing, `已补齐 ${g.missing.length} 个平台`)} disabled={syncing === g.name}>
                    一键补齐全部（{g.missing.length}）
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => onEdit(g.entries[0])}>
                  编辑
                </Button>
              </div>
            </div>
          ))}
          {groups.length === 0 && <div className="my-card p-4 text-center text-my-xs text-my-tertiary">暂无扩展——切回列表视图或先新建</div>}
        </div>
      )}

      {!aggMode &&
        byPlatform.map(([platform, list]) => (
          <div key={platform}>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-my-sm font-semibold text-my-secondary">{platform}</span>
              <span className="my-chip bg-my-layer-2 text-my-2xs text-my-tertiary">{list.length}</span>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {list.map((e) => (
                <button key={e.path} onClick={() => onEdit(e)} className="my-card p-3 text-left">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-my-xs font-medium text-my-primary">{e.name}</span>
                    {e.frontmatter.model && <span className="my-chip bg-my-label-purple text-my-2xs text-my-label-purple-text">{e.frontmatter.model}</span>}
                    <span className="ml-auto shrink-0 text-my-2xs text-my-placeholder">{relTime(e.mtime)}</span>
                  </div>
                  {e.frontmatter.description && (
                    <div className="mt-1 line-clamp-2 text-my-xs leading-4 text-my-tertiary">{e.frontmatter.description}</div>
                  )}
                  <div className="mt-2 flex items-center gap-1.5">
                    {e.invocation && <span className="my-chip bg-my-accent-subtle font-mono text-my-2xs text-my-accent-text">{e.invocation}</span>}
                    {e.frontmatter.tools && <span className="my-chip bg-my-layer-2 text-my-2xs text-my-tertiary">{e.frontmatter.tools.split(',').length} 工具</span>}
                    <span className="ml-auto font-mono text-my-2xs text-my-placeholder">{fmtBytes(e.size)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      {extensions.length === 0 && !aggMode && (
        <div className="my-card p-6 text-center text-my-xs text-my-tertiary">
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
      <div className="my-card p-4">
        <div className="mb-1 flex items-center gap-2">
          <Webhook size={14} className="text-my-accent-text" />
          <span className="text-my-xs font-semibold text-my-primary">任务生命周期钩子</span>
          <span className="text-my-xs text-my-tertiary">config.yaml hooks.* · 注入 TASK_JSON_PATH</span>
        </div>
        <div className="mt-3 space-y-2">
          {(['after_create', 'after_start', 'after_finish', 'after_archive'] as const).map((ev) => (
            <div key={ev} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-my-sm text-my-secondary">{EVENT_LABEL[ev]}</span>
              <input
                value={hooks[ev] ?? ''}
                onChange={(e) => setHooks((h) => ({ ...h, [ev]: e.target.value }))}
                placeholder="如：python scripts/notify.py（留空禁用）"
                className="my-input font-mono text-my-sm"
              />
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" onClick={saveLifecycle}>
            <Save size={12} /> 保存
          </Button>
          {saved && (
            <span className="flex items-center gap-1 text-my-xs text-my-success-text">
              <CheckCircle2 size={12} /> 已写入
            </span>
          )}
          <span className="ml-auto text-my-xs text-my-placeholder">失败仅警告，不阻塞操作</span>
        </div>
      </div>

      {/* 平台 hook 注册 */}
      <div className="my-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Webhook size={14} className="text-my-accent-text" />
          <span className="text-my-xs font-semibold text-my-primary">平台 Hook 注册</span>
          <span className="text-my-xs text-my-tertiary">settings.json / hooks.json 中的事件注册</span>
        </div>
        {scan.hookRegistrations.length === 0 ? (
          <div className="text-my-xs text-my-tertiary">
            未发现 hook 注册。可点「一键写入 Trellis hooks」（设置 → 桥接），或手动编辑平台 settings.json。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-my-sm">
              <thead>
                <tr className="border-b border-my-line text-my-xs uppercase tracking-wide text-my-tertiary">
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
                  <tr key={i} className="border-b border-my-line">
                    <td className="py-1.5 pr-3 text-my-secondary">{h.platformName}</td>
                    <td className="py-1.5 pr-3"><span className="my-chip bg-my-label-purple text-my-2xs text-my-label-purple-text">{h.event}</span></td>
                    <td className="py-1.5 pr-3 font-mono text-my-tertiary">{h.matcher}</td>
                    <td className="max-w-[380px] truncate py-1.5 pr-3 font-mono text-my-xs text-my-secondary" title={h.command}>{h.command}</td>
                    <td className="py-1.5 pr-3 text-my-tertiary">{h.timeout != null ? `${h.timeout}s` : '—'}</td>
                    <td className="py-1.5">
                      <Button variant="ghost" size="sm" onClick={() => onOpenFile(h.file)} title="编辑注册文件">
                        <FileCode2 size={12} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 钩子脚本 */}
      <div className="my-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <FileCode2 size={14} className="text-my-accent-text" />
          <span className="text-my-xs font-semibold text-my-primary">钩子脚本</span>
          <span className="text-my-xs text-my-tertiary">各平台 hooks / plugins / extensions 目录</span>
        </div>
        {scan.hookScripts.length === 0 ? (
          <div className="text-my-xs text-my-tertiary">未发现钩子脚本。</div>
        ) : (
          <div className="grid gap-1.5 md:grid-cols-2">
            {scan.hookScripts.map((f) => (
              <div key={f.path} className="flex items-center gap-2 rounded-my-lg border border-my-line px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-my-xs text-my-secondary" title={f.path}>{f.name}</span>
                <span className="shrink-0 text-my-2xs text-my-placeholder">{relTime(f.mtime)}</span>
                <Button variant="ghost" size="sm" onClick={() => onOpenFile(f.path)} title="查看 / 编辑">
                  <FileCode2 size={12} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void api.revealInExplorer(f.path)} title="在资源管理器显示">
                  <FolderOpen size={12} />
                </Button>
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
        <div className="flex items-center gap-2 rounded-my-lg border border-my-line-warning bg-my-warning-subtle p-3 text-my-sm text-my-warning-text">
          <AlertTriangle size={13} /> .trellis/config.yaml 不存在——保存时将创建（团队共享文件，建议提交评审）。
        </div>
      )}
      <div className="my-card space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Settings2 size={14} className="text-my-accent-text" />
          <span className="text-my-xs font-semibold text-my-primary">会话与任务</span>
        </div>
        <label className="block">
          <span className="mb-1 block text-my-xs text-my-tertiary">session_commit_message — journal 自动提交信息</span>
          <input value={form.session_commit_message} onChange={(e) => setForm((f) => ({ ...f, session_commit_message: e.target.value }))} className="my-input" />
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-my-xs text-my-tertiary">session_auto_commit</span>
            <select
              value={form.session_auto_commit === null ? 'default' : form.session_auto_commit ? 'true' : 'false'}
              onChange={(e) => setForm((f) => ({ ...f, session_auto_commit: e.target.value === 'default' ? null : e.target.value === 'true' }))}
              className="my-input"
            >
              <option value="default">默认（true）</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-my-xs text-my-tertiary">max_journal_lines — journal 轮转行数</span>
            <input
              type="number"
              value={form.max_journal_lines ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, max_journal_lines: e.target.value ? Number(e.target.value) : null }))}
              className="my-input"
              placeholder="2000"
            />
          </label>
        </div>
      </div>

      <div className="my-card space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Workflow size={14} className="text-my-accent-text" />
          <span className="text-my-xs font-semibold text-my-primary">Workflow 与包结构</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-my-xs text-my-tertiary">default_workflow — 团队默认 workflow</span>
            <select value={form.default_workflow} onChange={(e) => setForm((f) => ({ ...f, default_workflow: e.target.value }))} className="my-input">
              <option value="">（未设置）</option>
              {scan.workflows.filter((w) => w.scope === 'saved').map((w) => (
                <option key={w.id} value={w.id}>{w.id}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-my-xs text-my-tertiary">default_package</span>
            <select value={form.default_package} onChange={(e) => setForm((f) => ({ ...f, default_package: e.target.value }))} className="my-input">
              <option value="">（未设置）</option>
              {packages.filter((p) => p.name.trim()).map((p) => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-my-xs text-my-tertiary">packages — monorepo / submodule / polyrepo 声明</span>
            <Button variant="ghost" size="sm" onClick={() => setPackages((p) => [...p, { name: '', path: '', type: '', git: false }])}>
              <Plus size={11} /> 添加
            </Button>
          </div>
          <div className="space-y-1.5">
            {packages.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input value={p.name} onChange={(e) => setPackages((lst) => lst.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="名称" className="my-input w-28 text-my-sm" />
                <input value={p.path} onChange={(e) => setPackages((lst) => lst.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} placeholder="packages/xxx 路径" className="my-input min-w-0 flex-1 font-mono text-my-sm" />
                <input value={p.type} onChange={(e) => setPackages((lst) => lst.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)))} placeholder="type（submodule）" className="my-input w-32 text-my-sm" />
                <label className="flex shrink-0 items-center gap-1 text-my-xs text-my-tertiary">
                  <input type="checkbox" checked={p.git} onChange={(e) => setPackages((lst) => lst.map((x, j) => (j === i ? { ...x, git: e.target.checked } : x)))} /> git
                </label>
                <Button variant="ghost" size="sm" className="text-my-danger-text" onClick={() => setPackages((lst) => lst.filter((_, j) => j !== i))}>
                  <Trash2 size={12} />
                </Button>
              </div>
            ))}
            {packages.length === 0 && <div className="text-my-xs text-my-placeholder">未声明包（单仓项目可留空）</div>}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-my-xs text-my-tertiary">codex.dispatch_mode — Codex 调度方式</span>
          <select value={form.codex_dispatch_mode} onChange={(e) => setForm((f) => ({ ...f, codex_dispatch_mode: e.target.value }))} className="my-input md:w-64">
            <option value="">默认（inline）</option>
            <option value="inline">inline — 主 agent 实现</option>
            <option value="sub-agent">sub-agent — trellis-implement / trellis-check 分发</option>
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} disabled={saving}>
          <Save size={12} /> 保存 config.yaml
        </Button>
        <span className="text-my-xs text-my-placeholder">
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
      <div className="my-card p-4">
        <div className="mb-2 flex items-center gap-2">
          <MonitorSmartphone size={14} className="text-my-accent-text" />
          <span className="text-my-xs font-semibold text-my-primary">平台检测</span>
          <span className="my-chip bg-my-accent-subtle text-my-xs text-my-accent-text">{detected.length} / {scan.platforms.length}</span>
          <span className="ml-auto text-my-xs text-my-tertiary">trellis init --&lt;platform&gt;</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {scan.platforms.map((p) => (
            <div key={p.id} className={clsx('rounded-my-lg border p-3', p.detected ? 'border-my-line-accent-subtle bg-my-accent-subtle' : 'border-my-line bg-my-layer-1 opacity-70')}>
              <div className="flex items-center gap-1.5">
                <span className="text-my-xs font-medium text-my-primary">{p.name}</span>
                {p.detected ? (
                  <span className="my-chip bg-my-layer-2 text-my-2xs text-my-accent-text">已安装</span>
                ) : (
                  <span className="my-chip bg-my-layer-2 text-my-2xs text-my-tertiary">未安装 · {p.installFlag}</span>
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {p.capabilities.map((cap) => (
                  <span key={cap} className="my-chip bg-my-layer-2 text-my-2xs text-my-tertiary">{cap}</span>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-2 font-mono text-my-2xs text-my-tertiary">
                <span>{p.invocationHint}</span>
                <span className="ml-auto">
                  {p.detected ? `命令 ${p.counts.commands} · 代理 ${p.counts.agents} · 技能 ${p.counts.skills} · 钩子 ${p.counts.hooks}` : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="my-card p-4">
        <div className="mb-2 text-my-xs font-semibold text-my-primary">团队与个人配置</div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
            <div className="mb-1.5 text-my-sm font-medium text-my-secondary">团队共享（PR 评审协作）</div>
            <ul className="space-y-1 text-my-xs leading-4 text-my-tertiary">
              <li>· <code>.trellis/spec/</code> —— 规范知识库，像代码一样经 PR 评审</li>
              <li>· <code>.trellis/tasks/</code> —— 任务 JSON，用 --assignee 避免冲突</li>
              <li>· <code>.trellis/config.yaml</code> / <code>workflows/</code> —— 团队默认行为</li>
              <li>· 平台目录（.claude 等）—— hooks / skills / 命令，随仓库分发</li>
            </ul>
          </div>
          <div className="rounded-my-lg border border-my-line bg-my-layer-1 p-3">
            <div className="mb-1.5 text-my-sm font-medium text-my-secondary">个人隔离（gitignored）</div>
            <ul className="space-y-1 text-my-xs leading-4 text-my-tertiary">
              <li>· <code>.trellis/.developer</code> —— 本机身份与个人 workflow 偏好{name_ext(scan)}</li>
              <li>· <code>.trellis/workspace/&lt;name&gt;/</code> —— 个人日志与索引</li>
              <li>· <code>.trellis/.runtime/</code> —— 会话运行时（每会话独立活动任务）</li>
            </ul>
          </div>
        </div>
        <div className="mt-3 rounded-my-lg border border-my-line bg-my-layer-1 p-3 text-my-xs leading-5 text-my-tertiary">
          <span className="text-my-secondary">新成员加入：</span>
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
