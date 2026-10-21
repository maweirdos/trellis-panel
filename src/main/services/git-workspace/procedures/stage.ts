import type { GitWorkspaceMutationResult } from '../../../../shared/git-workspace'
import type { GitWorkspaceOperationOptions, GitWorkspaceProcedureContext } from '../types'
import { mutatePaths } from '../lib/paths'

export function stage(context: GitWorkspaceProcedureContext, root: string, input: unknown, options: GitWorkspaceOperationOptions): Promise<GitWorkspaceMutationResult> {
  return mutatePaths(context, root, input, false, options)
}
