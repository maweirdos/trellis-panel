# Project workspace UIUX — execution plan

Status: this-version checkpoint commit approved by the user (“先提交这一版吧”). Renderer/native refinement and code checks are complete. Native visual verification remains blocked after the earlier Computer Use stop; commit records preserve that limitation and the task remains in progress for follow-up verification.

## 0. Readiness and safeguards

- [x] User approved creating this task.
- [x] PRD captures the previously agreed window-root model and exclusions.
- [x] Read-only shell/content research completed; findings saved in `research/current-state.md`.
- [x] Complex-task technical design and ordered implementation plan prepared.
- [x] Curate `implement.jsonl` and `check.jsonl` with real specs and task research; validation is recorded below.
- [x] Presented updated final planning summary; user explicitly approved implementation (“可以，继续”).
- [x] User confirmed fixed module rail plus collapsible contextual sidebar; current visual style is retained, with improved light-theme hierarchy recorded as R8/AC9.
- [x] At implementation entry, saved 116 renderer/smoke/spec/roadmap files with SHA256 manifest, tracked diff and status under `C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a1436e-1074-7543-b63b-a091acb889ed/uiux-baseline`; no staging or unrelated edits.
- [x] Loaded frontend specs through native injection/child fallback for all three implementers and the full-scope check agent.

## 1. Shell and navigation

1. Extract the real project menu into `ProjectSwitcher`; compose one main-window header in desktop and preview.
2. Keep independent doc/capsule/quicktodo modes and guarded native controls.
3. Replace the task parent tree with a fixed peer module rail and collapsible contextual sidebar; contextual headings are inert, and all legacy routes remain reachable. Do not duplicate the main menu in the contextual sidebar.
4. Add explicit items/iterations navigation identity and actions; preserve ordinary layout/grouping preferences and root-scoped persistence.
5. Update PageFrame, WorkItems header and command palette to remove duplicated project identity and use the same metadata.
6. Verify no-project/demo labeling, collapsed labels, focus, keyboard shortcuts and mixed-scope tool notes.
7. Apply existing semantic surfaces consistently to rail/context/center/overlays. Keep the current design language; improve light-theme hierarchy through token use and, only if needed, scoped theme overrides. Do not edit generated tokens.

Ownership: shell coordinator owns `App.tsx`, title bar, `my/layout`, `my/navigation.ts`, `my/store.ts`, command palette and integration points. Overlapping files are serially integrated.

## 2. Central task workspace

1. Implement the presentation contract from `design.md`: stable task surface, mounted source body and explicit preview/workspace mode.
2. Reuse TaskDetail/DocPane/DocumentReader; remove drawer-only constraints when central.
3. Connect IssuePeek and other existing task entry points to central expansion; preserve independent document windows as secondary actions.
4. Connect return/focus/scroll restoration, root reset and deliberate module navigation.
5. Add material convenience groups with an all-material fallback; expose real ObservationPanel receipts in optional context.
6. Verify that an external document update remains pending across expand/return and that there is only one task reader instance.

Ownership: task-content implementer may own TaskDetail, IssuePeek, small material helpers and agreed ui-slice/type changes. Must not edit shell integration files concurrently. All workers must be told they are not alone and must preserve others' edits.

## 3. Knowledge, overview and team

1. Adapt Knowledge/Spec results and reading widths without new backends; retain real local/remote sources.
2. Rename/make explicit project notes; retain personal QA history's actual scope.
3. Fix Spec's loaded-content visibility for search/log selections; carry root-scoped document target from Knowledge.
4. Replace redundant overview lists with actual assigned/created/recently-updated views; demote maintenance noise.
5. Improve Team's responsibility/record presentation, preserving existing tabs and correcting actor/online/approval claims.
6. Document extension placement/status in the existing roadmap without marking future integrations or developer tools implemented.

Ownership: content-view implementer may own Knowledge, Spec, Team and YourWork only; coordinate any new store contracts with shell owner first.

## 4. Focused automated validation

Run checks appropriate to each slice, then the combined final suite:

