import type { JSX } from 'react'
import { ExternalLink, Globe, Loader2, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import { Button } from '../my/ui'
import './conversation-preview.css'

export interface PreviewToolbarProps {
  address: string
  addressLabel?: string
  expanded: boolean
  onReload: () => void
  onToggleExpanded: () => void
  onOpenExternal?: () => void
  externalDisabledReason?: string
  openingExternal?: boolean
  disabled?: boolean
  updated?: boolean
  onClose?: () => void
}

/** The address is a selectable source/lease entry, never a navigation input. */
export function PreviewToolbar({ address, addressLabel = '预览入口地址（只读）', expanded, onReload, onToggleExpanded, onOpenExternal, externalDisabledReason, openingExternal = false, disabled = false, updated = false, onClose }: PreviewToolbarProps): JSX.Element {
  return <div className="acp-preview-toolbar" data-standalone={Boolean(onClose)}>
    <div className="acp-preview-toolbar-leading">
      <Button size="sm" variant="ghost" className="acp-preview-icon-button" aria-label={updated ? '文件已更新，重新加载预览' : '重新加载预览'} title={updated ? '文件已更新，重新加载预览' : '重新加载预览'} disabled={disabled} onClick={onReload}><RefreshCw size={14} />{updated && <span className="acp-preview-update-dot" />}</Button>
    </div>
    <label className="acp-preview-address" title={address}>
      <Globe size={13} aria-hidden="true" />
      <input aria-label={addressLabel} readOnly value={address} spellCheck={false} />
    </label>
    <div className="acp-preview-toolbar-actions">
      <span title={externalDisabledReason}>
        <Button size="sm" variant="ghost" className="acp-preview-icon-button" aria-label="用本机浏览器打开" title={externalDisabledReason ?? '用本机浏览器打开'} disabled={disabled || !onOpenExternal || openingExternal} onClick={onOpenExternal}>{openingExternal ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}</Button>
      </span>
      <Button size="sm" variant="ghost" className="acp-preview-icon-button" aria-label={expanded ? '恢复预览宽度' : '扩大预览面板'} title={expanded ? '恢复预览宽度' : '扩大预览面板'} disabled={disabled} aria-pressed={expanded} onClick={onToggleExpanded}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</Button>
      {onClose && <Button size="sm" variant="ghost" className="acp-preview-icon-button" aria-label="关闭当前预览" title="关闭当前预览" onClick={onClose}><X size={14} /></Button>}
    </div>
  </div>
}
