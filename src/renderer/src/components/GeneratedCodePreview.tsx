import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { PrototypePreview } from '../creations/PrototypePreview'
import { PREVIEW_LIMITS } from '../creations/preview-bridge'
import { Button } from '../my/ui'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { useOpenCodePreview, type CodePreviewLanguage } from './CodePreviewContext'
import { ArtifactCopyButton } from './ArtifactCopyButton'

export function GeneratedCodePreviewContent({ source, language, fill = false }: { source: string; language: CodePreviewLanguage; fill?: boolean }): JSX.Element {
  const [imageError, setImageError] = useState(false)
  useEffect(() => setImageError(false), [source, language])
  const tooLarge = source.length > PREVIEW_LIMITS.bodyBytes || new TextEncoder().encode(source).length > PREVIEW_LIMITS.bodyBytes
  if (tooLarge) return <p role="alert" className="p-3 text-my-sm text-my-danger-text">内容超过预览大小限制，请缩短后重试。</p>
  if (language === 'html') return <PrototypePreview body={source} mode="browse" title="HTML 预览" onSelect={() => undefined} minHeight={fill ? 0 : 320} />
  return <div className={`flex min-h-0 items-center justify-center overflow-auto rounded-my-md border border-my-line bg-my-layer-1 p-3 ${fill ? 'h-full flex-1' : 'max-h-[60vh]'}`}>
    {imageError ? <p role="alert" className="text-my-sm text-my-danger-text">无法预览 SVG，请检查代码。</p>
      : <img className={fill ? 'max-h-full max-w-full object-contain' : 'max-h-[56vh] max-w-full'} src={`data:image/svg+xml,${encodeURIComponent(source)}`} alt="SVG 预览" onError={() => setImageError(true)} />}
  </div>
}

/** A message code block is only a preview source; it is not a saved file. */
export function GeneratedCodePreview({ source, language }: { source: string; language: CodePreviewLanguage }): JSX.Element {
  const openCodePreview = useOpenCodePreview()
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [source, language])
  return <>
    <div className="my-2 flex items-center justify-between gap-2">
      <span className="text-my-xs text-my-secondary">{language.toUpperCase()}</span>
      <span className="flex items-center gap-1"><ArtifactCopyButton text={source} ownerKey={language} label="复制代码" /><Button size="sm" variant="ghost" onClick={() => { if (!canInteract()) return; if (openCodePreview) openCodePreview(source, language); else setOpen(value => !value) }}>{!openCodePreview && open ? '收起预览' : '预览'}</Button></span>
    </div>
    <pre><code className={`language-${language}`}>{source}</code></pre>
    {!openCodePreview && open && interactive && <section className="my-3 flex min-w-0 flex-col gap-3 rounded-my-md border border-my-line p-3" aria-label={`${language.toUpperCase()} 内联预览`}>
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-my-sm font-semibold text-my-primary">{language.toUpperCase()} 预览</h2>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)} aria-label="关闭内联预览"><X size={16} /></Button>
        </header>
        <GeneratedCodePreviewContent source={source} language={language} />
      </section>
    }
  </>
}
