import { useMemo, useState } from 'react'
import { Activity, Database, Eye, FileClock, History, Loader2, RefreshCw, ShieldQuestion } from 'lucide-react'
import { clsx } from 'clsx'
import { api } from '../api'
import { useApp } from '../store'
import { confirmDialog } from '../components/Dialogs'
import { fmtBytes, relTime } from '../utils/format'
import { EvidenceBadge } from './EvidenceBadge'
import { useMaterialCurrency, useObservationScope } from './use-observation-scope'
import {
  EVIDENCE_UNOBSERVED,
  MATERIAL_CURRENCY_LABELS,
  MATERIAL_OUTCOME_LABELS,
  evidenceWording,
  projectReceipts,
  shortDigest,
  type ReceiptMaterialView,
  type ReceiptView
} from '../../../shared/observability/receipt'
import { projectActivity, type ActivityColumnView, type ActivityInput } from '../../../shared/observability/activity'
import { observationHealthView, type ObservationHealthTone } from '../../../shared/observability/store'
import type { JSX } from 'react'

/**
 * ObservationPanel（S0 G3 第二片，design §6.3 / review/03 场景 B）：
 * 观察面板 = 上下文回执（最近一次摘要 + 历史折叠）+ 实际活动（分列）+ 观测健康与治理。
 * Tasks 工作区右侧辅助栏与 AcpConsole 会话侧复用同一组件。
 *
 * 措辞红线（design §3.3）：最高措辞「已输出至宿主通道」；不宣称宿主确认、模型已注入
 * 或规范已遵守；无记录默认「未观察到」（中性），未绑定/未知不标失败；只有明确
 * output_failed / 存储损坏才用错误色。材料只显示相对来源与摘要，无绝对路径。
 */

const OUTCOME_TONE: Record<ReceiptMaterialView['outcome'], string> = {
  included: 'text-leaf',
  truncated: 'text-amber-400',
  index_only: 'text-sky-300',
  missing: 'text-amber-400',
  unreadable: 'text-amber-400'
}

const HEALTH_TONE_DOT: Record<ObservationHealthTone, string> = {
  ok: 'bg-leaf',
  neutral: 'bg-mist-400',
  warn: 'bg-amber-400',
  error: 'bg-rose-400'
}

function bytesLabel(bytes: number | null): string {
  return bytes === null ? '未记录' : fmtBytes(bytes)
}

function MaterialRow({ material, compact }: { material: ReceiptMaterialView; compact: boolean }): JSX.Element {
  const currency = MATERIAL_CURRENCY_LABELS[material.currency]
  return (
    <div className={clsx('flex flex-wrap items-baseline gap-x-1.5', compact ? 'text-[10.5px]' : 'text-[11px]')}>
      <span className="min-w-0 flex-1 truncate font-mono text-mist-300" title={material.source}>
        {material.source}
      </span>
      <span className={clsx('shrink-0 font-medium', OUTCOME_TONE[material.outcome])}>{MATERIAL_OUTCOME_LABELS[material.outcome]}</span>
      <span className="shrink-0 font-mono text-[10px] text-mist-500">
        {material.includedBytes !== null ? `纳入 ${fmtBytes(material.includedBytes)}` : material.sourceBytes !== null ? `源 ${fmtBytes(material.sourceBytes)}` : ''}
      </span>
      {material.reason !== null && <span className="shrink-0 text-[10px] text-mist-500">（{material.reason}）</span>}
      {currency !== '' && (
        <span
          className={clsx(
            'shrink-0 text-[10px]',
            material.currency === 'changed' ? 'text-amber-300' : material.currency === 'same' ? 'text-mist-500' : 'text-mist-400'
          )}
          title="材料当时摘要与当前文件的核对结果"
        >
          · {currency}
        </span>
      )}
    </div>
  )
}

