// 页面（Pages）页（R6）：左侧文档列表 + 右侧可编辑文档（emoji / 标题 / 正文）。
import { useState, type JSX } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { useMy, useProject } from '../store'
import { Button, Dropdown, EmptyState, formatDate, SearchInput } from '../ui'
import type { PageDoc } from '../types'

/** emoji 选择器候选（演示用固定集合） */
const EMOJI_CHOICES = ['📄', '📝', '🎨', '🚀', '📱', '📐', '🧭', '🧪', '📊', '💡', '🔧', '📌']

function EmojiPicker({ current, onPick }: { current: string; onPick: (emoji: string) => void }): JSX.Element {
  return (
    <Dropdown
      align="right"
      width={216}
      trigger={({ toggle }) => (
        <Button variant="ghost" size="sm" onClick={() => toggle()} title="更换图标">
          <span className="text-[13px]">{current}</span>
          <ChevronDown size={12} />
        </Button>
      )}
    >
      {(close) => (
        <div className="grid grid-cols-6 gap-1 p-2">
          {EMOJI_CHOICES.map((e) => (
            <button
              key={e}
              type="button"
              title={e}
              onClick={() => {
                onPick(e)
                close()
              }}
              className="flex h-7 w-7 items-center justify-center rounded text-[15px] hover:bg-my-layer-1-hover"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </Dropdown>
  )
}

export function PagesPage(): JSX.Element {
  const { data, selectedPageDocId, setSelectedPageDoc, updatePageDoc } = useMy()
  const project = useProject()
  const [query, setQuery] = useState('')

  // 只展示当前项目的页面；再按搜索词过滤
  const projectPages = data.pages.filter((p) => p.projectId === project.id)
  const visible = projectPages.filter((p) => p.title.toLowerCase().includes(query.trim().toLowerCase()))
  const selected: PageDoc | undefined = projectPages.find((p) => p.id === selectedPageDocId) ?? projectPages[0]

  // 新建页面：写入 data.pages 头部并选中新页
  const createPage = (): void => {
    const id = `pg-new-${Date.now()}`
    useMy.setState((s) => ({
      data: {
        ...s.data,
        pages: [{ id, projectId: project.id, emoji: '📄', title: '', content: '', updatedAt: '刚刚' }, ...s.data.pages]
      }
    }))
    setSelectedPageDoc(id)
    setQuery('')
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* 左侧文档列表 */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-my-line">
        <div className="space-y-2 p-3">
          <Button variant="neutral" className="w-full justify-center" onClick={() => createPage()}>
            <Plus size={14} />
            新建页面
          </Button>
          <SearchInput value={query} onChange={setQuery} placeholder="搜索页面…" />
        </div>
        <div className="my-scrollbar min-h-0 flex-1 pb-3">
          {visible.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedPageDoc(p.id)}
              className={
                p.id === selected?.id
                  ? 'flex w-full items-center gap-2 bg-my-layer-1-active px-3 py-2 text-left'
                  : 'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-my-layer-1'
              }
            >
              <span className="shrink-0 text-[14px]">{p.emoji}</span>
              <span
                className={
                  p.id === selected?.id
                    ? 'min-w-0 flex-1 truncate text-[12.5px] font-medium text-my-primary'
                    : 'min-w-0 flex-1 truncate text-[12.5px] text-my-secondary'
                }
              >
                {p.title === '' ? '无标题' : p.title}
              </span>
              <span className="shrink-0 text-[11px] text-my-tertiary">{formatDate(p.updatedAt)}</span>
            </button>
          ))}
          {visible.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] text-my-tertiary">没有匹配的页面</div>
          )}
        </div>
      </aside>

      {/* 右侧编辑器 */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-my-line px-4">
          <span className="truncate text-[12px] text-my-tertiary">
            {project.name}
            <span className="mx-1.5 text-my-line-strong">/</span>
            Pages
          </span>
          {selected && (
            <span className="ml-auto">
              <EmojiPicker current={selected.emoji} onPick={(emoji) => updatePageDoc(selected.id, { emoji })} />
            </span>
          )}
        </header>

        {selected ? (
          <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col px-8 py-6">
            <div className="text-[36px] leading-none">{selected.emoji}</div>
            <input
              value={selected.title}
              onChange={(e) => updatePageDoc(selected.id, { title: e.target.value })}
              placeholder="无标题"
              className="mt-3 bg-transparent text-[28px] font-bold text-my-primary outline-none placeholder:text-my-placeholder"
            />
            <textarea
              value={selected.content}
              onChange={(e) => updatePageDoc(selected.id, { content: e.target.value })}
              placeholder="撰写内容…"
              className="my-scrollbar mt-3 min-h-0 flex-1 resize-none bg-transparent text-[14px] leading-7 text-my-secondary outline-none placeholder:text-my-placeholder"
            />
          </div>
        ) : (
          <EmptyState title="还没有页面" description="点击左侧「新建页面」开始撰写。" />
        )}
      </section>
    </div>
  )
}
