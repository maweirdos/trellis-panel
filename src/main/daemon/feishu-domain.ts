import { join } from 'node:path'
import { FEISHU_DAEMON, feishuRequests, feishuResults, type FeishuInput, type FeishuMethod, type FeishuOutput } from '../../shared/feishu-integration'
import type { ProviderSchemaParsers } from '../../shared/daemon-domains'
import type { WorkspaceGrant } from '../../shared/daemon'
import { createFeishuVendor } from '../services/integrations/feishu-workspace/vendor'
import { IntegrationError } from '../services/integrations/types'
import { DaemonError } from './errors'
import { createFeishuTaskAssistant } from '../services/integrations/feishu-assistant'
import { feishuRuntimes } from '../services/integrations/feishu-assistant/runtime'
import { installFeishu } from './feishu'
import type { DaemonContext } from './context'
import type { ProviderDomain } from './provider-domain'
import type { DaemonWorkspaceScope } from './workspace-scope'

export function installFeishuDomain(input: {
  context: DaemonContext
  scope: DaemonWorkspaceScope
  domain: ProviderDomain
  assertOwner(): void
  assertWorkspaceAdmission(grant: WorkspaceGrant): void
}) {
  const assertWorkspace = (grant: WorkspaceGrant) => {
    input.scope.assert(grant)
    input.assertWorkspaceAdmission(grant)
  }
  const assistant = createFeishuTaskAssistant({ dataDir: join(input.context.userData, 'team-platform'), assertWorkspace })
  const service = installFeishu({
    directory: input.context.directory,
    assertOwner: input.assertOwner,
    capture: root => input.scope.capture(root),
    assertGrant: assertWorkspace,
    vendor: createFeishuVendor(),
    validateTarget: assistant.validateTarget,
    runtimes: feishuRuntimes,
    authorize: assistant.authorize,
    linkMember: assistant.linkMember,
    recover: assistant.recover,
    run: (request, signal) => request.agentId
      ? assistant.runAgent({ ...request, agentId: request.agentId }, signal)
      : assistant.run(request, signal)
  })
  const requests: ProviderSchemaParsers<typeof feishuRequests> = feishuRequests
  const responses: ProviderSchemaParsers<typeof feishuResults> = feishuResults
  function bind<M extends FeishuMethod>(method: M): void {
    input.domain.add<FeishuInput<M>, FeishuOutput<M>>(FEISHU_DAEMON[method], requests[method], responses[method], async request => {
      try { return await service.actions[method](request) }
      catch (error) {
        if (!(error instanceof IntegrationError)) throw error
        const codes = { invalid: 'E_INVALID_ARG', denied: 'E_DENIED', upstream: 'E_UNAVAILABLE', io: 'E_IO', conflict: 'E_CONFLICT', uncertain: 'E_UNKNOWN' } as const
        throw new DaemonError(codes[error.kind], error.message, error.kind === 'uncertain' ? 'unknown' : 'not-admitted')
      }
    })
  }
  for (const method of Object.keys(FEISHU_DAEMON) as FeishuMethod[]) bind(method)
  return service
}
