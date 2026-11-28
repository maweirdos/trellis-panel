import type { JSX } from 'react'
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { Dropdown, DropdownDivider, DropdownHeader, DropdownItem } from '../my/ui'
import { formatDayAwareTimestamp } from './chatTimestamp'
import {
  removePromptStashEntry,
  stashComposerPrompt,
  takePromptStashEntry,
  usePromptStashEntries,
  type PromptStashEntry,
} from './promptStashStore'
import type { ComposerDraftContent, ComposerReference } from './useComposerDraft'
import './conversation-enhancements.css'

export interface ComposerStashMenuProps {
  readonly disabled: boolean
  readonly hasContent: boolean
  readonly draftText: string
  readonly references: readonly ComposerReference[]
  readonly hasAttachments: boolean
  readonly legacyStash: ComposerDraftContent | null
  readonly onClearDraft: () => void
  readonly onApplyEntry: (entry: PromptStashEntry) => void
  readonly onLegacyStash: () => void
  readonly onLegacyRestore: () => void
}

function previewPrompt(entry: PromptStashEntry): string {
  const firstLine = entry.prompt.trim().split(/\r?\n/, 1)[0] ?? ''
  if (firstLine) return firstLine.length > 42 ? `${firstLine.slice(0, 42)}…` : firstLine
  return entry.references.length > 0 ? `含 ${entry.references.length} 条引用` : '空白草稿'
}

export function ComposerStashMenu({
  disabled,
  hasContent,
  draftText,
  references,
  hasAttachments,
  legacyStash,
  onClearDraft,
  onApplyEntry,
  onLegacyStash,
  onLegacyRestore,
}: ComposerStashMenuProps): JSX.Element | null {
  const entries = usePromptStashEntries()
  if (!hasContent && entries.length === 0 && !legacyStash) return null

  const stashCurrent = (): void => {
    if (!hasContent) return
    if (hasAttachments && !legacyStash) {
      onLegacyStash()
      return
    }
    const { entry } = stashComposerPrompt({ prompt: draftText, references })
    if (entry) onClearDraft()
  }

  const restoreEntry = (entryId: string): void => {
    // 若当前输入框已有文本内容，先自动存入暂存盒避免丢失
    if (draftText.trim() || references.length > 0) {
      stashComposerPrompt({ prompt: draftText, references })
    }
    const { entry } = takePromptStashEntry(entryId)
    if (entry) onApplyEntry(entry)
  }

  const badgeCount = entries.length + (legacyStash ? 1 : 0)

  return (
    <Dropdown
      disabled={disabled}
      placement="top"
      width={300}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="my-icon-control conversation-stash-trigger"
          title={badgeCount > 0 ? `草稿暂存盒（${badgeCount} 条）` : '暂存当前草稿'}
          aria-label={badgeCount > 0 ? `草稿暂存盒，共 ${badgeCount} 条` : '暂存当前草稿'}
          aria-expanded={open}
          disabled={disabled}
          onClick={toggle}
        >
          <Archive size={15} aria-hidden="true" />
          {badgeCount > 0 && <span className="conversation-stash-badge">{badgeCount}</span>}
        </button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-0.5 p-1">
          <DropdownHeader>草稿暂存盒</DropdownHeader>
          <DropdownItem
            icon={<Archive size={14} aria-hidden="true" />}
            disabled={!hasContent || (hasAttachments && Boolean(legacyStash))}
            description={hasAttachments ? '含附件草稿将暂存在当前会话槽位' : '跨会话持久保存，随时取回'}
            onClick={() => {
              stashCurrent()
              close()
            }}
          >
            暂存当前草稿
          </DropdownItem>
          {legacyStash && (
            <DropdownItem
              icon={<ArchiveRestore size={14} aria-hidden="true" />}
              disabled={hasContent}
              description="取回本会话带附件的暂存草稿"
              onClick={() => {
                onLegacyRestore()
                close()
              }}
            >
              取回当前会话暂存
            </DropdownItem>
          )}
          {entries.length > 0 && <DropdownDivider />}
          {entries.length > 0 && (
            <div className="conversation-stash-list my-scrollbar" role="list" aria-label="已暂存草稿列表">
              {entries.map((entry) => (
                <div key={entry.id} className="conversation-stash-row" role="listitem">
                  <button
                    type="button"
                    className="conversation-stash-restore"
                    onClick={() => {
                      restoreEntry(entry.id)
                      close()
                    }}
                  >
                    <span className="conversation-stash-preview">{previewPrompt(entry)}</span>
                    <span className="conversation-stash-meta">
                      {formatDayAwareTimestamp(entry.createdAt)}
                      {entry.references.length > 0 ? ` · ${entry.references.length} 条引用` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="my-icon-control"
                    title="删除此暂存草稿"
                    aria-label="删除此暂存草稿"
                    onClick={(event) => {
                      event.stopPropagation()
                      removePromptStashEntry(entry.id)
                    }}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Dropdown>
  )
}
