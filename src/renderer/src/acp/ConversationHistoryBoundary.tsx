import { useId, useState, type JSX } from 'react'
import { ArrowUp, Info, Loader2 } from 'lucide-react'
import { Button } from '../my/ui'

export interface ConversationHistoryBoundaryProps {
  hasEarlier: boolean
  startsMidTurn: boolean
  coverage?: 'complete' | 'partial' | 'unknown'
  loading: boolean
  onLoadEarlier: () => void
}

export function HistoryBoundary({ hasEarlier, startsMidTurn, coverage, loading, onLoadEarlier }: ConversationHistoryBoundaryProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const hasDetails = startsMidTurn || coverage === 'partial' || coverage === 'unknown'
  const description = [startsMidTurn ? '未找到这一回合的开头记录' : '', coverage === 'partial' ? '仅能确认部分历史，完整范围未确认' : coverage === 'unknown' ? '旧版记录的完整性尚无法验证' : ''].filter(Boolean).join('；')
  return <div className="acp-history-boundary">
    <div className="acp-history-controls" role="group" aria-label="对话历史">
      {hasEarlier && <Button size="sm" variant="neutral" className="acp-history-load" disabled={loading} aria-busy={loading} aria-label={loading ? '正在加载更早消息' : undefined} onClick={onLoadEarlier}>
        {loading ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <ArrowUp size={14} aria-hidden="true" />}
        加载更早消息
      </Button>}
      {hasDetails && <Button size="sm" variant="ghost" className="acp-history-coverage" aria-label="历史记录说明" title="历史记录说明" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded((value) => !value)}><Info size={14} aria-hidden="true" /></Button>}
    </div>
    {hasDetails && <p id={detailId} hidden={!expanded} className="acp-history-explanation">{description}。</p>}
  </div>
}
