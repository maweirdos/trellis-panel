import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { FileCode2 } from 'lucide-react'
import { MermaidBlock } from './MermaidBlock'
import { AsciiDiagramBlock } from './AsciiDiagramBlock'
import { GeneratedCodePreview } from './GeneratedCodePreview'
import { ArtifactCopyButton } from './ArtifactCopyButton'
import { ChatCodeBlock } from './ChatCodeBlock'
import { api, hasIpc } from '../api'
import { externalHttpUrl } from '../../../shared/external-url'
import { localDocumentHref, localDocumentLink } from '../../../shared/local-document-link'
import type { KnowledgeDocumentContext } from '../../../shared/knowledge-document-assets'
import { DocumentAssetScope, DocumentAssetImage } from '../knowledge/DocumentAssetImage'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
import { useDocumentSource } from '../reader/document-source'

const markdownUrlTransform: typeof defaultUrlTransform = (url) => localDocumentHref(url) ?? defaultUrlTransform(url)
const transformUrl: NonNullable<React.ComponentProps<typeof ReactMarkdown>['urlTransform']> = (url, key, node) =>
  key === 'href' && node.tagName === 'a' ? markdownUrlTransform(url) : defaultUrlTransform(url)

/** Heuristic: ASCII 线框图（box-drawing / +--- 风格）加宽展示并保持可横向滚动。 */
function looksLikeAsciiDiagram(text: string): boolean {
  if (text.length < 24 || !text.includes('\n')) return false
  const boxChars = (text.match(/[┌┐└┘├┤│─┬┴╔╗╚╝║╠╣═╬]/g) ?? []).length
  if (boxChars >= 8) return true
  const plusBox = (text.match(/^\s*\+[-=+|]+\+/gm) ?? []).length
  return plusBox >= 2
}

/**
 * 纵深防御（TPD-005）：当前未启用 rehype-raw，原始 HTML 本就不会渲染；
 * 挂 sanitize 保证未来任何人引入 rehype-raw 或升级管线时默认安全。
 * default schema 放行 code 的 language-* 类，mermaid 代码块路径不受影响。
 */
// Anchor-only file/drive syntax; the URL transform still rejects non-document URLs.
const REHYPE_PLUGINS: NonNullable<React.ComponentProps<typeof ReactMarkdown>['rehypePlugins']> = [[rehypeSanitize, {
  ...defaultSchema,
  protocols: { ...defaultSchema.protocols, href: [...(defaultSchema.protocols?.href ?? []), 'file', ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'] }
}]]
const REMARK_PLUGINS = [remarkGfm]

/** heading 覆写：按 hast position.source 行号挂稳定锚点 ID（无行号信息则不挂）。 */
type HeadingNode = { position?: { start?: { line?: number } } } | undefined
type HeadingProps = React.ComponentPropsWithoutRef<'h1'> & { node?: unknown }

function headingComponent(
  level: number,
  anchorsByLine: ReadonlyMap<number, string> | undefined
): (props: HeadingProps) => React.JSX.Element {
  return function MarkdownHeading({ node, children, ...rest }: HeadingProps) {
    const line = (node as HeadingNode)?.position?.start?.line
    const id = anchorsByLine !== undefined && line !== undefined ? anchorsByLine.get(line) : undefined
    return React.createElement(
      `h${level}`,
      id !== undefined ? { ...rest, id } : rest,
      children as React.ReactNode
    )
  }
}

export interface MarkdownViewProps {
  content: string
  documentAssetContext?: KnowledgeDocumentContext
  /** The conversation host alone can associate a local link with a real saved receipt. */
  onOpenDocumentLink?: (href: string) => boolean | Promise<boolean>
  chatFileLinks?: {
    resolve(href: string, inline?: boolean): { path: string; line?: number } | null
    open(file: { path: string; line?: number }): void
  }
  /**
   * S0 G2：行号 → 稳定锚点 ID（由 reader/heading-anchors.ts 的
   * headingAnchorsByLine(content) 预计算）。缺省不挂 ID，既有调用方零改动。
   */
  headingAnchorsByLine?: ReadonlyMap<number, string>
  /** Conversation prose uses chat tables (row separators) and plain code fences. */
  surface?: 'document' | 'chat'
  blocks?: readonly string[]
  /** Extra classes for the conversation host, e.g. the user-bubble modifier. */
  className?: string
  /** Present while the source streams so new blocks fade in once. */
  'data-streaming'?: string
}

type MarkdownComponents = NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>

const MarkdownSource = React.memo(function MarkdownSource({ source, components, urlTransform }: {
  source: string; components: MarkdownComponents; urlTransform: typeof transformUrl
}) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}
    urlTransform={urlTransform} components={components}>{source}</ReactMarkdown>
})

