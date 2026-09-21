import { ipcInvoke } from '../../shared/ipc-channels'
import { errorText } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { kbSearch } from '../services/knowledge'
import { kbMcpInstall, kbMcpStatus } from '../services/kbmcp'
import { getProjectRoot } from '../state'
import { handle } from './registry'

const KB_SEARCH_FAIL = { ok: false, hits: [], docs: [], totalDocs: 0, elapsedMs: 0 }

export function registerKnowledgeIpc(): void {
  handle(ipcInvoke.kb.search, (_e, library: string, query: string) => {
    const root = getProjectRoot()
    if (!root) return { ...KB_SEARCH_FAIL, error: '未打开项目' }
    try {
      const lib = ['requirements', 'spec', 'wiki', 'archive'].includes(library) ? library : 'all'
      return kbSearch(root, lib as 'all', String(query ?? ''))
    } catch (e) {
      return { ...KB_SEARCH_FAIL, error: errorText(e, '检索失败') }
    }
  })

  handle(ipcInvoke.kbmcp.install, () => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return kbMcpInstall(root)
  })

  // kbMcpStatus 原生接受 null（未打开项目时返回未安装态），保持原语义
  handle(ipcInvoke.kbmcp.status, () => kbMcpStatus(getProjectRoot()))
}
