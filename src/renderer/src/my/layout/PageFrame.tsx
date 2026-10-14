// 保留功能页面的统一框架：52px 顶栏（面包屑 + 标题）+ 内容区。
import type { JSX, ReactNode } from 'react'
import { useProject } from '../store'

export function PageFrame({ title, parent, children }: { title: string; parent?: string; children: ReactNode }): JSX.Element {
  const project = useProject()
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-my-line px-5">
        <span className="flex items-center gap-1.5 text-my-md text-my-tertiary">
          <span
            className="flex h-4 w-4 items-center justify-center rounded-my-sm text-my-2xs font-semibold text-white"
            style={{ background: project.color }}
          >
            {project.icon.slice(0, 1)}
          </span>
          {project.name}
          <span className="px-0.5 text-my-icon-placeholder">/</span>
          {parent && (
            <>
              {parent}
              <span className="px-0.5 text-my-icon-placeholder">/</span>
            </>
          )}
        </span>
        <span className="text-my-md font-medium text-my-primary">{title}</span>
      </header>
      <div className="my-scrollbar min-h-0 flex-1">{children}</div>
    </div>
  )
}
