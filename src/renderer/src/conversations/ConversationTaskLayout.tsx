import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Button } from '../my/ui'
import './conversation-task-layout.css'

export type TaskPane = 'task' | 'chat'

/** Keep the chat mounted while the reader opens so its selection, input and scroll survive. */
export function ConversationTaskLayout({ task, pane, onPaneChange, children, activation }: {
  task: ReactNode
  pane: TaskPane
  onPaneChange(pane: TaskPane): void
  children: ReactNode
  activation: number
}) {
  const reader = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (activation) reader.current?.focus({ preventScroll: true })
  }, [activation])
  return <div className="conversation-task-layout" data-open={Boolean(task)} data-pane={pane}>
    {task && <nav className="conversation-task-switch" aria-label="切换工作区内容">
      <Button size="sm" variant="ghost" aria-pressed={pane === 'task'} onClick={() => onPaneChange('task')}>任务</Button>
      <Button size="sm" variant="ghost" aria-pressed={pane === 'chat'} onClick={() => onPaneChange('chat')}>对话</Button>
    </nav>}
    <div className="conversation-task-columns">
      {task && <div ref={reader} role="region" aria-label="关联任务" tabIndex={-1} className="conversation-task-reader">{task}</div>}
      <div className="conversation-task-chat" key="chat">{children}</div>
    </div>
  </div>
}