```powershell
npm run typecheck
npm run build
node scripts/smoke/navigation.mjs
node scripts/smoke/task-presentation.mjs
node scripts/smoke/uiux-wiring.mjs
node scripts/smoke/acp-project-scope.mjs
node scripts/smoke/acp.mjs
node scripts/smoke/reading-session.mjs
node scripts/smoke/task-reader.mjs
node scripts/smoke/reader-wiring.mjs
python .trellis/tasks/10-15-unify-plane-uiux/check_my_classes.py
```

Inspect existing smoke runner setup before invoking; do not change install/runtime configuration just to satisfy a command. No lint script currently exists. Add narrowly meaningful navigation/presentation-state coverage where current tests miss the change; do not add snapshots that merely mirror markup.

Preserve existing navigation tests for all 17 pages, Windows/UNC/POSIX root identity, same-name roots, bounded scoped preferences, legacy-key preservation, initial deep links and recent-project races. Update old three-domain structure assertions to the final peer navigation contract.

Reader smoke tests validate services/pure state only; they do not replace mounted interface checks. Add focused presentation/return tests if the chosen state design introduces nontrivial transitions.

## 5. Actual UI acceptance and design QA

- Same reference and implementation viewport/state comparisons; use existing accepted content visuals with the documented top-header correction.
- Record findings in root `design-qa.md` per Product Design gate; explicitly distinguish intentional design changes from defects. Fix P0/P1/P2 before handoff, leave only documented P3 follow-ups.
- Cover 1440px and 960px layouts, light/dark, expanded/collapsed contextual sidebar with the fixed module rail retained, keyboard focus, no project and labeled browser preview.
- In light mode compare rail/context/central surfaces and floating menus in the same view. Check independent hover/selection/focus, rendered text contrast against R8's target, and continued use of current font/accent/density/radius. Recheck dark mode after any scoped override.
- Open a real task from work items, overview and team → preview → central workspace → return; verify selection, filters, local tab/collapse state, scroll and focus.
- With a real document update pending, expand/return without replacing displayed text or losing the update notice; test unknown and invalid raw materials.
- Switch between distinct same-name roots and return, checking task, notes, scoped views, drafts and ACP state.
- Check Spec search/log selection and Knowledge→Spec path targeting; fail company lookup and confirm local results survive.
- Verify native header drag/non-drag and window controls on actual Electron. Do not claim browser proves native behavior.
- Existing dev server uses port 5373; inspect/reuse it. Do not kill unrelated processes or expose a new service unnecessarily.

If source/native capture is blocked, report `blocked` or `unverified` accurately. Build success alone is not visual acceptance.

## 6. Review and finish

1. Dispatch Trellis check after implementation with this task's real check context; resolve spec/lint/type/meaningful-test failures.
2. Update the frontend navigation/presentation contract, preserving pre-existing changes to that spec.
3. Reconcile roadmap status only for features actually verified; retain deferred integration/run/log/Git scopes.
4. Inspect final diff against the task baseline and report changed behavior, tests and material limitations.
5. Follow `trellis-finish-work` for journal/commit/archive gates; do not archive unrelated active tasks or silently stage their work.

## Planning convergence record

Goal, included behavior, exclusions and observable AC1–AC9 are explicit in PRD. Technical unknowns (reader lifetime, source restoration and native verification) have an implementation/validation strategy; no speculative backend is required. The far-left rail decision reopened during review is now resolved by the user's explicit approval. Current-style continuity and light-theme hierarchy are folded into R8/AC9, not left as a separate brainstorm. No blocking product question remains; present the updated complete scope and obtain final implementation approval.

The final PRD convergence reread completed on 2026-10-16: requirement IDs, evidence anchors, decisions and AC mappings are preserved; temporary TBD/open-question sections are removed. No product code or implementation tests were run during planning.

Planning validation: `python ./.trellis/scripts/task.py validate .trellis/tasks/10-16-project-workspace-uiux` passed on 2026-10-16, with 12 implement-context entries and 9 check-context entries. Task status remains `planning` pending final review approval.
