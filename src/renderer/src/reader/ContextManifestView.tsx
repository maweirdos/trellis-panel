import type { JSX } from 'react'
import { FolderOpen, FileText, FileQuestion, FileX2 } from 'lucide-react'
import { clsx } from 'clsx'
import type { ContextManifestParsed, ManifestEntry, ManifestReadability } from '../../../shared/documents'

/**
 * ContextManifestView（S0 G2，design §6.1/PRD FR1）：上下文清单条目视图——
 * 材料路径、用途、顺序（真实行号）、条目形态与当前可读性。
 * 语义红线：present 只说明文件存在，不代表已执行/已使用/已注入；
 * 未知（unknown）用中性色，不是错误态；无任何执行时间语义。
 */

const READABILITY_VIEW: Record<ManifestReadability['status'], { label: string; cls: string; icon: typeof FileText }> = {
  present: { label: '存在', cls: 'bg-my-success-subtle text-my-success-text border border-my-line-success', icon: FileText },
  missing: { label: '缺失', cls: 'bg-my-warning-subtle text-my-warning-text border border-my-line-warning', icon: FileX2 },
  unknown: { label: '未知', cls: 'bg-my-layer-2 text-my-secondary border border-my-line-strong', icon: FileQuestion }
}

function ReadabilityBadge({ readability }: { readability: ManifestReadability }): JSX.Element {
  const view = READABILITY_VIEW[readability.status]
  const Icon = view.icon
  return (
    <span className={clsx('my-chip', view.cls)}>
      <Icon size={11} />
      {view.label}
      {readability.status === 'present' && readability.sizeBytes !== null && (
        <span className="font-mono opacity-70">{readability.sizeBytes}B</span>
      )}
    </span>
  )
}

function ManifestRow({ entry }: { entry: ManifestEntry }): JSX.Element {
  return (
    <tr className="border-b border-my-line last:border-b-0">
      <td className="px-2 py-1.5 text-right font-mono text-my-xs text-my-secondary select-none">{entry.line}</td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          {entry.type === 'directory' ? (
            <FolderOpen size={13} className="shrink-0 text-my-icon-secondary" />
          ) : (
            <FileText size={13} className="shrink-0 text-my-icon-secondary" />
          )}
          <span className="break-all font-mono text-my-sm text-my-primary">{entry.file}</span>
        </div>
        {entry.reason !== null && (
          <p className="mt-0.5 text-my-xs leading-4 text-my-tertiary">{entry.reason}</p>
        )}
      </td>
      <td className="px-2 py-1.5 text-my-xs text-my-secondary">{entry.type ?? '—'}</td>
      <td className="px-2 py-1.5">
        <ReadabilityBadge readability={entry.readability} />
      </td>
    </tr>
  )
}

const MANIFEST_NOTE = '本清单是计划里列出的材料与用途，不代表已经组装或输出；可读性是对磁盘文件的当前观察。'

export function ContextManifestView({ parsed }: { parsed: ContextManifestParsed }): JSX.Element {
  const totals = parsed.totals
  return (
    <div className="space-y-3">
      <p className="text-my-sm text-my-tertiary">{MANIFEST_NOTE}</p>
      <div className="overflow-x-auto rounded-my-lg border border-my-line">
        <table className="min-w-full w-max border-collapse text-left text-my-sm">
          <thead>
            <tr className="border-b border-my-line bg-my-layer-1 text-my-xs font-semibold tracking-wide text-my-secondary">
              <th className="w-12 px-2 py-2 text-right">行号</th>
              <th className="px-2 py-2">材料 / 用途</th>
              <th className="w-16 px-2 py-2">形态</th>
              <th className="w-32 px-2 py-2">可读性</th>
            </tr>
          </thead>
          <tbody>
            {parsed.entries.map((entry) => (
              <ManifestRow key={`${entry.line}-${entry.file}`} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-my-xs text-my-secondary">
        共 {totals.entries} 条 · 坏行 {totals.badLines} 行（见上方诊断，保留原始行号） · 空行 {totals.blankLines} 行（不改编号）
      </p>
    </div>
  )
}