export const MarkdownView = React.memo(function MarkdownView({ content, headingAnchorsByLine, documentAssetContext, onOpenDocumentLink, chatFileLinks, surface = 'document', blocks, className, 'data-streaming': dataStreaming }: MarkdownViewProps): JSX.Element {
  const source = useDocumentSource()
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const [linkError, setLinkError] = useState<string | null>(null)
  const owner = useRef(0)
  useEffect(() => {
    owner.current++
    setLinkError(null)
    return () => { owner.current++ }
  }, [content, onOpenDocumentLink, source, documentAssetContext?.expectedRoot, documentAssetContext?.sessionId, documentAssetContext?.artifactId, documentAssetContext?.revision, interactionSignal])
  const openMarkdownLink = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    if (event.type === 'auxclick' && event.button !== 1) return
    if (!canInteract()) { event.preventDefault(); return }
    const href = event.currentTarget.getAttribute('href')
    if (href?.startsWith('#')) return
    event.preventDefault()
    const generation = ++owner.current
    const fail = (message: string): void => { if (owner.current === generation && canInteract()) setLinkError(message) }
    setLinkError(null)
    if (!hasIpc) { fail('请在桌面应用中打开此链接。'); return }
    const url = externalHttpUrl(href)
    if (url) {
      void api.openExternal(url).catch(() => fail('无法打开链接，请检查系统默认浏览器后重试。'))
    } else if (localDocumentLink(href)) {
      void (async () => {
        if (onOpenDocumentLink) {
          try { if (await onOpenDocumentLink(href ?? '')) return }
          catch (error) { fail(error instanceof Error ? error.message : '无法打开已保存的文档，请重新核对文档记录。'); return }
        }
        if (owner.current !== generation || !canInteract()) return
        if (source) {
          const link = localDocumentLink(href)
          if (!link) { fail('此文档链接无法识别，请从会话文件中打开。'); return }
          try { await source.openDocument(link.path) }
          catch (error) { fail(error instanceof Error ? error.message : '无法打开此会话的文档，请重新核对文件。') }
          return
        }
        if (typeof api.openLocalDocument !== 'function') { fail('本地文档打开功能尚未加载，请完整退出并重启应用后重试。'); return }
        try { const result = await api.openLocalDocument(href ?? ''); if (!result.ok) fail(result.error) }
        catch { fail('无法打开本地文档。请完整退出并重启应用后重试；若仍失败，请让 AI 重新生成。') }
      })()
    } else {
      fail('此链接格式或文件类型不受支持。请让 AI 提供有效的网页或本地文档链接。')
    }
  }
  // Retained sources may receive new interaction/asset scopes without new text.
  // Keep render component types stable; action callbacks still read the latest
  // guarded source/link handler rather than a stale memoized authorization.
  const linkHandler = useRef(openMarkdownLink)
  linkHandler.current = openMarkdownLink
  const openFile = useRef(chatFileLinks?.open)
  openFile.current = chatFileLinks?.open
  const forwardMarkdownLink = useCallback<React.MouseEventHandler<HTMLAnchorElement>>((event) => linkHandler.current(event), [])
  const hasAssetContext = Boolean(documentAssetContext)
  const resolveChatFile = chatFileLinks?.resolve
  const transformChatUrl = useCallback<typeof transformUrl>((url, key, node) =>
    key === 'href' && node.tagName === 'a' && resolveChatFile?.(url) ? url : transformUrl(url, key, node),
  [resolveChatFile])
  const markdownComponents = useMemo<MarkdownComponents>(() => ({
    ...(hasAssetContext ? { img: ({ node: _node, ...props }: React.ComponentPropsWithoutRef<'img'> & { node?: unknown }) => <DocumentAssetImage src={props.src} alt={props.alt} title={props.title} /> } : {}),
    a({ node: _node, ...props }) {
      const file = props.href && resolveChatFile?.(props.href)
      if (file) return <a {...props} className="chat-project-file-link" title={file.path} onClick={event => {
        event.preventDefault()
        if (canInteract()) openFile.current?.(file)
      }} onAuxClick={event => event.preventDefault()}>
        <FileCode2 size={13} aria-hidden="true" /><span>{props.children}</span>
        {file.line && <span className="chat-project-file-line"> · L{file.line}</span>}
      </a>
      return <a {...props} onClick={forwardMarkdownLink} onAuxClick={forwardMarkdownLink} />
    },
    h1: headingComponent(1, headingAnchorsByLine),
    h2: headingComponent(2, headingAnchorsByLine),
    h3: headingComponent(3, headingAnchorsByLine),
    h4: headingComponent(4, headingAnchorsByLine),
    h5: headingComponent(5, headingAnchorsByLine),
    h6: headingComponent(6, headingAnchorsByLine),
    pre({ children, ...props }) {
      // 当代码块内容是自成一体的块级组件（AsciiDiagramBlock / MermaidBlock）时，直接返回该组件，彻底消除外层多余的 pre 边框与内边距
      const child = React.isValidElement(children)
        ? children
        : Array.isArray(children) && React.isValidElement(children[0])
          ? children[0]
          : null

      if (child) {
        const codeProps = child.props as { className?: string; children?: React.ReactNode }
        const text = String(codeProps?.children ?? '').replace(/\n$/, '')
        const className = codeProps?.className
        const fenceLanguage = /language-([\w+-]+)/.exec(className ?? '')?.[1]
        const plainSource = String(codeProps?.children ?? '')

        if (className?.includes('language-mermaid')) {
          return <div><div className="flex justify-end"><ArtifactCopyButton text={text} ownerKey={text} label="复制图表源码" /></div><MermaidBlock chart={text} /></div>
        }
        if (/\blanguage-(?:html|svg)\b/i.test(className ?? '')) {
          return <GeneratedCodePreview source={text} language={/\blanguage-svg\b/i.test(className ?? '') ? 'svg' : 'html'} />
        }
        if (!className && looksLikeAsciiDiagram(text)) {
          return <AsciiDiagramBlock chart={text} />
        }
        if (surface === 'chat') {
          return <ChatCodeBlock code={plainSource} language={fenceLanguage}>{children}</ChatCodeBlock>
        }
      }
      const source = child ? String((child.props as { children?: React.ReactNode }).children ?? '') : undefined
      return <div>{source !== undefined && <div className="flex justify-end"><ArtifactCopyButton text={source} ownerKey={source} label="复制代码" /></div>}<pre {...props}>{children}</pre></div>
    },
    table({ children, ...props }) {
      if (surface === 'chat') return <div className="my-scrollbar md-chat-table"><table {...props}>{children}</table></div>
      return (
        <div className="my-4 overflow-x-auto rounded-my-lg border border-my-line bg-my-surface-1 shadow-xs">
          <table className="min-w-full w-max border-collapse text-left text-my-sm" {...props}>
            {children}
          </table>
        </div>
      )
    },
    thead({ children, ...props }) {
      if (surface === 'chat') return <thead {...props}>{children}</thead>
      return (
        <thead className="border-b border-my-line bg-my-layer-2 text-my-primary font-semibold" {...props}>
          {children}
        </thead>
      )
    },
    th({ children, ...props }) {
      if (surface === 'chat') return <th {...props}>{children}</th>
      return (
        <th
          className="border-r border-my-line last:border-r-0 px-4 py-2.5 text-left font-semibold tracking-wide text-my-primary break-keep"
          {...props}
        >
          {children}
        </th>
      )
    },
    tr({ children, ...props }) {
      if (surface === 'chat') return <tr {...props}>{children}</tr>
      return (
        <tr className="border-b border-my-line last:border-b-0 even:bg-my-layer-1-hover hover:bg-my-layer-1-hover transition-colors" {...props}>
          {children}
        </tr>
      )
    },
    td({ children, ...props }) {
      if (surface === 'chat') return <td {...props}>{children}</td>
      return (
        <td
          className="border-r border-my-line last:border-r-0 px-4 py-2.5 leading-relaxed text-my-secondary align-top break-keep break-words"
          {...props}
        >
          {children}
        </td>
      )
    },
    code({ className, children, node: _node, ...props }) {
      const source = String(children ?? '')
      const text = source.replace(/\n$/, '')
      const file = !className && !source.includes('\n') ? resolveChatFile?.(text, true) : null
      if (file) return <button type="button" className="chat-project-file-link" title={file.path} onClick={() => {
        if (canInteract()) openFile.current?.(file)
      }}><FileCode2 size={13} aria-hidden="true" /><span>{file.path.split('/').at(-1)}</span>
        {file.line && <span className="chat-project-file-line"> · L{file.line}</span>}
      </button>
      if (className?.includes('language-mermaid')) {
        return <MermaidBlock chart={text} />
      }
      if (!className && looksLikeAsciiDiagram(text)) {
        return <AsciiDiagramBlock chart={text} />
      }
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
  }), [headingAnchorsByLine, hasAssetContext, forwardMarkdownLink, surface, resolveChatFile, canInteract])

  return (
    <div className={[surface === 'chat' ? 'chat-markdown' : 'md', className].filter(Boolean).join(' ')}
      {...(dataStreaming !== undefined ? { 'data-streaming': dataStreaming } : {})}>
      <DocumentAssetScope context={documentAssetContext} contentKey={content}>
        {(blocks ?? [content]).map((source, index) => <MarkdownSource key={index} source={source} components={markdownComponents}
          urlTransform={resolveChatFile ? transformChatUrl : transformUrl} />)}
      </DocumentAssetScope>
      {linkError && <p role="alert" className="mt-3 rounded-my-md bg-my-danger-subtle p-3 text-my-sm text-my-danger-text">{linkError}</p>}
    </div>
  )
})
