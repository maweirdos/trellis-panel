import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace'
import { gitWorkspace } from '../git-workspace'
import { codeRepositoryIdentity } from '../../../shared/code-repository-identity'
import type { TeamCodeResource } from '../../../shared/team-code-resources'
import { repositoryExecutionIdentity } from '../git-workspace/lib/state'

export interface CruxWorkExecutionProject {
  git: Pick<GitWorkspaceSnapshot, 'repoRoot' | 'branch' | 'head' | 'detached'> | null
  resourceMatched: boolean
}

export interface CruxWorkProjectPreview {
  taskId: string
  taskTitle: string
  root: string
  identity: string
  git: Pick<GitWorkspaceSnapshot, 'repoRoot' | 'branch' | 'head' | 'clean' | 'detached' | 'unborn' | 'revision'> | null
  gitError?: string
  resource?: { resourceId: string; name: string; repositoryUrl: string; matched: boolean }
}

/** Main-only directory identity; a same-named replacement is not the original binding. */
export function cruxWorkProjectIdentity(input: string): string {
  const root = realpathSync.native(input)
  const info = statSync(root, { bigint: true })
  if (!info.isDirectory()) throw new Error('The original engineering directory is unavailable')
  const key = process.platform === 'win32' ? root.toLowerCase() : root
  return createHash('sha256').update(JSON.stringify([key, info.dev.toString(), info.ino.toString(), info.birthtimeNs.toString()])).digest('hex')
}

/** Fresh root/ref/remote verification; changed-file presentation stays in the full preview. */
export async function inspectCruxWorkExecutionProject(root: string, resource?: TeamCodeResource): Promise<CruxWorkExecutionProject> {
  const identity = cruxWorkProjectIdentity(root), actual = await repositoryExecutionIdentity(root)
  if (cruxWorkProjectIdentity(root) !== identity) throw new Error('The original engineering directory changed during verification')
  const expected = resource ? codeRepositoryIdentity(resource.source.repositoryUrl) : null
  return { git: actual ? { repoRoot: actual.repoRoot, branch: actual.branch, head: actual.head, detached: actual.detached } : null,
    resourceMatched: !resource || Boolean(expected && actual?.fetchUrls.some(url => codeRepositoryIdentity(url) === expected)) }
}

export async function inspectCruxWorkProject(root: string, taskId: string, taskTitle: string, resource?: TeamCodeResource): Promise<CruxWorkProjectPreview> {
  const identity = cruxWorkProjectIdentity(root)
  const result = await gitWorkspace.status(root)
  if (cruxWorkProjectIdentity(root) !== identity) throw new Error('The selected engineering directory changed during inspection')
  const resourcePreview = resource ? { resourceId: resource.resourceId, name: resource.name, repositoryUrl: resource.source.repositoryUrl, matched: false } : undefined
  if (result.ok === false) return { taskId, taskTitle, root, identity, git: null, gitError: result.error, ...(resourcePreview ? { resource: resourcePreview } : {}) }
  const { repoRoot, branch, head, clean, detached, unborn, revision } = result.snapshot
  if (resourcePreview && resource) {
    const expected = codeRepositoryIdentity(resource.source.repositoryUrl)
    resourcePreview.matched = expected !== null && result.snapshot.remotes.some((remote) => codeRepositoryIdentity(remote.fetchUrl) === expected)
  }
  return { taskId, taskTitle, root, identity, git: { repoRoot, branch, head, clean, detached, unborn, revision }, ...(resourcePreview ? { resource: resourcePreview } : {}) }
}
