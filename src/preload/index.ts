import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectSnapshot, RunDoneEvent, RunEvent, Settings, TaskPatch } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  pickProject: () => ipcRenderer.invoke('project:pick'),
  openProject: (root: string) => ipcRenderer.invoke('project:open', root),
  getSnapshot: () => ipcRenderer.invoke('project:snapshot'),
  closeProject: () => ipcRenderer.invoke('project:close'),
  onSnapshotUpdated: (cb: (s: ProjectSnapshot) => void) => subscribe('project:snapshot', cb),

  updateTask: (taskDir: string, patch: TaskPatch) => ipcRenderer.invoke('task:update', taskDir, patch),
  readTextFile: (absPath: string) => ipcRenderer.invoke('fs:readText', absPath),
  revealInExplorer: (p: string) => ipcRenderer.invoke('shell:reveal', p),
  openInEditor: (p: string) => ipcRenderer.invoke('shell:openInEditor', p),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),

  runCli: (args: string[]) => ipcRenderer.invoke('cli:run', args),
  abortCli: (runId: number) => ipcRenderer.invoke('cli:abort', runId),
  onCliOutput: (cb: (e: RunEvent) => void) => subscribe('cli:output', cb),
  onCliDone: (cb: (e: RunDoneEvent) => void) => subscribe('cli:done', cb),

  windowMinimize: () => ipcRenderer.send('win:minimize'),
  windowMaximize: () => ipcRenderer.send('win:maximize'),
  windowClose: () => ipcRenderer.send('win:close'),
  onWindowMaximized: (cb: (maximized: boolean) => void) => subscribe('window:maximized', cb)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('trellis', api)
