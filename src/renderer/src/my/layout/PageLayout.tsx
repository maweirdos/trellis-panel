import type { ComponentPropsWithoutRef, JSX } from 'react'
import { clsx } from 'clsx'
import type { Page } from '../../store'

export type PageLayoutVariant = 'full' | 'centered'

/** Every route explicitly chooses one of the two page-width contracts. */
export const PAGE_LAYOUTS = {
  dashboard: 'full',
  tasks: 'full',
  creations: 'full',
  inbox: 'full',
  jira: 'full',
  archive: 'centered',
  analytics: 'full',
  team: 'full',
  crux: 'full',
  knowledge: 'full',
  spec: 'full',
  acp: 'full',
  channels: 'full',
  chat: 'full',
  architecture: 'full',
  studio: 'full',
  models: 'centered',
  settings: 'centered',
  integrations: 'centered',
  gateway: 'centered',
  devtools: 'full'
} satisfies Record<Page, PageLayoutVariant>

type LayoutProps = ComponentPropsWithoutRef<'div'> & { variant: PageLayoutVariant }

/** Full pages retain their pane scroll owners; centered pages scroll only their body. */
export function PageLayout({ variant, className, ...props }: LayoutProps): JSX.Element {
  return <div {...props} data-page-layout={variant} className={clsx('my-page-layout', `my-page-layout--${variant}`, className)} />
}

/** Header, scope note and content share the same width and horizontal gutter. */
export function PageHeader({ className, children, ...props }: ComponentPropsWithoutRef<'header'>): JSX.Element {
  return <header {...props} className={clsx('my-page-header', className)}><div className="my-page-container my-page-header-inner">{children}</div></header>
}

export function PageToolbar({ className, children, ...props }: ComponentPropsWithoutRef<'div'>): JSX.Element {
  return <div {...props} className={clsx('my-page-toolbar', className)}><div className="my-page-container my-page-toolbar-inner">{children}</div></div>
}

export function PageNotice({ className, children, ...props }: ComponentPropsWithoutRef<'div'>): JSX.Element {
  return <div {...props} className={clsx('my-page-notice', className)}><div className="my-page-container">{children}</div></div>
}

type ContentProps = ComponentPropsWithoutRef<'div'> & { variant?: PageLayoutVariant }

/** A horizontal alignment band for pane controls, footers and other compact regions. */
export function PageSection({ variant, className, ...props }: ContentProps): JSX.Element {
  return <div {...props} data-content-layout={variant} className={clsx('my-page-container', className)} />
}

/** Used inside a page or a nested workspace pane; never supply a private max-width. */
export function PageContent({ className, ...props }: ContentProps): JSX.Element {
  return <PageSection {...props} className={clsx('my-page-content', className)} />
}

export function PageBody({ className, ...props }: ComponentPropsWithoutRef<'div'>): JSX.Element {
  return <div {...props} className={clsx('my-page-body my-scrollbar', className)} />
}
