import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { FolderOpen, Loader2, Plus, Trash2, X } from 'lucide-react'
import { applicationSaveSchema, type ApplicationConfig, type ApplicationDefinition, type ApplicationPort, type ApplicationSaveInput } from '@shared/app-runtime'
import { api } from '../api'
import { Select } from '../components/Select'
import { Button, Modal } from '../my/ui'
import { applicationsGeneration, saveApplication } from './useApplications'

type OverrideDraft = { key: string; action: 'keep' | 'replace' | 'clear'; value: string; existing: boolean }
type Draft = {
  id: string; name: string; cwd: string; kind: ApplicationConfig['launch']['kind']
  executable: string; args: string; command: string; script: string; envFiles: string; ports: string
  readiness: 'none' | 'tcp' | 'http'; host: '127.0.0.1' | '::1' | 'localhost'; port: string; url: string
  timeout: string; stopTimeout: string; overrides: OverrideDraft[]
}

function initialDraft(definition?: ApplicationDefinition, npm = false): Draft {
  const launch = definition?.launch
  const readiness = definition?.readiness
  return {
    id: definition?.id ?? '', name: definition?.name ?? '', cwd: definition?.cwd ?? '.', kind: launch?.kind ?? (npm ? 'npm-script' : 'argv'),
    executable: launch?.kind === 'argv' ? launch.executable : '', args: launch?.kind === 'argv' ? launch.args.join('\n') : '',
    command: launch?.kind === 'script' ? launch.command : '', script: launch?.kind === 'npm-script' ? launch.script : '',
    envFiles: definition?.envFiles.join('\n') ?? '', ports: definition?.ports.map(({ host, port }) => `${host.includes(':') ? `[${host}]` : host}:${port}`).join('\n') ?? '',
    readiness: readiness?.kind ?? 'none', host: readiness?.kind === 'tcp' ? readiness.host : '127.0.0.1',
    port: readiness?.kind === 'tcp' ? String(readiness.port) : '', url: readiness?.kind === 'http' ? readiness.url : '',
    timeout: readiness && readiness.kind !== 'none' ? String(readiness.timeoutMs / 1000) : '30', stopTimeout: String((definition?.stopTimeoutMs ?? 10000) / 1000),
    overrides: definition?.overrideKeys.map((key) => ({ key, action: 'keep', value: '', existing: true })) ?? []
  }
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }): JSX.Element {
  return <label className="my-application-field"><span className="text-my-sm font-medium text-my-primary">{label}</span>{children}{hint && <span className="text-my-xs text-my-tertiary">{hint}</span>}</label>
}

function parsePorts(value: string): ApplicationPort[] {
  return value.split(/[\n,]+/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = /^(?:(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):)?(\d+)$/.exec(line)
    if (!match) throw new Error('端口格式应为 8080 或 127.0.0.1:8080，每行一个。')
    const port = Number(match[2])
    if (port < 1 || port > 65535) throw new Error('端口必须介于 1 和 65535。')
    const host = (match[1] ?? '127.0.0.1').replace(/[\[\]]/g, '') as ApplicationPort['host']
    return { host, port }
  })
}

function directoryPath(root: string, cwd: string): string {
  return /^(?:[a-z]:[\\/]|[\\/])/i.test(cwd) ? cwd : `${root.replace(/[\\/]+$/, '')}/${cwd || '.'}`
}

