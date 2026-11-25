import { memo, useContext, useMemo } from 'react'
import { MarkdownView } from '../components/MarkdownView'
import { ChatProjectFileLinks, resolveChatProjectFile } from './chatProjectFileLinks'
import { splitMarkdownBlocks } from './markdownStreamBlocks'

function shouldPreserveAssistantLineBreaks(text: string): boolean {
  return /^★ Insight(?:\s|─)/mu.test(text)
}

export const ChatMarkdown = memo(function ChatMarkdown({ text, isStreaming = false, user = false }: {
  readonly text: string
  readonly isStreaming?: boolean
  /** User bubbles use message ink for their plain-text fences and keep leading whitespace. */
  readonly user?: boolean
}) {
  const files = useContext(ChatProjectFileLinks)
  const root = files?.root
  const resolve = useMemo(() => root ? (href: string, inline?: boolean) => resolveChatProjectFile(href, root, inline) : undefined, [root])
  const blocks = isStreaming ? splitMarkdownBlocks(text) ?? [text] : [text]
  return <MarkdownView content={text} surface="chat" blocks={blocks}
    chatFileLinks={resolve && files ? { resolve, open: files.open } : undefined}
    className={user ? 'user-message-markdown'
      : shouldPreserveAssistantLineBreaks(text) ? 'assistant-message-preserve-lines' : undefined}
    data-streaming={isStreaming ? '' : undefined} />
})
