import { contextBridge, ipcRenderer } from 'electron'
import { ipcEvent, ipcInvoke } from '../shared/ipc-channels'
import type { DocumentWindowApi, DocumentOriginReturn } from '../shared/document-windows'
import type {
  DocumentChangedEvent,
  DocumentDiffOutcome,
  DocumentDiffRequest,
  DocumentReadOutcome,
  DocumentReadRequest,
  DocumentReadScope,
  DocumentWatchOutcome
} from '../shared/documents'
import type {
  ObservationCursor,
  ObservationQueryRequest,
  ObservationQuerySuccess,
  ObservationScope,
  ObservationStatusResult,
  ObservationSubscribeResult,
  ObservationSubscriptionEvent
} from '../shared/observability/store'
import type { IpcFail } from '../shared/ipc-errors'
import type { IntegrationApi } from '../shared/integrations'
import { createJiraWorkspaceBridge } from '../shared/jira-integration'
import { createGitlabWorkspaceBridge } from '../shared/gitlab-integration'
import { createDingTalkBridge } from '../shared/dingtalk-integration'
import type { DaemonApi } from '../shared/daemon'
import type { DaemonQuitApi } from '../shared/daemon-quit'
import type { BootstrapApi } from '../shared/bootstrap'
import type { KnowledgeApi } from '../shared/knowledge-access'
import type { TrellisApi } from '../shared/types'
import type { TaskConversationsApi } from '../shared/task-conversations'
import type { ApplicationRuntimeApi, ApplicationInstanceApi, ApplicationRuntimeEvent } from '../shared/app-runtime'
import type { ApplicationTaskRuntimeApi } from '../shared/app-task-runtime'
import type { GitHistoryRequest, GitCommitRequest, GitCommitDiffRequest } from '../shared/git-readonly'
import type { GitWorkspaceApi } from '../shared/git-workspace'
import type { HifoxApi } from '../shared/hifox'
import type { HifoxWorkApi } from '../shared/hifox-work'
import type { ConversationApi } from '../shared/private-conversations'

/** 订阅推送信封（subscriptionId 关联；backend/ipc/observability.ts 广播口径） */
type ObservationSubscriptionPush = { subscriptionId: string; event: ObservationSubscriptionEvent }
import type {
  AiConfig,
  ChatMessage,
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
  MaterialUpdatedEvent,
  ContextExpectEntry
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const applicationApi: ApplicationRuntimeApi & ApplicationInstanceApi & ApplicationTaskRuntimeApi = {
  appRuntimeTaskPlan: input => ipcRenderer.invoke(ipcInvoke.appRuntime.taskPlan, input),
  appRuntimeTaskVerify: input => ipcRenderer.invoke(ipcInvoke.appRuntime.taskVerify, input),
  appRuntimeTaskStart: input => ipcRenderer.invoke(ipcInvoke.appRuntime.taskStart, input),
  appRuntimeTaskReuse: input => ipcRenderer.invoke(ipcInvoke.appRuntime.taskReuse, input),
  appRuntimeTaskDetach: input => ipcRenderer.invoke(ipcInvoke.appRuntime.taskDetach, input),
  appRuntimeList: (root) => ipcRenderer.invoke(ipcInvoke.appRuntime.list, root),
  appRuntimeSave: (root, input) => ipcRenderer.invoke(ipcInvoke.appRuntime.save, root, input),
  appRuntimeRemove: (root, id, revision) => ipcRenderer.invoke(ipcInvoke.appRuntime.remove, root, id, revision),
  appRuntimeImportNpm: (root, dir, script, name) => ipcRenderer.invoke(ipcInvoke.appRuntime.importNpm, root, dir, script, name),
  appRuntimeStart: (root, id, revision) => ipcRenderer.invoke(ipcInvoke.appRuntime.start, root, id, revision),
  appRuntimeStop: (root, id, expectedRunId) => ipcRenderer.invoke(ipcInvoke.appRuntime.stop, root, id, expectedRunId),
  appRuntimeRestart: (root, id, revision, expectedRunId) => ipcRenderer.invoke(ipcInvoke.appRuntime.restart, root, id, revision, expectedRunId),
  appRuntimeLogs: (root, id, after, expectedRunId) => ipcRenderer.invoke(ipcInvoke.appRuntime.logs, root, id, after, expectedRunId),
  appRuntimeInventory: (input) => ipcRenderer.invoke(ipcInvoke.appRuntime.inventory, input),
  appRuntimeStopInstance: (target) => ipcRenderer.invoke(ipcInvoke.appRuntime.stopInstance, target),
  appRuntimeRestartInstance: (target, expectedRevision) => ipcRenderer.invoke(ipcInvoke.appRuntime.restartInstance, target, expectedRevision),
  appRuntimeLogsInstance: (target, after) => ipcRenderer.invoke(ipcInvoke.appRuntime.logsInstance, target, after),
  appRuntimeDetachInstanceReference: (target, referenceId) => ipcRenderer.invoke(ipcInvoke.appRuntime.detachInstanceReference, target, referenceId),
  onAppRuntimeEvent: (listener) => {
    const release = [ipcEvent.appRuntimeChanged, ipcEvent.appRuntimeOutput, ipcEvent.appRuntimeDone]
      .map((channel) => subscribe<ApplicationRuntimeEvent>(channel, listener))
    return () => release.forEach((unsubscribe) => unsubscribe())
  }
}

const taskConversationsApi: TaskConversationsApi = {
  taskConversationsList: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.list, input),
  taskConversationsDiscover: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.discover, input),
  taskConversationsBind: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.bind, input),
  taskConversationsSetPrimary: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.setPrimary, input),
  taskConversationsUnbind: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.unbind, input),
  taskConversationsOpen: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.open, input),
  taskConversationsPrepare: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.prepare, input),
  taskConversationsContinue: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.continue, input),
  taskConversationsPreview: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.preview, input),
  taskConversationsInspect: (input) => ipcRenderer.invoke(ipcInvoke.taskConversations.inspect, input)
}

let hifoxScopeKey = 'local'
let hifoxScopeGeneration = 0
function observeHifoxContext(context: unknown): void {
  if (context && typeof context === 'object' && 'key' in context && typeof context.key === 'string' && context.key !== hifoxScopeKey) {
    hifoxScopeKey = context.key
    hifoxScopeGeneration++
  }
}
subscribe(ipcEvent.hifoxWorkspaceChanged, observeHifoxContext)
type HifoxInvokeMethod = Exclude<keyof HifoxApi, 'onWorkspaceChanged'>
async function invokeHifox<K extends HifoxInvokeMethod>(method: K, input?: unknown): Promise<Awaited<ReturnType<HifoxApi[K]>>> {
  const generation = method === 'selectWorkspace' ? ++hifoxScopeGeneration : hifoxScopeGeneration
  const scopeKey = hifoxScopeKey
  const response: unknown = await ipcRenderer.invoke(ipcInvoke.hifox[method], input, scopeKey)
  if (generation === hifoxScopeGeneration && response && typeof response === 'object' && 'context' in response) {
    observeHifoxContext(response.context)
  }
  return response as Awaited<ReturnType<HifoxApi[K]>>
}

