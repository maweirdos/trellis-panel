/**
 * IPC 通道中央注册表 —— 主进程与 preload 的唯一事实源（决策 TPD-001/TPD-002）。
 *
 * 约定：
 * 1. invoke 通道统一 `<domain>:<action>`；主进程 → 渲染层的事件通道集中在 `ipcEvent` 节，
 *    与 invoke 通道在命名上即可区分（Electron 两者共享一个命名空间，靠注册表分节管理）。
 * 2. 任何 `ipcMain.handle/on`、`ipcRenderer.invoke/send/on` 必须引用本表常量，
 *    禁止散落字符串字面量；新增通道先在此登记。
 * 3. 长任务事件流：runId 关联 + `<domain>:output` / `<domain>:done` 成对事件（参照 cli 域），
 *    禁止用单次巨型 invoke 响应承载流式输出。
 *
 * 字面量保持历史 `<domain>:<action>` 形态（决策 TPD-002）：不改名、零回归，
 * 改造的本质是"结构化收口"而非重命名。
 */

/** 主进程提供的 invoke 通道（渲染层请求 → 响应） */
export const ipcInvoke = {
  project: {
    pick: 'project:pick',
    open: 'project:open',
    snapshot: 'project:snapshot',
    close: 'project:close'
  },
  task: {
    update: 'task:update',
    delete: 'task:delete',
    create: 'task:create',
    createFromJira: 'task:createFromJira',
    createFromPlan: 'task:createFromPlan',
    linkSubtask: 'task:linkSubtask',
    writeArtifact: 'task:writeArtifact',
    resolveClipboardTask: 'task:resolveClipboardTask',
    buildTaskLink: 'task:buildTaskLink',
    handoffBuild: 'task:handoffBuild',
    contextExpect: 'task:contextExpect',
    dispatchReview: 'task:dispatchReview',
    dispatchPlan: 'task:dispatchPlan',
    dispatchAbort: 'task:dispatchAbort'
  },
  todo: {
    list: 'todo:list',
    save: 'todo:save',
    delete: 'todo:delete'
  },
  fs: {
    readText: 'fs:readText',
    writeSpec: 'fs:writeSpec'
  },
  document: {
    /** S0 G2：文档限界读取（revision/诊断契约，design §5.1） */
    read: 'document:read',
    /** S0 G2：行级版本比较（jsdiff worker，2MiB/侧 + 1s 超时，design §6.2） */
    diff: 'document:diff',
    /** S0 G2 第三片：渲染端注册"当前打开的阅读会话"以接收定向变更信号（design §5.2） */
    watch: 'document:watch',
    /** S0 G2 第三片：解除会话监听（引用计数归零才真正停发） */
    unwatch: 'document:unwatch'
  },
  observation: {
    /** S0 G3：观测事件查询（limit≤100；cursor epoch 不符 → resetRequired，design §5.1） */
    query: 'observation:query',
    /** S0 G3：订阅增量（快照基准 cursor + 独立高水位轮询推送） */
    subscribe: 'observation:subscribe',
    /** S0 G3：解除订阅（项目切换由主进程 generation 兜底取消） */
    unsubscribe: 'observation:unsubscribe',
    /** S0 G3 第二片：绑定/健康综合状态（含绑定 workspaceId，供渲染端组 scope） */
    health: 'observation:health',
    /** S0 G3 第二片：启用/停用采集（需已有绑定；未绑定为中性事实不是错误） */
    setEnabled: 'observation:set-enabled',
    /** S0 G3 第二片：清理观测（retention=保留策略清理；all=清空观测记录，epoch 更换） */
    cleanup: 'observation:cleanup',
    /** G3 走查补全：首次显式绑定（design §3.1；未绑定分支的唯一入口） */
    bind: 'observation:bind'
  },
  spec: {
    backlinks: 'spec:backlinks'
  },
  docs: {
    search: 'docs:search'
  },
  git: {
    taskInfo: 'git:taskInfo',
    createBranch: 'git:createBranch'
  },
  devtools: {
    gitStatus: 'devtools:gitStatus',
    gitFileDiff: 'devtools:gitFileDiff',
    listScripts: 'devtools:listScripts',
    devRunStart: 'devtools:devRunStart',
    devRunStop: 'devtools:devRunStop',
    devRunStopAll: 'devtools:devRunStopAll',
    devRunList: 'devtools:devRunList',
    devRunGet: 'devtools:devRunGet'
  },
  analytics: {
    get: 'analytics:get'
  },
  report: {
    generate: 'report:generate',
    standup: 'report:standup',
    save: 'report:save'
  },
  channel: {
    list: 'channel:list',
    send: 'channel:send',
    action: 'channel:action',
    dispatch: 'channel:dispatch'
  },
  studio: {
    scan: 'studio:scan',
    read: 'studio:read',
    write: 'studio:write',
    delete: 'studio:delete',
    setConfig: 'studio:setConfig',
    setDeveloper: 'studio:setDeveloper',
    createWorkflow: 'studio:createWorkflow',
    createExtension: 'studio:createExtension',
    syncExtension: 'studio:syncExtension'
  },
  kb: {
    search: 'kb:search',
    saveNote: 'kb:saveNote',
    deleteNote: 'kb:deleteNote',
    qaHistory: 'kb:qaHistory',
    qaSave: 'kb:qaSave',
    qaClear: 'kb:qaClear'
  },
  flow: {
    list: 'flow:list',
    read: 'flow:read',
    save: 'flow:save',
    delete: 'flow:delete',
    generate: 'flow:generate',
    templates: 'flow:templates',
    installTemplate: 'flow:installTemplate',
    run: 'flow:run',
    abort: 'flow:abort',
    runs: 'flow:runs'
  },
  kbmcp: {
    install: 'kbmcp:install',
    status: 'kbmcp:status'
  },
  weknora: {
    test: 'weknora:test',
    search: 'weknora:search',
    listDocs: 'weknora:listDocs',
    read: 'weknora:read',
    testMcp: 'weknora:testMcp'
  },
  gateway: {
    status: 'gateway:status',
    search: 'gateway:search',
    recentLogs: 'gateway:recentLogs',
    syncSpec: 'gateway:syncSpec',
    testProvider: 'gateway:testProvider',
    testTool: 'gateway:testTool',
    updateSecurity: 'gateway:updateSecurity'
  },
  access: {
    status: 'access:status',
    rotateToken: 'access:rotateToken'
  },
  chat: {
    list: 'chat:list',
    open: 'chat:open',
    new: 'chat:new',
    delete: 'chat:delete',
    rename: 'chat:rename',
    send: 'chat:send',
    abort: 'chat:abort',
    regenerate: 'chat:regenerate',
    edit: 'chat:edit',
    branch: 'chat:branch',
    steer: 'chat:steer',
    permissionResolve: 'chat:permission-resolve',
    screenshot: 'chat:screenshot',
    distill: 'chat:distill'
  },
  ai: {
    chat: 'ai:chat',
    test: 'ai:test',
    'fetch-models': 'ai:fetch-models',
    'test-model': 'ai:test-model',
    prdDraft: 'ai:prdDraft',
    summary: 'ai:summary',
    plan: 'ai:plan',
    splitEpic: 'ai:splitEpic',
    commitMsg: 'ai:commitMsg',
    prDesc: 'ai:prDesc'
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set'
  },
  desktop: {
    setExplorerMenu: 'desktop:setExplorerMenu'
  },
  doc: {
    open: 'doc:open',
    read: 'doc:read',
    setPin: 'doc:setPin'
  },
  cli: {
    run: 'cli:run',
    abort: 'cli:abort'
  },
  bridge: {
    installTpanel: 'bridge:installTpanel',
    installHooks: 'bridge:installHooks',
    pullFocus: 'bridge:pullFocus'
  },
  util: {
    clipboard: 'util:clipboard'
  },
  win: {
    capsule: 'win:capsule',
    minimize: 'win:minimize',
    maximize: 'win:maximize',
    close: 'win:close'
  },
  capsule: {
    onTop: 'capsule:onTop',
    setShape: 'capsule:setShape',
    resize: 'capsule:resize',
    close: 'capsule:close'
  },
  quicktodo: {
    close: 'quicktodo:close'
  },
  mcp: {
    info: 'mcp:info',
    toggle: 'mcp:toggle'
  },
  jira: {
    test: 'jira:test',
    search: 'jira:search',
    /** G4 第二片：Jira 页查询改走分页服务（完整字段 + 完整性口径；旧 jira:search 保留给既有调用方） */
    searchPaged: 'jira:searchPaged',
    transitions: 'jira:transitions',
    transition: 'jira:transition',
    comment: 'jira:comment'
  },
  gitlab: {
    test: 'gitlab:test',
    taskStatus: 'gitlab:taskStatus',
    createMr: 'gitlab:createMr'
  },
  shell: {
    reveal: 'shell:reveal',
    openInEditor: 'shell:openInEditor',
    openExternal: 'shell:openExternal'
  },
  acp: {
    agents: 'acp:agents',
    sessions: 'acp:sessions',
    sessionNew: 'acp:session.new',
    sessionPrompt: 'acp:session.prompt',
    sessionCancel: 'acp:session.cancel',
    sessionKill: 'acp:session.kill',
    permissionRespond: 'acp:permission.respond',
    profiles: 'acp:profiles',
    profileSave: 'acp:profile.save',
    profileDelete: 'acp:profile.delete',
    runtimeRefresh: 'acp:runtime.refresh',
    runtimeSetup: 'acp:runtime.setup',
    runtimeNodePick: 'acp:runtime.node-pick',
    sessionResume: 'acp:session.resume',
    sessionConfigure: 'acp:session.configure',
    sessionBindTask: 'acp:session.bind-task'
  }
} as const

