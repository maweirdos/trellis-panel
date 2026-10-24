import type { JSX } from 'react'
import type { ProviderId } from '../../../../../shared/integrations'
import jira from '../../../assets/integrations/jira.svg'
import github from '../../../assets/integrations/github.svg?url'
import gitlab from '../../../assets/integrations/gitlab.svg'
import gitee from '../../../assets/integrations/gitee.ico'
import dingtalk from '../../../assets/integrations/dingtalk.png'
import feishu from '../../../assets/integrations/feishu.ico'
import weknora from '../../../assets/integrations/weknora.ico'

const ARTWORK = { jira, github, gitlab, gitee, dingtalk, feishu, weknora } satisfies Record<ProviderId, string>

/** Product identity is independent of editor/Agent brands. All art ships offline. */
export function IntegrationProductIcon({ provider, large = false }: { provider: ProviderId; large?: boolean }): JSX.Element {
  const className = `${large ? 'h-10 w-10' : 'h-8 w-8'} inline-block shrink-0 object-contain`
  if (provider === 'github') return <span aria-hidden="true" className={`${className} bg-current text-my-primary`} style={{ maskImage: `url("${ARTWORK[provider]}")`, WebkitMaskImage: `url("${ARTWORK[provider]}")`, maskSize: 'contain', WebkitMaskSize: 'contain', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskPosition: 'center' }} />
  return <img src={ARTWORK[provider]} alt="" aria-hidden="true" draggable={false} className={provider === 'weknora' ? `${className} rounded-my-inset bg-white p-0.5` : className} />
}
