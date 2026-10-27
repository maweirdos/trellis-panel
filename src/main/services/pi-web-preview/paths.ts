import { constants, promises as fs, type Stats } from 'node:fs'
import { execFile } from 'node:child_process'
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { IpcErrorCode } from '../../../shared/ipc-errors'

export const MAX_FILE_BYTES = 16 * 1024 * 1024
export const MAX_TRACKED_BYTES = 64 * 1024 * 1024
const MAX_COMPONENTS = 128
const MAX_METADATA_CACHE = 2048
const windowsMetadata = new Map<string, string>()

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.gltf': 'model/gltf+json', '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf'
}

export class PreviewError extends Error {
  constructor(readonly code: IpcErrorCode, message: string) { super(message) }
}
export const denied = (): never => { throw new PreviewError(IpcErrorCode.Denied, '预览仅允许入口目录内的普通静态文件。') }
export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}
export function within(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}
function localAbsolute(value: string): boolean {
  return isAbsolute(value) && !/^[/\\]{2}/.test(value) && !/[\u0000-\u001f\u007f]/.test(value)
}
function safeComponent(value: string): boolean {
  return Boolean(value) && !value.startsWith('.') && !/[<>:"|?*%/\\\u0000-\u001f\u007f]/.test(value) && !/[. ]$/.test(value) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value) &&
    !/(?:^|[._-])(?:env|secrets?|credentials?|passwords?|tokens?|private|keystore)(?:[._-]|$)/i.test(value) &&
    !/^(?:package(?:-lock)?|tsconfig(?:\..+)?|jsconfig|composer|config|settings|appsettings(?:\..+)?)\.json$/i.test(value)
}
function fingerprint(stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` }

export function clearPreviewMetadata(directory: string): void {
  for (const path of windowsMetadata.keys()) if (within(directory, path)) windowsMetadata.delete(path)
}

// Node's Stats does not expose Windows Hidden/System attributes or mapped-drive ownership.
// A fixed OS metadata query runs without profiles or project commands; paths are data in the environment.
async function checkWindowsMetadata(items: Array<{ path: string; stat: Stats }>): Promise<void> {
  if (process.platform !== 'win32') return
  const pending = items.filter(item => windowsMetadata.get(item.path) !== fingerprint(item.stat))
  if (!pending.length) return
  const source = "$ErrorActionPreference='Stop'; foreach($p in (ConvertFrom-Json -InputObject $env:TRELLIS_PREVIEW_METADATA_PATHS)) { $i=Get-Item -Force -LiteralPath $p; if (($i.Attributes -band [IO.FileAttributes]::Hidden) -or ($i.Attributes -band [IO.FileAttributes]::System) -or ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $i.PSDrive.DisplayRoot) { exit 3 } }; exit 0"
  await new Promise<void>((done, reject) => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    execFile(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096, env: { ...process.env, TRELLIS_PREVIEW_METADATA_PATHS: JSON.stringify(pending.map(item => item.path)) } },
      error => error ? reject(new PreviewError(IpcErrorCode.Denied, '不能预览隐藏、系统、重定向或网络共享文件。')) : done())
  })
  for (const item of pending) {
    if (windowsMetadata.size >= MAX_METADATA_CACHE) windowsMetadata.delete(windowsMetadata.keys().next().value ?? '')
    windowsMetadata.set(item.path, fingerprint(item.stat))
  }
}

/** Walk from the volume root before realpath/open, so a junction is never deliberately followed. */
async function inspect(project: string, target: string, directory: boolean): Promise<Stats> {
  if (!localAbsolute(project) || !localAbsolute(target) || !within(project, target)) denied()
  const base = parse(target).root
  const parts = relative(base, target).split(sep)
  if (parts.length > MAX_COMPONENTS) denied()
  let current = base
  let last = await fs.lstat(base)
  const metadata: Array<{ path: string; stat: Stats }> = []
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i])
    last = await fs.lstat(current)
    if (last.isSymbolicLink() || (i < parts.length - 1 || directory ? !last.isDirectory() : !last.isFile())) denied()
    if (within(project, current)) {
      if (!safeComponent(parts[i])) denied()
      metadata.push({ path: current, stat: last })
    }
  }
  const canonicalProject = await fs.realpath(project)
  const canonicalTarget = await fs.realpath(target)
  if (!localAbsolute(canonicalProject) || !localAbsolute(canonicalTarget) || !within(canonicalProject, canonicalTarget)) denied()
  if (!safeComponent(basename(canonicalProject)) || !directory && !MIME[extname(canonicalTarget).toLowerCase()]) denied()
  if (!relative(canonicalProject, canonicalTarget).split(sep).filter(Boolean).every(safeComponent)) denied()
  if (!directory && last.nlink !== 1) denied()
  await checkWindowsMetadata(metadata)
  return last
}

export async function previewEntry(project: string, cwd: string, path: string): Promise<{ entry: string; directory: string }> {
  if (!localAbsolute(project) || !localAbsolute(cwd) || !within(project, cwd)) denied()
  if (isAbsolute(path) || /^[a-z]:/i.test(path)) denied()
  const entry = resourcePath(project, path.split(/[/\\]/))
  if (!/\.html?$/i.test(entry) || !within(project, entry)) denied()
  await inspect(project, cwd, true)
  await inspect(project, entry, false)
  return { entry, directory: dirname(entry) }
}

export function resourcePath(directory: string, segments: string[]): string {
  if (!segments.length || segments.length > MAX_COMPONENTS || !segments.every(safeComponent)) denied()
  const target = resolve(directory, ...segments)
  if (!within(directory, target) || !MIME[extname(target).toLowerCase()]) denied()
  return target
}

export async function readPreviewFile(project: string, directory: string, target: string): Promise<{ bytes: Buffer; mime: string }> {
  if (!within(directory, target)) denied()
  const mime = MIME[extname(target).toLowerCase()]
  if (!mime) denied()
  const before = await inspect(project, target, false)
  if (before.size > MAX_FILE_BYTES) throw new PreviewError(IpcErrorCode.Denied, '静态文件超过 16 MiB 预览上限。')
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.nlink !== 1 || fingerprint(opened) !== fingerprint(before)) denied()
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await inspect(project, target, false)
    if (offset !== before.size || fingerprint(after) !== fingerprint(opened) || fingerprint(await file.stat()) !== fingerprint(opened))
      throw new PreviewError(IpcErrorCode.Conflict, '静态文件正在修改，请稍后刷新。')
    return { bytes: bytes.subarray(0, offset), mime }
  } finally { await file.close() }
}
