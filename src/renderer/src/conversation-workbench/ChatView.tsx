import type { ReactNode } from 'react'

interface ChatViewProps {
  readonly label: string
  readonly header: ReactNode
  readonly projectIntake?: ReactNode
  readonly draftHero: boolean
  readonly children: ReactNode
}

export function ChatView({ label, header, projectIntake, draftHero, children }: ChatViewProps) {
  return (
    <section className="acp-main my-conversation-frame" aria-label={label} data-chat-column>
      {header}
      {projectIntake}
      <div data-chat-canvas className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="acp-content" data-empty={draftHero || undefined}>{children}</div>
      </div>
    </section>
  )
}
