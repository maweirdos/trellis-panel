import { join } from 'node:path'
import { createAcpJobOwner, recoverAcpJobOwner, type AcpJobOwner } from '../../workcopy-use/acp-jobs'
import type { ApplicationProcessContainer } from '../types'
import { runtimeDirectory } from './persistence'

/** Same native Job implementation and lease owner; no second process authority. */
export function applicationProcessContainer(root: string, owner: ApplicationProcessContainer['owner']): ApplicationProcessContainer {
  return { scheme: 'windows-job-v1', directory: join(runtimeDirectory(), 'process-jobs'), root, owner: { ...owner } }
}
export function prepareApplicationJob(container: ApplicationProcessContainer): Promise<AcpJobOwner> {
  return createAcpJobOwner(container.directory, container.root, container.owner)
}
export function recoverApplicationJob(container: ApplicationProcessContainer): Promise<boolean> {
  return recoverAcpJobOwner(container.directory, container.owner)
}
