import { app, shell } from 'electron'
import { constants, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IpcErrorCode, ipcFail } from '../../shared/ipc-errors'
import { localDocumentLink, supportedLocalDocumentPath, type LocalDocumentOpenResult } from '../../shared/local-document-link'

function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

async function hasRedirectedDescendant(target: string, trustedRoots: string[]): Promise<boolean> {
  const base = parse(target).root
  const segments = relative(base, target).split(sep)
  if (segments.length > 128) return true
  let current = base
  // Walk top-down: following an untrusted junction first can contact an SMB share.
  for (const segment of segments) {
    current = join(current, segment)
    if ((await fs.lstat(current)).isSymbolicLink() && !trustedRoots.some(root => within(current, root))) return true
  }
  return false
}

/** Explicit clicks only. Generated documents open outside the privileged app. */
export async function openLocalDocumentLink(value: unknown, projectRoot: string | null, stillCurrent: () => boolean = () => true): Promise<LocalDocumentOpenResult> {
  const link = localDocumentLink(value)
  if (!link) return ipcFail(IpcErrorCode.InvalidArg, '该链接不是支持的本地文档。支持 HTML、SVG、PDF、Markdown 和文本文件。')
  if (!link.absolute && !projectRoot) return ipcFail(IpcErrorCode.NoProject, '相对文档链接需要先打开所属项目。')
  const target = resolve(projectRoot ?? '', link.path)
  // A Windows drive path must not be reinterpreted as relative on another OS.
  if (link.absolute && !isAbsolute(link.path)) return ipcFail(IpcErrorCode.InvalidArg, '该文档路径不适用于当前系统。')
  if (/^[/\\]{2}/.test(target)) return ipcFail(IpcErrorCode.Denied, '不能打开网络共享中的文档。')
  const rootPaths = link.absolute
    ? [projectRoot, app.getPath('temp'), join(homedir(), '.codex', 'visualizations'), join(homedir(), '.answer-me-with-html', 'pages')]
    : [projectRoot]
  try {
    const trustedRoots = rootPaths.filter((root): root is string => Boolean(root) && !/^[/\\]{2}/.test(root ?? '')).map(root => resolve(root))
    if (await hasRedirectedDescendant(target, trustedRoots)) return ipcFail(IpcErrorCode.Denied, '不能通过符号链接或目录联接打开文档。')
    const roots = (await Promise.all(trustedRoots.map(async root => {
      try { return await fs.realpath(root) } catch { return null }
    }))).filter((root): root is string => root !== null)
    const canonical = await fs.realpath(target)
    const root = roots.find(candidate => within(candidate, canonical))
    if (!root || /^[/\\]{2}/.test(canonical)) return ipcFail(IpcErrorCode.Denied, '只能打开当前项目、临时目录或 AI 生成页面目录中的文档。')
    if (!supportedLocalDocumentPath(canonical)) return ipcFail(IpcErrorCode.Denied, '文档的实际类型不受支持。')
    const stat = await fs.lstat(target)
    if (!stat.isFile() || stat.isSymbolicLink()) return ipcFail(IpcErrorCode.Denied, '链接目标必须是普通文档，不能是文件夹、快捷方式或符号链接。')
    await fs.access(canonical, constants.R_OK)
    const url = pathToFileURL(canonical)
    url.hash = link.fragment
    if (!stillCurrent()) return ipcFail(IpcErrorCode.Conflict, '项目或阅读窗口已变化，未打开本地文档。')
    await shell.openExternal(url.href)
    return { ok: true }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
    if (code === 'ENOENT' || code === 'ENOTDIR') return ipcFail(IpcErrorCode.NotFound, '本地文档不存在，可能已被临时目录清理。请让 AI 重新生成。')
    if (code === 'EACCES' || code === 'EPERM') return ipcFail(IpcErrorCode.Denied, '没有读取该文档的权限，请检查文件权限。')
    return ipcFail(IpcErrorCode.Io, '无法打开本地文档，请检查系统默认应用后重试。')
  }
}
