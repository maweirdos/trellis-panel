import { useMemo } from 'react'
import { Inbox as InboxIcon, Sparkles, FileText, Trash2, Copy, ExternalLink, Link2, CheckCircle2 } from 'lucide-react'
import { useApp } from '../store'
import { api } from '../api'
import { Button } from '../my/ui'
import { PageContent, PageToolbar } from '../my/layout/PageLayout'
import { PriorityBadge } from '../components/badges'
import { confirmDialog } from '../components/Dialogs'
import type { JSX } from 'react'
import type { TodoItem } from '../../../shared/types'

/**
 * 待办池（Backlog / 需求池）：
 * 存放从 Jira 提取的待办事项与本地需求草稿，保存为 .trellis/todos/<id>.md。
 * 下游 Codex / ZCode / Claude Code 可以直接读取以启动正式规划与实施。
 */
export function InboxPage(): JSX.Element {
  const todos = useApp((s) => s.todos)
  const setPage = useApp((s) => s.setPage)
  const setIntakeOpen = useApp((s) => s.setIntakeOpen)
  const deleteTodo = useApp((s) => s.deleteTodo)
  const saveTodo = useApp((s) => s.saveTodo)
  const openArtifact = useApp((s) => s.openArtifact)
  const pushToast = useApp((s) => s.pushToast)

  const pending = useMemo(() => todos.filter((t) => t.status === 'pending'), [todos])
  const completed = useMemo(() => todos.filter((t) => t.status !== 'pending'), [todos])

  const copyPrompt = (todo: TodoItem): void => {
    const prompt = `请阅读本地待办需求文件 \`${todo.filePath}\`，按照项目 workflow.md 规范开始规划，并在 .trellis/tasks/ 下创建正式任务。`
    void navigator.clipboard.writeText(prompt)
    pushToast({
      kind: 'success',
      title: '已复制 AI 认领指令',
      body: '可直接粘贴到 Codex / ZCode 会话中执行'
    })
  }

  const markConverted = async (todo: TodoItem): Promise<void> => {
    const nextStatus = todo.status === 'converted' ? 'pending' : 'converted'
    await saveTodo({
      ...todo,
      status: nextStatus
    })
  }

  const removeTodo = async (todo: TodoItem): Promise<void> => {
    const ok = await confirmDialog({
      title: `确定删除待办“${todo.title}”吗？`,
      message: `将删除本地文件 ${todo.filePath}。`,
      danger: true
    })
    if (!ok) return
    await deleteTodo(todo.id)
  }

  const viewDoc = (todo: TodoItem): void => {
    openArtifact(
      {
        name: `${todo.id}.md`,
        path: todo.filePath,
        kind: 'file',
        size: 0,
        mtime: Date.now(),
        ext: '.md'
      },
      true
    )
  }

  return (
    <div className="my-fade flex h-full min-h-0 min-w-0 flex-col">
      {/* toolbar */}
      <PageToolbar>
        <span className="my-chip border border-my-line-warning bg-my-warning-subtle text-my-warning-text">
          {pending.length} 待规划
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" onClick={() => setPage('jira')}>
            <Link2 size={12} /> 从 Jira 导入
          </Button>
          <Button variant="primary" onClick={() => setIntakeOpen(true)}>
            <Sparkles size={12} /> 新建待办
          </Button>
        </div>
      </PageToolbar>

      <div className="my-scrollbar min-h-0 flex-1">
        <PageContent variant="full">
        {todos.length === 0 && (
          <div className="grid place-items-center gap-3 py-24 text-my-tertiary">
            <InboxIcon size={36} strokeWidth={1.2} />
            <div className="text-my-sm text-my-secondary">待办池为空</div>
            <div className="max-w-md text-center text-my-sm leading-5">
              这里是上游需求（Jira 待办或本地草稿）的收集与预处理池。
              待办保存在本地 Markdown 文件（<code className="text-my-accent-text">.trellis/todos/*.md</code>）中，
              Codex / ZCode / Claude Code 可以直接读取以启动正式任务规划与实施。
            </div>
          </div>
        )}

        {/* 待规划列表 */}
        {pending.length > 0 && (
          <>
            <div className="mb-2 text-my-xs font-medium uppercase tracking-wide text-my-tertiary">待规划需求</div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {pending.map((todo) => (
                <TodoCard
                  key={todo.id}
                  todo={todo}
                  onCopyPrompt={copyPrompt}
                  onViewDoc={viewDoc}
                  onToggleStatus={markConverted}
                  onDelete={removeTodo}
                />
              ))}
            </div>
          </>
        )}

        {/* 已转任务 / 已归档待办 */}
        {completed.length > 0 && (
          <>
            <div className="mb-2 mt-6 text-my-xs font-medium uppercase tracking-wide text-my-tertiary">
              已转任务 / 已完成 ({completed.length})
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {completed.map((todo) => (
                <TodoCard
                  key={todo.id}
                  todo={todo}
                  onCopyPrompt={copyPrompt}
                  onViewDoc={viewDoc}
                  onToggleStatus={markConverted}
                  onDelete={removeTodo}
                />
              ))}
            </div>
          </>
        )}
        </PageContent>
      </div>
    </div>
  )
}

function TodoCard({
  todo,
  onCopyPrompt,
  onViewDoc,
  onToggleStatus,
  onDelete
}: {
  todo: TodoItem
  onCopyPrompt: (todo: TodoItem) => void
  onViewDoc: (todo: TodoItem) => void
  onToggleStatus: (todo: TodoItem) => void
  onDelete: (todo: TodoItem) => void
}): JSX.Element {
  const isConverted = todo.status === 'converted'
  return (
    <div
      className="my-card flex flex-col p-3.5"
    >
      <div className="mb-1.5 flex items-center gap-2 text-my-xs text-my-tertiary">
        <PriorityBadge priority={todo.priority} />
        <span className="font-mono">{todo.id}</span>
        {todo.source === 'jira' && todo.jiraKey && (
          <span className="my-chip border border-my-line-accent-subtle bg-my-accent-subtle text-my-accent-text">
            Jira {todo.jiraKey}
          </span>
        )}
        <span className="ml-auto font-mono text-my-2xs text-my-tertiary">{todo.createdAt}</span>
      </div>

      <div
        onClick={() => onViewDoc(todo)}
        className="cursor-pointer font-medium leading-5 text-my-primary transition-colors hover:text-my-accent-text"
      >
        <div className="line-clamp-2 text-my-xs">{todo.title}</div>
      </div>

      {todo.description && (
        <div className="mt-1 line-clamp-2 text-my-xs leading-4 text-my-tertiary">
          {todo.description.replace(/^#+ .*/g, '').trim()}
        </div>
      )}

      <div className="mt-1.5 flex items-center gap-1.5 text-my-xs font-mono text-my-tertiary">
        <FileText size={10} className="text-my-icon-accent" />
        <span className="truncate">{todo.filePath}</span>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-1.5 border-t border-my-line pt-2.5">
        <Button
          variant="primary"
          size="sm"
          onClick={() => onCopyPrompt(todo)}
          title="复制供 Codex / ZCode 读取并认领的 Prompt"
        >
          <Copy size={11} /> 复制认领指令
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onViewDoc(todo)}
          title="在右侧编辑器中查看与编辑该 Markdown 文档"
        >
          <FileText size={11} /> 查看文档
        </Button>
        {todo.jiraUrl && (
          <Button
            variant="ghost"
            size="sm"
            className="text-my-tertiary hover:text-my-accent-text"
            onClick={() => {
              if (!todo.jiraUrl) return
              void api.openExternal(todo.jiraUrl)
            }}
            title="在浏览器中打开 Jira"
          >
            <ExternalLink size={11} />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-my-tertiary hover:text-my-accent-text"
          onClick={() => onToggleStatus(todo)}
          title={isConverted ? '恢复为待规划' : '标记为已转任务'}
        >
          <CheckCircle2 size={12} className={isConverted ? 'text-my-icon-accent' : ''} />
          {isConverted ? '已转' : '完成'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-my-tertiary hover:text-my-danger-text"
          onClick={() => onDelete(todo)}
          title="删除本地待办文件"
        >
          <Trash2 size={11} />
        </Button>
      </div>
    </div>
  )
}
