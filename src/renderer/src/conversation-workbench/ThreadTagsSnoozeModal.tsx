import { useEffect, useState, type JSX } from 'react'
import { BellOff, Clock, Plus, Tag, X } from 'lucide-react'
import { FeedbackNotice } from '../my/FeedbackNotice'
import { Button, Modal } from '../my/ui'
import './conversation-enhancements.css'

export interface ThreadTagsSnoozeModalProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly currentTags: readonly string[]
  readonly snoozedUntil: string | null
  readonly onSaveTags: (tags: readonly string[]) => Promise<{ readonly ok: boolean; readonly reason?: string }>
  readonly onSaveSnooze: (snoozedUntil: string | null) => Promise<{ readonly ok: boolean; readonly reason?: string }>
}

const MAX_USER_TAGS = 12

function computeSnoozePreset(preset: '1h' | 'tonight' | 'tomorrow' | 'nextWeek'): string {
  const now = new Date()
  if (preset === '1h') {
    return new Date(now.getTime() + 60 * 60_000).toISOString()
  }
  if (preset === 'tonight') {
    const target = new Date(now)
    target.setHours(18, 0, 0, 0)
    if (target.getTime() <= now.getTime() + 15 * 60_000) {
      target.setDate(target.getDate() + 1)
    }
    return target.toISOString()
  }
  if (preset === 'tomorrow') {
    const target = new Date(now)
    target.setDate(target.getDate() + 1)
    target.setHours(9, 0, 0, 0)
    return target.toISOString()
  }
  const target = new Date(now)
  const day = target.getDay()
  const daysToMonday = day === 0 ? 1 : 8 - day
  target.setDate(target.getDate() + daysToMonday)
  target.setHours(9, 0, 0, 0)
  return target.toISOString()
}

export function formatSnoozeLabel(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms) || ms <= Date.now()) return null
  const target = new Date(ms)
  const now = new Date()
  const sameDay = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate()
  const hh = String(target.getHours()).padStart(2, '0')
  const mm = String(target.getMinutes()).padStart(2, '0')
  if (sameDay) return `置后至 ${hh}:${mm}`
  return `置后至 ${target.getMonth() + 1}/${target.getDate()} ${hh}:${mm}`
}

export function ThreadTagsSnoozeModal({
  open,
  onClose,
  currentTags,
  snoozedUntil,
  onSaveTags,
  onSaveSnooze,
}: ThreadTagsSnoozeModalProps): JSX.Element {
  const systemTags = currentTags.filter((tag) => tag.startsWith('crux:'))
  const initialUserTags = currentTags.filter((tag) => !tag.startsWith('crux:'))
  const [userTags, setUserTags] = useState<readonly string[]>(initialUserTags)
  const [draftTag, setDraftTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setUserTags(currentTags.filter((tag) => !tag.startsWith('crux:')))
    setDraftTag('')
    setError('')
  }, [currentTags, open])

  const commitTags = async (nextUserTags: readonly string[]): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const merged = [...systemTags, ...nextUserTags]
      const result = await onSaveTags(merged)
      if (result.ok) setUserTags(nextUserTags)
      else setError(result.reason ?? '更新标签失败。')
    } finally {
      setBusy(false)
    }
  }

  const addTag = (): void => {
    const cleaned = draftTag.trim()
    if (!cleaned || busy) return
    if (cleaned.startsWith('crux:')) {
      setError('标签不能以系统保留前缀 crux: 开头。')
      return
    }
    if (userTags.includes(cleaned)) {
      setDraftTag('')
      return
    }
    if (userTags.length >= MAX_USER_TAGS) {
      setError(`单个会话最多添加 ${MAX_USER_TAGS} 个自定义标签。`)
      return
    }
    setDraftTag('')
    void commitTags([...userTags, cleaned])
  }

  const applySnooze = async (nextIso: string | null): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await onSaveSnooze(nextIso)
      if (!result.ok) setError(result.reason ?? '更新置后提醒失败。')
    } finally {
      setBusy(false)
    }
  }

  const activeSnoozeLabel = formatSnoozeLabel(snoozedUntil)

  return (
    <Modal open={open} onClose={onClose} ariaLabel="标签与置后提醒" width={440}>
      <div className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-my-lg font-medium">标签与置后提醒</h2>
          <button type="button" className="my-icon-control" aria-label="关闭" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <section className="space-y-2" aria-label="会话标签">
          <div className="flex items-center gap-1.5 text-my-sm font-medium text-my-primary">
            <Tag size={14} aria-hidden="true" />
            <span>自定义标签</span>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              addTag()
            }}
          >
            <input
              type="text"
              className="my-input flex-1"
              maxLength={48}
              disabled={busy}
              placeholder="输入标签名，回车添加（如：需求评审、待跟进）"
              aria-label="新增标签名"
              value={draftTag}
              onChange={(event) => setDraftTag(event.target.value)}
            />
            <Button type="submit" size="sm" variant="outline" disabled={busy || !draftTag.trim()}>
              <Plus size={13} aria-hidden="true" />
              添加
            </Button>
          </form>
          {userTags.length > 0 ? (
            <div className="conversation-tag-list">
              {userTags.map((tag) => (
                <span key={tag} className="conversation-tag-chip">
                  <span>{tag}</span>
                  <button
                    type="button"
                    className="my-icon-control"
                    aria-label={`移除标签 ${tag}`}
                    disabled={busy}
                    onClick={() => void commitTags(userTags.filter((item) => item !== tag))}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="my-item-description">暂无自定义标签，可用于在会话列表快速归类与检索。</p>
          )}
        </section>

        <section className="space-y-2 border-t border-my-line pt-3" aria-label="置后提醒">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 text-my-sm font-medium text-my-primary">
              <Clock size={14} aria-hidden="true" />
              <span>置后提醒（Snooze）</span>
            </span>
            {activeSnoozeLabel && (
              <span className="conversation-snooze-chip">{activeSnoozeLabel}</span>
            )}
          </div>
          <p className="my-item-description">暂时搁置当前会话，到期后再提醒你回来继续处理。</p>
          <div className="conversation-snooze-presets">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void applySnooze(computeSnoozePreset('1h'))}>
              1 小时后
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void applySnooze(computeSnoozePreset('tonight'))}>
              今天 18:00
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void applySnooze(computeSnoozePreset('tomorrow'))}>
              明天 09:00
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void applySnooze(computeSnoozePreset('nextWeek'))}>
              下周一 09:00
            </Button>
            {activeSnoozeLabel && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void applySnooze(null)}>
                <BellOff size={13} aria-hidden="true" />
                清除置后
              </Button>
            )}
          </div>
        </section>

        {error && <FeedbackNotice variant="bar-compact" tone="error" title="未能保存设置" description={error} />}

        <div className="flex justify-end">
          <Button type="button" variant="primary" size="sm" onClick={onClose}>完成</Button>
        </div>
      </div>
    </Modal>
  )
}
