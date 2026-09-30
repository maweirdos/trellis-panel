import { contextBridge, ipcRenderer } from 'electron'
import { ipcEvent, ipcInvoke } from '../shared/ipc-channels'
import type {
  AiConfig,
  ChatMessage,
  ChatDoneEvent,
  ChatOutputEvent,
  ExtKind,
  GatewaySecurityConfig,
  GitLabConfig,
  InboxNewEvent,
  JiraConfig,
  KbLibrary,
  ModelProvider,
  ProjectSnapshot,
  RunDoneEvent,
  RunEvent,
  Settings,
  TaskPatch,
  ToastEvent,
  WeknoraConfig,
  MaterialUpdatedEvent
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  pickProject: () => ipcRenderer.invoke(ipcInvoke.project.pick),
  openProject: (root: string) => ipcRenderer.invoke(ipcInvoke.project.open, root),
  getSnapshot: () => ipcRenderer.invoke(ipcInvoke.project.snapshot),
  closeProject: () => ipcRenderer.invoke(ipcInvoke.project.close),
  onSnapshotUpdated: (cb: (s: ProjectSnapshot) => void) => subscribe(ipcEvent.snapshotUpdated, cb),

  updateTask: (taskDir: string, patch: TaskPatch, expectedMtime?: number) =>
    ipcRenderer.invoke(ipcInvoke.task.update, taskDir, patch, expectedMtime),
  deleteTask: (taskDir: string, expectedMtime?: number) =>
    ipcRenderer.invoke(ipcInvoke.task.delete, taskDir, expectedMtime),
  createTaskFromJira: (input: Record<string, unknown>) => ipcRenderer.invoke(ipcInvoke.task.createFromJira, input),
  readTextFile: (absPath: string) => ipcRenderer.invoke(ipcInvoke.fs.readText, absPath),
  writeSpecFile: (absPath: string, content: string, expectedMtime?: number) =>
    ipcRenderer.invoke(ipcInvoke.fs.writeSpec, absPath, content, expectedMtime),
  specBacklinks: () => ipcRenderer.invoke(ipcInvoke.spec.backlinks),
  revealInExplorer: (p: string) => ipcRenderer.invoke(ipcInvoke.shell.reveal, p),
  openInEditor: (p: string) => ipcRenderer.invoke(ipcInvoke.shell.openInEditor, p),
  openExternal: (url: string) => ipcRenderer.invoke(ipcInvoke.shell.openExternal, url),

  getSettings: () => ipcRenderer.invoke(ipcInvoke.settings.get),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(ipcInvoke.settings.set, patch),

  runCli: (args: string[]) => ipcRenderer.invoke(ipcInvoke.cli.run, args),
  abortCli: (runId: number) => ipcRenderer.invoke(ipcInvoke.cli.abort, runId),
  onCliOutput: (cb: (e: RunEvent) => void) => subscribe(ipcEvent.cliOutput, cb),
  onCliDone: (cb: (e: RunDoneEvent) => void) => subscribe(ipcEvent.cliDone, cb),

  gitTaskInfo: (dirName: string) => ipcRenderer.invoke(ipcInvoke.git.taskInfo, dirName),
  gitCreateBranch: (name: string, fromBase: string) => ipcRenderer.invoke(ipcInvoke.git.createBranch, name, fromBase),

  getAnalytics: () => ipcRenderer.invoke(ipcInvoke.analytics.get),
  generateReport: (scope: 'personal' | 'team') => ipcRenderer.invoke(ipcInvoke.report.generate, scope),
  saveReport: (fileName: string, markdown: string) => ipcRenderer.invoke(ipcInvoke.report.save, fileName, markdown),

  channelList: () => ipcRenderer.invoke(ipcInvoke.channel.list),
  channelSend: (name: string, text: string) => ipcRenderer.invoke(ipcInvoke.channel.send, name, text),
  channelAction: (args: string[]) => ipcRenderer.invoke(ipcInvoke.channel.action, args),
  channelDispatch: (input: { taskDir?: string; text?: string; channel?: string }) =>
    ipcRenderer.invoke(ipcInvoke.channel.dispatch, input),

  studioScan: () => ipcRenderer.invoke(ipcInvoke.studio.scan),
  studioRead: (absPath: string) => ipcRenderer.invoke(ipcInvoke.studio.read, absPath),
  studioWrite: (absPath: string, content: string, expectedMtime?: number) =>
    ipcRenderer.invoke(ipcInvoke.studio.write, absPath, content, expectedMtime),
  studioSetConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke(ipcInvoke.studio.setConfig, patch),
  studioSetDeveloper: (content: string) => ipcRenderer.invoke(ipcInvoke.studio.setDeveloper, content),
  studioCreateWorkflow: (id: string) => ipcRenderer.invoke(ipcInvoke.studio.createWorkflow, id),
  studioCreateExtension: (kind: ExtKind, platform: string, name: string) =>
    ipcRenderer.invoke(ipcInvoke.studio.createExtension, kind, platform, name),
  studioDeleteFile: (absPath: string) => ipcRenderer.invoke(ipcInvoke.studio.delete, absPath),

  kbSearch: (library: KbLibrary | 'all', query: string) => ipcRenderer.invoke(ipcInvoke.kb.search, library, query),
  kbSaveNote: (fileName: string, content: string) => ipcRenderer.invoke(ipcInvoke.kb.saveNote, fileName, content),
  kbDeleteNote: (fileName: string) => ipcRenderer.invoke(ipcInvoke.kb.deleteNote, fileName),
  kbQaHistory: () => ipcRenderer.invoke(ipcInvoke.kb.qaHistory),
  kbQaSave: (entry: { question: string; answer: string; sources?: Array<{ title: string; path: string; library?: string }> }) =>
    ipcRenderer.invoke(ipcInvoke.kb.qaSave, entry),
  kbQaClear: () => ipcRenderer.invoke(ipcInvoke.kb.qaClear),

  flowList: () => ipcRenderer.invoke(ipcInvoke.flow.list),
  flowRead: (id: string) => ipcRenderer.invoke(ipcInvoke.flow.read, id),
  flowSave: (def: import('../shared/types').FlowDef) => ipcRenderer.invoke(ipcInvoke.flow.save, def),
  flowDelete: (id: string) => ipcRenderer.invoke(ipcInvoke.flow.delete, id),
  flowGenerate: (description: string) => ipcRenderer.invoke(ipcInvoke.flow.generate, description),
  flowTemplates: () => ipcRenderer.invoke(ipcInvoke.flow.templates),
  flowInstallTemplate: (def: import('../shared/types').FlowDef) => ipcRenderer.invoke(ipcInvoke.flow.installTemplate, def),
  flowRun: (id: string, input: Record<string, string>) => ipcRenderer.invoke(ipcInvoke.flow.run, id, input),
  flowAbort: (runId: string) => ipcRenderer.invoke(ipcInvoke.flow.abort, runId),
  flowRuns: (limit?: number) => ipcRenderer.invoke(ipcInvoke.flow.runs, limit),
  onFlowOutput: (cb: (e: import('../shared/types').FlowRunEvent) => void) => subscribe(ipcEvent.flowOutput, cb),
  onFlowDone: (cb: (e: { runId: string; flowId: string; status: string; error?: string; flowName?: string }) => void) =>
    subscribe(ipcEvent.flowDone, cb),

  /* WeKnora 桥接统一兜底：旧主进程（无对应通道）时降级为 ok:false，不产生未处理 rejection */
  weknoraTest: (cfg: WeknoraConfig) =>
    ipcRenderer.invoke(ipcInvoke.weknora.test, cfg).catch((e: Error) => ({ ok: false, error: e?.message ?? String(e) })),
  weknoraSearch: (query: string, limit?: number) =>
    ipcRenderer
      .invoke(ipcInvoke.weknora.search, query, limit)
      .catch((e: Error) => ({ ok: false, error: e?.message ?? String(e), hits: [], elapsedMs: 0 })),
  weknoraListDocs: (kbId: string) =>
    ipcRenderer.invoke(ipcInvoke.weknora.listDocs, kbId).catch((e: Error) => ({ ok: false, error: e?.message ?? String(e) })),
  weknoraRead: (knowledgeId: string) =>
    ipcRenderer.invoke(ipcInvoke.weknora.read, knowledgeId).catch((e: Error) => ({ ok: false, error: e?.message ?? String(e) })),
  weknoraTestMcp: (url: string, token: string) =>
    ipcRenderer.invoke(ipcInvoke.weknora.testMcp, url, token).catch((e: Error) => ({ ok: false, error: e?.message ?? String(e) })),

  aiChat: (messages: ChatMessage[]) => ipcRenderer.invoke(ipcInvoke.ai.chat, messages),
  aiTest: (cfg: AiConfig) => ipcRenderer.invoke(ipcInvoke.ai.test, cfg),
  aiFetchModels: (provider: ModelProvider) => ipcRenderer.invoke(ipcInvoke.ai['fetch-models'], provider),
  aiTestModel: (provider: ModelProvider, modelId: string) => ipcRenderer.invoke(ipcInvoke.ai['test-model'], provider, modelId),
  aiPrdDraft: (dirName: string) => ipcRenderer.invoke(ipcInvoke.ai.prdDraft, dirName),
  aiSummary: (dirName: string) => ipcRenderer.invoke(ipcInvoke.ai.summary, dirName),
  aiPlan: (input: { title: string; description: string; jiraKey?: string; jiraUrl?: string }) =>
    ipcRenderer.invoke(ipcInvoke.ai.plan, input),
  taskCreateFromPlan: (input: Record<string, unknown>) => ipcRenderer.invoke(ipcInvoke.task.createFromPlan, input),
  planHandoff: (dirName: string) => ipcRenderer.invoke(ipcInvoke.plan.handoff, dirName),
  aiSplitEpic: (dirName: string) => ipcRenderer.invoke(ipcInvoke.ai.splitEpic, dirName),
  aiCommitMsg: (dirName: string) => ipcRenderer.invoke(ipcInvoke.ai.commitMsg, dirName),
  aiPrDesc: (dirName: string) => ipcRenderer.invoke(ipcInvoke.ai.prDesc, dirName),
  taskWriteArtifact: (dirName: string, fileName: string, content: string) =>
    ipcRenderer.invoke(ipcInvoke.task.writeArtifact, dirName, fileName, content),
  taskResolveClipboardTask: () =>
    ipcRenderer.invoke(ipcInvoke.task.resolveClipboardTask) as Promise<
      { ok: true; dirName: string; archived: boolean } | { ok: false; error: string }
    >,

  kbMcpInstall: () => ipcRenderer.invoke(ipcInvoke.kbmcp.install),
  kbMcpStatus: () => ipcRenderer.invoke(ipcInvoke.kbmcp.status),

  gatewayStatus: () => ipcRenderer.invoke(ipcInvoke.gateway.status),
  gatewaySearch: (query: string, limit?: number) => ipcRenderer.invoke(ipcInvoke.gateway.search, query, limit),
  gatewayRecentLogs: () => ipcRenderer.invoke(ipcInvoke.gateway.recentLogs),
  gatewaySyncSpec: (remoteDocId: string, targetFileName: string) =>
    ipcRenderer.invoke(ipcInvoke.gateway.syncSpec, remoteDocId, targetFileName),
  gatewayTestProvider: (providerId: string) => ipcRenderer.invoke(ipcInvoke.gateway.testProvider, providerId),
  gatewayTestTool: (toolName: string, args: Record<string, unknown>) =>
    ipcRenderer.invoke(ipcInvoke.gateway.testTool, toolName, args),
  gatewayUpdateSecurity: (security: GatewaySecurityConfig) =>
    ipcRenderer.invoke(ipcInvoke.gateway.updateSecurity, security),

  accessStatus: () => ipcRenderer.invoke(ipcInvoke.access.status),
  accessRotateToken: () => ipcRenderer.invoke(ipcInvoke.access.rotateToken),

  chatList: () => ipcRenderer.invoke(ipcInvoke.chat.list),
  chatOpen: (id: string) => ipcRenderer.invoke(ipcInvoke.chat.open, id),
  chatNew: (binding?: { providerId?: string; modelId?: string }) => ipcRenderer.invoke(ipcInvoke.chat.new, binding),
  chatDelete: (id: string) => ipcRenderer.invoke(ipcInvoke.chat.delete, id),
  chatRename: (id: string, title: string) => ipcRenderer.invoke(ipcInvoke.chat.rename, id, title),
  chatSend: (input: {
    sessionId: string
    content: string
    providerId?: string
    modelId?: string
    thinkingLevel?: import('../shared/types').ThinkingLevel
    images?: string[]
    agent?: boolean
    taskDir?: string | null
  }) => ipcRenderer.invoke(ipcInvoke.chat.send, input),
  chatRegenerate: (sessionId: string) => ipcRenderer.invoke(ipcInvoke.chat.regenerate, sessionId),
  chatEditResend: (sessionId: string, messageId: string, content: string) =>
    ipcRenderer.invoke(ipcInvoke.chat.edit, sessionId, messageId, content),
  chatBranch: (sessionId: string, messageId: string) =>
    ipcRenderer.invoke(ipcInvoke.chat.branch, sessionId, messageId),
  chatSteer: (sessionId: string, content: string) => ipcRenderer.invoke(ipcInvoke.chat.steer, sessionId, content),
  chatScreenshot: () => ipcRenderer.invoke(ipcInvoke.chat.screenshot),
  chatResolvePermission: (permId: string, decision: 'allow-once' | 'allow-session' | 'deny') =>
    ipcRenderer.invoke(ipcInvoke.chat.permissionResolve, permId, decision),
  onChatPermission: (cb: (e: import('../shared/types').ChatPermissionEvent) => void) => subscribe(ipcEvent.chatPermission, cb),
  onChatSteer: (cb: (e: import('../shared/types').ChatSteerEvent) => void) => subscribe(ipcEvent.chatSteer, cb),
  chatAbort: (sessionId: string) => ipcRenderer.invoke(ipcInvoke.chat.abort, sessionId),
  chatDistill: (sessionId: string, messageId: string) => ipcRenderer.invoke(ipcInvoke.chat.distill, sessionId, messageId),
  onChatOutput: (cb: (e: ChatOutputEvent) => void) => subscribe(ipcEvent.chatOutput, cb),
  onChatDone: (cb: (e: ChatDoneEvent) => void) => subscribe(ipcEvent.chatDone, cb),

  studioSyncExtension: (sourcePath: string, targets: string[]) =>
    ipcRenderer.invoke(ipcInvoke.studio.syncExtension, sourcePath, targets),

  generateStandup: () => ipcRenderer.invoke(ipcInvoke.report.standup),

  installTpanel: () => ipcRenderer.invoke(ipcInvoke.bridge.installTpanel),
  installTrellisHooks: () => ipcRenderer.invoke(ipcInvoke.bridge.installHooks),
  pullPendingFocus: () => ipcRenderer.invoke(ipcInvoke.bridge.pullFocus),
  copyToClipboard: (text: string) => ipcRenderer.invoke(ipcInvoke.util.clipboard, text),
  setCapsuleMode: (on: boolean) => ipcRenderer.send(ipcInvoke.win.capsule, on),
  setCapsuleOnTop: (on: boolean) => ipcRenderer.invoke(ipcInvoke.capsule.onTop, on),
  setCapsuleShape: (shape: 'pill' | 'card') => ipcRenderer.invoke(ipcInvoke.capsule.setShape, shape),
  closeCapsule: () => ipcRenderer.invoke(ipcInvoke.capsule.close),
  resizeCapsule: (width: number, height: number) => ipcRenderer.invoke(ipcInvoke.capsule.resize, width, height),
  closeQuickTodo: () => ipcRenderer.invoke(ipcInvoke.quicktodo.close),
  onQuickTodoShown: (cb: () => void) => subscribe(ipcEvent.quickTodoShown, cb),
  onToast: (cb: (e: ToastEvent) => void) => subscribe(ipcEvent.toast, cb),
  onBridgeTaskFocus: (cb: (taskDir: string) => void) => subscribe(ipcEvent.bridgeTaskFocus, cb),
  onMaterialUpdated: (cb: (e: MaterialUpdatedEvent) => void) => subscribe(ipcEvent.materialUpdated, cb),
  onFocusLastReading: (cb: () => void) => subscribe(ipcEvent.focusLastReading, cb),
  getMcpInfo: () => ipcRenderer.invoke(ipcInvoke.mcp.info),
  toggleHttpApi: (on: boolean) => ipcRenderer.invoke(ipcInvoke.mcp.toggle, on),

  jiraTest: (cfg: JiraConfig) => ipcRenderer.invoke(ipcInvoke.jira.test, cfg),
  jiraSearch: (cfg: JiraConfig, jql: string) => ipcRenderer.invoke(ipcInvoke.jira.search, cfg, jql),
  jiraTransitions: (cfg: JiraConfig, key: string) => ipcRenderer.invoke(ipcInvoke.jira.transitions, cfg, key),
  jiraTransition: (cfg: JiraConfig, key: string, transitionId: string) =>
    ipcRenderer.invoke(ipcInvoke.jira.transition, cfg, key, transitionId),
  jiraComment: (cfg: JiraConfig, key: string, body: string) => ipcRenderer.invoke(ipcInvoke.jira.comment, cfg, key, body),

  gitlabTest: (cfg: GitLabConfig) => ipcRenderer.invoke(ipcInvoke.gitlab.test, cfg),
  gitlabTaskStatus: (dirName: string) => ipcRenderer.invoke(ipcInvoke.gitlab.taskStatus, dirName),
  gitlabCreateMr: (dirName: string) => ipcRenderer.invoke(ipcInvoke.gitlab.createMr, dirName),

  createTask: (input: { title: string; description: string; priority: string }) =>
    ipcRenderer.invoke(ipcInvoke.task.create, input),

  todoList: () => ipcRenderer.invoke(ipcInvoke.todo.list),
  todoSave: (input: {
    id?: string
    title: string
    description: string
    priority?: string
    source?: 'jira' | 'manual'
    jiraKey?: string
    jiraUrl?: string
    status?: 'pending' | 'converted' | 'dismissed'
  }) => ipcRenderer.invoke(ipcInvoke.todo.save, input),
  todoDelete: (id: string) => ipcRenderer.invoke(ipcInvoke.todo.delete, id),

  onInboxNew: (cb: (e: InboxNewEvent) => void) => subscribe(ipcEvent.inboxNew, cb),

  docsSearch: (query: string, group: 'all' | 'spec' | 'workspace') =>
    ipcRenderer.invoke(ipcInvoke.docs.search, query, group),

  windowMinimize: () => ipcRenderer.send(ipcInvoke.win.minimize),
  windowMaximize: () => ipcRenderer.send(ipcInvoke.win.maximize),
  windowClose: () => ipcRenderer.send(ipcInvoke.win.close),
  onWindowMaximized: (cb: (maximized: boolean) => void) => subscribe(ipcEvent.windowMaximized, cb)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('trellis', api)
