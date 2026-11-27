import { useMemo, useState, type JSX } from 'react'
import { AlertCircle, Check, ChevronDown, ChevronRight, Monitor, MoreHorizontal, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import type { CruxRuntimeKind } from '@shared/crux'
import type { AcpAgentStatus } from '../../../shared/types'
import { api, hasIpc } from '../api'
import { publishRuntimeInventorySnapshot } from '../acp/useRuntimeInventoryRefresh'
import { ToolBrandIcon } from '../components/ToolBrandIcon'
import { Dropdown, DropdownDivider, DropdownHeader } from '../my/ui'
import type { CustomRuntimeConfig } from './collaboration-platform-store'
import {
  resolveRuntimeBrandId,
  resolveRuntimeDisplayName,
  toCruxRuntimeKind
} from './local-execution-slot'

interface RuntimeOptionItem {
  id: string
  runtimeKind: CruxRuntimeKind
  label: string
  brandId: string
  available: boolean
  setupRequired: boolean
  health?: AcpAgentStatus['health']
  version?: string
  isCustom?: boolean
  customId?: string
}

const CORE_RUNTIMES: ReadonlyArray<{ id: string; runtimeKind: CruxRuntimeKind; label: string; brandId: string }> = [
  { id: 'codex', runtimeKind: 'codex', label: 'Codex', brandId: 'codex' },
  { id: 'claude-code', runtimeKind: 'claude-code', label: 'Claude Code', brandId: 'claude-code' },
  { id: 'pi', runtimeKind: 'custom', label: 'Pi', brandId: 'pi' }
]

/**
 * 1:1 复刻 HiFox 图 6 分组 Runtime 选择器：
 * - 数据 100% 来自主进程 api.acpAgents() / api.acpRuntimeRefresh() 对本机 CLI 与内置引擎的真实扫描
 * - 触发按钮与列表项逐行使用各自官方彩色品牌图标，支持一键现场重新探测
 */
export function RuntimePicker({
  valueKind,
  valueRuntimeId,
  customRuntimeId,
  detectedRuntimes,
  customRuntimes = [],
  machineName,
  onSelect,
  onOpenMore,
  fullWidth = false
}: {
  valueKind: CruxRuntimeKind
  valueRuntimeId?: string
  customRuntimeId?: string
  detectedRuntimes: readonly AcpAgentStatus[]
  customRuntimes?: readonly CustomRuntimeConfig[]
  machineName: string
  onSelect: (next: { runtimeKind: CruxRuntimeKind; runtimeId: string; customRuntimeId?: string }) => void
  onOpenMore?: () => void
  fullWidth?: boolean
}): JSX.Element {
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async (): Promise<void> => {
    if (!hasIpc || refreshing) return
    setRefreshing(true)
    try {
      const reply = await api.acpRuntimeRefresh()
      if (reply.ok && reply.agents) publishRuntimeInventorySnapshot(reply.agents)
    } finally {
      setRefreshing(false)
    }
  }

  const options = useMemo<RuntimeOptionItem[]>(() => {
    const map = new Map<string, RuntimeOptionItem>()
    for (const core of CORE_RUNTIMES) {
      map.set(core.id, {
        ...core,
        available: false,
        setupRequired: false
      })
    }
    for (const rt of detectedRuntimes) {
      if (rt.launchKind === 'custom') continue
      const id = rt.runtimeId || rt.id
      const normalizedId = id === 'claude' ? 'claude-code' : id
      const existing = map.get(normalizedId)
      map.set(normalizedId, {
        id: normalizedId,
        runtimeKind: toCruxRuntimeKind(normalizedId),
        label: rt.name || existing?.label || normalizedId,
        brandId: normalizedId,
        available: Boolean(rt.available),
        setupRequired: Boolean(rt.setupRequired),
        health: rt.health,
        version: rt.adapterVersion
      })
    }
    for (const custom of customRuntimes) {
      if (custom.archived) continue
      map.set(`custom:${custom.id}`, {
        id: `custom:${custom.id}`,
        runtimeKind: custom.base === 'acp' ? 'custom' : custom.base,
        label: custom.displayName,
        brandId: custom.base === 'acp' ? 'pi' : custom.base,
        available: true,
        setupRequired: false,
        health: 'ready',
        isCustom: true,
        customId: custom.id
      })
    }
    return [...map.values()].sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1
      return 0
    })
  }, [detectedRuntimes, customRuntimes])

  const activeBrandId = resolveRuntimeBrandId({ runtimeKind: valueKind, runtimeId: valueRuntimeId })
  const activeCustom = customRuntimeId ? customRuntimes.find((c) => c.id === customRuntimeId && !c.archived) : undefined
  const activeLabel = activeCustom?.displayName ?? resolveRuntimeDisplayName({ runtimeKind: valueKind, runtimeId: valueRuntimeId }, detectedRuntimes)
  const activeOption = options.find((opt) =>
    customRuntimeId ? opt.customId === customRuntimeId : opt.id === activeBrandId
  )
  const isHealthError = (h?: AcpAgentStatus['health']): boolean =>
    h === 'launch_error' || h === 'incompatible' || h === 'directory_unavailable'
  const isOnline = Boolean(activeOption ? activeOption.available && !activeOption.setupRequired && !isHealthError(activeOption.health) && activeOption.health !== 'auth_required' : true)

  return (
    <Dropdown
      align="right"
      width={304}
      trigger={({ toggle, open }) => (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className={`collab-runtime-trigger ${fullWidth ? 'w-full' : 'max-w-[240px]'}`}
        >
          <ToolBrandIcon brand={activeBrandId} size={15} />
          <span className="shrink-0 font-medium text-my-primary">{activeLabel}</span>
          <span className="min-w-0 flex-1 truncate text-my-xs text-my-tertiary">{machineName}</span>
          {isOnline ? (
            <Wifi size={13} className="shrink-0 text-my-success-text" />
          ) : (
            <WifiOff size={13} className="shrink-0 text-my-tertiary" />
          )}
          <ChevronDown size={13} className="shrink-0 text-my-tertiary" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center justify-between px-2 pt-1 pb-0.5">
            <span className="text-my-sm font-semibold text-my-primary">选择 Runtime</span>
            {hasIpc && (
              <button
                type="button"
                title="重新探测本机已安装的 Runtime"
                aria-label="重新探测本机 Runtime"
                onClick={() => void handleRefresh()}
                className="grid h-6 w-6 place-items-center rounded-my-base text-my-icon-secondary transition-colors hover:bg-my-layer-2 hover:text-my-primary"
              >
                <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
              </button>
            )}
          </div>
          <DropdownHeader>我的</DropdownHeader>

          {/* 本机分组标题 */}
          <div className="flex items-center justify-between gap-2 px-2 py-1 text-my-xs font-medium text-my-primary">
            <span className="inline-flex min-w-0 items-center gap-2">
              <Monitor size={14} className="shrink-0 text-my-icon-secondary" />
              <span className="truncate">{machineName} (本机)</span>
            </span>
            <Wifi size={13} className="shrink-0 text-my-success-text" />
          </div>

          {/* 真实引擎列表（复用统一 .my-menu-item 规范：30px 行高、13px 字号、统一 9% 悬停反馈） */}
          <div className="collab-scroll flex max-h-64 flex-col gap-0.5 pl-1">
            {options.map((opt) => {
              const selected = customRuntimeId
                ? opt.customId === customRuntimeId
                : !opt.isCustom && opt.id === activeBrandId
              const hasError = isHealthError(opt.health)
              const needsAuth = opt.health === 'auth_required'
              const healthy = opt.available && !opt.setupRequired && !hasError && !needsAuth
              const statusTitle = !opt.available
                ? '本机 PATH 未检测到可执行程序'
                : opt.setupRequired
                  ? '已检测到安装，需完成初始化配置'
                  : needsAuth
                    ? '已检测到安装，需完成账号登录授权'
                    : hasError
                      ? '连通性检查异常，请前往 Runtime 设置查看诊断'
                      : opt.health === 'ready'
                        ? `已实测就绪${opt.version ? ` (${opt.version})` : ''}`
                        : `已检测到本机安装${opt.version ? ` (${opt.version})` : ''}`
              return (
                <button
                  key={opt.id}
                  type="button"
                  title={statusTitle}
                  data-selected={selected || undefined}
                  onClick={() => {
                    close()
                    onSelect({
                      runtimeKind: opt.runtimeKind,
                      runtimeId: opt.isCustom ? opt.brandId : opt.id,
                      customRuntimeId: opt.customId
                    })
                  }}
                  className="my-menu-item"
                >
                  <span className="grid h-4 w-4 shrink-0 place-items-center">
                    {selected && (
                      <span className="grid h-4 w-4 place-items-center rounded-full bg-my-success text-my-on-color">
                        <Check size={10} strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <ToolBrandIcon brand={opt.brandId} size={15} />
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {healthy ? (
                    <Wifi size={13} className="shrink-0 text-my-success-text" />
                  ) : hasError ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-my-2xs text-my-danger-text">
                      <AlertCircle size={12} />
                      <span>异常</span>
                    </span>
                  ) : opt.available ? (
                    <span className="shrink-0 text-my-2xs text-my-warning-text">待验证</span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 text-my-2xs text-my-tertiary">
                      <span>未检测到</span>
                      <WifiOff size={12} />
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {onOpenMore && (
            <>
              <DropdownDivider />
              <button
                type="button"
                onClick={() => {
                  close()
                  onOpenMore()
                }}
                className="my-menu-item"
              >
                <span className="my-menu-icon"><MoreHorizontal size={14} /></span>
                <span className="min-w-0 flex-1 text-left text-my-secondary">更多 Runtime</span>
                <span className="inline-flex items-center gap-1">
                  <ToolBrandIcon brand="claude-code" size={13} />
                  <ToolBrandIcon brand="codex" size={13} />
                  <ToolBrandIcon brand="gemini-cli" size={13} />
                </span>
                <ChevronRight size={13} className="shrink-0 text-my-tertiary" />
              </button>
            </>
          )}
        </>
      )}
    </Dropdown>
  )
}
