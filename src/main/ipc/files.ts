import { clipboard, shell } from 'electron'
import { ipcInvoke } from '../../shared/ipc-channels'
import { errorText } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { writeSpecFile, computeSpecBacklinks, readTextWithMtime, searchDocs } from '../services/scan'
import { getProjectRoot, sendSnapshot, safeReadText } from '../state'
import { handle } from './registry'

export function registerFilesIpc(): void {
  handle(ipcInvoke.fs.readText, (_e, absPath: string) => {
    const base = safeReadText(absPath)
    if (base.ok) {
      const withM = readTextWithMtime(absPath)
      return { ...base, mtime: withM.mtime }
    }
    return base
  })

  handle(ipcInvoke.fs.writeSpec, (_e, absPath: string, content: string, expectedMtime?: number) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      writeSpecFile(root, absPath, content, expectedMtime)
      sendSnapshot()
      return { ok: true }
    } catch (e) {
      const conflict = typeof e === 'object' && e !== null && 'conflict' in e && Boolean((e as { conflict?: unknown }).conflict)
      const msg = errorText(e, '写入失败')
      if (conflict) return ipcFail(IpcErrorCode.Conflict, msg, { conflict: true })
      return ipcFail(IpcErrorCode.Io, msg)
    }
  })

  handle(ipcInvoke.spec.backlinks, () => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      return { ok: true, counts: computeSpecBacklinks(root) }
    } catch (e) {
      return { ...ipcFail(IpcErrorCode.Io, errorText(e, '统计失败')), counts: {} }
    }
  })

  handle(ipcInvoke.docs.search, (_e, query: string, group: 'all' | 'spec' | 'workspace') => {
    const root = getProjectRoot()
    if (!root) return { ...noProject(), hits: [] }
    try {
      return searchDocs(root, String(query ?? ''), group === 'spec' || group === 'workspace' ? group : 'all')
    } catch (e) {
      return { ...ipcFail(IpcErrorCode.Io, errorText(e, '检索失败')), hits: [] }
    }
  })

  handle(ipcInvoke.shell.reveal, (_e, p: string) => {
    shell.showItemInFolder(p)
  })

  handle(ipcInvoke.shell.openInEditor, (_e, p: string) => {
    if (process.env.VSCODE) shell.openExternal(`vscode://file/${p}`)
    else shell.openPath(p)
  })

  handle(ipcInvoke.shell.openExternal, (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })

  handle(ipcInvoke.util.clipboard, (_e, text: string) => {
    clipboard.writeText(text)
  })
}
