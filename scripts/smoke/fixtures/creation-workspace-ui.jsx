/** Test-only in-memory CreationApi adapter. Uses production domain commands and components; model output and network outcomes are simulated. No main-process store, project, task CLI or real model is used. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/renderer/src/my/my.css";
import "../../../src/renderer/src/styles.css";
window.__errors = [];
window.__consoleErrors = [];
const originalConsoleError = console.error.bind(console);
console.error = (...items) => {
  window.__consoleErrors.push(items.map(String).join(' '));
  originalConsoleError(...items);
};
window.addEventListener("error", (e) => window.__errors.push(String(e.error || e.message)));
window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));
const listeners = /* @__PURE__ */ new Set();
const calls = { list: [], get: [], command: [], recover: [], plan: [], generate: [], cancel: [], sourceSwitch: [] };
const controls = { unknownNext: false, modelAvailable: false, deferGeneration: false, cancelFalseOnce: false, getOverride: null };
let pendingReceipt = null;
let pendingGeneration = null;
const domain = await import("../../../src/shared/creations-domain.ts");
const pure = await import("../../../src/renderer/src/creations/creation-state.ts");
const ctx = { projectId: "project-one", actorId: "person-one", now: 1e3, activeMemberIds: ["person-one", "person-two"], spaces: [{ id: "space-1", archived: false, canRead: true, canWrite: true, memberIds: ["person-one", "person-two"] }], tasks: [{ id: "task-1", spaceId: "space-1" }], digestBody: () => "a".repeat(64) };
let record = null;
const command = (action, extra = {}) => ({ action, commandId: crypto.randomUUID(), creationId: record?.creationId ?? crypto.randomUUID(), expectedRevision: record?.revision ?? null, ...extra });
const apply = (input) => {
  ctx.now++;
  record = domain.executeCreationCommand(input.action === "create" ? null : record, input, ctx);
  return { status: "committed", commandId: input.commandId, result: { projectId: ctx.projectId, creationId: record.creationId, revision: record.revision, action: input.action, scopeSpaceIds: record.spaceId ? [record.spaceId] : [], scopeTaskIds: input.taskId ? [input.taskId] : [], scopePersonIds: [], private: !record.spaceId, ...input.action === "publish" ? { revisionId: input.commandId } : {}, ...input.action === "candidateSave" ? { candidateId: input.commandId } : {}, ...input.action === "annotate" ? { commentId: input.commandId } : {} } };
};
apply(command("create", { title: "检视文档", kind: "document", home: "personal", spaceId: null, body: "第一段正文\n第二段正文", privateNotes: "仅拥有者可读" }));
apply(command("publish", { spaceId: "space-1", reviewerIds: ["person-two"] }));
const r1 = record.revisions[0].revisionId;
for (let i = 0; i < 22; i++) apply(command("annotate", { revisionId: r1, target: { kind: "general" }, body: "意见 " + (i + 1), severity: i === 0 ? "required" : "suggestion" }));
apply(command("publish", { spaceId: "space-1", reviewerIds: ["person-two"] }));
const r2 = record.revisions[1].revisionId;
const changed = () => {
  for (const listener of listeners) listener({ workspaceKey: "workspace-a", creationId: record.creationId });
};
const bridge = {
  list: async (input) => {
    calls.list.push(input);
    const item = domain.summarizeCreation(record, ctx, { taskId: input.taskId });
    const items = input.workspaceKey !== 'workspace-a' || input.taskId && !record.adoptions.some((a) => a.taskId === input.taskId) ? [] : [item];
    return { ok: true, value: { items, hasMore: false, nextCursor: null } };
  },
  get: async (input) => {
    calls.get.push(input);
    if (controls.getOverride) return controls.getOverride(input);
    try {
      return { ok: true, value: domain.viewCreation(record, ctx, { ...input.revisionId ? { revisionId: input.revisionId } : {}, commentOffset: input.commentOffset ?? 0, commentLimit: input.commentLimit ?? 20 }) };
    } catch (error) {
      return { ok: false, code: error.code, error: error.message };
    }
  },
  command: async (input) => {
    calls.command.push(input);
    try {
      const receipt = apply(input.command);
      changed();
      if (controls.unknownNext) {
        controls.unknownNext = false;
        pendingReceipt = receipt;
        return { ok: false, code: "OUTCOME_UNKNOWN", error: "连接中断，结果待核对", outcomeUnknown: true };
      }
      return { ok: true, value: receipt };
    } catch (error) {
      return { ok: false, code: error.code, error: error.message };
    }
  },
  recover: async (input) => {
    calls.recover.push(input);
    const value = pendingReceipt;
    pendingReceipt = null;
    return { ok: true, value };
  },
  planCandidate: async (input) => {
    calls.plan.push(input);
    return { ok: true, value: { inputBytes: 800, estimatedTokens: 800, fragmentCount: 2, selectedCount: input.commentIds.length, maxInputBytes: 12288, model: controls.modelAvailable ? "fixture-only-model" : null, available: controls.modelAvailable } };
  },
  generateCandidate: async (input) => {
    calls.generate.push(input);
    if (controls.deferGeneration) return new Promise((resolve) => pendingGeneration = resolve);
    try {
      const receipt = apply({ action: "candidateSave", commandId: input.commandId, creationId: input.creationId, expectedRevision: input.expectedRevision, body: "候选正文", baseDraftRevision: record.draft.serial, selectedCommentIds: input.commentIds });
      changed();
      return { ok: true, value: receipt };
    } catch (error) {
      return { ok: false, code: error.code, error: error.message };
    }
  },
  cancelCandidate: async (input) => {
    calls.cancel.push(input);
    if (controls.cancelFalseOnce) {
      controls.cancelFalseOnce = false;
      return { ok: true, value: { cancelled: false } };
    }
    const resolve = pendingGeneration;
    pendingGeneration = null;
    if (resolve) resolve({ ok: false, code: "CANCELLED", error: "生成已停止" });
    return { ok: true, value: { cancelled: Boolean(resolve) } };
  },
  onChanged: (callback) => {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }
};
window.trellis = { creations: bridge };
const { useHifox } = await import("../../../src/renderer/src/hifox/store.ts");
const { useApp } = await import("../../../src/renderer/src/store/index.ts");
const { CreationWorkspace } = await import("../../../src/renderer/src/creations/CreationWorkspace.tsx");
const { TaskCreationReferences } = await import("../../../src/renderer/src/creations/TaskCreationReferences.tsx");
const navigation = await import("../../../src/renderer/src/creations/navigation.ts");
const hooks = await import("../../../src/renderer/src/creations/hooks.ts");
const { InteractionScope } = await import('../../../src/renderer/src/utils/interaction-scope.tsx');
const { creationViewSchema } = await import('../../../src/shared/creations.ts');
const { dispatchEscKey } = await import("../../../src/renderer/src/utils/esc-layer.ts");
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && dispatchEscKey()) {
    e.preventDefault();
    e.stopPropagation();
  }
});
const workspace = { key: "workspace-a", connectionId: null, projectId: "project-one", projectName: "隔离验证", actorId: "person-one", canManage: true, revision: 0, state: "local", pendingCount: 0 };
const snapshot = { spaces: [{ id: "space-1", name: "验证空间", key: "ONE", memberIds: ["person-one", "person-two"], multiAssignee: false, taskSeq: 1, createdAt: "2026-01-01" }], members: [{ id: "person-one", name: "甲", role: "member" }, { id: "person-two", name: "乙", role: "member" }], tasks: [{ id: "task-1", spaceId: "space-1", title: "同空间任务" }], taskTypes: [], taskStatuses: [], taskLabels: [], comments: [], activities: [], projects: [], iterations: [], views: [], triageDecisions: [], automations: [], inbox: [], agents: [], skills: [], crews: [] };
// Connection selection also uses a test adapter; it never contacts this .invalid origin.
const cloudWorkspace = { ...workspace, key: 'fixture-cloud', state: 'connected', connectionId: 'fixture-connection', projectName: 'Fixture cloud' };
const connectionListeners = new Set();
window.trellis.hifox = {
  workspacePending: async () => ({ ok: true, data: [] }),
  selectWorkspace: async ({ connectionId }) => {
    calls.sourceSwitch.push(connectionId);
    return { ok: true, data: structuredClone(snapshot), context: connectionId ? cloudWorkspace : workspace };
  }
};
window.trellis.teamDesktop = {
  connections: async () => ({ ok: true, value: [{ connectionId: 'fixture-connection', deviceName: 'Fixture cloud', state: 'active', accessLocked: false, origin: 'https://fixture.invalid' }] }),
  onChanged: (callback) => { connectionListeners.add(callback); return () => connectionListeners.delete(callback) }
};
useHifox.setState({ workspaceContext: workspace, snapshot, currentSpaceId: "space-1" });
useApp.setState({ snapshot: null });
const root = createRoot(document.getElementById("root"));
function ViewProbe() {
  const [args, setArgs] = useState({ id: record.creationId, revisionId: record.revisions[0].revisionId });
  window.__setProbe = setArgs;
  const query = hooks.useCreationView(args.id, args.revisionId);
  window.__probe = query;
  return <pre id="probe">{query.view?.selected.body ?? "none"}</pre>;
}
function FixtureRoot({ children }) {
  const [active, setActive] = useState(true);
  window.__setInteractionActive = setActive;
  return <div className="my-root" data-my-theme="light" data-my-font-size="standard" data-fixture-interaction={active ? 'active' : 'hidden'} style={{ height: "100vh", display: "flex", flexDirection: "column" }}><InteractionScope active={active}>{children}</InteractionScope></div>;
}
function render(element) {
  root.render(<React.StrictMode><FixtureRoot>{element}</FixtureRoot></React.StrictMode>);
}
window.__fixture = { calls, controls, ctx, workspace, snapshot, pure, navigation, useHifox, useApp, bridge, r1, r2, changed, record: () => record, apply, command, listeners, connectionListeners, probeRevisions: () => ({ a: record.revisions[0].revisionId, b: record.draft.revisionId }), mountWorkspace: (scope = "personal") => render(<CreationWorkspace scope={scope} />), mountReferences: () => render(<TaskCreationReferences taskId="task-1" spaceId="space-1" />), mountProbe: () => render(<ViewProbe />), unmount: () => render(null), resolveDeferred: (request, body) => {
  const view = domain.viewCreation(record, ctx, { revisionId: request.input.revisionId });
  request.settled = true;
  request.resolve({ ok: true, value: creationViewSchema.parse({ ...view, selected: { ...view.selected, revisionId: request.input.revisionId, body } }) });
}, externalSave: (body) => {
  apply(command("saveDraft", { body }));
  changed();
}, addAdoption: (ids) => apply(command("adoptForTask", { taskId: "task-1", revisionId: r2, confirmedCommentIds: ids })) };
window.__fixture.mountWorkspace();
