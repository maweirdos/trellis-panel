import type { JSX } from 'react'
import feishuIcon from '../assets/integrations/feishu.ico'
import dingtalkIcon from '../assets/integrations/dingtalk.png'
import wecomIcon from '../assets/integrations/wecom.svg'
import wechatIcon from '../assets/integrations/wechat.svg'
import slackIcon from '../assets/integrations/slack.svg'
import weknoraIcon from '../assets/integrations/weknora.ico'
import githubIcon from '../assets/integrations/github.svg'
import gitlabIcon from '../assets/integrations/gitlab.svg'
import jiraIcon from '../assets/integrations/jira.svg'
import giteeIcon from '../assets/integrations/gitee.ico'

export type AppBrandId =
  | 'feishu'
  | 'dingtalk'
  | 'wecom'
  | 'wechat'
  | 'slack'
  | 'weknora'
  | 'github'
  | 'gitlab'
  | 'jira'
  | 'gitee'

const APP_BRAND_MAP: Record<AppBrandId, { src: string; label: string; mode?: 'image' | 'mask' }> = {
  feishu: { src: feishuIcon, label: '飞书' },
  dingtalk: { src: dingtalkIcon, label: '钉钉' },
  wecom: { src: wecomIcon, label: '企业微信' },
  wechat: { src: wechatIcon, label: '微信' },
  slack: { src: slackIcon, label: 'Slack' },
  weknora: { src: weknoraIcon, label: 'WeKnora' },
  github: { src: githubIcon, label: 'GitHub', mode: 'mask' },
  gitlab: { src: gitlabIcon, label: 'GitLab' },
  jira: { src: jiraIcon, label: 'Jira' },
  gitee: { src: giteeIcon, label: 'Gitee' }
}

/** 渲染真实彩色应用品牌图标（飞书 / 钉钉 / 企微 / 微信 / Slack / WeKnora / GitLab / GitHub / Jira 等）。 */
export function AppBrandIcon({
  brand,
  size = 16,
  className = ''
}: {
  brand: AppBrandId
  size?: number
  className?: string
}): JSX.Element {
  const meta = APP_BRAND_MAP[brand]
  if (meta.mode === 'mask') {
    return (
      <span
        role="img"
        aria-label={meta.label}
        title={meta.label}
        className={`inline-block shrink-0 ${className}`}
        style={{
          width: size,
          height: size,
          backgroundColor: 'currentColor',
          maskImage: `url("${meta.src}")`,
          WebkitMaskImage: `url("${meta.src}")`,
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
          maskSize: 'contain',
          WebkitMaskSize: 'contain'
        }}
      />
    )
  }
  return (
    <img
      src={meta.src}
      alt={meta.label}
      title={meta.label}
      draggable={false}
      width={size}
      height={size}
      className={`inline-block shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  )
}

/** 根据 MCP 服务名称自动识别是否匹配已知应用品牌图标。 */
export function inferAppBrandFromName(name: string): AppBrandId | null {
  const lower = name.toLowerCase()
  if (lower.includes('weknora')) return 'weknora'
  if (lower.includes('feishu') || lower.includes('飞书') || lower.includes('lark')) return 'feishu'
  if (lower.includes('dingtalk') || lower.includes('钉钉')) return 'dingtalk'
  if (lower.includes('wecom') || lower.includes('企微') || lower.includes('企业微信')) return 'wecom'
  if (lower.includes('wechat') || lower.includes('微信')) return 'wechat'
  if (lower.includes('slack')) return 'slack'
  if (lower.includes('gitlab')) return 'gitlab'
  if (lower.includes('github')) return 'github'
  if (lower.includes('jira')) return 'jira'
  if (lower.includes('gitee')) return 'gitee'
  return null
}
