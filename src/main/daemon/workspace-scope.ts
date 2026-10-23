import { AsyncLocalStorage } from 'node:async_hooks'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { WorkspaceGrant } from '../../shared/daemon'
import { installIntegrationWorkspaceHost } from '../services/integrations/workspace-host'
import { scanProject } from '../services/scan'
import type { DaemonRepository } from './repository'
import { DaemonError } from './errors'

/** Request-local identity; retained work supplies its original grant explicitly. */
export class DaemonWorkspaceScope {
  private readonly scope = new AsyncLocalStorage<WorkspaceGrant | null>()
  constructor(private readonly repository: DaemonRepository, private readonly assertOwner: () => void) {
    installIntegrationWorkspaceHost({ root: () => this.current()?.root ?? null, snapshot: () => { const grant = this.current(); return grant ? scanProject(grant.root) : null } })
  }
  current(): WorkspaceGrant | null { return this.scope.getStore() ?? null }
  assert(grant: WorkspaceGrant): void {
    this.assertOwner()
    const current = this.repository.grant(grant.workspaceId)
    if (!current || JSON.stringify(current) !== JSON.stringify(grant) || realpathSync(grant.root) !== grant.root) throw new DaemonError('E_CONFLICT', 'The authorized native workspace identity or grant revision changed.')
  }
  capture(expectedRoot: string): WorkspaceGrant {
    const grant = this.current()
    if (!grant || realpathSync(expectedRoot) !== grant.root) throw new DaemonError('E_DENIED', 'The request root does not match its native workspace grant.')
    this.assert(grant); return grant
  }
  run<T>(grant: WorkspaceGrant | null, action: () => T): T {
    if (grant) this.assert(grant)
    return this.scope.run(grant, action)
  }
  grantForRoot(root: string): WorkspaceGrant | null {
    const physical = realpathSync(root), key = process.platform === 'win32' ? physical.toLowerCase() : physical
    const grant = this.repository.grant(createHash('sha256').update(key).digest('hex'))
    if (grant) this.assert(grant)
    return grant
  }
}
