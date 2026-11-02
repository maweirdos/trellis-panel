# Developer Tools Workbench

## 1. Scope / Trigger

Read this for ordinary-header Git/run controls, the run dock and configuration
manager. Reuse global `my-*` tokens and the existing runtime/read-only viewer;
IDEA is an interaction reference, not a private theme or IDE implementation.

## 2. Signatures

- `GitBranchControl()` owns the branch dropdown and portalled changes panel.
- `useGitWorkspace()` owns the current-root/generation projection and pending
  mutation gate; use `api.gitWorkspace`, including its root-scoped `diff`.
- `ApplicationPanel()` is the stable named run-selector/action/dialog owner.
- `ApplicationDock()` is mounted once after the ordinary main content, never
  inside a conditional route or conversation. Do not mount in document/capsule views.
- `ApplicationConfigurationManager` (also exported as `ApplicationConfigDialog`)
  reuses `ApplicationConfigForm`; the existing inline Run view still works.

## 3. Contracts

- The desktop global row carries Work/Code, team space, search, activity, account,
  context collapse and native controls. Code engineering tools occupy a compact
  secondary row owned by `TitleBar`: real project/development source and branch
  state on the left, selected config and direct start/restart/stop on the right.
  Preserve `no-drag` interactions. Keep the existing personal/team page components
  and their routing, filters, forms and task workflows.
- Show the tools row only in Code engineering contexts or an open task surface;
  team/settings pages, creations and personal team-task lists do not gain
  engineering controls merely because Code is selected. Private Code conversations
  show the existing Git/run controls only when their fixed directory matches the
  actual loaded engineering source. The fixed directory caption shrinks through
  its tooltip wrapper and truncates without overlapping the adjacent branch.
  Mode changes remain a
  presentation preference and never prepare/rebind a task or start/stop a run.
- Private conversations have no personal/team selector. The global team-space
  switch retains its existing business scope without filtering, replacing or
  moving the current conversation or draft. Knowledge sources, requirement
  destinations and artifact publication scopes belong to their respective
  authorized business flows.
  Private Code directory controls use that conversation's native grant rather
  than the shell's selected project. Do not show another project's Git/run state
  beside a private conversation.
- `ApplicationRunCenter` can expose a compact `activity` trigger in the global
  row. Its count and unavailable/partial/uncertain states come from the existing
  instance store; this does not claim to aggregate Agent or background job activity.
  Preserve the actual instance details, source targeting and operation receipts.

  Empty/unavailable/detached/unborn are honest states, not placeholder branches.
  Test the actual shared header at the native 960px minimum with long project,
  branch and application names; child triggers must fit their shrinking owners,
  search keeps a full icon and native window targets must not overlap.
- Store presentation only (selected app ID, dock tabs/open/height) separately
  from process authority. Closing/collapsing a tab or dock never sends stop.
  Keep current page/source nodes mounted while resizing or opening tools.
  Closing a focused output tab restores a remaining tab (or the expand control);
  closing the dock restores its expand control without changing launch selection.
- `ApplicationDock` writes measured occupied height to its nearest existing
  `.my-root` as `--my-run-dock-occupied-height`, including collapsed height;
  reset on hide/unmount. The Git panel ends above it. One canonical geometry
  token set governs config width/list width/dock bounds, not duplicated literals.
- Keep bounded current-root/current-run output, cursor/truncation/error text and
  follow/pause. Selection is not authority to accept another run's late logs.
- The manager uses grouped configuration list plus reusable fields and independent
  drafts. Save does not run. Save-and-run is explicit and uses returned revision.
  Keep/replace/clear write-only overrides; never round-trip stored secret values.
  Confirm dirty dismissal and preserve shared Modal focus/Escape ownership.
- Git selection is by returned paths, not indexes or a broad add-all fallback.
  Show actual mutation failures and completed/uncertain qualifiers. Do not assume
  a rejected/timed-out request rolled back. Commit/push still require native main
  review; renderer confirmation is not an execution authorization.
- Capture root plus request/generation for every async operation. A -> B -> A,
  late status/diff and stale errors must not mutate the current view. Pending
  mutation disables double action; refresh does not authorize a changed revision.
  Last-consumer teardown also advances projection generation, so a delayed action
  cannot publish into a later same-root ordinary-window mount.
- Retain read-only history navigation; no new Git editor, debug UI, reset/rebase,
  force push, automatic network operation or external Agent write endpoint.

## 4. Validation & Error Matrix

| Condition | Required UI |
| --- | --- |
| Missing IPC/project/repo/Git | Explicit empty/unavailable status; no fake success |
| Starting/running/unhealthy/stopping | Separate actual process/readiness labels |
| External occupied port | Visible runtime failure; never kill its owner |
| Late previous project/run reply | Discard; do not retarget action or draft |
| Config CAS conflict | Keep draft and show error; no implicit launch |
| Dirty manager close | Shared confirmation, correct focus restoration |
| Git stale/hook/native cancel | Preserve actionable failure; refresh before retry |
| Short/narrow window, large font, maximum dock | Scrollable bounded panes; all actions reachable |

## 5. Good / Base / Bad Cases

Good: user stops a backend from the header while the current conversation/reader
remains mounted; Git panel stays above its resized output dock in either theme.
Base: an empty project offers add/import and a Git-unavailable explanation.
Bad: closing output kills a service, switching drafts saves automatically, a
branch change silently stashes files, or a stale diff renders under another root.

## 6. Validation

Run `npm run typecheck`, `npm run build` and static `npm run check:ui`. Inspect themes/font presets, constrained dock geometry, pointer/keyboard resize, independent drafts, source retention and focus/Escape.

Verify actual selected paths/refs after Git operations, unchanged run identity during unrelated edits, alive-after-collapse and service-stop port release using disposable OS TEMP repositories/services. Capture the current compositor after frames settle; DOM bounds or an offscreen first paint do not establish the visible result.

## 7. Wrong vs Correct

Wrong: put a second `.my-root` around the popup, render tools by replacing the
source route, or call `stop` in a dock component's cleanup.

Correct: inherit the App theme, mount the dock as an ordinary-shell sibling,
retain source ownership and delegate only explicit user lifecycle actions.
