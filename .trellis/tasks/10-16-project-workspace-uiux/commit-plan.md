# Checkpoint commit plan — approved

User authorization: “先提交这一版吧”. Local checkpoint only; native visual verification remains pending. No push or task archive.

## 1. feat(workspace): 固定模块导航与中央任务工作区

- `.trellis/spec/backend/index.md`
- `.trellis/spec/backend/window-appearance.md`
- `.trellis/spec/frontend/my-ui-module.md`
- `scripts/smoke/navigation.mjs`
- `scripts/smoke/task-presentation.mjs`
- `scripts/smoke/uiux-wiring.mjs`
- `src/main/index.ts`
- `src/main/ipc/deps.ts`
- `src/main/ipc/docs.ts`
- `src/main/ipc/index.ts`
- `src/main/ipc/settings.ts`
- `src/main/services/window-appearance.ts`
- `src/preload/index.ts`
- `src/renderer/src/App.tsx`
- `src/renderer/src/components/TitleBar.tsx`
- `src/renderer/src/my/CommandPalette.tsx`
- `src/renderer/src/my/layout/MyApp.tsx`
- `src/renderer/src/my/layout/PageFrame.tsx`
- `src/renderer/src/my/layout/ProjectSwitcher.tsx`
- `src/renderer/src/my/layout/WorkspaceSidebar.tsx`
- `src/renderer/src/my/my.css`
- `src/renderer/src/my/navigation.ts`
- `src/renderer/src/my/pages/IssuePeek.tsx`
- `src/renderer/src/my/pages/WorkItemsPage.tsx`
- `src/renderer/src/my/pages/YourWorkPage.tsx`
- `src/renderer/src/my/project-preferences.ts`
- `src/renderer/src/my/store.ts`
- `src/renderer/src/my/ui.tsx`
- `src/renderer/src/pages/Knowledge.tsx`
- `src/renderer/src/pages/Spec.tsx`
- `src/renderer/src/pages/TaskDetail.tsx`
- `src/renderer/src/pages/Team.tsx`
- `src/renderer/src/reader/task-materials.ts`
- `src/renderer/src/store/slices/session.ts`
- `src/renderer/src/store/slices/ui.ts`
- `src/renderer/src/store/types.ts`
- `src/shared/ipc-channels.ts`
- `src/shared/types.ts`

## 2. docs(workspace): 同步布局验收与外部集成路线图

- `.trellis/tasks/10-16-project-workspace-uiux/check.jsonl`
- `.trellis/tasks/10-16-project-workspace-uiux/commit-plan.md`
- `.trellis/tasks/10-16-project-workspace-uiux/design.md`
- `.trellis/tasks/10-16-project-workspace-uiux/implement.jsonl`
- `.trellis/tasks/10-16-project-workspace-uiux/implement.md`
- `.trellis/tasks/10-16-project-workspace-uiux/prd.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/checkpoint-commits.json`
- `.trellis/tasks/10-16-project-workspace-uiux/research/commit-plan.json`
- `.trellis/tasks/10-16-project-workspace-uiux/research/content-implementation.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/current-state.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/final-check.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/native-frame-diagnosis.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/shell-implementation.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/staged-verification.json`
- `.trellis/tasks/10-16-project-workspace-uiux/research/task-implementation.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/visual-chrome-implementation.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/visual-refinement-audit.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/visual-refinement-check.md`
- `.trellis/tasks/10-16-project-workspace-uiux/research/visual-refinement.md`
- `.trellis/tasks/10-16-project-workspace-uiux/task.json`
- `.trellis/tasks/10-16-project-workspace-uiux/validation.md`
- `design-qa.md`
- `docs/proposals/2026-10-15-hifox-roadmap/01-product-roadmap.md`
- `docs/proposals/2026-10-15-hifox-roadmap/02-capability-map.md`
- `docs/proposals/2026-10-15-hifox-roadmap/03-source-index.md`
- `docs/proposals/2026-10-15-hifox-roadmap/04-baseline-and-boundaries.md`
- `docs/proposals/2026-10-15-hifox-roadmap/05-project-workspace-and-integrations.md`
- `docs/proposals/2026-10-15-hifox-roadmap/README.md`
- `docs/proposals/2026-10-15-hifox-roadmap/extension-manifest.json`
- `docs/proposals/2026-10-15-hifox-roadmap/source-manifest.json`
- `docs/proposals/2026-10-16-workbench-layout/01-boundaries-and-page-map.md`
- `docs/proposals/2026-10-16-workbench-layout/02-workflows-and-interactions.md`
- `docs/proposals/2026-10-16-workbench-layout/03-validation-and-rollout.md`
- `docs/proposals/2026-10-16-workbench-layout/04-visual-brief.md`
- `docs/proposals/2026-10-16-workbench-layout/README.md`
- `docs/proposals/2026-10-16-workbench-layout/assets/knowledge-reader.png`
- `docs/proposals/2026-10-16-workbench-layout/assets/task-workspace.png`
- `docs/proposals/2026-10-16-workbench-layout/assets/work-items.png`
- `docs/roadmap.md`

## Necessary existing dependency wiring

An isolated staged tree initially failed with missing docOpen/docSetPin types. The existing DocWindow/current IssuePeek already use these methods. The complete existing document-window API/main/preload wiring is included so this checkpoint compiles independently; no source behavior was invented during packaging. This includes the existing document-window portion of main/index.ts. Unrelated ACP implementation, other task metadata and DocWindow cosmetic WIP stay out.

- `src/main/index.ts`
- `src/main/ipc/deps.ts`
- `src/main/ipc/docs.ts`
- `src/main/ipc/index.ts`
- `src/preload/index.ts`
- `src/shared/ipc-channels.ts`
- `src/shared/types.ts`

## Excluded prior work

- `.trellis/tasks/00-bootstrap-guidelines/task.json`
- `.trellis/tasks/09-23-spec-code-health/task.json`
- `.trellis/tasks/09-30-planner-dispatch-demo/task.json`
- `.trellis/tasks/10-09-acp-agent-console/task.json`
- `.trellis/tasks/10-11-cockpit-s0-glass-box/task.json`
- `.trellis/tasks/10-13-honsky-662--药库管理-显示药品金额小数位数/task.json`
- `.trellis/tasks/10-14-my-ui-shell/task.json`
- `.trellis/tasks/10-15-weekly-cycles/task.json`
- `scripts/smoke/acp-project-scope.mjs`
- `src/main/ipc/acp.ts`
- `src/main/services/acp.ts`
- `src/renderer/src/my/layout/ProjectSidebar.tsx`
- `src/renderer/src/my/pages/DocWindow.tsx`
- `src/renderer/src/pages/AcpConsole.tsx`

Code work commit: `519c69ca9d103f20be74fd5dda8718a2485338ff`. Native visual acceptance remains pending.
