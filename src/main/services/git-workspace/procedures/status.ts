import { gitWorkspaceStatusSchema, type GitWorkspaceStatusResult } from '../../../../shared/git-workspace'
import { workspaceFailure } from '../types'
import { parse, checkScope } from '../lib/helpers'
import { repositoryState } from '../lib/state'

export async function status(root: string, input?: unknown): Promise<GitWorkspaceStatusResult> {
  try {
    const expected = input === undefined ? root : parse(gitWorkspaceStatusSchema, input).expectedRoot
    const selected = checkScope(root, expected)
    const state = await repositoryState(selected)
    return { ok: true, root: selected, snapshot: state.snapshot }
  } catch (error) { return workspaceFailure(error, root) }
}
