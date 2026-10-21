import type { GitWorkspaceMutationResult } from '../../../../shared/git-workspace'
import type { GitWorkspaceOperationOptions, GitWorkspaceProcedureContext } from '../types'
import { mutatePaths } from '../lib/paths'

export function unstage(context: GitWorkspaceProcedureContext, root: string, input: unknown, options: GitWorkspaceOperationOptions): Promise<GitWorkspaceMutationResult> {
  return mutatePaths(context, root, input, true, options)
}