export function ApplicationConfigDialog({ root, definition, npm, onClose }: {
  root: string; definition?: ApplicationDefinition; npm?: boolean; onClose: () => void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(() => initialDraft(definition, npm))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scripts, setScripts] = useState<string[]>([])
  const [scriptsLoading, setScriptsLoading] = useState(false)
  const [scriptError, setScriptError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const mounted = useRef(true)
  const generation = useRef(applicationsGeneration()).current
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [advanced, setAdvanced] = useState(Boolean(definition?.overrideKeys.length || (definition?.readiness && definition.readiness.kind !== 'none')))
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => { setDraft((current) => ({ ...current, [key]: value })); setError(null) }

  useEffect(() => {
    if (draft.kind !== 'npm-script') return
    let live = true
    setScriptsLoading(true)
    setScriptError(null)
    setScripts([])
    void api.devtoolsListScripts(directoryPath(root, draft.cwd)).then((result) => {
      if (!live) return
      if (result.ok === true) setScripts(result.scripts.map((script) => script.name))
      else setScriptError(result.error ?? '未能读取 package.json 脚本。')
    }).catch(() => { if (live) setScriptError('脚本读取失败，请检查工作目录。') }).finally(() => { if (live) setScriptsLoading(false) })
    return () => { live = false }
  }, [root, draft.cwd, draft.kind])

  const chooseDirectory = async (): Promise<void> => {
    setPicking(true)
    try {
      const selected = await api.pickProject()
      if (selected && mounted.current) set('cwd', selected)
    } catch { if (mounted.current) setError('目录选择未完成，请重试。') }
    finally { if (mounted.current) setPicking(false) }
  }

  const save = async (): Promise<void> => {
    if (saving) return
    let input: ApplicationSaveInput
    try {
      const candidate = {
        config: {
          id: draft.id.trim(), name: draft.name.trim(), cwd: draft.cwd.trim() || '.',
          launch: draft.kind === 'argv' ? { kind: 'argv' as const, executable: draft.executable.trim(), args: draft.args ? draft.args.split(/\r?\n/) : [] }
            : draft.kind === 'script' ? { kind: 'script' as const, command: draft.command.trim() }
              : { kind: 'npm-script' as const, script: draft.script },
          envFiles: draft.envFiles.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), ports: parsePorts(draft.ports),
          readiness: draft.readiness === 'none' ? { kind: 'none' as const }
            : draft.readiness === 'tcp' ? { kind: 'tcp' as const, host: draft.host, port: Number(draft.port), timeoutMs: Number(draft.timeout) * 1000 }
              : { kind: 'http' as const, url: draft.url.trim(), timeoutMs: Number(draft.timeout) * 1000 },
          stopTimeoutMs: Number(draft.stopTimeout) * 1000
        },
        expectedRevision: definition?.revision ?? null,
        overrides: draft.overrides.filter((row) => row.key.trim()).map((row) => row.action === 'replace'
          ? { key: row.key.trim(), action: 'replace' as const, value: row.value }
          : { key: row.key.trim(), action: row.action })
      }
      const parsed = applicationSaveSchema.safeParse(candidate)
      if (!parsed.success) { setError('请检查应用标识、名称、启动命令、环境变量名称及检查参数。'); return }
      if (draft.kind === 'npm-script' && !scripts.includes(draft.script)) { setError('请选择工作目录中实际存在的 npm 脚本。'); return }
      const keys = candidate.overrides.map((row) => row.key.toUpperCase())
      if (new Set(keys).size !== keys.length) { setError('环境覆盖变量名称不能重复。'); return }
      input = parsed.data
    } catch (caught) { setError(caught instanceof Error ? caught.message : '配置格式不正确。'); return }
    setSaving(true)
    setError(null)
    const failure = await saveApplication(input, generation)
    if (!mounted.current) return
    setSaving(false)
    if (failure) setError(failure.error)
    else onClose()
  }

  const updateOverride = (index: number, patch: Partial<OverrideDraft>): void => {
    set('overrides', draft.overrides.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))
  }

  return <Modal open onClose={onClose} ariaLabel={definition ? '编辑应用' : npm ? '导入 npm 脚本' : '添加应用'}>
    <div className="my-application-dialog">
      <header className="flex shrink-0 items-center gap-3 border-b border-my-line px-5 py-4">
        <h2 className="min-w-0 flex-1 text-my-lg font-semibold text-my-primary">{definition ? '编辑应用' : npm ? '导入 npm 脚本' : '添加应用'}</h2>
        <button type="button" className="my-icon-control" onClick={onClose} aria-label="关闭应用配置"><X size={16} /></button>
      </header>
      <form id={`${id}-form`} className="my-application-form my-scrollbar" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <div className="my-application-form-grid">
          <Field label="名称"><input aria-label="应用名称" className="my-input w-full" value={draft.name} maxLength={120} onChange={(event) => set('name', event.target.value)} autoComplete="off" /></Field>
          <Field label="应用标识" hint="用于 Agent 命令，例如 backend。"><input aria-label="应用标识" className="my-input w-full font-mono" value={draft.id} disabled={Boolean(definition)} maxLength={80} onChange={(event) => set('id', event.target.value)} autoComplete="off" /></Field>
        </div>
        <Field label="工作目录">
          <span className="flex min-w-0 gap-2"><input aria-label="工作目录" className="my-input min-w-0 flex-1 font-mono" value={draft.cwd} onChange={(event) => set('cwd', event.target.value)} autoComplete="off" /><Button variant="outline" onClick={() => void chooseDirectory()} disabled={picking} aria-label="选择工作目录">{picking ? <Loader2 size={15} className="animate-spin" /> : <FolderOpen size={15} />}</Button></span>
        </Field>
        <Field label="启动方式"><Select ariaLabel="启动方式" value={draft.kind} onChange={(value) => set('kind', value)} className="w-full" options={[{ value: 'argv', label: '程序与参数' }, { value: 'script', label: 'Shell 命令' }, { value: 'npm-script', label: 'npm 脚本' }]} /></Field>
        {draft.kind === 'argv' && <>
          <Field label="可执行程序"><input aria-label="可执行程序" className="my-input w-full font-mono" value={draft.executable} placeholder="java、python 或程序路径" onChange={(event) => set('executable', event.target.value)} autoComplete="off" /></Field>
          <Field label="参数" hint="每行一个参数；带空格的参数保持在同一行，不要添加 Shell 引号。"><textarea aria-label="启动参数" className="my-input w-full font-mono" rows={3} value={draft.args} placeholder={'-jar\napp.jar'} onChange={(event) => set('args', event.target.value)} spellCheck={false} /></Field>
        </>}
        {draft.kind === 'script' && <Field label="Shell 命令"><textarea aria-label="Shell 命令" className="my-input w-full font-mono" rows={3} value={draft.command} placeholder="填写项目的启动命令" onChange={(event) => set('command', event.target.value)} spellCheck={false} /></Field>}
        {draft.kind === 'npm-script' && <Field label="npm 脚本">
          <Select ariaLabel="npm 脚本" value={draft.script} onChange={(value) => { set('script', value); if (!draft.name) set('name', value); if (!draft.id) set('id', value.replace(/[^a-zA-Z0-9._-]/g, '-')) }} options={scripts.map((script) => ({ value: script, label: script }))} disabled={scriptsLoading || scripts.length === 0} placeholder={scriptsLoading ? '正在读取脚本…' : scripts.length === 0 ? '当前目录没有 npm 脚本' : '选择脚本'} className="w-full" />
          {scriptError && <span role="status" className="text-my-xs text-my-danger-text">{scriptError}</span>}
        </Field>}
        <Field label="环境文件" hint="相对工作目录，每行一个；每次启动重新读取。"><textarea aria-label="环境文件" className="my-input w-full font-mono" rows={2} value={draft.envFiles} placeholder={'.env\n.env.local'} onChange={(event) => set('envFiles', event.target.value)} spellCheck={false} /></Field>
        <Field label="预期端口" hint="每行一个，例如 8080 或 0.0.0.0:8080。"><textarea aria-label="预期端口" className="my-input w-full font-mono" rows={2} value={draft.ports} placeholder="8080" onChange={(event) => set('ports', event.target.value)} spellCheck={false} /></Field>
        <button type="button" className="my-control my-button-ghost justify-start" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>{advanced ? '收起高级配置' : '高级配置'}</button>
        {advanced && <div className="space-y-4">
          <Field label="服务就绪检查"><Select ariaLabel="服务就绪检查" value={draft.readiness} onChange={(value) => set('readiness', value)} options={[{ value: 'none', label: '不检查' }, { value: 'tcp', label: 'TCP 端口' }, { value: 'http', label: 'HTTP 地址' }]} className="w-full" /></Field>
          {draft.readiness === 'tcp' && <div className="my-application-form-grid"><Field label="检查地址"><Select ariaLabel="TCP 检查地址" value={draft.host} onChange={(value) => set('host', value)} options={['127.0.0.1', '::1', 'localhost']} className="w-full" /></Field><Field label="检查端口"><input aria-label="TCP 检查端口" className="my-input w-full" inputMode="numeric" value={draft.port} onChange={(event) => set('port', event.target.value)} /></Field></div>}
          {draft.readiness === 'http' && <Field label="HTTP 检查地址"><input aria-label="HTTP 检查地址" className="my-input w-full font-mono" placeholder="http://127.0.0.1:8080/health" value={draft.url} onChange={(event) => set('url', event.target.value)} /></Field>}
          <div className="my-application-form-grid">
            {draft.readiness !== 'none' && <Field label="就绪等待（秒）"><input aria-label="就绪等待秒数" className="my-input w-full" inputMode="decimal" value={draft.timeout} onChange={(event) => set('timeout', event.target.value)} /></Field>}
            <Field label="停止等待（秒）"><input aria-label="停止等待秒数" className="my-input w-full" inputMode="numeric" value={draft.stopTimeout} onChange={(event) => set('stopTimeout', event.target.value)} /></Field>
          </div>
          <section aria-label="环境变量覆盖" className="space-y-2">
            <div className="flex flex-wrap items-center gap-2"><h3 className="flex-1 text-my-sm font-medium text-my-primary">环境变量覆盖</h3><Button size="sm" variant="ghost" onClick={() => set('overrides', [...draft.overrides, { key: '', action: 'replace', value: '', existing: false }])}><Plus size={13} />添加变量</Button></div>
            {draft.overrides.map((row, index) => <div className="my-application-override" key={index}>
              <input aria-label={`变量名称 ${index + 1}`} className="my-input min-w-0 font-mono" value={row.key} disabled={row.existing} onChange={(event) => updateOverride(index, { key: event.target.value })} autoComplete="off" />
              <Select ariaLabel={`变量操作 ${index + 1}`} value={row.action} onChange={(action) => updateOverride(index, { action, value: '' })} size="sm" options={row.existing ? [{ value: 'keep', label: '保留' }, { value: 'replace', label: '替换' }, { value: 'clear', label: '移除' }] : [{ value: 'replace', label: '设置' }]} />
              {row.action === 'replace' && <input aria-label={`变量值 ${index + 1}`} type="password" className="my-input min-w-0 font-mono" value={row.value} onChange={(event) => updateOverride(index, { value: event.target.value })} autoComplete="new-password" placeholder="新值" />}
              {!row.existing && <button type="button" className="my-icon-control" aria-label={`删除变量 ${index + 1}`} onClick={() => set('overrides', draft.overrides.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={14} /></button>}
            </div>)}
          </section>
        </div>}
        {error && <p role="alert" className="my-application-message text-my-danger-text">{error}</p>}
      </form>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-my-line px-5 py-3">
        <span className="mr-auto text-my-xs text-my-tertiary">保存后手动启动</span>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={saving || picking} onClick={() => void save()}>{saving && <Loader2 size={14} className="animate-spin" />}保存</Button>
      </footer>
    </div>
  </Modal>
}
