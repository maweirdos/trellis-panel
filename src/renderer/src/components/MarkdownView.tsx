import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { MermaidBlock } from './MermaidBlock'
import { AsciiDiagramBlock } from './AsciiDiagramBlock'
import { api, hasIpc } from '../api'
import { externalHttpUrl } from '../../../shared/external-url'
import { localDocumentHref, localDocumentLink } from '../../../shared/local-document-link'
import type { KnowledgeDocumentContext } from '../../../shared/knowledge-document-assets'
import { DocumentAssetScope, DocumentAssetImage } from '../knowledge/DocumentAssetImage'
import { useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'

const markdownUrlTransform: typeof defaultUrlTransform = (url) => localDocumentHref(url) ?? defaultUrlTransform(url)

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
  /**
   * S0 G2：行号 → 稳定锚点 ID（由 reader/heading-anchors.ts 的
   * headingAnchorsByLine(content) 预计算）。缺省不挂 ID，既有调用方零改动。
   */
  headingAnchorsByLine?: ReadonlyMap<number, string>
}

export const MarkdownView = React.memo(function MarkdownView({ content, headingAnchorsByLine, documentAssetContext, onOpenDocumentLink }: MarkdownViewProps): JSX.Element {
  const canInteract = useInteractionGuard()
  const interactionSignal = useInteractionSignal()
  const [linkError, setLinkError] = useState<string | null>(null)
  const owner = useRef(0)
  useEffect(() => {
    owner.current++
    setLinkError(null)
    return () => { owner.current++ }
  }, [content, onOpenDocumentLink, documentAssetContext?.expectedRoot, documentAssetContext?.sessionId, documentAssetContext?.artifactId, documentAssetContext?.revision, interactionSignal])
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
  const forwardMarkdownLink = useCallback<React.MouseEventHandler<HTMLAnchorElement>>((event) => linkHandler.current(event), [])
  const hasAssetContext = Boolean(documentAssetContext)
  const markdownComponents = useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>>(() => ({
    ...(hasAssetContext ? { img: ({ node: _node, ...props }: React.ComponentPropsWithoutRef<'img'> & { node?: unknown }) => <DocumentAssetImage src={props.src} alt={props.alt} title={props.title} /> } : {}),
    a({ node: _node, ...props }) {
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

        if (className?.includes('language-mermaid')) {
          return <MermaidBlock chart={text} />
        }
        if (!className && looksLikeAsciiDiagram(text)) {
          return <AsciiDiagramBlock chart={text} />
        }
      }
      return <pre {...props}>{children}</pre>
    },
    table({ children, ...props }) {
      return (
        <div className="my-4 overflow-x-auto rounded-my-lg border border-my-line bg-my-surface-1 shadow-xs">
          <table className="min-w-full w-max border-collapse text-left text-my-sm" {...props}>
            {children}
          </table>
        </div>
      )
    },
    thead({ children, ...props }) {
      return (
        <thead className="border-b border-my-line bg-my-layer-2 text-my-primary font-semibold" {...props}>
          {children}
        </thead>
      )
    },
    th({ children, ...props }) {
      return (
        <th
          className="border-r border-my-line last:border-r-0 px-4 py-2.5 text-left font-semibold tracking-wide text-my-primary select-none break-keep"
          {...props}
        >
          {children}
        </th>
      )
    },
    tr({ children, ...props }) {
      return (
        <tr className="border-b border-my-line last:border-b-0 even:bg-my-layer-1-hover hover:bg-my-layer-1-hover transition-colors" {...props}>
          {children}
        </tr>
      )
    },
    td({ children, ...props }) {
      return (
        <td
          className="border-r border-my-line last:border-r-0 px-4 py-2.5 leading-relaxed text-my-secondary align-top break-keep break-words"
          {...props}
        >
          {children}
        </td>
      )
    },
    code({ className, children, ...props }) {
      const text = String(children ?? '').replace(/\n$/, '')
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
  }), [headingAnchorsByLine, hasAssetContext, forwardMarkdownLink])

  return (
    <div className="md">
      <DocumentAssetScope context={documentAssetContext} contentKey={content}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={(url, key, node) => key === 'href' && node.tagName === 'a' ? markdownUrlTransform(url) : defaultUrlTransform(url)}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
      </DocumentAssetScope>
      {linkError && <p role="alert" className="mt-3 rounded-my-md bg-my-danger-subtle p-3 text-my-sm text-my-danger-text">{linkError}</p>}
    </div>
  )
})