const api = {
  conversations: {
    list: (input) => ipcRenderer.invoke(ipcInvoke.privateConversations.list, input),
    createDraft: (input) => ipcRenderer.invoke(ipcInvoke.privateConversations.createDraft, input),
    updateDraft: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.updateDraft, id, input),
    read: (id) => ipcRenderer.invoke(ipcInvoke.privateConversations.read, id),
    events: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.events, id, input),
    send: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.send, id, input),
    respond: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.respond, id, input),
    cancel: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.cancel, id, input),
    end: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.end, id, input),
    configure: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.configure, id, input),
    recoverModel: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.recoverModel, id, input),
    pickDirectory: input => ipcRenderer.invoke(ipcInvoke.privateConversations.pickDirectory, input),
    git: id => ipcRenderer.invoke(ipcInvoke.privateConversations.git, id),
    requirements: {
      knowledge: {
        connections: id => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.knowledge.connections, id),
        collections: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.knowledge.collections, id, input),
        search: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.knowledge.search, id, input)
      },
      list: id => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.list, id),
      create: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.create, id, input),
      createSuccessor: (id, originalDraftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.createSuccessor, id, originalDraftId, input),
      read: (id, draftId) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.read, id, draftId),
      save: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.save, id, draftId, input),
      sync: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.sync, id, draftId, input),
      resolveConflict: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.resolveConflict, id, draftId, input),
      target: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.target, id, draftId, input),
      run: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.run, id, draftId, input),
      observe: (id, draftId, operationId) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.observe, id, draftId, operationId),
      evidence: (id, draftId, operationId) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.evidence, id, draftId, operationId),
      adopt: (id, draftId, operationId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.adopt, id, draftId, operationId, input),
      applySelection: (id, draftId, operationId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.applySelection, id, draftId, operationId, input),
      confirmRequirement: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.confirmRequirement, id, draftId, input),
      savePlan: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.savePlan, id, draftId, input),
      prepareExecution: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.prepareExecution, id, draftId, input),
      commit: (id, draftId, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.commit, id, draftId, input),
      open: (id, draftId) => ipcRenderer.invoke(ipcInvoke.privateConversations.requirements.open, id, draftId)
    },
    pickFiles: (id) => ipcRenderer.invoke(ipcInvoke.privateConversations.pickFiles, id),
    files: (id) => ipcRenderer.invoke(ipcInvoke.privateConversations.files, id),
    openFile: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.openFile, id, input),
    readFile: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.readFile, id, input),
    image: (id, imageId) => ipcRenderer.invoke(ipcInvoke.privateConversations.image, id, imageId),
    saveImage: (id, imageId) => ipcRenderer.invoke(ipcInvoke.privateConversations.saveImage, id, imageId),
    projects: () => ipcRenderer.invoke(ipcInvoke.privateConversations.projects),
    createProject: (input) => ipcRenderer.invoke(ipcInvoke.privateConversations.createProject, input),
    reclassify: (id, input) => ipcRenderer.invoke(ipcInvoke.privateConversations.reclassify, id, input)
  } satisfies ConversationApi,
  hifoxMaterials: {
    list: input => ipcRenderer.invoke(ipcInvoke.hifoxMaterials.list, input),
    read: input => ipcRenderer.invoke(ipcInvoke.hifoxMaterials.read, input),
    versions: input => ipcRenderer.invoke(ipcInvoke.hifoxMaterials.versions, input),
    submissions: input => ipcRenderer.invoke(ipcInvoke.hifoxMaterials.submissions, input),
    command: input => ipcRenderer.invoke(ipcInvoke.hifoxMaterials.command, input),
    pending: input => ipcRenderer.invoke(ipcInvoke.hifoxMaterials.pending, input),
    reconcile: input => ipcRenderer.invoke(ipcInvoke.hifoxMaterials.reconcile, input),
    retry: input => ipcRenderer.invoke(ipcInvoke.hifoxMaterials.retry, input)
  } satisfies import('../shared/hifox-task-materials').HifoxTaskMaterialsApi,
  hifoxResources: {
    list: (input) => ipcRenderer.invoke(ipcInvoke.hifoxResources.list, input),
    task: (input) => ipcRenderer.invoke(ipcInvoke.hifoxResources.task, input),
    command: (input) => ipcRenderer.invoke(ipcInvoke.hifoxResources.command, input),
    pending: (input) => ipcRenderer.invoke(ipcInvoke.hifoxResources.pending, input),
    reconcile: (input) => ipcRenderer.invoke(ipcInvoke.hifoxResources.reconcile, input),
    retry: (input) => ipcRenderer.invoke(ipcInvoke.hifoxResources.retry, input)
  } satisfies import('../shared/hifox-code-resources').HifoxCodeResourceApi,
  storage: {
    scan: () => ipcRenderer.invoke(ipcInvoke.storage.scan),
    clean: (input: import('../shared/storage').StorageCleanInput) => ipcRenderer.invoke(ipcInvoke.storage.clean, input),
    openDataDirectory: () => ipcRenderer.invoke(ipcInvoke.storage.openDataDirectory)
  },
  onboarding: {
    status: () => ipcRenderer.invoke(ipcInvoke.onboarding.status),
    complete: (outcome: import('../shared/onboarding').OnboardingOutcome) => ipcRenderer.invoke(ipcInvoke.onboarding.complete, outcome)
  },
  bootstrap: {
    status: () => ipcRenderer.invoke(ipcInvoke.bootstrap.status),
    takeoverStatus: () => ipcRenderer.invoke(ipcInvoke.bootstrap.takeoverStatus),
    retry: () => ipcRenderer.invoke(ipcInvoke.bootstrap.retry),
    legacyInspect: () => ipcRenderer.invoke(ipcInvoke.bootstrap.legacyInspect),
    legacyStop: (input) => ipcRenderer.invoke(ipcInvoke.bootstrap.legacyStop, input),
    legacyReconcile: (input) => ipcRenderer.invoke(ipcInvoke.bootstrap.legacyReconcile, input),
    workcopyRecovery: (input) => ipcRenderer.invoke(ipcInvoke.bootstrap.workcopyRecovery, input),
    exit: () => ipcRenderer.invoke(ipcInvoke.bootstrap.exit),
    minimize: () => ipcRenderer.invoke(ipcInvoke.bootstrap.minimize),
    maximize: () => ipcRenderer.invoke(ipcInvoke.bootstrap.maximize),
    rendered: () => ipcRenderer.invoke(ipcInvoke.bootstrap.rendered),
    attached: () => ipcRenderer.invoke(ipcInvoke.bootstrap.attached),
    detached: () => ipcRenderer.invoke(ipcInvoke.bootstrap.detached),
    paint: (input) => ipcRenderer.invoke(ipcInvoke.bootstrap.paint, input),
    onChanged: (listener) => subscribe(ipcEvent.bootstrapChanged, listener)
  } satisfies BootstrapApi,
  jiraIntegration: createJiraWorkspaceBridge((channel, input) => ipcRenderer.invoke(channel, input)),
  gitlabWorkspace: createGitlabWorkspaceBridge((channel, input) => ipcRenderer.invoke(channel, input)),
  dingtalkWorkspace: createDingTalkBridge((channel, input) => ipcRenderer.invoke(channel, input)),
  hifox: {
    workspaceStatus: () => invokeHifox('workspaceStatus'),
    workspacePending: () => invokeHifox('workspacePending'),
    discardWorkspaceCommand: (input) => invokeHifox('discardWorkspaceCommand', input),
    selectWorkspace: (input) => invokeHifox('selectWorkspace', input),
    retryWorkspaceCommand: (input) => invokeHifox('retryWorkspaceCommand', input),
    onWorkspaceChanged: (callback) => subscribe<import('../shared/hifox-remote').HifoxWorkspaceContext>(ipcEvent.hifoxWorkspaceChanged, callback),
    snapshot: () => invokeHifox('snapshot'),
    resetDemo: () => invokeHifox('resetDemo'),
    triageQueue: (spaceId) => invokeHifox('triageQueue', spaceId),
    createSpace: (input) => invokeHifox('createSpace', input),
    updateSpace: (input) => invokeHifox('updateSpace', input),
    joinSpace: (input) => invokeHifox('joinSpace', input),
    inviteMember: (input) => invokeHifox('inviteMember', input),
    updateMember: (input) => invokeHifox('updateMember', input),
    removeMember: (input) => invokeHifox('removeMember', input),
    setSpaceMembers: (input) => invokeHifox('setSpaceMembers', input),
    createTaskType: (input) => invokeHifox('createTaskType', input),
    updateTaskType: (input) => invokeHifox('updateTaskType', input),
    removeTaskType: (input) => invokeHifox('removeTaskType', input),
    createTaskStatus: (input) => invokeHifox('createTaskStatus', input),
    removeTaskStatus: (input) => invokeHifox('removeTaskStatus', input),
    createLabel: (input) => invokeHifox('createLabel', input),
    archiveLabel: (input) => invokeHifox('archiveLabel', input),
    createTask: (input) => invokeHifox('createTask', input),
    transitionTask: (input) => invokeHifox('transitionTask', input),
    recordVersionDelivery: (input) => invokeHifox('recordVersionDelivery', input),
    saveMilestone: (input) => invokeHifox('saveMilestone', input),
    completeMilestone: (input) => invokeHifox('completeMilestone', input),
    removeMilestone: (input) => invokeHifox('removeMilestone', input),
    updateTask: (input) => invokeHifox('updateTask', input),
    removeTask: (input) => invokeHifox('removeTask', input),
    addRelation: (input) => invokeHifox('addRelation', input),
    removeRelation: (input) => invokeHifox('removeRelation', input),
    addComment: (input) => invokeHifox('addComment', input),
    resolveComment: (input) => invokeHifox('resolveComment', input),
    createProject: (input) => invokeHifox('createProject', input),
    updateProject: (input) => invokeHifox('updateProject', input),
    createIteration: (input) => invokeHifox('createIteration', input),
    updateIteration: (input) => invokeHifox('updateIteration', input),
    completeIteration: (input) => invokeHifox('completeIteration', input),
    saveView: (input) => invokeHifox('saveView', input),
    removeView: (input) => invokeHifox('removeView', input),
    triage: (input) => invokeHifox('triage', input),
    recordTaskDelivery: (input) => invokeHifox('recordTaskDelivery', input),
    saveAutomation: (input) => invokeHifox('saveAutomation', input),
    toggleAutomation: (input) => invokeHifox('toggleAutomation', input),
    removeAutomation: (input) => invokeHifox('removeAutomation', input),
    runAutomation: (input) => invokeHifox('runAutomation', input),
    markInboxRead: (input) => invokeHifox('markInboxRead', input),
    snoozeInbox: (input) => invokeHifox('snoozeInbox', input),
    clearInbox: (input) => invokeHifox('clearInbox', input),
    restoreInbox: (input) => invokeHifox('restoreInbox', input),
    saveAgent: (input) => invokeHifox('saveAgent', input),
    removeAgent: (input) => invokeHifox('removeAgent', input),
    saveSkill: (input) => invokeHifox('saveSkill', input),
    removeSkill: (input) => invokeHifox('removeSkill', input),
    saveCrew: (input) => invokeHifox('saveCrew', input),
    removeCrew: (input) => invokeHifox('removeCrew', input)
  } satisfies HifoxApi,
  hifoxWork: {
    status: (input) => ipcRenderer.invoke(ipcInvoke.hifoxWork.status, input),
    prepare: (input) => ipcRenderer.invoke(ipcInvoke.hifoxWork.prepare, input),
    development: input => ipcRenderer.invoke(ipcInvoke.hifoxWork.development, input),
    change: input => ipcRenderer.invoke(ipcInvoke.hifoxWork.change, input)
  } satisfies HifoxWorkApi,
  teamContent: {
    readiness: input => ipcRenderer.invoke(ipcInvoke.teamContent.readiness, input),
    generate: input => ipcRenderer.invoke(ipcInvoke.teamContent.generate, input),
    job: input => ipcRenderer.invoke(ipcInvoke.teamContent.job, input),
    receipt: input => ipcRenderer.invoke(ipcInvoke.teamContent.receipt, input),
    cancel: input => ipcRenderer.invoke(ipcInvoke.teamContent.cancel, input),
    listReferences: input => ipcRenderer.invoke(ipcInvoke.teamContent.listReferences, input),
    config: input => ipcRenderer.invoke(ipcInvoke.teamContent.config, input),
    configure: input => ipcRenderer.invoke(ipcInvoke.teamContent.configure, input),
    probe: input => ipcRenderer.invoke(ipcInvoke.teamContent.probe, input)
  } satisfies import('../shared/team-content-api').TeamContentApi,
  hifoxGovernance: {
    readDocument: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.readDocument, input),
    list: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.list, input),
    read: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.read, input),
    command: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.command, input),
    inputs: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.inputs, input),
    candidates: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.candidates, input),
    adopt: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.adopt, input),
    inputRevision: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.inputRevision, input),
    pending: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.pending, input),
    reconcile: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.reconcile, input),
    retry: input => ipcRenderer.invoke(ipcInvoke.hifoxGovernance.retry, input)
  } satisfies import('../shared/team-governance').TeamGovernanceApi,
  taskOutputs: {
    read: input => ipcRenderer.invoke(ipcInvoke.taskOutputs.read, input),
    preview: input => ipcRenderer.invoke(ipcInvoke.taskOutputs.preview, input),
    confirm: input => ipcRenderer.invoke(ipcInvoke.taskOutputs.confirm, input),
    compare: input => ipcRenderer.invoke(ipcInvoke.taskOutputs.compare, input),
    recover: input => ipcRenderer.invoke(ipcInvoke.taskOutputs.recover, input)
  } satisfies import('../shared/hifox-task-outputs').TaskOutputsApi,
  hifoxProgress: {
    status: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.status, input),
    start: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.start, input),
    report: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.report, input),
    retry: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.retry, input),
    detach: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.detach, input),
    conversation: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.conversation, input),
    events: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.events, input),
    send: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.send, input),
    respond: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.respond, input),
    cancel: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.cancel, input),
    resume: input => ipcRenderer.invoke(ipcInvoke.hifoxProgress.resume, input)
  } satisfies import('../shared/hifox-task-progress').HifoxProgressApi,
  creations: {
    list: (input) => ipcRenderer.invoke(ipcInvoke.creations.list, input),
    get: (input) => ipcRenderer.invoke(ipcInvoke.creations.get, input),
    command: (input) => ipcRenderer.invoke(ipcInvoke.creations.command, input),
    recover: (input) => ipcRenderer.invoke(ipcInvoke.creations.recover, input),
    planCandidate: (input) => ipcRenderer.invoke(ipcInvoke.creations.planCandidate, input),
    generateCandidate: (input) => ipcRenderer.invoke(ipcInvoke.creations.generateCandidate, input),
    cancelCandidate: (input) => ipcRenderer.invoke(ipcInvoke.creations.cancelCandidate, input),
    onChanged: (callback) => subscribe(ipcEvent.creationsChanged, callback)
  } satisfies import('../shared/creation-api').CreationApi,
  gitWorkspace: {
    status: (input) => ipcRenderer.invoke(ipcInvoke.gitWorkspace.status, input),
    diff: (input) => ipcRenderer.invoke(ipcInvoke.gitWorkspace.diff, input),
    stage: (input) => ipcRenderer.invoke(ipcInvoke.gitWorkspace.stage, input),
    unstage: (input) => ipcRenderer.invoke(ipcInvoke.gitWorkspace.unstage, input),
    commit: (input) => ipcRenderer.invoke(ipcInvoke.gitWorkspace.commit, input),
    createBranch: (input) => ipcRenderer.invoke(ipcInvoke.gitWorkspace.createBranch, input),
    switchBranch: (input) => ipcRenderer.invoke(ipcInvoke.gitWorkspace.switchBranch, input),
    push: (input) => ipcRenderer.invoke(ipcInvoke.gitWorkspace.push, input)
  } satisfies GitWorkspaceApi,
  ...applicationApi,
  ...taskConversationsApi,
  acpKnowledgeReferenceCapability: () => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.referenceCapability),
  knowledgeAccess: {
    rebindSource: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.rebindSource, input),
    artifactImage: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.artifactImage, input),
    artifactOpenLocal: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.artifactOpenLocal, input),
    context: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.context, input),
    collections: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.collections, input),
    updateScope: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.updateScope, input),
    search: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.search, input),
    documents: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.documents, input),
    folders: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.folders, input),
    read: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.read, input),
    source: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.source, input),
    sources: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.sources, input),
    cancel: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.cancel, input),
    importLegacy: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.importLegacy, input),
    saveArtifact: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.saveArtifact, input),
    artifacts: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.artifacts, input),
    artifact: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.artifact, input),
    taskPrd: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.taskPrd, input),
    handoff: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.handoff, input),
    previewPublication: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.previewPublication, input),
    confirmPublication: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.confirmPublication, input),
    publications: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.publications, input),
    publicationPage: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.publicationPage, input),
    resolvePublication: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.resolvePublication, input),
    clearHistory: (input) => ipcRenderer.invoke(ipcInvoke.knowledgeAccess.clearHistory, input)
  } satisfies KnowledgeApi,
  daemonQuit: {
    state: () => ipcRenderer.invoke(ipcInvoke.daemonQuit.state),
    decide: (input) => ipcRenderer.invoke(ipcInvoke.daemonQuit.decide, input)
  } satisfies DaemonQuitApi,
  onDaemonRuntimeUnavailable: (callback: (event: { projectRoot: string; error: string }) => void) => subscribe(ipcEvent.daemonRuntimeUnavailable, callback),
  onDaemonRuntimeReset: (callback: (event: { projectRoot: string }) => void) => subscribe(ipcEvent.daemonRuntimeReset, callback),
  daemon: {
    protocolVersion: 1,
    status: () => ipcRenderer.invoke(ipcInvoke.daemon.status),
    start: () => ipcRenderer.invoke(ipcInvoke.daemon.start),
    stop: () => ipcRenderer.invoke(ipcInvoke.daemon.stop),
    restart: () => ipcRenderer.invoke(ipcInvoke.daemon.restart),
    onOpenSettings: (listener) => subscribe(ipcEvent.daemonOpenSettings, listener),
    preferences: () => ipcRenderer.invoke(ipcInvoke.daemon.preferences),
    setPreferences: (input) => ipcRenderer.invoke(ipcInvoke.daemon.setPreferences, input),
    reconcileStartup: (originalCommandId) => ipcRenderer.invoke(ipcInvoke.daemon.reconcileStartup, { originalCommandId }),
    logs: (input) => ipcRenderer.invoke(ipcInvoke.daemon.logs, input)
  } satisfies DaemonApi,
  integrations: {
    authorize: (input) => ipcRenderer.invoke(ipcInvoke.integration.authorize, input),
    cancelAuthorization: (requestId) => ipcRenderer.invoke(ipcInvoke.integration.cancelAuthorization, { requestId }),
    onChanged: (callback) => subscribe(ipcEvent.integrationsChanged, () => callback()),
    cancelRead: (requestId) => ipcRenderer.invoke(ipcInvoke.integration.cancelRead, { requestId }),
    list: () => ipcRenderer.invoke(ipcInvoke.integration.list),
    saveConnection: (input) => ipcRenderer.invoke(ipcInvoke.integration.saveConnection, input),
    removeConnection: (input) => ipcRenderer.invoke(ipcInvoke.integration.removeConnection, input),
    inspect: (input) => ipcRenderer.invoke(ipcInvoke.integration.inspect, input),
    saveBinding: (input) => ipcRenderer.invoke(ipcInvoke.integration.saveBinding, input),
    removeBinding: (input) => ipcRenderer.invoke(ipcInvoke.integration.removeBinding, input),
    repositories: (input) => ipcRenderer.invoke(ipcInvoke.integration.repositories, input),
    pullRequests: (input) => ipcRenderer.invoke(ipcInvoke.integration.pullRequests, input),
    links: (input) => ipcRenderer.invoke(ipcInvoke.integration.links, input),
    attach: (input) => ipcRenderer.invoke(ipcInvoke.integration.attach, input),
    unlink: (input) => ipcRenderer.invoke(ipcInvoke.integration.unlink, input),
    previewNotification: (input) => ipcRenderer.invoke(ipcInvoke.integration.previewNotification, input),
    sendNotification: (input) => ipcRenderer.invoke(ipcInvoke.integration.sendNotification, input),
    jiraContext: (input) => ipcRenderer.invoke(ipcInvoke.integration.jiraContext, input),
    jiraSearch: (input) => ipcRenderer.invoke(ipcInvoke.integration.jiraSearch, input),
    jiraTransitions: (input) => ipcRenderer.invoke(ipcInvoke.integration.jiraTransitions, input),
    jiraTransition: (input) => ipcRenderer.invoke(ipcInvoke.integration.jiraTransition, input),
    jiraComment: (input) => ipcRenderer.invoke(ipcInvoke.integration.jiraComment, input)
  } satisfies IntegrationApi,
  pickProject: () => ipcRenderer.invoke(ipcInvoke.project.pick),
  openProject: (root: string) => ipcRenderer.invoke(ipcInvoke.project.open, root),
  getSnapshot: () => ipcRenderer.invoke(ipcInvoke.project.snapshot),
  closeProject: () => ipcRenderer.invoke(ipcInvoke.project.close),
  onSnapshotUpdated: (cb: (s: ProjectSnapshot) => void) => subscribe(ipcEvent.snapshotUpdated, cb),

  updateTask: (taskDir: string, patch: TaskPatch, expectedMtime?: number) =>
    ipcRenderer.invoke(ipcInvoke.task.update, taskDir, patch, expectedMtime),
  /* C1–C3：本机开发工具（只读 Git + 有归属的工程运行） */
  devtoolsGitStatus: () => ipcRenderer.invoke(ipcInvoke.devtools.gitStatus),
  devtoolsGitFileDiff: (relPath: string, staged: boolean) =>
    ipcRenderer.invoke(ipcInvoke.devtools.gitFileDiff, relPath, staged),
  devtoolsGitHistory: (request: GitHistoryRequest) => ipcRenderer.invoke(ipcInvoke.devtools.gitHistory, request),
  devtoolsGitCommit: (request: GitCommitRequest) => ipcRenderer.invoke(ipcInvoke.devtools.gitCommit, request),
  devtoolsGitCommitDiff: (request: GitCommitDiffRequest) => ipcRenderer.invoke(ipcInvoke.devtools.gitCommitDiff, request),
  devtoolsListScripts: (dir: string) => ipcRenderer.invoke(ipcInvoke.devtools.listScripts, dir),
  devRunStart: (dir: string, script: string) => ipcRenderer.invoke(ipcInvoke.devtools.devRunStart, dir, script),
  devRunStop: (id: string) => ipcRenderer.invoke(ipcInvoke.devtools.devRunStop, id),
  devRunStopAll: () => ipcRenderer.invoke(ipcInvoke.devtools.devRunStopAll),
  devRunList: () => ipcRenderer.invoke(ipcInvoke.devtools.devRunList),
  deleteTask: (taskDir: string, expectedMtime?: number) =>
    ipcRenderer.invoke(ipcInvoke.task.delete, taskDir, expectedMtime),
  createTaskFromJira: (input: Record<string, unknown>) => ipcRenderer.invoke(ipcInvoke.task.createFromJira, input),
  readTextFile: (absPath: string) => ipcRenderer.invoke(ipcInvoke.fs.readText, absPath),
  /* S0 G2：文档限界读取（revision 随内容变化；缺失/坏行/超限走诊断而非错误伪装） */
  documentRead: (scope: DocumentReadScope, input: DocumentReadRequest) =>
    ipcRenderer.invoke(ipcInvoke.document.read, scope, input) as Promise<DocumentReadOutcome>,
  /* S0 G2：行级版本比较（jsdiff worker；2MiB/侧 + 1s 超时；Git 基线不可用为中性降级） */
  documentDiff: (scope: DocumentReadScope, input: DocumentDiffRequest) =>
    ipcRenderer.invoke(ipcInvoke.document.diff, scope, input) as Promise<DocumentDiffOutcome>,
  /* S0 G2 第三片：注册/解除阅读会话的定向变更监听（design §5.2） */
  documentWatch: (scope: DocumentReadScope, input: { relativePath: string; knownRevision: string | null }) =>
    ipcRenderer.invoke(ipcInvoke.document.watch, scope, input) as Promise<DocumentWatchOutcome>,
  documentUnwatch: (canonicalPath: string, watchId?: string) => ipcRenderer.invoke(ipcInvoke.document.unwatch, canonicalPath, watchId),
  onDocumentChanged: (cb: (e: DocumentChangedEvent) => void) => subscribe(ipcEvent.documentChanged, cb),
  /* S0 G3：观测事件查询（limit≤100；cursor epoch 不符 → resetRequired 全量重拉） */
  observationQuery: (scope: ObservationScope, request: ObservationQueryRequest) =>
    ipcRenderer.invoke(ipcInvoke.observation.query, scope, request) as Promise<ObservationQuerySuccess | IpcFail>,
  /* S0 G3：订阅增量（返回快照基准 cursor；增量经 onObservationEvents 推送，按 eventId 去重）。pollMs=轮询请求（可见 1s/后台 5s，主进程夹取 [1000,5000]） */
  observationSubscribe: (scope: ObservationScope, options?: { afterCursor?: ObservationCursor; pollMs?: number }) =>
    ipcRenderer.invoke(ipcInvoke.observation.subscribe, scope, options) as Promise<ObservationSubscribeResult | IpcFail>,
  observationUnsubscribe: (subscriptionId: string) => ipcRenderer.invoke(ipcInvoke.observation.unsubscribe, subscriptionId),
  onObservationEvents: (cb: (e: ObservationSubscriptionPush) => void) =>
    subscribe(ipcEvent.observationEvents, cb),
  /* S0 G3 第二片：绑定/健康综合状态（含绑定 workspaceId） */
  observationHealth: () =>
    ipcRenderer.invoke(ipcInvoke.observation.health) as Promise<ObservationStatusResult | IpcFail>,
  /* G3 走查补全：首次显式绑定当前项目（未绑定分支的唯一入口，design §3.1） */
  observationBind: () =>
    ipcRenderer.invoke(ipcInvoke.observation.bind) as Promise<
      { ok: true; bound: boolean; bindingStatus: string; status: ObservationStatusResult } | IpcFail
    >,
  /* S0 G3 第二片：启用/停用采集（需已有绑定） */
  observationSetEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(ipcInvoke.observation.setEnabled, enabled) as Promise<
      { ok: true; health: import('../shared/observability/store').ObservationHealth } | IpcFail
    >,
  /* S0 G3 第二片：清理观测（retention=保留策略；all=清空观测记录，epoch 更换） */
  observationCleanup: (mode: 'retention' | 'all') =>
    ipcRenderer.invoke(ipcInvoke.observation.cleanup, mode) as Promise<
      { ok: true; removed: number; resumed: boolean } | { ok: true; storeEpoch: string } | IpcFail
    >,
  writeSpecFile: (absPath: string, content: string, expectedMtime?: number) =>
    ipcRenderer.invoke(ipcInvoke.fs.writeSpec, absPath, content, expectedMtime),
  specBacklinks: () => ipcRenderer.invoke(ipcInvoke.spec.backlinks),
  revealInExplorer: (p: string) => ipcRenderer.invoke(ipcInvoke.shell.reveal, p),
  openInEditor: (p: string) => ipcRenderer.invoke(ipcInvoke.shell.openInEditor, p),
  openExternal: (url: string) => ipcRenderer.invoke(ipcInvoke.shell.openExternal, url),
  openLocalDocument: (href: string) => ipcRenderer.invoke(ipcInvoke.shell.openLocalDocument, href),

  getSettings: () => ipcRenderer.invoke(ipcInvoke.settings.get),
  onThemeChanged: (cb: (theme: Settings['theme']) => void) => subscribe(ipcEvent.themeChanged, cb),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke(ipcInvoke.settings.set, patch),

  runCli: (args: string[]) => ipcRenderer.invoke(ipcInvoke.cli.run, args),
  abortCli: (runId: number) => ipcRenderer.invoke(ipcInvoke.cli.abort, runId),
  onCliOutput: (cb: (e: RunEvent) => void) => subscribe(ipcEvent.cliOutput, cb),
  onCliDone: (cb: (e: RunDoneEvent) => void) => subscribe(ipcEvent.cliDone, cb),

  acpAgents: () => ipcRenderer.invoke(ipcInvoke.acp.agents),
  acpSessions: () => ipcRenderer.invoke(ipcInvoke.acp.sessions),
  acpHistoryList: (input?: Parameters<TrellisApi['acpHistoryList']>[0]) => ipcRenderer.invoke(ipcInvoke.acp.historyList, input),
  acpHistorySession: (sessionId: string) => ipcRenderer.invoke(ipcInvoke.acp.historySession, sessionId),
  acpHistoryUpdate: (sessionId: string, input: Parameters<TrellisApi['acpHistoryUpdate']>[1]) => ipcRenderer.invoke(ipcInvoke.acp.historyUpdate, sessionId, input),
  acpHistoryDelete: (sessionId: string, input: Parameters<TrellisApi['acpHistoryDelete']>[1]) => ipcRenderer.invoke(ipcInvoke.acp.historyDelete, sessionId, input),
  acpHistoryRegenerateTitle: (sessionId: string) => ipcRenderer.invoke(ipcInvoke.acp.historyRegenerateTitle, sessionId),
  onAcpHistoryChanged: (callback: Parameters<TrellisApi['onAcpHistoryChanged']>[0]) => subscribe(ipcEvent.acpHistoryChanged, callback),
  acpHistoryEvents: (sessionId: string, input?: Parameters<TrellisApi['acpHistoryEvents']>[1]) => ipcRenderer.invoke(ipcInvoke.acp.historyEvents, sessionId, input),
  acpPiImage: (sessionId: string, imageId: string) => ipcRenderer.invoke(ipcInvoke.acp.piImage, sessionId, imageId),
  acpPiImageSave: (sessionId: string, imageId: string) => ipcRenderer.invoke(ipcInvoke.acp.piImageSave, sessionId, imageId),
  acpPiDocumentOpen: (input: import('../shared/pi-document').PiDocumentOpenInput) => ipcRenderer.invoke(ipcInvoke.acp.piDocumentOpen, input),
  acpPiDocumentCancel: (operationId: string) => ipcRenderer.send(ipcInvoke.acp.piDocumentCancel, operationId),
  acpPiWebPreviewOpen: (input: import('../shared/pi-web-preview').PiWebPreviewOpenInput) => ipcRenderer.invoke(ipcInvoke.acp.piWebPreviewOpen, input),
  acpPiWebPreviewStatus: (id: string) => ipcRenderer.invoke(ipcInvoke.acp.piWebPreviewStatus, id),
  acpPiWebPreviewClose: (id: string) => ipcRenderer.invoke(ipcInvoke.acp.piWebPreviewClose, id),
  acpPiWebPreviewOpenExternal: (id: string) => ipcRenderer.invoke(ipcInvoke.acp.piWebPreviewOpenExternal, id),
  acpHistoryRetry: (sessionId: string) => ipcRenderer.invoke(ipcInvoke.acp.historyRetry, sessionId),
  acpSessionHandoffPreview: (sessionId: string, input: import('../shared/acp-handoff').AcpHandoffPreviewInput) => ipcRenderer.invoke(ipcInvoke.acp.sessionHandoffPreview, sessionId, input),
  acpSessionHandoffCreate: (sessionId: string, input: import('../shared/acp-handoff').AcpHandoffCreateInput) => ipcRenderer.invoke(ipcInvoke.acp.sessionHandoffCreate, sessionId, input),
  acpSessionHandoffStatus: (sessionId: string, operationId: string) => ipcRenderer.invoke(ipcInvoke.acp.sessionHandoffStatus, sessionId, operationId),
  acpSessionHandoffCancel: (sessionId: string, input: import('../shared/acp-handoff').AcpHandoffCancelInput) => ipcRenderer.invoke(ipcInvoke.acp.sessionHandoffCancel, sessionId, input),
  acpSessionRecoverModel: (sessionId: string, input: import('../shared/acp-recovery').AcpRecoverModelInput) => ipcRenderer.invoke(ipcInvoke.acp.sessionRecoverModel, sessionId, input),
  acpSessionNew: (input: { agentId: string; profileId?: string; taskDir?: string }) => ipcRenderer.invoke(ipcInvoke.acp.sessionNew, input),
  acpSessionPrompt: (sessionId: string, text: string, options?: import('../shared/types').AcpPromptOptions) => ipcRenderer.invoke(ipcInvoke.acp.sessionPrompt, sessionId, text, options),
  acpSessionBindTask: (sessionId: string, input: import('../shared/types').AcpBindTaskInput) => ipcRenderer.invoke(ipcInvoke.acp.sessionBindTask, sessionId, input),
  acpSessionCancel: (sessionId: string) => ipcRenderer.invoke(ipcInvoke.acp.sessionCancel, sessionId),
  acpSessionKill: (sessionId: string) => ipcRenderer.invoke(ipcInvoke.acp.sessionKill, sessionId),
  acpPermissionRespond: (requestId: string, optionId: string) =>
    ipcRenderer.invoke(ipcInvoke.acp.permissionRespond, requestId, optionId),
  acpProfiles: () => ipcRenderer.invoke(ipcInvoke.acp.profiles),
  acpProfileSave: (profile: import('../shared/types').AcpAgentProfile) => ipcRenderer.invoke(ipcInvoke.acp.profileSave, profile),
  acpProfileDelete: (id: string) => ipcRenderer.invoke(ipcInvoke.acp.profileDelete, id),
  acpRuntimeRefresh: () => ipcRenderer.invoke(ipcInvoke.acp.runtimeRefresh),
  acpRuntimeSetup: (runtimeId: string) => ipcRenderer.invoke(ipcInvoke.acp.runtimeSetup, runtimeId),
  acpRuntimeNodePick: () => ipcRenderer.invoke(ipcInvoke.acp.runtimeNodePick),
  acpRuntimeTestConnection: (runtimeId: string) => ipcRenderer.invoke(ipcInvoke.acp.runtimeTest, runtimeId),
  acpRuntimePathPick: (runtimeId: string) => ipcRenderer.invoke(ipcInvoke.acp.runtimePathPick, runtimeId),
  acpSessionResume: (sessionId: string) => ipcRenderer.invoke(ipcInvoke.acp.sessionResume, sessionId),
  acpSessionConfigure: (sessionId: string, input: import('../shared/types').AcpConfigureInput) => ipcRenderer.invoke(ipcInvoke.acp.sessionConfigure, sessionId, input),
  onAcpState: (cb: (e: import('../shared/types').AcpStateEvent) => void) => subscribe(ipcEvent.acpState, cb),
  onAcpOutput: (cb: (e: import('../shared/types').TimelineEvent) => void) => subscribe(ipcEvent.acpOutput, cb),
  onAcpPermission: (cb: (e: import('../shared/types').AcpPermissionPayload) => void) => subscribe(ipcEvent.acpPermission, cb),
  onAcpDone: (cb: (e: import('../shared/types').AcpDoneEvent) => void) =>
    subscribe(ipcEvent.acpDone, cb),

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

  kbSearch: (library: KbLibrary | 'all', query: string, scope?: import('../shared/types').KbSearchScope) => ipcRenderer.invoke(ipcInvoke.kb.search, library, query, scope),
  kbBrowse: (input: import('../shared/types').KbBrowseInput) => ipcRenderer.invoke(ipcInvoke.kb.browse, input),
  kbSaveNote: (fileName: string, content: string) => ipcRenderer.invoke(ipcInvoke.kb.saveNote, fileName, content),
  kbDeleteNote: (fileName: string) => ipcRenderer.invoke(ipcInvoke.kb.deleteNote, fileName),
  kbQaHistory: () => ipcRenderer.invoke(ipcInvoke.kb.qaHistory),
  kbQaSave: (entry: { question: string; answer: string; sources?: Array<{ title: string; path: string; library?: string }> }) =>
    ipcRenderer.invoke(ipcInvoke.kb.qaSave, entry),
  kbQaClear: () => ipcRenderer.invoke(ipcInvoke.kb.qaClear),

  teamDesktop: {
    executionRead: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.executionRead, input),
    executionHistory: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.executionHistory, input),
    executionCommand: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.executionCommand, input),
    executionReconcile: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.executionReconcile, input),
    executionPending: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.executionPending, input),
    authOptions: (origin) => ipcRenderer.invoke(ipcInvoke.teamDesktop.authOptions, origin),
    accounts: () => ipcRenderer.invoke(ipcInvoke.teamDesktop.accounts),
    login: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.login, input),
    register: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.register, input),
    logout: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.logout, id),
    organizations: (id, options) => ipcRenderer.invoke(ipcInvoke.teamDesktop.organizations, id, options),
    createOrganization: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.createOrganization, input),
    workspaces: (id, options) => ipcRenderer.invoke(ipcInvoke.teamDesktop.workspaces, id, options),
    createWorkspace: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.createWorkspace, input),
    createInvitation: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.createInvitation, input),
    inspectInvitation: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.inspectInvitation, input),
    acceptInvitation: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.acceptInvitation, input),
    connectWorkspace: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.connectWorkspace, input),
    connections: () => ipcRenderer.invoke(ipcInvoke.teamDesktop.connections),
    connectionContext: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.connectionContext, id),
    beginPairing: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.beginPairing, input),
    openPairing: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.openPairing, id),
    pollPairing: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.pollPairing, id),
    disconnect: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.disconnect, id),
    heartbeat: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.heartbeat, id),
    queueAuthoredPublication: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.queueAuthoredPublication, input),
    queueFeedback: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.queueFeedback, input),
    outbox: (id, options) => ipcRenderer.invoke(ipcInvoke.teamDesktop.outbox, id, options),
    cancelQueued: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.cancelQueued, id),
    dispatch: (id, options) => ipcRenderer.invoke(ipcInvoke.teamDesktop.dispatch, id, options),
    reconcile: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.reconcile, id),
    readDocument: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.readDocument, input),
    listMaterials: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.listMaterials, input),
    listVersions: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.listVersions, input),
    listFeedback: (input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.listFeedback, input),
    syncEvents: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.syncEvents, id),
    refreshSharedSnapshot: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.refreshSharedSnapshot, id),
    cachedSnapshot: (id) => ipcRenderer.invoke(ipcInvoke.teamDesktop.cachedSnapshot, id),
    queueWorkflowMaterial: (root, input) => ipcRenderer.invoke(ipcInvoke.teamDesktop.queueWorkflowMaterial, root, input),
    onChanged: (callback) => subscribe(ipcEvent.teamDesktopChanged, callback)
  } satisfies import('../shared/team-desktop-bridge').TeamDesktopBridgeApi,
  managedWorkflow: {
    templates: (root) => ipcRenderer.invoke(ipcInvoke.workflow.templates, root),
    preview: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.preview, root, input),
    start: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.start, root, input),
    snapshot: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.snapshot, root, input),
    events: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.events, root, input),
    stop: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.stop, root, input),
    artifact: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.artifact, root, input),
    previewRevision: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.previewRevision, root, input),
    acceptRevision: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.acceptRevision, root, input),
    cancelRevision: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.cancelRevision, root, input),
    revisionStatus: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.revisionStatus, root, input),
    inspectRecovery: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.inspectRecovery, root, input),
    recoveryArtifact: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.recoveryArtifact, root, input),
    subscribe: (root, input) => ipcRenderer.invoke(ipcInvoke.workflow.subscribe, root, input),
    unsubscribe: (leaseId) => ipcRenderer.invoke(ipcInvoke.workflow.unsubscribe, leaseId),
    onOutput: (callback) => subscribe(ipcEvent.workflowOutput, callback),
    onDone: (callback) => subscribe(ipcEvent.workflowDone, callback)
  } satisfies import('../shared/workflow-desktop').WorkflowDesktopApi,
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
  taskLinkSubtask: (parentDir: string, childDir: string, remove?: boolean) =>
    ipcRenderer.invoke(ipcInvoke.task.linkSubtask, parentDir, childDir, remove) as Promise<{ ok: boolean; error?: string }>,
  aiSplitEpic: (dirName: string) => ipcRenderer.invoke(ipcInvoke.ai.splitEpic, dirName),
  aiCommitMsg: (dirName: string) => ipcRenderer.invoke(ipcInvoke.ai.commitMsg, dirName),
  aiPrDesc: (dirName: string) => ipcRenderer.invoke(ipcInvoke.ai.prDesc, dirName),
  taskWriteArtifact: (dirName: string, fileName: string, content: string) =>
    ipcRenderer.invoke(ipcInvoke.task.writeArtifact, dirName, fileName, content),
  taskBuildTaskLink: (dirName: string) =>
    ipcRenderer.invoke(ipcInvoke.task.buildTaskLink, dirName) as Promise<
      { ok: true; url: string } | { ok: false; error: string }
    >,
  taskDispatchReview: (dirName: string) =>
    ipcRenderer.invoke(ipcInvoke.task.dispatchReview, dirName) as Promise<{
      ok: boolean
      phase?: string
      error?: string
      report?: string
      channel?: string
    }>,
  taskDispatchPlan: (input: { title: string; requirement: string }) =>
    ipcRenderer.invoke(ipcInvoke.task.dispatchPlan, input) as Promise<{
      ok: boolean
      phase?: string
      error?: string
      report?: string
      channel?: string
    }>,
  taskDispatchAbort: () => ipcRenderer.invoke(ipcInvoke.task.dispatchAbort) as Promise<{ ok: boolean }>,
  onDispatchPhase: (cb: (p: { key: string; label: string; detail?: string }) => void) =>
    subscribe(ipcEvent.dispatchPhase, cb),
  taskContextExpect: (dirName: string) =>
    ipcRenderer.invoke(ipcInvoke.task.contextExpect, dirName) as Promise<
      | { ok: false; error: string }
      | {
          ok: true
          implement: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }
          check: { present: boolean; totalBytes: number; entries: ContextExpectEntry[] }
          caps: { perFile: number; total: number }
        }
    >,
  taskHandoffBuild: (dirName: string, intent: string, includePrd: boolean) =>
    ipcRenderer.invoke(ipcInvoke.task.handoffBuild, dirName, intent, includePrd) as Promise<{
      ok: boolean
      error?: string
      text: string
      issues: string[]
      files: string[]
      gitLines: string[]
      checkFiles: string[]
      uncheckedSubtasks: string[]
      openQuestions: string[]
    }>,
  desktopSetExplorerMenu: (on: boolean) =>
    ipcRenderer.invoke(ipcInvoke.desktop.setExplorerMenu, on) as Promise<
      { ok: boolean; supported: boolean; reason?: string }
    >,
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
  chatOpen: (id: string, branchId?: string) => ipcRenderer.invoke(ipcInvoke.chat.open, id, branchId),
  studioSyncExtension: (sourcePath: string, targets: string[]) =>
    ipcRenderer.invoke(ipcInvoke.studio.syncExtension, sourcePath, targets),

  generateStandup: () => ipcRenderer.invoke(ipcInvoke.report.standup),

  installTpanel: () => ipcRenderer.invoke(ipcInvoke.bridge.installTpanel),
  installTrellisHooks: () => ipcRenderer.invoke(ipcInvoke.bridge.installHooks),
  pullPendingFocus: () => ipcRenderer.invoke(ipcInvoke.bridge.pullFocus),
  copyToClipboard: (text: string) => ipcRenderer.invoke(ipcInvoke.util.clipboard, text),
  setCapsuleMode: (on: boolean) => ipcRenderer.send(ipcInvoke.win.capsule, on),
  openMainTask: (projectRoot: string, taskDir: string) => ipcRenderer.invoke(ipcInvoke.win.openTask, projectRoot, taskDir),
  setCapsuleOnTop: (on: boolean) => ipcRenderer.invoke(ipcInvoke.capsule.onTop, on),
  setCapsuleShape: (shape: 'pill' | 'card') => ipcRenderer.invoke(ipcInvoke.capsule.setShape, shape),
  closeCapsule: () => ipcRenderer.invoke(ipcInvoke.capsule.close),
  resizeCapsule: (width: number, height: number) => ipcRenderer.invoke(ipcInvoke.capsule.resize, width, height),
  showQuickTodo: () => ipcRenderer.invoke(ipcInvoke.quicktodo.show),
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
  /* G4 第二片：分页查询（完整字段 + 完整性口径；sample ≠ 失败） */
  jiraSearchPaged: (cfg: JiraConfig, jql: string, opts?: { maxPages?: number }) =>
    ipcRenderer.invoke(ipcInvoke.jira.searchPaged, cfg, jql, opts),
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
  appQuit: () => ipcRenderer.invoke(ipcInvoke.win.quit),
  onWindowMaximized: (cb: (maximized: boolean) => void) => subscribe(ipcEvent.windowMaximized, cb),

  docOpen: (opts: { key: string; title: string; file: string; theme: string }) =>
    ipcRenderer.invoke(ipcInvoke.doc.open, opts) as Promise<{ ok: boolean; focused?: boolean; error?: string }>,
  docRead: (path: string) =>
    ipcRenderer.invoke(ipcInvoke.doc.read, path) as Promise<{
      ok: boolean
      content?: string
      mtime?: number
      error?: string
    }>,
  docSetPin: (on: boolean) => ipcRenderer.invoke(ipcInvoke.doc.setPin, on) as Promise<{ ok: boolean; pinned?: boolean; error?: string }>,
  documentVersions: (...args: Parameters<DocumentWindowApi['documentVersions']>) => ipcRenderer.invoke(ipcInvoke.doc.versions, ...args),
  documentCaptureVersion: (...args: Parameters<DocumentWindowApi['documentCaptureVersion']>) => ipcRenderer.invoke(ipcInvoke.doc.captureVersion, ...args),
  documentCompareVersions: (...args: Parameters<DocumentWindowApi['documentCompareVersions']>) => ipcRenderer.invoke(ipcInvoke.doc.compareVersions, ...args),
  documentOpenWindow: (...args: Parameters<DocumentWindowApi['documentOpenWindow']>) => ipcRenderer.invoke(ipcInvoke.doc.openVersion, ...args),
  documentWindowBootstrap: () => ipcRenderer.invoke(ipcInvoke.doc.bootstrap),
  documentWindowSourceState: () => ipcRenderer.invoke(ipcInvoke.doc.sourceState),
  documentWindowRead: (...args: Parameters<DocumentWindowApi['documentWindowRead']>) => ipcRenderer.invoke(ipcInvoke.doc.current, ...args),
  documentWindowWatch: (...args: Parameters<DocumentWindowApi['documentWindowWatch']>) => ipcRenderer.invoke(ipcInvoke.doc.watch, ...args),
  documentWindowUnwatch: (...args: Parameters<DocumentWindowApi['documentWindowUnwatch']>) => ipcRenderer.invoke(ipcInvoke.doc.unwatch, ...args),
  documentWindowDiff: (...args: Parameters<DocumentWindowApi['documentWindowDiff']>) => ipcRenderer.invoke(ipcInvoke.doc.diff, ...args),
  documentWindowReturn: () => ipcRenderer.invoke(ipcInvoke.doc.returnOrigin),
  onDocumentOriginReturn: (callback: (origin: DocumentOriginReturn) => void) => subscribe(ipcEvent.documentOriginReturn, callback)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('trellis', api)
