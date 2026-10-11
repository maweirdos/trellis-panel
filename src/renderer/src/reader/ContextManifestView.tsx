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
  present: { label: '存在', cls: 'bg-emerald-50 text-emerald-800 border border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30', icon: FileText },
  missing: { label: '缺失', cls: 'bg-amber-50 text-amber-800 border border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30', icon: FileX2 },
  unknown: { label: '未知', cls: 'bg-ink-100 text-mist-600 border border-ink-300 dark:bg-ink-700 dark:text-mist-300 dark:border-ink-500', icon: FileQuestion }
}

function ReadabilityBadge({ readability }: { readability: ManifestReadability }): JSX.Element {
  const view = READABILITY_VIEW[readability.status]
  const Icon = view.icon
  return (
    <span className={clsx('chip inline-flex items-center gap-1 text-[10.5px]', view.cls)}>
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
    <tr className="border-b border-ink-100 last:border-b-0 dark:border-ink-700/60">
      <td className="px-2 py-1.5 text-right font-mono text-[11px] text-mist-400 select-none">{entry.line}</td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          {entry.type === 'directory' ? (
            <FolderOpen size={13} className="shrink-0 text-mist-400" />
          ) : (
            <FileText size={13} className="shrink-0 text-mist-400" />
          )}
          <span className="break-all font-mono text-[12px] text-slate-700 dark:text-mist-200">{entry.file}</span>
        </div>
        {entry.reason !== null && (
          <p className="mt-0.5 text-[11.5px] leading-4 text-mist-500">{entry.reason}</p>
        )}
      </td>
      <td className="px-2 py-1.5 text-[11px] text-mist-400">{entry.type ?? '—'}</td>
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
      <p className="text-[12px] text-mist-500">{MANIFEST_NOTE}</p>
      <div className="overflow-x-auto rounded-lg border border-ink-200 dark:border-ink-700">
        <table className="min-w-full w-max border-collapse text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50/80 text-[11px] font-semibold tracking-wide text-mist-500 dark:border-ink-700 dark:bg-ink-850/60 dark:text-mist-300">
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
      <p className="text-[11px] text-mist-400">
        共 {totals.entries} 条 · 坏行 {totals.badLines} 行（见上方诊断，保留原始行号） · 空行 {totals.blankLines} 行（不改编号）
      </p>
    </div>
  )
}
