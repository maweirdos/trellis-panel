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

import { JIRA_IPC } from './jira-integration'
import { workTaskActionChannel } from './conversation/work-task-action'
import { codeTaskActionChannel } from './conversation/code-task-action'
import { GITLAB_IPC } from './gitlab-integration'
import { DINGTALK_IPC } from './dingtalk-integration'
import { FEISHU_IPC } from './feishu-integration'

/** 主进程提供的 invoke 通道（渲染层请求 → 响应） */
export const ipcInvoke = {
  speech: {
    status: 'speech:status', begin: 'speech:begin', transcribe: 'speech:transcribe',
    cancel: 'speech:cancel', importModel: 'speech:importModel', downloadModel: 'speech:downloadModel'
  },
  designWorkspace: {
    list: 'designWorkspace:list', get: 'designWorkspace:get', listConversation: 'designWorkspace:listConversation', sync: 'designWorkspace:sync', createConversation: 'designWorkspace:createConversation',
    save: 'designWorkspace:save', send: 'designWorkspace:send', status: 'designWorkspace:status', respond: 'designWorkspace:respond',
    adopt: 'designWorkspace:adopt', discard: 'designWorkspace:discard', export: 'designWorkspace:export'
  },
  docxPreviewResult: 'docxPreview:result',
  privateConversations: {
    taskSuggestion: { start: 'privateConversations:taskSuggestion:start', check: 'privateConversations:taskSuggestion:check', adopt: 'privateConversations:taskSuggestion:adopt', close: 'privateConversations:taskSuggestion:close' },
    list: 'privateConversations:list', createDraft: 'privateConversations:createDraft', updateDraft: 'privateConversations:updateDraft',
    read: 'privateConversations:read', events: 'privateConversations:events', pickDirectory: 'privateConversations:pickDirectory', pickFiles: 'privateConversations:pickFiles',
    files: 'privateConversations:files', openFile: 'privateConversations:openFile', readFile: 'privateConversations:readFile', readAttachment: 'privateConversations:readAttachment', previewImage: 'privateConversations:previewImage', previewPdf: 'privateConversations:previewPdf', previewDocx: 'privateConversations:previewDocx', cancelDocx: 'privateConversations:cancelDocx', validatePdfLocator: 'privateConversations:validatePdfLocator', releasePdfLocator: 'privateConversations:releasePdfLocator', image: 'privateConversations:image', saveImage: 'privateConversations:saveImage',
    projects: 'privateConversations:projects', createProject: 'privateConversations:createProject', reclassify: 'privateConversations:reclassify',
    git: 'privateConversations:git',
    requirements: {
      polish: { run: 'privateConversations:requirements:polish:run', observe: 'privateConversations:requirements:polish:observe', cancel: 'privateConversations:requirements:polish:cancel', apply: 'privateConversations:requirements:polish:apply' },
      list: 'privateConversations:requirements:list', create: 'privateConversations:requirements:create', createSuccessor: 'privateConversations:requirements:createSuccessor', read: 'privateConversations:requirements:read',
      save: 'privateConversations:requirements:save', sync: 'privateConversations:requirements:sync',
      target: 'privateConversations:requirements:target', commit: 'privateConversations:requirements:commit', open: 'privateConversations:requirements:open',
      run: 'privateConversations:requirements:run', observe: 'privateConversations:requirements:observe', adopt: 'privateConversations:requirements:adopt', applySelection: 'privateConversations:requirements:applySelection', resolveConflict: 'privateConversations:requirements:resolveConflict',
      evidence: 'privateConversations:requirements:evidence',
      confirmRequirement: 'privateConversations:requirements:confirmRequirement', savePlan: 'privateConversations:requirements:savePlan',
      prepareExecution: 'privateConversations:requirements:prepareExecution',
      knowledge: { connections: 'privateConversations:requirements:knowledge:connections', collections: 'privateConversations:requirements:knowledge:collections', search: 'privateConversations:requirements:knowledge:search' }
    }
  },
  onboarding: { status: 'onboarding:status', complete: 'onboarding:complete' },
  bootstrap: { status: 'bootstrap:status', appearance: 'bootstrap:appearance', retry: 'bootstrap:retry', takeoverStatus: 'bootstrap:takeoverStatus', legacyInspect: 'bootstrap:legacyInspect', legacyStop: 'bootstrap:legacyStop', legacyReconcile: 'bootstrap:legacyReconcile', workcopyRecovery: 'bootstrap:workcopyRecovery', exit: 'bootstrap:exit', minimize: 'bootstrap:minimize', maximize: 'bootstrap:maximize', rendered: 'bootstrap:rendered', attached: 'bootstrap:attached', detached: 'bootstrap:detached', paint: 'bootstrap:paint' },
  jiraIntegration: JIRA_IPC,
  gitlabWorkspace: GITLAB_IPC,
  dingtalkWorkspace: DINGTALK_IPC,
  feishuWorkspace: FEISHU_IPC,
  daemonQuit: { state: 'daemonQuit:state', decide: 'daemonQuit:decide' },
  daemonLifecycleDialog: { state: 'daemonLifecycleDialog:state', decide: 'daemonLifecycleDialog:decide' },
  daemon: {
    inspectRecovery: 'daemon:inspectRecovery',
    status: 'daemon:status', start: 'daemon:start', stop: 'daemon:stop', restart: 'daemon:restart',
    preferences: 'daemon:preferences', setPreferences: 'daemon:setPreferences', reconcileStartup: 'daemon:reconcileStartup', logs: 'daemon:logs'
  },
  creations: {
    list: 'creations:list', get: 'creations:get', command: 'creations:command', recover: 'creations:recover',
    planCandidate: 'creations:planCandidate', generateCandidate: 'creations:generateCandidate', cancelCandidate: 'creations:cancelCandidate'
  },
  whiteboardV2: {
    capabilities: 'whiteboardV2:capabilities', list: 'whiteboardV2:list', get: 'whiteboardV2:get',
    command: 'whiteboardV2:command', recover: 'whiteboardV2:recover'
  },
  taskConversations: {
    list: 'taskConversations:list',
    discover: 'taskConversations:discover',
    bind: 'taskConversations:bind',
    setPrimary: 'taskConversations:setPrimary',
    unbind: 'taskConversations:unbind',
    open: 'taskConversations:open',
    prepare: 'taskConversations:prepare',
    continue: 'taskConversations:continue',
    preview: 'taskConversations:preview',
    inspect: 'taskConversations:inspect'
  },
  integration: {
    authorize: 'integration:authorize', cancelAuthorization: 'integration:cancelAuthorization',
    cancelRead: 'integration:cancelRead',
    list: 'integration:list', saveConnection: 'integration:saveConnection', removeConnection: 'integration:removeConnection', inspect: 'integration:inspect',
    saveBinding: 'integration:saveBinding', removeBinding: 'integration:removeBinding', repositories: 'integration:repositories', pullRequests: 'integration:pullRequests',
    links: 'integration:links', attach: 'integration:attach', unlink: 'integration:unlink', previewNotification: 'integration:previewNotification', sendNotification: 'integration:sendNotification',
    jiraContext: 'integration:jiraContext', jiraSearch: 'integration:jiraSearch', jiraTransitions: 'integration:jiraTransitions', jiraTransition: 'integration:jiraTransition', jiraComment: 'integration:jiraComment'
  },
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
  crux: {
    workspaceStatus: 'crux:workspaceStatus',
    workspacePending: 'crux:workspacePending',
    discardWorkspaceCommand: 'crux:discardWorkspaceCommand',
    selectWorkspace: 'crux:selectWorkspace',
    retryWorkspaceCommand: 'crux:retryWorkspaceCommand',
    snapshot: 'crux:snapshot',
    resetDemo: 'crux:resetDemo',
    triageQueue: 'crux:triageQueue',
    createSpace: 'crux:createSpace',
    updateSpace: 'crux:updateSpace',
    inviteMember: 'crux:inviteMember',
    updateMember: 'crux:updateMember',
    removeMember: 'crux:removeMember',
    setSpaceMembers: 'crux:setSpaceMembers',
    joinSpace: 'crux:joinSpace',
    createTaskType: 'crux:createTaskType',
    updateTaskType: 'crux:updateTaskType',
    removeTaskType: 'crux:removeTaskType',
    createTaskStatus: 'crux:createTaskStatus',
    removeTaskStatus: 'crux:removeTaskStatus',
    createLabel: 'crux:createLabel',
    archiveLabel: 'crux:archiveLabel',
    createTask: 'crux:createTask',
    transitionTask: 'crux:transitionTask',
    recordVersionDelivery: 'crux:recordVersionDelivery',
    saveMilestone: 'crux:saveMilestone',
    completeMilestone: 'crux:completeMilestone',
    removeMilestone: 'crux:removeMilestone',
    updateTask: 'crux:updateTask',
    restoreLightweightTask: 'crux:restoreLightweightTask',
    removeTask: 'crux:removeTask',
    addRelation: 'crux:addRelation',
    removeRelation: 'crux:removeRelation',
    addComment: 'crux:addComment',
    resolveComment: 'crux:resolveComment',
    createProject: 'crux:createProject',
    updateProject: 'crux:updateProject',
    createIteration: 'crux:createIteration',
    updateIteration: 'crux:updateIteration',
    completeIteration: 'crux:completeIteration',
    saveView: 'crux:saveView',
    removeView: 'crux:removeView',
    triage: 'crux:triage',
    recordTaskDelivery: 'crux:recordTaskDelivery',
    saveAutomation: 'crux:saveAutomation',
    toggleAutomation: 'crux:toggleAutomation',
    removeAutomation: 'crux:removeAutomation',
    runAutomation: 'crux:runAutomation',
    markInboxRead: 'crux:markInboxRead',
    snoozeInbox: 'crux:snoozeInbox',
    clearInbox: 'crux:clearInbox',
    restoreInbox: 'crux:restoreInbox',
    saveAgent: 'crux:saveAgent',
    removeAgent: 'crux:removeAgent',
    saveSkill: 'crux:saveSkill',
    removeSkill: 'crux:removeSkill',
    saveCrew: 'crux:saveCrew',
    removeCrew: 'crux:removeCrew'
  },
  taskPlanning: {
    catalog: 'taskPlanning:catalog',
    read: 'taskPlanning:read', prepare: 'taskPlanning:prepare', selectSources: 'taskPlanning:selectSources', generate: 'taskPlanning:generate',
    respond: 'taskPlanning:respond',
    reconcile: 'taskPlanning:reconcile', stop: 'taskPlanning:stop', saveDraft: 'taskPlanning:saveDraft', recoverSave: 'taskPlanning:recoverSave'
  },
  productTask: {
    read: 'productTask:read', prepare: 'productTask:prepare', retryPrepare: 'productTask:retryPrepare', start: 'productTask:start',
    stop: 'productTask:stop', permission: 'productTask:permission', reconcile: 'productTask:reconcile',
    results: 'productTask:results', artifact: 'productTask:artifact', finish: 'productTask:finish'
  },
  cruxWork: {
    status: 'crux-work:status',
    prepare: 'crux-work:prepare', development: 'crux-work:development', change: 'crux-work:change'
  },
  cruxGovernance: {
    readDocument: 'crux-governance:readDocument',
    list: 'crux-governance:list', read: 'crux-governance:read', command: 'crux-governance:command',
    inputs: 'crux-governance:inputs', candidates: 'crux-governance:candidates', adopt: 'crux-governance:adopt',
    inputRevision: 'crux-governance:inputRevision', pending: 'crux-governance:pending',
    reconcile: 'crux-governance:reconcile', retry: 'crux-governance:retry'
  },
  taskOutputs: { read: 'task-outputs:read', preview: 'task-outputs:preview', confirm: 'task-outputs:confirm', compare: 'task-outputs:compare', recover: 'task-outputs:recover' },
  cruxProgress: {
    status: 'crux-progress:status', report: 'crux-progress:report',
    retry: 'crux-progress:retry', detach: 'crux-progress:detach'
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
    gitHistory: 'devtools:gitHistory',
    gitCommit: 'devtools:gitCommit',
    gitCommitDiff: 'devtools:gitCommitDiff',
    listScripts: 'devtools:listScripts',
    devRunStart: 'devtools:devRunStart',
    devRunStop: 'devtools:devRunStop',
    devRunStopAll: 'devtools:devRunStopAll',
    devRunList: 'devtools:devRunList',
    devRunGet: 'devtools:devRunGet'
  },
  gitWorkspace: {
    status: 'gitWorkspace:status',
    diff: 'gitWorkspace:diff',
    stage: 'gitWorkspace:stage',
    unstage: 'gitWorkspace:unstage',
    commit: 'gitWorkspace:commit',
    createBranch: 'gitWorkspace:createBranch',
    switchBranch: 'gitWorkspace:switchBranch',
    push: 'gitWorkspace:push'
  },
  appRuntime: {
    taskPlan: 'appRuntime:taskPlan', taskVerify: 'appRuntime:taskVerify', taskStart: 'appRuntime:taskStart',
    taskReuse: 'appRuntime:taskReuse', taskDetach: 'appRuntime:taskDetach',
    detachInstanceReference: 'appRuntime:detachInstanceReference',
    list: 'appRuntime:list',
    save: 'appRuntime:save',
    remove: 'appRuntime:remove',
    importNpm: 'appRuntime:importNpm',
    start: 'appRuntime:start',
    stop: 'appRuntime:stop',
    restart: 'appRuntime:restart',
    logs: 'appRuntime:logs',
    inventory: 'appRuntime:inventory',
    stopInstance: 'appRuntime:stopInstance',
    restartInstance: 'appRuntime:restartInstance',
    logsInstance: 'appRuntime:logsInstance'
  },
  teamContent: {
    readiness: 'teamContent:readiness', generate: 'teamContent:generate',
    job: 'teamContent:job', receipt: 'teamContent:receipt', cancel: 'teamContent:cancel',
    listReferences: 'teamContent:listReferences', config: 'teamContent:config',
    configure: 'teamContent:configure', probe: 'teamContent:probe'
  },
  cruxResources: {
    list: 'cruxResources:list',
    task: 'cruxResources:task',
    command: 'cruxResources:command',
    pending: 'cruxResources:pending',
    reconcile: 'cruxResources:reconcile',
    retry: 'cruxResources:retry'
  },
  cruxMaterials: {
    list: 'cruxMaterials:list', sourcePart: 'cruxMaterials:sourcePart',
    read: 'cruxMaterials:read',
    versions: 'cruxMaterials:versions',
    submissions: 'cruxMaterials:submissions',
    command: 'cruxMaterials:command',
    pending: 'cruxMaterials:pending',
    reconcile: 'cruxMaterials:reconcile',
    retry: 'cruxMaterials:retry'
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
    browse: 'kb:browse',
    saveNote: 'kb:saveNote',
    deleteNote: 'kb:deleteNote',
    qaHistory: 'kb:qaHistory',
    qaSave: 'kb:qaSave',
    qaClear: 'kb:qaClear'
  },
  teamDesktop: {
    executionRead: 'teamDesktop:executionRead', executionHistory: 'teamDesktop:executionHistory', executionCommand: 'teamDesktop:executionCommand', executionReconcile: 'teamDesktop:executionReconcile', executionPending: 'teamDesktop:executionPending',
    authOptions: 'teamDesktop:authOptions', accounts: 'teamDesktop:accounts', login: 'teamDesktop:login', register: 'teamDesktop:register', logout: 'teamDesktop:logout',
    organizations: 'teamDesktop:organizations', createOrganization: 'teamDesktop:createOrganization', workspaces: 'teamDesktop:workspaces', createWorkspace: 'teamDesktop:createWorkspace',
    createInvitation: 'teamDesktop:createInvitation', inspectInvitation: 'teamDesktop:inspectInvitation', acceptInvitation: 'teamDesktop:acceptInvitation', connectWorkspace: 'teamDesktop:connectWorkspace',
    connections: 'teamDesktop:connections', connectionContext: 'teamDesktop:connectionContext', beginPairing: 'teamDesktop:beginPairing', openPairing: 'teamDesktop:openPairing', pollPairing: 'teamDesktop:pollPairing',
    disconnect: 'teamDesktop:disconnect', heartbeat: 'teamDesktop:heartbeat', queueAuthoredPublication: 'teamDesktop:queueAuthoredPublication', queueFeedback: 'teamDesktop:queueFeedback',
    outbox: 'teamDesktop:outbox', cancelQueued: 'teamDesktop:cancelQueued', dispatch: 'teamDesktop:dispatch', reconcile: 'teamDesktop:reconcile',
    readDocument: 'teamDesktop:readDocument', listMaterials: 'teamDesktop:listMaterials', listVersions: 'teamDesktop:listVersions', listFeedback: 'teamDesktop:listFeedback',
    syncEvents: 'teamDesktop:syncEvents', refreshSharedSnapshot: 'teamDesktop:refreshSharedSnapshot', cachedSnapshot: 'teamDesktop:cachedSnapshot', queueWorkflowMaterial: 'teamDesktop:queueWorkflowMaterial'
  },
  workflow: {
    templates: 'workflow:templates', preview: 'workflow:preview', start: 'workflow:start',
    snapshot: 'workflow:snapshot', events: 'workflow:events', stop: 'workflow:stop',
    artifact: 'workflow:artifact', subscribe: 'workflow:subscribe', unsubscribe: 'workflow:unsubscribe',
    previewRevision: 'workflow:previewRevision', acceptRevision: 'workflow:acceptRevision',
    cancelRevision: 'workflow:cancelRevision', revisionStatus: 'workflow:revisionStatus',
    inspectRecovery: 'workflow:inspectRecovery', recoveryArtifact: 'workflow:recoveryArtifact'
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
  knowledgeAccess: {
    referenceCapability: 'knowledge-access:reference-capability',
    rebindSource: 'knowledge-access:rebind-source',
    artifactImage: 'knowledge-access:artifact-image', artifactOpenLocal: 'knowledge-access:artifact-open-local',
    context: 'knowledge-access:context', collections: 'knowledge-access:collections', updateScope: 'knowledge-access:update-scope',
    search: 'knowledge-access:search', documents: 'knowledge-access:documents', folders: 'knowledge-access:folders', read: 'knowledge-access:read', source: 'knowledge-access:source', sources: 'knowledge-access:sources', cancel: 'knowledge-access:cancel', importLegacy: 'knowledge-access:import-legacy',
    saveArtifact: 'knowledge-access:save-artifact', artifacts: 'knowledge-access:artifacts', artifact: 'knowledge-access:artifact', taskPrd: 'knowledge-access:task-prd', handoff: 'knowledge-access:handoff', previewPublication: 'knowledge-access:preview-publication', confirmPublication: 'knowledge-access:confirm-publication', publications: 'knowledge-access:publications', publicationPage: 'knowledge-access:publication-page', resolvePublication: 'knowledge-access:resolve-publication', clearHistory: 'knowledge-access:clear-history'
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
  chat: { list: 'chat:list', open: 'chat:open' },
  ai: {
    chat: 'ai:chat',
    test: 'ai:test',
    'test-connection': 'ai:test-connection',
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
    setDefaultConversationModel: 'settings:setDefaultConversationModel',
    set: 'settings:set'
  },
  storage: { scan: 'storage:scan', clean: 'storage:clean', openDataDirectory: 'storage:openDataDirectory' },
  desktop: {
    setExplorerMenu: 'desktop:setExplorerMenu'
  },
  doc: {
    open: 'doc:open',
    read: 'doc:read',
    setPin: 'doc:setPin',
    versions: 'doc:versions',
    captureVersion: 'doc:capture-version',
    compareVersions: 'doc:compare-versions',
    openVersion: 'doc:open-version',
    bootstrap: 'doc:view-bootstrap',
    sourceState: 'doc:source-state',
    current: 'doc:view-current',
    watch: 'doc:view-watch',
    unwatch: 'doc:view-unwatch',
    diff: 'doc:view-diff',
    returnOrigin: 'doc:return-origin'
  },
  cli: {
    run: 'cli:run',
    abort: 'cli:abort'
  },
  bridge: {
    installTpanel: 'bridge:installTpanel',
    pullFocus: 'bridge:pullFocus'
  },
  util: {
    clipboard: 'util:clipboard'
  },
  win: {
    capsule: 'win:capsule',
    openTask: 'win:openTask',
    minimize: 'win:minimize',
    maximize: 'win:maximize',
    close: 'win:close',
    quit: 'win:quit'
  },
  capsule: {
    onTop: 'capsule:onTop',
    setShape: 'capsule:setShape',
    resize: 'capsule:resize',
    close: 'capsule:close'
  },
  quicktodo: {
    show: 'quicktodo:show',
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
    openExternal: 'shell:openExternal',
    openLocalDocument: 'shell:openLocalDocument'
  },
  conversation: {
    workRoot: 'conversation:work-root',
    taskScope: 'conversation:task-scope',
    models: 'conversation:models',
    create: 'conversation:create',
    list: 'conversation:list',
    search: 'conversation:search',
    searchAll: 'conversation:search-all',
    checkpointDiff: 'conversation:checkpoint-diff',
    usageLimits: 'conversation:usage-limits',
    read: 'conversation:read',
    command: 'conversation:command',
    events: 'conversation:events',
    apply: 'conversation:apply',
    threadCommand: 'conversation:thread-command',
    eventDelta: 'conversation:event-delta',
    history: 'conversation:history',
    drivers: 'conversation:drivers',
    describeDriver: 'conversation:describe-driver',
    attachmentStage: 'conversation:attachment-stage',
    attachmentPick: 'conversation:attachment-pick',
    attachmentList: 'conversation:attachment-list',
    attachmentRelease: 'conversation:attachment-release',
    attachmentRead: 'conversation:attachment-read',
    projectWorkbench: 'conversation:projectWorkbench',
    workTaskAction: workTaskActionChannel,
    codeTaskAction: codeTaskActionChannel,
  },
  acp: {
    agents: 'acp:agents',
    piWebPreviewOpen: 'acp:pi.web-preview.open',
    piWebPreviewStatus: 'acp:pi.web-preview.status',
    piWebPreviewClose: 'acp:pi.web-preview.close',
    piWebPreviewOpenExternal: 'acp:pi.web-preview.open-external',
    profiles: 'acp:profiles',
    profileSave: 'acp:profile.save',
    profileDelete: 'acp:profile.delete',
    runtimeRefresh: 'acp:runtime.refresh',
    runtimeSetup: 'acp:runtime.setup',
    runtimeSetupStatus: 'acp:runtime.setup-status',
    runtimeNodePick: 'acp:runtime.node-pick',
    runtimeTest: 'acp:runtime.test-connection',
    runtimePathPick: 'acp:runtime.path-pick',
    registryList: 'acp:registry.list',
    registrySearch: 'acp:registry.search',
    localProviderList: 'acp:local-provider.list',
    localProviderSave: 'acp:local-provider.save',
    localProviderDelete: 'acp:local-provider.delete',
    providerCapabilities: 'acp:provider.capabilities'
  }
} as const

/** 主进程 → 渲染层的事件通道（广播/推送） */
export const ipcEvent = {
  docxPreviewInput: 'docxPreview:input',
  bootstrapChanged: 'bootstrap:changed',
  appRuntimeChanged: 'appRuntime:changed',
  appRuntimeOutput: 'appRuntime:output',
  appRuntimeDone: 'appRuntime:done',
  /** Appearance only; never broadcast settings containing credentials. */
  themeChanged: 'settings:themeChanged',
  conversationDefaultsChanged: 'settings:conversationDefaultsChanged',
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
  daemonOpenSettings: 'daemon:open-settings',
  /** T4：只读审阅派发阶段进度 */
  dispatchPhase: 'bridge:dispatch-phase',
  /** cli 长任务事件流（runId 关联，成对出现） */
  cliOutput: 'cli:output',
  cliDone: 'cli:done',
  /** 工作流运行事件流（runId 关联，成对出现） */
  flowOutput: 'flow:output',
  flowDone: 'flow:done',
  workflowOutput: 'workflow:output',
  teamDesktopChanged: 'teamDesktop:changed',
  cruxWorkspaceChanged: 'crux:workspaceChanged',
  creationsChanged: 'creations:changed',
  workflowDone: 'workflow:done',
  /** ACP 会话事件流（runId 关联，成对出现；TimelineEvent 双轨混排 + 权限请求） */
  acpOutput: 'acp:output',
  acpPermission: 'acp:permission',
  acpDone: 'acp:done',
  acpState: 'acp:state',
  acpHistoryChanged: 'acp:history.changed',
  daemonRuntimeUnavailable: 'daemon:runtimeUnavailable',
  daemonRuntimeReset: 'daemon:runtimeReset',
  /** 窗口最大化状态 */
  windowMaximized: 'window:maximized',
  documentOriginReturn: 'doc:origin-return',
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
