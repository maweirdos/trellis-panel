import { useState, type JSX } from 'react'
import { PreviewToolbar } from './PreviewToolbar'
import { GeneratedCodePreviewContent } from '../components/GeneratedCodePreview'
import type { CodePreviewLanguage } from '../components/CodePreviewContext'

export function CodePreviewPane({ source, language, expanded, onToggleExpanded, onClose, error }: {
  source: string; language: CodePreviewLanguage; expanded: boolean; onToggleExpanded: () => void; onClose?: () => void; error?: string
}): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  return <section className="acp-web-preview" aria-label={`${language.toUpperCase()} 代码预览`}>
    <PreviewToolbar address={`会话中的 ${language.toUpperCase()} 片段（未保存）`} addressLabel="代码片段来源（只读）" expanded={expanded} onReload={() => setAttempt(value => value + 1)} onToggleExpanded={onToggleExpanded} onClose={onClose} externalDisabledReason="保存为本地产物后可用本机浏览器打开" />
    <div className="acp-code-preview-content">{error ? <p role="alert" className="text-my-danger-text">{error}</p> : <GeneratedCodePreviewContent key={attempt} source={source} language={language} fill />}</div>
  </section>
}
