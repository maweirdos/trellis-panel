# Application Panel

## 1. Scope / Trigger

The ordinary-window header and Tasks > Tools > Run project the same application
runtime. Read this when changing `src/renderer/src/applications/`, the header
trigger or runtime IPC. The data/lifecycle contract is in `../backend/app-runtime.md`.

## 2. Signatures

- `ApplicationPanel()` is the stable named run-selector/direct-action/dialog owner.
- `ApplicationDock()` mounts once after ordinary main content; output tabs, resize
  and collapse are presentation only. See `developer-tools-workbench.md`.
- `ApplicationRuntimeView()` reuses the list inside the existing Run tool destination.
- `ApplicationList({ compact?, onOpenEditor? })` projects app cards and output.
- `ApplicationConfigDialog(...)` reexports the grouped list/form configuration
  manager, with independent drafts, shared Modal and write-only override fields.
- `useApplications()` exposes one shared project-root/generation-scoped projection.
- Use the root-first `ApplicationRuntimeApi` from `@shared/app-runtime` via `api`.

## 3. Contracts

- Main owns process lifetime. Unmount, closing popup/editor, changing projects or
  ending a conversation never sends stop. Do not restore a second dev-run map.
- Header, inline list and dialogs share projection/editor ownership. Modal state
  lives outside conditional dropdown content, so dismissing the popup does not
  destroy a draft. Only the stable owner mounts the editor/review/remove dialog.
- Clear selection/errors/editor on genuine root changes. Generation/request guards
  discard old replies, including A -> B -> A. Freeze root and revision for a user
  action and never apply a result from another project/run.
- Persist configuration in main. Do not persist output, secret values, approval
  booleans or PID authority in renderer preferences. Saving/importing does not start.
- Process labels and readiness labels remain separate and use text plus semantic
  icons. Unconfigured/unknown readiness is not success. Backend capability fields
  govern actions; show per-app pending states and persistent failure detail.
- Root-less/no-IPC previews show honest unavailable/empty states; no simulated
  successful execution or native chooser call. Root paths are request scope checks,
  not renderer authority to open or operate an arbitrary project.
- Use canonical tokens, shared Button/Modal/Dropdown/Tooltip/fields, one App-owned
  theme root and existing Escape/focus ownership. Severity uses semantic ink/icons
  and neutral complete borders, never a colored left stripe or private palette.
- Keep the title bar's drag regions and native controls intact; new controls are
  `no-drag`. Popup/log/list sizes are bounded against viewport insets; text wraps,
  controls stay reachable and only the appropriate pane owns overflow.
- Do not reuse ACP inspector/transcript/source lifetimes for application state.

## 4. Validation & Error Matrix

| Case | Required result |
| --- | --- |
| Pending Agent request | Header attention and current-app confirmation action |
| First start/changed command | Native main review; no renderer trust toggle |
| External port conflict | Visible detail and retry/configuration, no automatic kill |
| Stop timeout/unknown ownership | Persistent error, no optimistic stopped status |
| Popup closes while config opens | Dialog/draft survives; focus returns to connected trigger |
| Root A reply arrives after B or A -> B -> A | Ignore old projection/error/editor mutation |
| App restarts while output read/probe is pending | Reject old run's projection |
| Narrow viewport / large font | Popup/modal fit; labels/actions remain reachable |
| Missing IPC/project | Clear unavailable state and disabled native actions |

## 5. Good / Base / Bad Cases

Good: a developer checks readiness and stops a running backend from the header
while a conversation remains mounted. Base: an empty project offers add/import.
Bad: navigating away stops a service, a stale list overwrites a newer event, or a
green running dot claims a service is healthy without a successful readiness check.

## 6. Validation

Run `npm run check:ui`, `npm run typecheck` and `npm run build`. The UI check is static; inspect actual light/dark, all font presets, 960px desktop and narrow modal layouts separately.

Verify save without execution, approvals, delete, output/follow/bounds, per-app failure/busy, missing IPC, root generations, dismissal/focus and subscriptions. Check toolbar/dock resizing, independent drafts and source retention while real application and disposable Git operations coexist. Actual process ownership and native human decisions require real renderer/preload/main/service evidence; keep any temporary scripts and data in OS TEMP.

## 7. Wrong vs Correct

Wrong: modal editor nested under popup-only JSX, `.my-root` nested in the popup,
local hardcoded colors, or a component cleanup that calls stop.

Correct: sibling stable modal ownership, shared inherited tokens, root/run-scoped
subscriptions and explicit user lifecycle actions delegated to main.
