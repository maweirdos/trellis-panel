import { contextBridge, ipcRenderer } from 'electron'
import type {
  BridgeEvent,
  JiraConfig,
  ProjectSnapshot,
  RunDoneEvent,
  RunEvent,
  Settings,
  TaskPatch,
  ToastEvent
} from '../shared/types'

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
  createTaskFromJira: (input: Record<string, unknown>) => ipcRenderer.invoke('task:createFromJira', input),
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

  /* AI bridge */
  installTpanel: () => ipcRenderer.invoke('bridge:installTpanel'),
  installTrellisHooks: () => ipcRenderer.invoke('bridge:installHooks'),
  copyToClipboard: (text: string) => ipcRenderer.invoke('util:clipboard', text),
  setCapsuleMode: (on: boolean) => ipcRenderer.send('win:capsule', on),
  setCapsuleOnTop: (on: boolean) => ipcRenderer.invoke('capsule:onTop', on),
  launchAiApp: (app: 'codex' | 'zcode' | 'claude', taskDir: string | null) =>
    ipcRenderer.invoke('ai:launch', app, taskDir),
  onToast: (cb: (e: ToastEvent) => void) => subscribe('bridge:toast', cb),
  onBridgeTaskFocus: (cb: (taskDir: string) => void) => subscribe('bridge:focus-task', cb),

  /* Jira */
  jiraTest: (cfg: JiraConfig) => ipcRenderer.invoke('jira:test', cfg),
  jiraSearch: (cfg: JiraConfig, jql: string) => ipcRenderer.invoke('jira:search', cfg, jql),
  jiraTransitions: (cfg: JiraConfig, key: string) => ipcRenderer.invoke('jira:transitions', cfg, key),
  jiraTransition: (cfg: JiraConfig, key: string, transitionId: string) =>
    ipcRenderer.invoke('jira:transition', cfg, key, transitionId),
  jiraComment: (cfg: JiraConfig, key: string, body: string) =>
    ipcRenderer.invoke('jira:comment', cfg, key, body),

  /* window */
  windowMinimize: () => ipcRenderer.send('win:minimize'),
  windowMaximize: () => ipcRenderer.send('win:maximize'),
  windowClose: () => ipcRenderer.send('win:close'),
  onWindowMaximized: (cb: (maximized: boolean) => void) => subscribe('window:maximized', cb)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('trellis', api)

export type { BridgeEvent }
