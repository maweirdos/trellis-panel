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
  l0: 'border border-my-line text-my-secondary',
  // L1：灰描边
  l1: 'border border-my-line-strong bg-my-layer-2 text-my-primary',
  // L2：实心蓝
  l2: 'border border-my-line-info bg-my-info-subtle text-my-info-text',
  // 输出失败：错误色（仅明确故障）
  fail: 'border border-my-line-danger bg-my-danger-subtle text-my-danger-text'
}

const TONE_DOT: Record<EvidenceTone, string> = {
  l0: 'bg-transparent border border-my-line-strong',
  l1: 'bg-my-icon-secondary',
  l2: 'bg-my-on-color',
  fail: 'bg-my-danger'
}

export interface EvidenceBadgeProps {
  level?: ReceiptEvidenceLevel
  /** 无任何记录（未观察到）；level 缺省同此。 */
  unobserved?: boolean
  size?: 'sm' | 'md'
}

export function EvidenceBadge({ level, unobserved = false }: EvidenceBadgeProps): JSX.Element {
  // size 语义已由 my-chip 徽标基线统一（sm/md 同高同字号），参数仅保留 API 兼容
  const wording = level !== undefined && !unobserved ? evidenceWording(level) : EVIDENCE_UNOBSERVED
  return (
    <span
      className={clsx('my-chip', TONE_CLASS[wording.tone])}
      title={wording.hint}
    >
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT[wording.tone])} aria-hidden />
      {wording.label}
    </span>
  )
}
