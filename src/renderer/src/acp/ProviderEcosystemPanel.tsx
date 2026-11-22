import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api, hasIpc } from '../api'
import { Button, EmptyState, SearchInput, Switch } from '../my/ui'
import type { AcpCapabilityMatrixItem, AcpLocalProviderRecord, AcpRegistryCatalogState } from '../../../shared/acp-provider-ecosystem'

type Draft = { id?: string; name: string; agentId: string; executable: string; argv: string; env: string; enabled: boolean }

const emptyDraft: Draft = { name: '', agentId: '', executable: '', argv: '', env: '', enabled: true }
const capabilityLabel: Record<AcpCapabilityMatrixItem['key'], string> = { protocolVersion: '协议版本', loadSession: '会话恢复', imageInput: '图片输入', embeddedContext: '嵌入上下文', mcp: 'MCP' }
const evidenceLabel: Record<AcpCapabilityMatrixItem['status'], string> = { 'registry-declared': '目录声明', negotiated: '握手确认', unknown: '未知' }

function parseDraft(draft: Draft): Record<string, unknown> {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    agentId: draft.agentId.trim(),
    executable: draft.executable.trim(),
    argv: draft.argv.split('\n').map(value => value.trim()).filter(Boolean),
    env: draft.env.split('\n').map(line => line.split('=', 2)).filter((parts): parts is [string, string] => parts.length === 2)
      .map(([key, value]) => ({ key: key.trim(), value })),
    enabled: draft.enabled
  }
}

function serializeProvider(provider: AcpLocalProviderRecord): Draft {
  return { id: provider.id, name: provider.name, agentId: provider.agentId, executable: provider.executable,
    argv: provider.argv.join('\n'), env: provider.env.map(item => `${item.key}=${item.value}`).join('\n'), enabled: provider.enabled }
}

