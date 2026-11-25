import type { ComponentProps } from 'react'

function Shell(props: ComponentProps<'div'>) {
  return <div {...props} data-slot="composer-shell" className="my-conversation-column acp-composer-region" />
}

function Main(props: ComponentProps<'div'>) {
  return <div {...props} data-chat-composer-main-surface="true" className="relative min-w-0" />
}

function Host({ children, ...props }: ComponentProps<'form'>) {
  return <form {...props} data-slot="composer-host" data-chat-composer-form="true" className="acp-composer conversation-composer"><Main>{children}</Main></form>
}

export const ComposerSurface = { Shell, Host }
