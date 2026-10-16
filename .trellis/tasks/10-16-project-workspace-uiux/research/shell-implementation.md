# Shell implementation — 2026-10-16

## Change boundary

The old task-parent sidebar mixed unrelated destinations and the browser preview skipped the native header. Task expansion was recorded but never hosted centrally. This slice changes renderer composition, route/view metadata and existing view preferences only. It does not add IPC, runtime execution, integrations, Git operations, workflow lifecycle writes or auth.

## Implemented

- `components/TitleBar.tsx` is the shared normal-window header. `my/layout/ProjectSwitcher.tsx` extracts the real-root project menu; selector names/paths come only from snapshots and recent settings. Native controls and maximize subscriptions are bridge-guarded. Buttons/menus are outside drag regions. Failed project opens remain visible in the header as well as the menu.
- `App.tsx` renders the same header in browser preview, guards bootstrap without IPC, keeps preview HTML theme consistent and leaves doc/capsule/quicktodo window modes outside this shell. Material update notifications now recognize reading from any source page.
- `WorkspaceSidebar.tsx` keeps a fixed 56px rail with eight peer modules, visible Chinese labels, accessible names and titles. Work/intake/tools receive useful contextual views; Knowledge/Spec and ACP retain their page-owned result/session browsers. Overview/team/analytics receive no empty context column. Collapse affects context only.
- `navigation.ts` owns all 17 route metadata entries, module identity and scope notes. API chat remains a local cross-project tool. The command palette consumes the same metadata.
- `my/store.ts` has explicit items/iterations identity separate from grouping, plus shared work-view tabs. Entering iterations selects cycle grouping; returning to items restores the ordinary grouping. Actual root changes clear task/material/spec targets without losing initial deep-link focus or scoped preferences.
- `WorkItemsPage.tsx` removes repeated project identity, consumes shared view state and keeps all five layouts, filtering, saved views and week rollover. The page header exposes view tabs when context is collapsed.
- `MyApp.tsx` keeps source PageBody mounted while central task presentation is active. It changes one stable TaskDetail slot's presentation prop, keeps its key semantic (root/task), hides/inerts source interaction and captures/restores nested scroll hosts and source focus (host fallback if the originating modal disappeared).
- `PageFrame.tsx` displays module/object identity without another project breadcrumb. Project ACP and collaboration channels are distinct modes; local API chat is outside these tabs.
- `my.css` uses existing canvas/layer/surface roles and structural borders for rail/context/center, with independent keyboard focus outlines and selected-module marker. Generated tokens were not edited. Future integration/run/log/Git placement is explanatory text, with no pretend executable controls.

## Files

`src/renderer/src/App.tsx`; `components/TitleBar.tsx`; `my/layout/ProjectSwitcher.tsx`; `my/layout/WorkspaceSidebar.tsx`; `my/layout/MyApp.tsx`; `my/layout/PageFrame.tsx`; `my/navigation.ts`; `my/CommandPalette.tsx`; `my/store.ts`; `my/pages/WorkItemsPage.tsx`; `my/my.css`; `scripts/smoke/navigation.mjs`.

## Validation

- `npm run typecheck` passed twice after integration with task worker state/presentation changes.
- `node scripts/smoke/navigation.mjs` passed. Added real-store checks for eight peer modules/all legacy routes, explicit iteration vs cycle grouping, ordinary grouping restoration, useful context ownership and task/spec/material target clearing on root changes. Existing Windows/UNC/POSIX identity, same-name roots, bounded scoped prefs, legacy preservation, initial deep links and asynchronous history/open races remain covered.
- Main session owns browser/native visual checks and final build/design QA. Typecheck and pure-state smoke do not establish mounted reader continuity, contrast or native drag/control behavior.

## Remaining checks / risks

Verify at 960px and wide viewports, light/dark; preview must remain visibly unbound. Native controls and project switch failures need real Electron verification. Expand/return must retain one reader instance and pending revisions, source scroll and keyboard focus. Existing ACP's session browser is page-owned and was not rewritten. Existing dirty baseline and other workers' edits were preserved; no staging/commit occurred.
