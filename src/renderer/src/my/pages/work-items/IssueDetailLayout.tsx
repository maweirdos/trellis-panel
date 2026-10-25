import type { JSX, ReactNode } from 'react'
import { PageContent, PageLayout } from '../../layout/PageLayout'

export interface IssueDetailLayoutProps {
  header: ReactNode
  children: ReactNode
  properties: ReactNode
}

/** Shared detail geometry; the caller owns identity, editing, dismissal and workflow. */
export function IssueDetailLayout({ header, children, properties }: IssueDetailLayoutProps): JSX.Element {
  return (
    <PageLayout variant="full" className="flex-1" style={{ height: 'auto', background: 'inherit' }}>
      <div className="flex h-my-header shrink-0 items-center gap-2 border-b border-my-line px-4">
        {header}
      </div>
      <PageContent variant="full" className="flex min-h-0 flex-1" style={{ padding: 0 }}>
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        <aside className="my-scrollbar w-[260px] shrink-0 overflow-y-auto border-l border-my-line p-3">
          {properties}
        </aside>
      </PageContent>
    </PageLayout>
  )
}