function ReceiptCard({ receipt, compact }: { receipt: ReceiptView; compact: boolean }): JSX.Element {
  const wording = evidenceWording(receipt.level)
  return (
    <div className={clsx('rounded-lg border border-ink-700/70 bg-ink-850/50 p-2.5', compact && 'p-2')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <EvidenceBadge level={receipt.level} />
        <span className="ml-auto shrink-0 font-mono text-[10px] text-mist-500" title={new Date(receipt.occurredAtMs).toLocaleString()}>
          {relTime(receipt.occurredAtMs)}
        </span>
      </div>
      <p className={clsx('mt-1.5 text-mist-400', compact ? 'text-[10px]' : 'text-[10.5px]')}>{wording.hint}</p>
      <div className={clsx('mt-1.5 flex flex-wrap gap-x-2 text-[10px] text-mist-500', compact && 'text-[9.5px]')}>
        <span title="事件来源（宿主 / Hook）">
          {receipt.host} · {receipt.hook} v{receipt.producerVersion}
        </span>
        {receipt.taskRef !== null && (
          <span className="font-mono" title="归属任务（绑定内稳定本机 ID）">
            任务 {receipt.taskRef.length > 22 ? `${receipt.taskRef.slice(0, 22)}…` : receipt.taskRef}
          </span>
        )}
        {receipt.session.parentId !== null && <span title="父会话">父会话已关联</span>}
        {receipt.session.childId !== null && <span title="子 Agent 会话">子会话已关联</span>}
        {receipt.session.runId !== null && <span title="ACP run">run 已关联</span>}
        {receipt.association === 'unresolved' && <span title="未能确定任务归属，保留未归属记录">任务未归属</span>}
        {receipt.paired && <span title="assembled 与 emitted 均已落账">配对完整</span>}
        {!receipt.paired && receipt.level === 'emitted' && <span title="assembled 记录缺失，emitted 仍为完整证据">缺组装记录（输出证据仍完整）</span>}
      </div>

      <div className={clsx('mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px] text-mist-400', compact && 'text-[9.5px]')}>
        <span title="组装后上下文 UTF-8 字节（含标题/提示文案）">上下文 {bytesLabel(receipt.totals.contextUtf8Bytes)}</span>
        <span title="宿主协议包装整体 stdout UTF-8 字节（最终序列化后可得）">输出包装 {bytesLabel(receipt.totals.stdoutUtf8Bytes)}</span>
        <span title="本次采集实际记录的材料条数">
          记录 {receipt.totals.recordedEntries} 条
          {receipt.totals.expectedEntries !== null ? ` / 预期 ${receipt.totals.expectedEntries}` : ' / 预期未知'}
        </span>
        {receipt.totals.budgetBytes !== null && <span title="宿主提供的字节预算">预算 {fmtBytes(receipt.totals.budgetBytes)}</span>}
      </div>

      {receipt.manifestIncomplete && (
        <div className="mt-1.5 rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-1 text-[10px] text-amber-300">
          清单不完整：遗漏 {receipt.totals.omittedEntries} 条（本次采集所列材料口径，不代表规范覆盖完整）
          {receipt.totals.expectedEntries === null && '；预期数量未知，不计算缺失率'}
        </div>
      )}

      {receipt.materials.length > 0 ? (
        <div className="mt-2 space-y-1">
          {receipt.materials.map((material) => (
            <MaterialRow key={`${receipt.injectionId}:${material.source}`} material={material} compact={compact} />
          ))}
        </div>
      ) : (
        receipt.totals.omittedEntries > 0 && (
          <div className="mt-1.5 text-[10px] text-mist-500">材料明细超编码预算未保留（汇总与遗漏数仍在）。</div>
        )
      )}

      {receipt.outputDigest !== null && (
        <div className="mt-1.5 font-mono text-[9.5px] text-mist-600" title="实际输出上下文字段 SHA-256（UI 缩写）">
          digest {shortDigest(receipt.outputDigest)}
        </div>
      )}
      {receipt.diagnosticCode !== null && (
        <div className="mt-1 font-mono text-[9.5px] text-mist-500">诊断码 {receipt.diagnosticCode}</div>
      )}
    </div>
  )
}

function ActivityColumns({ columns, compact }: { columns: ActivityColumnView[]; compact: boolean }): JSX.Element {
  return (
    <div className={clsx('space-y-2.5', compact && 'space-y-2')}>
      {columns.map((column) => (
        <div key={column.key}>
          <div className={clsx('mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-mist-500', compact && 'text-[9.5px]')}>
            <Activity size={10} />
            {column.label}
          </div>
          {column.entries.length === 0 ? (
            <div className={clsx('text-[10px] text-mist-600', compact && 'text-[9.5px]')}>暂无记录</div>
          ) : (
            <ul className="space-y-0.5">
              {column.entries.map((entry) => (
                <li key={entry.key} className={clsx('flex items-baseline gap-1.5 text-[10.5px] text-mist-300', compact && 'text-[10px]')}>
                  <span className="min-w-0 flex-1 break-words">{entry.text}</span>
                  {entry.atMs > 0 && (
                    <span className="shrink-0 font-mono text-[9.5px] text-mist-600" title={new Date(entry.atMs).toLocaleString()}>
                      {relTime(entry.atMs)}
                    </span>
                  )}
                  {entry.taskDir === null && column.key !== 'task-record' && (
                    <span className="shrink-0 text-[9.5px] text-mist-500" title="任务归属无法确定，保留未归属，不借当前选中任务补全">
                      未归属
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {column.note !== null && (
            <div className={clsx('mt-0.5 text-[9.5px] leading-relaxed text-mist-600', compact && 'text-[9px]')}>{column.note}</div>
          )}
        </div>
      ))}
    </div>
  )
}

/* ---------------- 健康与治理 ---------------- */

function HealthGovernance(): JSX.Element {
  const pushToast = useApp((s) => s.pushToast)
  const status = useApp((s) => s.observationStatus)
  const [busy, setBusy] = useState<'toggle' | 'retention' | 'all' | null>(null)

  const health = status?.health ?? null
  const binding = status?.binding ?? null
  const view = health !== null ? observationHealthView(health) : null

  const refresh = async (): Promise<void> => {
    const next = await api.observationHealth()
    if (next.ok === true) useApp.getState().observationSetStatus(next)
  }

  const toggle = async (): Promise<void> => {
    if (binding?.collectionEnabled == null) return
    setBusy('toggle')
    try {
      const res = await api.observationSetEnabled(!binding.collectionEnabled)
      if (res.ok === true) {
        await refresh()
        pushToast({ kind: 'success', title: binding.collectionEnabled ? '观测采集已停用' : '观测采集已启用' })
      } else {
        pushToast({ kind: 'error', title: '切换失败', body: res.error })
      }
    } finally {
      setBusy(null)
    }
  }

  const cleanup = async (mode: 'retention' | 'all'): Promise<void> => {
    if (mode === 'all') {
      const count = health?.logicalCount ?? 0
      const size = health !== null ? fmtBytes(health.logicalPayloadBytes) : '0 B'
      const ok = await confirmDialog({
        title: '清空观测记录？',
        message: `将删除本工作区全部观测事件（当前 ${count} 条、约 ${size}）。清理观测 ≠ 归档任务：任务文档、归档位置与来源关联均不受影响。此操作不可撤销。`,
        confirmText: '清空观测记录',
        danger: true
      })
      if (!ok) return
    }
    setBusy(mode)
    try {
      const res = await api.observationCleanup(mode)
      if (res.ok === true) {
        await refresh()
        if ('removed' in res) {
          pushToast({
            kind: 'success',
            title: '保留清理完成',
            body: `移除 ${res.removed} 条过期/超限记录${res.resumed ? '，采集已恢复' : ''}`
          })
        } else {
          pushToast({
            kind: 'success',
            title: '观测记录已清空',
            body: '旧游标已重置；回执将按「未观察到」重新开始'
          })
        }
      } else {
        pushToast({ kind: 'error', title: '清理失败', body: res.error })
      }
    } finally {
      setBusy(null)
    }
  }

  if (status === null) {
    return <div className="text-[10px] text-mist-600">正在读取观测健康状态…</div>
  }

  return (
    <div className="space-y-2">
      {view !== null && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', HEALTH_TONE_DOT[view.tone])} aria-hidden />
          <span className={clsx('font-medium', view.tone === 'error' ? 'text-rose-300' : view.tone === 'warn' ? 'text-amber-300' : 'text-mist-200')}>
            {view.label}
          </span>
          {binding?.bindingStatus === 'rebind_required' && (
            <span className="text-[10px] text-amber-300" title={binding.blockReason ?? undefined}>
              需重新绑定
            </span>
          )}
        </div>
      )}
      {view?.detail !== null && view !== null && <div className="text-[10px] leading-relaxed text-mist-500">{view.detail}</div>}

      {health !== null && (
        <div className="grid grid-cols-2 gap-x-2 font-mono text-[10px] text-mist-500">
          <span title="库＋sidecar 物理字节（软保护口径，非精确配额）">磁盘 {fmtBytes(health.physicalBytes)}</span>
          <span title="逻辑事件条数（保留策略口径）">事件 {health.logicalCount} 条</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {binding !== null && binding.collectionEnabled !== null && binding.bindingStatus === 'bound' && (
          <button
            type="button"
            className="btn-ghost px-2 py-0.5 text-[10.5px]"
            disabled={busy !== null}
            onClick={() => void toggle()}
            title={binding.collectionEnabled ? '停用后 Hook 不再落新记录；读取与清理不受影响' : '启用后恢复采集落账'}
          >
            {busy === 'toggle' ? <Loader2 size={11} className="animate-spin" /> : null}
            {binding.collectionEnabled ? '停用采集' : '启用采集'}
          </button>
        )}
        <button
          type="button"
          className="btn-ghost px-2 py-0.5 text-[10.5px]"
          disabled={busy !== null}
          onClick={() => void cleanup('retention')}
          title="按保留策略清理过期/超限记录（不换游标纪元）"
        >
          {busy === 'retention' ? <Loader2 size={11} className="animate-spin" /> : null}
          按保留策略清理
        </button>
        <button
          type="button"
          className="btn-ghost px-2 py-0.5 text-[10.5px] text-rose-300"
          disabled={busy !== null}
          onClick={() => void cleanup('all')}
          title="清空观测事件并重置游标纪元；清理观测 ≠ 归档任务"
        >
          {busy === 'all' ? <Loader2 size={11} className="animate-spin" /> : null}
          清空观测记录…
        </button>
      </div>
    </div>
  )
}

/* ---------------- 面板 ---------------- */

export interface ObservationPanelProps {
  /** 项目根（文档域 workspaceId；观测 scope 的绑定 workspaceId 由 hook 经 health 解析）。 */
  workspaceId: string
  /** 任务范围（`task:<id>` / `dir:<repo-relative-dir>`；缺省=工作区级）。 */
  taskRef?: string
  /** 活动投影输入（任务原值/文件变化/时间线事件/归档）；缺省不渲染活动区。 */
  activity?: ActivityInput
  /** compact = AcpConsole 侧窄形态。 */
  variant?: 'panel' | 'compact'
}

export function ObservationPanel({ workspaceId, taskRef, activity, variant = 'panel' }: ObservationPanelProps): JSX.Element {
  const compact = variant === 'compact'
  const scope = useObservationScope({ workspaceId, taskRef })
  const [showHistory, setShowHistory] = useState(false)

  // 材料核对（有界：仅最新回执的 file 来源）→ 带当前文件比对结果的回执投影
  const currentDigests = useMaterialCurrency(scope.receipts, workspaceId, taskRef)
  const receipts = useMemo(() => projectReceipts(scope.events, currentDigests), [scope.events, currentDigests])

  const latestView = receipts.receipts[0] ?? null
  const history = receipts.receipts.slice(1)
  const activityColumns = useMemo(() => (activity !== undefined ? projectActivity(activity) : null), [activity])

  const latestWording = latestView !== null ? evidenceWording(latestView.level) : EVIDENCE_UNOBSERVED

  return (
    <section
      className={clsx('rounded-lg border border-ink-700/70 bg-ink-900/60', compact ? 'p-2' : 'p-2.5')}
      aria-label="上下文回执与观察"
      data-observation-panel={scope.scopeKey}
    >
      <header className="flex items-center gap-1.5">
        <Eye size={12} className="shrink-0 text-leaf" />
        <span className={clsx('font-semibold text-mist-200', compact ? 'text-[11px]' : 'text-[11.5px]')}>观察 · 上下文回执</span>
        <span className="ml-auto">
          <EvidenceBadge level={latestView?.level} unobserved={latestView === null} size={compact ? 'sm' : 'md'} />
        </span>
      </header>

      {/* 状态行（未知/未绑定/连接中都是中性，不标失败） */}
      {scope.status === 'connecting' && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-mist-500">
          <Loader2 size={11} className="animate-spin" /> 正在连接观测存储…
        </div>
      )}
      {scope.status === 'closed' && (
        <div className="mt-1.5 text-[10.5px] leading-relaxed text-mist-500">
          本工作区未绑定观测（未观察到 ≠ 故障）。绑定与启用属显式操作，读取不依赖它。
        </div>
      )}
      {scope.status === 'error' && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[10.5px] text-amber-300">
          <ShieldQuestion size={11} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{scope.error ?? '观测读取失败'}</span>
          <button type="button" className="btn-ghost shrink-0 px-1.5 py-0.5 text-[10px]" onClick={scope.reload} title="重试连接">
            <RefreshCw size={10} /> 重试
          </button>
        </div>
      )}
      {scope.lastResetAtMs !== null && scope.status === 'live' && (
        <div className="mt-1.5 text-[10px] text-mist-500" title={new Date(scope.lastResetAtMs).toLocaleString()}>
          观测记录已重置（清理/重建），已按最新纪元重新拉取。
        </div>
      )}

      {/* 最近一次回执 */}
      {scope.status !== 'closed' && (
        <div className="mt-2">
          {latestView !== null ? (
            <ReceiptCard receipt={latestView} compact={compact} />
          ) : scope.status === 'live' ? (
            <div className="rounded-lg border border-dashed border-ink-600 p-2.5 text-center text-[10.5px] text-mist-500">
              未观察到注入记录（{latestWording.label}）。这不是故障证明；可在下方「健康与治理」检查观测配置。
            </div>
          ) : null}
        </div>
      )}

      {/* 历史折叠 */}
      {history.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded px-0.5 py-0.5 text-[10.5px] text-mist-400 transition-colors hover:text-mist-200"
            onClick={() => setShowHistory((v) => !v)}
            aria-expanded={showHistory}
          >
            <History size={11} />
            历史回执（{history.length} 次）
            <span className="ml-auto font-mono text-[9.5px] text-mist-600">{showHistory ? '收起' : '展开'}</span>
          </button>
          {showHistory && (
            <ul className="mt-1 space-y-1">
              {history.map((receipt) => (
                <li key={receipt.injectionId} className="flex items-center gap-1.5 text-[10.5px] text-mist-400">
                  <EvidenceBadge level={receipt.level} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-mist-600">
                    {receipt.host} · {receipt.materials.length} 材料{receipt.manifestIncomplete ? ` · 遗漏 ${receipt.totals.omittedEntries}` : ''}
                  </span>
                  <span className="shrink-0 font-mono text-[9.5px] text-mist-600" title={new Date(receipt.occurredAtMs).toLocaleString()}>
                    {relTime(receipt.occurredAtMs)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 实际活动（分列；不含回执，不升级阶段） */}
      {activityColumns !== null && (
        <div className={clsx('mt-3 border-t border-ink-700/60 pt-2.5', compact && 'mt-2 pt-2')}>
          <div className={clsx('mb-1.5 flex items-center gap-1.5 font-semibold text-mist-200', compact ? 'text-[11px]' : 'text-[11.5px]')}>
            <FileClock size={12} className="shrink-0 text-leaf" /> 实际活动
          </div>
          <ActivityColumns columns={activityColumns.columns} compact={compact} />
        </div>
      )}

      {/* 健康与治理 */}
      <details className={clsx('mt-3 border-t border-ink-700/60 pt-2', compact && 'mt-2')}>
        <summary className={clsx('flex cursor-pointer select-none items-center gap-1.5 text-[10.5px] font-medium text-mist-400 hover:text-mist-200', compact && 'text-[10px]')}>
          <Database size={11} /> 观测健康与治理
        </summary>
        <div className="mt-2">
          <HealthGovernance />
        </div>
      </details>
    </section>
  )
}
