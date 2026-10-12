import { clsx } from 'clsx'
import type { JSX } from 'react'
import { EVIDENCE_UNOBSERVED, evidenceWording, type EvidenceTone, type ReceiptEvidenceLevel } from '../../../shared/observability/receipt'

/**
 * EvidenceBadge（S0 G3 第二片，review/03 场景 B）：证据等级徽标。
 * L0 灰圈（未观察到）/ L1 灰描边（已组装）/ L2 实心蓝（已输出至宿主通道）；
 * 未知一律中性色，只有明确输出失败才用错误色。文字 + 图形双通道（不只靠颜色）。
 */

const TONE_CLASS: Record<EvidenceTone, string> = {
  // L0：灰圈（空心）
  l0: 'border-mist-600/60 text-mist-400',
  // L1：灰描边
  l1: 'border-mist-500 bg-mist-700/30 text-mist-200',
  // L2：实心蓝
  l2: 'border-sky-500 bg-sky-500/85 text-white',
  // 输出失败：错误色（仅明确故障）
  fail: 'border-rose-500/70 bg-rose-500/15 text-rose-300'
}

const TONE_DOT: Record<EvidenceTone, string> = {
  l0: 'bg-transparent border border-mist-500',
  l1: 'bg-mist-400',
  l2: 'bg-white',
  fail: 'bg-rose-400'
}

export interface EvidenceBadgeProps {
  level?: ReceiptEvidenceLevel
  /** 无任何记录（未观察到）；level 缺省同此。 */
  unobserved?: boolean
  size?: 'sm' | 'md'
}

export function EvidenceBadge({ level, unobserved = false, size = 'sm' }: EvidenceBadgeProps): JSX.Element {
  const wording = level !== undefined && !unobserved ? evidenceWording(level) : EVIDENCE_UNOBSERVED
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-[10.5px]' : 'px-2.5 py-1 text-[11.5px]',
        TONE_CLASS[wording.tone]
      )}
      title={wording.hint}
    >
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[wording.tone])} aria-hidden />
      {wording.label}
    </span>
  )
}