export function ProviderEcosystemPanel(): JSX.Element {
  const [catalog, setCatalog] = useState<AcpRegistryCatalogState | null>(null)
  const [providers, setProviders] = useState<AcpLocalProviderRecord[]>([])
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [matrix, setMatrix] = useState<Record<string, AcpCapabilityMatrixItem[]>>({})

  const reload = useCallback(async (refresh = false) => {
    if (!hasIpc) return
    setBusy(refresh ? 'catalog' : 'load')
    try {
      const [nextCatalog, nextProviders] = await Promise.all([api.acpRegistryList(refresh), api.acpLocalProviderList()])
      setCatalog(nextCatalog)
      setProviders(nextProviders.providers)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy('') }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const searchResults = useMemo(() => {
    const agents = catalog?.agents ?? []
    if (!query.trim()) return agents
    const terms = query.trim().toLowerCase().split(/\s+/)
    return agents.filter(agent => terms.every(term => `${agent.id}\n${agent.name}\n${agent.description}`.toLowerCase().includes(term)))
  }, [catalog?.agents, query])

  const save = async (): Promise<void> => {
    setBusy('save')
    setError('')
    try {
      const result = await api.acpLocalProviderSave(parseDraft(draft))
      if (!('provider' in result)) throw new Error(result.error ?? '保存失败')
      setDraft(emptyDraft)
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy('') }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const result = await api.acpLocalProviderDelete(id)
      if (!result.ok) throw new Error(result.error ?? '删除失败')
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy('') }
  }

  const inspect = async (runtimeId: string): Promise<void> => {
    setBusy(`matrix-${runtimeId}`)
    try { const result = await api.acpProviderCapabilities(runtimeId); setMatrix(current => ({ ...current, [runtimeId]: result.matrix })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy('') }
  }

  return <div className="preferences-page space-y-4">
    <section className="rounded-my-md border border-my-line bg-my-panel p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="my-item-title text-my-lg">ACP Registry</h2>
          <p className="my-item-description">{catalog ? `${catalog.stale ? '缓存' : '在线'} · ${catalog.indexVersion ?? '未知版本'} · ${catalog.agents.length} 项` : '目录未加载'}</p>
        </div>
        <Button size="sm" variant="outline" disabled={busy === 'catalog'} onClick={() => void reload(true)}>
          <RefreshCw size={14} aria-hidden />{busy === 'catalog' ? '刷新中…' : '刷新'}
        </Button>
      </div>
      <SearchInput className="mt-3" value={query} onChange={setQuery} placeholder="搜索官方目录" ariaLabel="搜索官方 ACP Registry 目录" />
      <div className="mt-3 divide-y divide-my-line">
        {searchResults.map(agent => <div key={agent.id} className="grid gap-1 py-3">
          <div className="flex items-center gap-2"><span className="my-item-title">{agent.name}</span><code className="text-my-xs text-my-tertiary">{agent.id}@{agent.version}</code></div>
          <p className="my-item-description line-clamp-2">{agent.description}</p>
          <p className="text-my-xs text-my-tertiary">{agent.license ?? '许可证未声明'}{agent.distribution.binary ? ' · 二进制分发' : agent.distribution.npx || agent.distribution.uvx ? ' · 包分发' : ' · 分发信息未知'}</p>
        </div>)}
        {!searchResults.length && <p className="py-4 text-my-sm text-my-tertiary">暂无匹配目录项</p>}
      </div>
    </section>

    <section className="rounded-my-md border border-my-line bg-my-panel p-4">
      <h2 className="my-item-title text-my-lg">本地 Provider</h2>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <label className="grid gap-1 text-my-sm text-my-secondary" htmlFor="provider-name">名称<input id="provider-name" className="my-input" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="grid gap-1 text-my-sm text-my-secondary" htmlFor="provider-agent">Provider ID<input id="provider-agent" className="my-input font-mono" value={draft.agentId} onChange={event => setDraft({ ...draft, agentId: event.target.value })} /></label>
        <label className="grid gap-1 text-my-sm text-my-secondary md:col-span-2" htmlFor="provider-executable">可执行文件绝对路径<input id="provider-executable" className="my-input font-mono" value={draft.executable} onChange={event => setDraft({ ...draft, executable: event.target.value })} /></label>
        <label className="grid gap-1 text-my-sm text-my-secondary" htmlFor="provider-argv">固定参数（每行一个）<textarea id="provider-argv" className="my-input font-mono" rows={3} value={draft.argv} onChange={event => setDraft({ ...draft, argv: event.target.value })} /></label>
        <label className="grid gap-1 text-my-sm text-my-secondary" htmlFor="provider-env">环境变量（每行 NAME=value）<textarea id="provider-env" className="my-input font-mono" rows={3} value={draft.env} onChange={event => setDraft({ ...draft, env: event.target.value })} /></label>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Switch label="启用本地 provider" checked={draft.enabled} onChange={enabled => setDraft({ ...draft, enabled })} />
        <Button size="sm" disabled={busy === 'save' || !draft.name || !draft.agentId || !draft.executable} onClick={() => void save()}>
          <Plus size={14} aria-hidden />{draft.id ? '重新保存' : '添加'}
        </Button>
        {draft.id && <Button size="sm" variant="ghost" onClick={() => setDraft(emptyDraft)}>取消编辑</Button>}
      </div>
      {error && <p role="alert" className="mt-2 text-my-sm text-my-danger-text">{error}</p>}
      <div className="mt-4 divide-y divide-my-line">
        {providers.map(provider => <div key={provider.id} className="grid gap-2 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="my-item-title">{provider.name}</span>
            <code className="text-my-xs text-my-tertiary">{provider.agentId}</code>
            <span className="text-my-xs text-my-tertiary">{provider.enabled ? '已启用' : '已停用'}</span>
            <span className="flex-1" />
            <Button size="sm" variant="ghost" disabled={busy === `matrix-${provider.id}`} onClick={() => void inspect(provider.id)}>能力矩阵</Button>
            <Button size="sm" variant="ghost" onClick={() => setDraft(serializeProvider(provider))}>编辑</Button>
            <Button size="sm" variant="ghost" aria-label={`删除 ${provider.name}`} disabled={busy === provider.id} onClick={() => void remove(provider.id)}><Trash2 size={14} aria-hidden /></Button>
          </div>
          <p className="my-item-description break-all font-mono text-my-xs">{provider.executable} {provider.argv.join(' ')}</p>
          {matrix[provider.id] && <dl className="grid gap-2 rounded-my-sm bg-[var(--my-bg-canvas)] p-3 sm:grid-cols-2">
            {matrix[provider.id].map(item => <div key={item.key} className="flex items-center justify-between gap-2">
              <dt className="my-item-title text-my-sm">{capabilityLabel[item.key]}</dt><dd className="text-my-xs text-my-tertiary">{item.negotiated ?? (item.registry ? `${item.registry} · ` : '') + evidenceLabel[item.status]}</dd>
            </div>)}
          </dl>}
        </div>)}
        {!providers.length && <EmptyState title="暂无本地 provider" description="添加本机已安装的 ACP 可执行文件后，仍需显式检查连接。" />}
      </div>
    </section>
  </div>
}