/** 主进程 → 渲染层的事件通道（广播/推送） */
export const ipcEvent = {
  /** Appearance only; never broadcast settings containing credentials. */
  themeChanged: 'settings:themeChanged',
  integrationsChanged: 'integration:changed',
  /** 项目快照刷新（全量推送） */
  snapshotUpdated: 'project:snapshot',
  /** S0 G2 第三片：阅读会话定向文档变更（只发给已注册的 canonicalPath，design §5.2） */
  documentChanged: 'document:changed',
  /** S0 G3：观测订阅增量/复位推送（subscriptionId 关联；渲染端按 eventId 去重，design §5.1） */
  observationEvents: 'observation:events',
  /** 全局 toast */
  toast: 'bridge:toast',
  /** 深链/AI 工具触发任务聚焦 */
  bridgeTaskFocus: 'bridge:focus-task',
  /** FR：任务材料更新（按任务防抖合并后广播；面板自写不通知） */
  materialUpdated: 'bridge:material-updated',
  /** FR：全局热键唤起主窗口时请求恢复上次阅读位置 */
  focusLastReading: 'bridge:focus-last-reading',
  /** T4：只读审阅派发阶段进度 */
  dispatchPhase: 'bridge:dispatch-phase',
  /** cli 长任务事件流（runId 关联，成对出现） */
  cliOutput: 'cli:output',
  cliDone: 'cli:done',
  /** chat 流式对话事件流（runId 关联，成对出现；增量/完成） */
  chatOutput: 'chat:output',
  chatDone: 'chat:done',
  /** 工作流运行事件流（runId 关联，成对出现） */
  flowOutput: 'flow:output',
  flowDone: 'flow:done',
  /** 工具调用权限卡（请求决策）与 steer 注入 */
  chatPermission: 'chat:permission',
  chatSteer: 'chat:steer',
  /** ACP 会话事件流（runId 关联，成对出现；TimelineEvent 双轨混排 + 权限请求） */
  acpOutput: 'acp:output',
  acpPermission: 'acp:permission',
  acpDone: 'acp:done',
  acpState: 'acp:state',
  /** 窗口最大化状态 */
  windowMaximized: 'window:maximized',
  /** 速记窗已显示（渲染层收到后重新聚焦编辑区） */
  quickTodoShown: 'quicktodo:shown',
  /**
   * 遗留通道：渲染层仍订阅，但主进程当前无发送方（新任务走系统通知）。
   * 保留常量以免 preload 断链；确认无消费方后可移除。
   */
  inboxNew: 'inbox:new'
} as const

/** 深度收集注册表里全部字面量通道（供 dev 断言与一致性检查用） */
function collectLeaves(node: Record<string, unknown>, out: string[] = []): string[] {
  for (const value of Object.values(node)) {
    if (typeof value === 'string') out.push(value)
    else if (typeof value === 'object' && value !== null) collectLeaves(value as Record<string, unknown>, out)
  }
  return out
}

/** 全量已声明通道（invoke + event）。dev 断言据此拒绝未登记通道。 */
export const allIpcChannels: ReadonlySet<string> = new Set([
  ...collectLeaves(ipcInvoke),
  ...collectLeaves(ipcEvent)
])
