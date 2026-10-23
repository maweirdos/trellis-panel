import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readBounded, writeAtomic } from '../../../daemon/files'
import { IntegrationError } from '../types'
import { gitlabStateSchema, type GitlabState } from './types'

/** Construct only in the leased daemon composition, under its protected directory.
 * The supplied fence is mandatory on reads and writes, including after awaits. */
export class GitlabWorkspaceRepository {
  private readonly path: string
  constructor(daemonDirectory: string, private readonly assertOwner: () => void) { this.path = join(daemonDirectory, 'gitlab-workspace-v1.json') }
  read(): GitlabState {
    this.assertOwner()
    if (!existsSync(this.path)) return { version: 1, bindings: [], accounts: [], permissions: [], previews: [], baselines: [], conflicts: [], effects: [], hookEvents: [], notes: [], failures: [], intents: [] }
    try { return gitlabStateSchema.parse(JSON.parse(readBounded(this.path, 16 * 1024 * 1024))) }
    catch { throw new IntegrationError('GitLab 工作区状态损坏或版本不兼容，已保留原文件', 'io') }
  }
  change<T>(mutate: (state: GitlabState) => T): T {
    const state = this.read()
    const result = mutate(state)
    const next = gitlabStateSchema.parse(state)
    const text = JSON.stringify(next)
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new IntegrationError('GitLab 工作区容量已达上限，请处理历史记录', 'io')
    this.assertOwner()
    writeAtomic(this.path, text)
    return result
  }
}
