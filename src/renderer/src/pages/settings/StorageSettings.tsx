import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { api, hasIpc } from '../../api'
import { confirmDialog } from '../../components/Dialogs'
import { Button } from '../../my/ui'
import { ConversationArchiveManager } from '../../conversation-workbench/ConversationArchiveManager'
import { useInteractionSignal } from '../../utils/interaction-scope'
import { PreferenceRow, PreferenceSection } from './PreferenceSection'
import type { StorageCacheId, StorageCleanItem, StorageScanResult } from '../../../../shared/storage'

const CACHE_CONTENT: Record<StorageCacheId, { label: string; hint: string }> = {
  'electron-session': { label: '界面缓存', hint: '应用界面加载时产生的缓存，清理后会按需重新获取。' },
  'model-catalog': { label: '模型目录缓存', hint: '清理后需重新获取模型目录；离线时可能无法使用本地回退。' },
  zcode: { label: '引擎启动缓存', hint: '用于准备 ZCode 启动。' }
}

function sizeLabel(bytes: number | null): string {
  if (bytes === null) return '无法统计'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function resultLabel(item: StorageCleanItem): string {
  const label = CACHE_CONTENT[item.id].label
  if (item.status === 'cleaned') return `${label}：已清理${item.bytesFreed === null ? '' : `（${sizeLabel(item.bytesFreed)}）`}`
  const status = item.status === 'failed' ? '清理失败' : item.status === 'skipped' ? '已跳过' : '暂不可清理'
  return `${label}：${status}${item.reason ? `，${item.reason}` : ''}`
}

export function StorageSettings(): JSX.Element {
  const [archiveOpen, setArchiveOpen] = useState(false)
  const bridge = hasIpc && typeof api.storage?.scan === 'function' ? api.storage : null
  const [scan, setScan] = useState<StorageScanResult | null>(null)
  const [selected, setSelected] = useState<StorageCacheId[]>([])
  const [busy, setBusy] = useState<'scan' | 'clean' | 'open' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<StorageCleanItem[]>([])
  const mounted = useRef(false)
  const pending = useRef(false)
  const signal = useInteractionSignal()

  const refresh = useCallback(async (): Promise<void> => {
    if (!bridge || pending.current) return
    pending.current = true
    setBusy('scan'); setError(null)
    try {
      const next = await bridge.scan()
      if (!mounted.current) return
      if (next.busy) { setError('存储操作正在进行，请稍后重试。'); return }
      setScan(next); setSelected([])
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pending.current = false; if (mounted.current) setBusy(null) }
  }, [bridge])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])

  const openDirectory = async (): Promise<void> => {
    if (!bridge || pending.current) return
    pending.current = true; setBusy('open'); setError(null)
    try {
      const result = await bridge.openDataDirectory()
      if (mounted.current && !result.ok) setError(result.error || '无法打开应用数据目录。')
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pending.current = false; if (mounted.current) setBusy(null) }
  }

  const clean = async (): Promise<void> => {
    if (!bridge || pending.current || selected.length === 0) return
    const ids = [...selected]
    pending.current = true; setBusy('clean'); setError(null)
    try {
      const names = ids.map(id => CACHE_CONTENT[id].label).join('、')
      const confirmed = await confirmDialog({ title: '清理选中的缓存？', message: `将清理：${names}。\n${ids.includes('model-catalog') ? '模型目录的离线回退也会被移除。\n' : ''}清理后部分内容需要重新获取。`, confirmText: '确认清理', danger: true }, signal)
      if (!confirmed || !mounted.current || signal?.aborted) return
      const result = await bridge.clean({ ids, includeModelCatalog: ids.includes('model-catalog') })
      if (!mounted.current) return
      if (result.busy) { setError('存储操作正在进行，请稍后重试。'); return }
      setResults(result.items); setSelected([])
      const next = await bridge.scan()
      if (!mounted.current) return
      if (next.busy) setError('清理完成，存储状态尚未刷新，请重试。')
      else setScan(next)
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pending.current = false; if (mounted.current) setBusy(null) }
  }

  const archiveManagement = <>
    <PreferenceSection id="storage-data" title="数据管理">
      <PreferenceRow label="归档会话" hint="读取或恢复已归档的会话。">
        <Button size="sm" variant="outline" onClick={() => setArchiveOpen(true)}>管理归档</Button>
      </PreferenceRow>
      <PreferenceRow label="任务观测" hint="在对应任务的详情中查看和管理观测记录。"><span className="text-my-sm text-my-secondary">任务详情</span></PreferenceRow>
    </PreferenceSection>
    <ConversationArchiveManager open={archiveOpen} onClose={() => setArchiveOpen(false)} />
  </>

  if (!bridge) return <div className="preferences-page"><PreferenceSection id="storage-unavailable" title="存储空间"><p className="my-item-description py-4">本机存储服务暂不可用。</p></PreferenceSection>{archiveManagement}</div>

  return <div className="preferences-page">
    <PreferenceSection id="storage-usage" title="本机存储">
      <PreferenceRow label="应用数据占用" hint={scan?.dataIncomplete ? '统计不完整，仅显示已读取的文件；项目目录不包含在内。' : '应用数据目录内的文件大小，不包含项目目录。'}>
        <span role="status" className="text-my-sm text-my-secondary">{!scan ? (busy === 'scan' ? '正在统计…' : '尚未统计') : scan.dataBytes === null ? '无法统计' : `${scan.dataIncomplete ? '已统计 ' : ''}${sizeLabel(scan.dataBytes)}`}</span>
      </PreferenceRow>
    </PreferenceSection>
    <PreferenceSection id="storage-location" title="数据目录">
      <PreferenceRow label="应用数据" hint={scan?.userDataPath ?? (busy === 'scan' ? '正在读取目录…' : '目录暂不可用')}>
        <Button size="sm" variant="outline" disabled={Boolean(busy) || !scan} onClick={() => void openDirectory()}><FolderOpen size={14} />打开目录</Button>
      </PreferenceRow>
    </PreferenceSection>
    <PreferenceSection id="storage-cache" title="缓存清理" action={<Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={14} />{busy === 'scan' ? '扫描中…' : '重新扫描'}</Button>}>
      {!scan && <p className="py-4 text-my-sm text-my-tertiary">{busy === 'scan' ? '正在扫描可清理缓存…' : '扫描后查看缓存。'}</p>}
      {scan?.items.map(item => {
        const content = CACHE_CONTENT[item.id]
        const checked = selected.includes(item.id)
        return <PreferenceRow key={item.id} label={content.label} hint={<>{content.hint}{item.reason && <> {item.reason}</>}</>}>
          <span className="text-my-sm text-my-secondary">{item.status === 'available' ? sizeLabel(item.bytes) : item.status === 'error' ? '读取失败' : '暂不可清理'}</span>
          <label className="text-my-sm text-my-secondary"><input type="checkbox" aria-label={`选择${content.label}`} checked={checked} disabled={Boolean(busy) || item.status !== 'available' || item.bytes === 0} onChange={event => { const enabled = event.target.checked; setSelected(previous => enabled ? [...previous, item.id] : previous.filter(id => id !== item.id)) }} />选择</label>
        </PreferenceRow>
      })}
      {scan && <div className="preference-actions"><span className="my-item-description mr-auto">扫描不会删除文件。</span><Button size="sm" variant="outline" disabled={Boolean(busy) || selected.length === 0} onClick={() => void clean()}>{busy === 'clean' ? '处理中…' : '清理所选'}</Button></div>}
    </PreferenceSection>
    {error && <p role="alert" className="text-my-sm text-my-danger-text">{error}</p>}
    {results.length > 0 && <PreferenceSection id="storage-result" title="清理结果"><ul className="space-y-2 py-4 text-my-sm text-my-secondary" aria-live="polite">{results.map(item => <li key={item.id}>{resultLabel(item)}</li>)}</ul></PreferenceSection>}
    {archiveManagement}
  </div>
}
