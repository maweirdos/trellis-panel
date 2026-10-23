import { z } from 'zod'
import type { WorkspaceGrant } from '../../shared/daemon'
import { createDingTalkWorkspace, DingTalkRepository, createStableDingTalkStreamFactory, type DingTalkStreamNetwork, type StableDingTalkClient } from '../services/integrations/dingtalk-workspace'
import { DingTalkRest } from '../services/integrations/dingtalk-workspace/rest'
import { protectSecret, revealSecret } from '../services/integrations/credentials'
import { proxyEnabled } from '../services/proxy'
import { getSettings } from '../services/store'
import { IntegrationError } from '../services/integrations/types'
import { digest } from '../services/integrations/dingtalk-workspace/repository'
import type { DaemonContext } from './context'
import type { DaemonRuntime } from './runtime'
import type { DaemonWorkspaceScope } from './workspace-scope'
import { createDingTalkExecution } from './dingtalk-execution'

const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>
export interface DingTalkCompositionInput {
  context: DaemonContext
  assertOwner(): void
  scope: Pick<DaemonWorkspaceScope, 'current' | 'capture' | 'assert'>
  currentGrant(workspaceId: string): WorkspaceGrant | null
  assertAdmission?(grant: WorkspaceGrant): void
  runtime: DaemonRuntime
  /** Optional ws-compatible proxy adapter. Without it, configured proxies are
   * explicitly unavailable; Stream never silently opens a direct connection. */
  streamNetwork?: DingTalkStreamNetwork
  changed?(): void
}
export function createDingTalkComposition(input: DingTalkCompositionInput) {
  const { context, scope } = input
  const assertGrant = (grant: WorkspaceGrant): void => {
    input.assertOwner(); scope.assert(grant)
    input.assertAdmission?.(grant)
    const current = input.currentGrant(grant.workspaceId)
    if (!current || current.grantId !== grant.grantId || current.revision !== grant.revision || current.root !== grant.root) throw new IntegrationError('原钉钉工作区授权已变更或撤销', 'denied')
  }
  const repository = new DingTalkRepository(context.directory, { protect: protectSecret, reveal: revealSecret }, input.assertOwner)
  const execution = createDingTalkExecution(input.runtime, assertGrant)
  const rest = new DingTalkRest(undefined, app => { input.assertOwner(); const saved = repository.read().apps.find(item => item.id === app.id && item.revision === app.revision); if (!saved?.secret || saved.state === 'revoked') throw new IntegrationError('原应用已变更或撤销', 'denied') })
  const stream = createStableDingTalkStreamFactory({
    version: '2.1.5', rest,
    async load() {
      input.assertOwner()
      // The official package uses v2.1.5 internally and exports .mjs/.cjs. Use
      // its export map, not the stale package.main path ending in index.js.
      const manifest = z.object({ version: z.string(), license: z.literal('MIT') }).parse(require('dingtalk-stream/package.json'))
      if (manifest.version.replace(/^v/, '') !== '2.1.5') throw new IntegrationError('必须安装官方 dingtalk-stream 2.1.5；当前版本不匹配', 'conflict')
      const module = z.object({ DWClient: z.custom<new (config: { clientId: string; clientSecret: string; keepAlive: boolean; debug: boolean }) => StableDingTalkClient>(value => typeof value === 'function') }).parse(await nativeImport('dingtalk-stream'))
      return { DWClient: module.DWClient }
    },
    network: input.streamNetwork ?? { async socketOptions() { if (proxyEnabled()) throw new IntegrationError('当前已启用代理，但 SDK 2.1.5 的 WebSocket 代理适配尚未配置；已阻止直连', 'denied'); return { mode: 'direct' as const } } }
  })
  const workspace = createDingTalkWorkspace({
    repository, stream, execution, changed: input.changed,
    networkKey: () => digest(getSettings().proxy),
    workspace: {
      current(expectedRoot) {
        input.assertOwner()
        const grant = expectedRoot === null ? null : scope.capture(expectedRoot)
        if (expectedRoot === null && scope.current()) throw new IntegrationError('当前请求包含工作区授权，必须携带对应 expectedRoot', 'conflict')
        return { nativeSubject: context.identity.userId, workspace: grant }
      },
      assertWorkspace: assertGrant
    }
    // Personal OAuth is intentionally absent until main installs a real paired
    // callback-service transport. Local Stream/Agent use requires no team user.
  })
  let started = false
  return { ...workspace, execution, repository,
    async poll() { if (!started && repository.hasBackgroundWork()) { await workspace.start(); started = true } },
    async shutdown() { await workspace.shutdown(); execution.close() }
  }
}
