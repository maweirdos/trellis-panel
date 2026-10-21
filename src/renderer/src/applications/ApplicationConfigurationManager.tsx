import { useCallback, useId, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { PackagePlus, Plus, Terminal, Trash2, X } from 'lucide-react'
import type { ApplicationDefinition } from '@shared/app-runtime'
import { Button, Modal, Tooltip } from '../my/ui'
import { useEscLayer } from '../utils/use-esc-layer'
import { ApplicationConfigForm, initialApplicationDraft, type ApplicationDraft } from './ApplicationConfigForm'
import { applicationById, removeApplication, runConfiguredApplication, selectApplication, useApplications } from './useApplications'

type CachedConfiguration = { definition?: ApplicationDefinition; npm?: boolean; draft: ApplicationDraft; original: string; dirty: boolean; version: number }
type Notice = { kind: 'discard'; runId?: string } | { kind: 'delete'; definition: ApplicationDefinition }
const GROUPS = [{ kind: 'argv', label: '程序与参数' }, { kind: 'npm-script', label: 'npm 脚本' }, { kind: 'script', label: 'Shell 命令' }] as const

export function ApplicationConfigurationManager({ root, definition, npm, onClose }: {
  root: string; definition?: ApplicationDefinition; npm?: boolean; onClose: () => void
}): JSX.Element {
  const state = useApplications()
  const id = useId()
  const [selected, setSelected] = useState(definition?.id ?? (npm ? 'new:npm-script' : 'new:argv'))
  const cache = useRef(new Map<string, CachedConfiguration>())
  const [, update] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [escEpoch, setEscEpoch] = useState(0)
  const noticeButton = useRef<HTMLButtonElement>(null)
  const priorFocus = useRef<HTMLElement | null>(null)
  const request = useRef(0)
  const generation = state.generation

  const remember = (key: string): CachedConfiguration => {
    const saved = cache.current.get(key)
    if (saved) return saved
    const current = key.startsWith('new:') ? undefined : state.apps.find((app) => app.definition.id === key)?.definition
    const baseline = current ?? (definition?.id === key ? definition : undefined)
    const usesNpm = key === 'new:npm-script'
    const draft = initialApplicationDraft(baseline, usesNpm)
    const value = { definition: baseline, npm: usesNpm, draft, original: JSON.stringify(draft), dirty: false, version: 0 }
    cache.current.set(key, value)
    return value
  }
  const entry = remember(selected)
  const dirtyCount = [...cache.current.values()].filter((item) => item.dirty).length
  const busy = Boolean(state.busy[selected] || deleting || saving)

  const close = (runId?: string): void => {
    request.current += 1
    onClose()
    if (runId) void runConfiguredApplication(runId, 'start', generation)
  }
  const showNotice = (next: Notice): void => {
    priorFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setNotice(next)
    setError(null)
    setEscEpoch((value) => value + 1)
  }
  const requestClose = (runId?: string): void => {
    if (notice) { setNotice(null); setEscEpoch((value) => value + 1); return }
    if ([...cache.current.values()].some((item) => item.dirty)) showNotice({ kind: 'discard', runId })
    else close(runId)
  }
  useEscLayer(dirtyCount > 0 || notice !== null, { kind: 'modal', id: `run-configuration-${id}-${escEpoch}`, onClose: () => requestClose() })
  useLayoutEffect(() => {
    if (notice) noticeButton.current?.focus({ preventScroll: true })
    else if (priorFocus.current?.isConnected) priorFocus.current.focus({ preventScroll: true })
  }, [notice])
  useLayoutEffect(() => () => { request.current += 1 }, [])

  const rememberDraft = useCallback((draft: ApplicationDraft): void => {
    const current = cache.current.get(selected)
    if (!current) return
    current.draft = draft
    const dirty = JSON.stringify(draft) !== current.original
    current.dirty = dirty
    update((version) => version + 1)
  }, [selected])
  const choose = (key: string): void => {
    if (busy || notice) return
    remember(key)
    setSelected(key)
    setError(null)
  }
  const onSaved = (appId: string, run: boolean): void => {
    const current = cache.current.get(selected)
    if (current) {
      const definition = applicationById(appId)?.definition ?? current.definition
      const clean = initialApplicationDraft(definition)
      current.definition = definition
      current.draft = clean
      current.dirty = false
      current.original = JSON.stringify(clean)
      current.version += 1
      cache.current.delete(selected)
      cache.current.set(appId, current)
    }
    setSelected(appId)
    setSaving(false)
    selectApplication(appId, generation)
    update((version) => version + 1)
    requestClose(run ? appId : undefined)
  }
  const selectedApp = state.apps.find((app) => app.definition.id === selected)
  const active = Boolean(selectedApp && ['unknown', 'cleanup-required', 'starting', 'running', 'stopping'].includes(selectedApp.processState))
  const canDelete = Boolean(entry.definition && !active && !busy)
  const pendingKeys = [...cache.current.keys()].filter((key) => key.startsWith('new:'))
  const rows = [
    ...state.apps.map((app) => ({ key: app.definition.id, name: app.definition.name, kind: app.definition.launch.kind })),
    ...pendingKeys.map((key) => ({ key, name: cache.current.get(key)?.draft.name || '新建配置', kind: cache.current.get(key)?.draft.kind ?? 'argv' as const }))
  ]

  return <Modal open width="var(--my-run-config-width)" ariaLabel={definition ? '编辑应用' : npm ? '导入 npm 脚本' : '添加应用'} onClose={() => requestClose()}>
    <div className="my-run-config-manager">
      <header className="my-run-config-header"><h2 className="min-w-0 flex-1 text-my-lg font-semibold text-my-primary">运行配置</h2><button type="button" className="my-icon-control" aria-label="关闭应用配置" onClick={() => requestClose()}><X size={16} /></button></header>
      <div className="my-run-config-layout" hidden={notice !== null}>
        <aside className="my-run-config-sidebar" aria-label="运行配置列表">
          <div className="my-run-config-tools">
            <Tooltip label="添加程序配置"><button type="button" className="my-icon-control" aria-label="添加程序配置" disabled={busy} onClick={() => choose('new:argv')}><Plus size={15} /></button></Tooltip>
            <Tooltip label="导入 npm 脚本"><button type="button" className="my-icon-control" aria-label="添加 npm 配置" disabled={busy} onClick={() => choose('new:npm-script')}><PackagePlus size={15} /></button></Tooltip>
            <Tooltip label="删除当前配置"><button type="button" className="my-icon-control" aria-label="删除当前配置" disabled={!canDelete} onClick={() => entry.definition && showNotice({ kind: 'delete', definition: entry.definition })}><Trash2 size={15} /></button></Tooltip>
          </div>
          <div className="my-run-config-entries my-scrollbar">
            {GROUPS.map((group) => {
              const entries = rows.filter((row) => row.kind === group.kind)
              return entries.length > 0 && <section key={group.kind} aria-label={group.label}>
                <h3 className="px-2 py-2 text-my-xs font-medium text-my-tertiary">{group.label}</h3>
                {entries.map((row) => <button key={row.key} type="button" className={`my-run-config-entry ${selected === row.key ? 'is-selected' : ''}`} aria-label={`编辑配置 ${row.name}`} aria-pressed={selected === row.key} disabled={busy} onClick={() => choose(row.key)}>
                  <Terminal size={14} className="shrink-0" /><span className="min-w-0 flex-1 truncate" title={row.name}>{row.name}</span>{cache.current.get(row.key)?.dirty && <span aria-label="未保存" className="my-run-config-dirty">•</span>}
                </button>)}
              </section>
            })}
          </div>
        </aside>
        <div className="my-run-config-detail">
          {active && <p role="status" className="my-run-config-running text-my-xs text-my-secondary">请先停止并核验应用退出，再保存配置修改。</p>}
          <ApplicationConfigForm key={`${selected}:${entry.version}`} root={root} definition={entry.definition} npm={entry.npm} initialDraft={entry.draft} saveDisabled={active} onDraftChange={rememberDraft} onSavingChange={setSaving} onSaved={onSaved} onCancel={() => requestClose()} />
        </div>
      </div>
      {notice && <section className="my-run-config-notice" role="alertdialog" aria-label={notice.kind === 'discard' ? '未保存的运行配置' : '删除应用配置'}>
        <h3 className="text-my-md font-semibold text-my-primary">{notice.kind === 'discard' ? '还有未保存的配置' : `删除“${notice.definition.name}”？`}</h3>
        <p className="mt-2 text-my-sm text-my-secondary">{notice.kind === 'discard' ? '切换配置时已保留草稿。关闭此窗口会放弃这些未保存的更改。' : '只删除本机启动配置，不删除项目文件。'}</p>
        {error && <p role="alert" className="my-application-message mt-3 text-my-danger-text">{error}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button ref={noticeButton} type="button" className="my-control my-button-ghost" disabled={deleting} onClick={() => { setNotice(null); setError(null); setEscEpoch((value) => value + 1) }}>{notice.kind === 'discard' ? '继续编辑' : '取消'}</button>
          {notice.kind === 'discard' ? <Button variant="danger" onClick={() => close(notice.runId)}>放弃更改并关闭</Button> : <Button variant="danger" disabled={deleting} onClick={() => {
            const operation = ++request.current
            setDeleting(true)
            void removeApplication(notice.definition).then((failure) => {
              if (operation !== request.current) return
              if (failure) setError(failure)
              else { cache.current.delete(notice.definition.id); setSelected(state.apps.find((app) => app.definition.id !== notice.definition.id)?.definition.id ?? 'new:argv'); setNotice(null); setEscEpoch((value) => value + 1) }
            }).finally(() => { if (operation === request.current) setDeleting(false) })
          }}>删除</Button>}
        </div>
      </section>}
    </div>
  </Modal>
}
