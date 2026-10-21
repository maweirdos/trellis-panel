import { useCallback, useMemo, useRef, useState, type JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize from 'rehype-sanitize'
import { externalHttpUrl } from '../../../shared/external-url'
import { api } from '../api'
import { useTeamOwner } from './use-team-owner'

/** Published text has no local filesystem or automatically mirrored image grant. */
export function TeamMarkdown({ text, identity }: { text: string; identity: string }): JSX.Element {
  const owner = useTeamOwner(identity), [error, setError] = useState('')
  const current = useRef(owner); current.current = owner
  const open = useCallback((event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (event.type === 'auxclick' && event.button !== 1) return
    const href = event.currentTarget.getAttribute('href')
    if (href?.startsWith('#')) return
    event.preventDefault()
    const captured = current.current.capture()
    if (!current.current.valid(captured)) return
    const url = externalHttpUrl(href)
    if (!url) { setError('共享文档的本地链接尚未发布，不会打开当前项目里的同名文件。'); return }
    void api.openExternal(url).catch(() => { if (current.current.valid(captured)) setError('无法打开该网页链接。') })
  }, [])
  const components = useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>>(() => ({
    a: ({ node: _node, ...props }) => <a {...props} onClick={open} onAuxClick={open} />,
    img: ({ alt }) => <span className="team-unpublished-asset">附件未发布{alt ? `：${alt}` : ''}</span>
  }), [open])
  return <><div className="team-document-prose my-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>{text}</ReactMarkdown></div>{error && <p role="status" className="team-notice">{error}</p>}</>
}
