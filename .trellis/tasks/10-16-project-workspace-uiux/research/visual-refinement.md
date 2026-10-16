# Visual refinement after user review — 2026-10-16

The user rejected the first shell's visual finish and supplied Codex plus the actual Trellis native screenshot as references. Existing navigation/workflow authorization remains; this is a scoped visual correction within the same in-progress task, not a new feature plan. No commit approval was given. Previous visual QA is reopened.

## Evidence and defects

- User screenshot `codex-clipboard-96efc65f-a31e-4438-8b69-e6e23e9477af.png`: Codex reference, spacious neutral desktop rail, quiet current selection, clear sidebar typography and integrated application heading.
- User screenshot `codex-clipboard-d34e1518-4a22-40bf-b9cb-1509832a9b27.png`: current Trellis, dense icon/caption stack, bordered project field, heavy external black rounded frame.
- The project selector is implemented as a bordered layer in my.css; the rail uses 18px icons plus 10px captions. Context items have persistent borders/shadows. These produce toolbar/form styling instead of a desktop navigation hierarchy.
- The outer black frame's source is not established. Renderer root styles and Electron/native decoration must be checked separately; do not call it a CSS focus ring or remove resizing without evidence.

## Correction boundary

Retain one top-level project identity, eight peer modules, current routes, context ownership, reader lifetime and all workflow behavior. Refine TitleBar/ProjectSwitcher/WorkspaceSidebar/my.css only for renderer chrome; inspect native decoration separately. Keep green as product accent and the current icon/font/token family, with Codex used as the minimum finish reference.

- Project title: borderless/transparent at rest, readable medium/semibold title and quiet chevron; subtle hover target, accessible keyboard focus and real-root menu behavior retained.
- Header: fewer boxed controls/dividers, consistent baseline and spacing; compact search action retains Ctrl+K and native drag/no-drag boundaries.
- Rail: desktop icon targets, more breathing room, quiet neutral selection, full accessible names and useful hover labels. Visible 10px captions are not a fixed requirement after this feedback. Keep all modules discoverable; do not bury them under tasks.
- Context: larger readable labels and spacing, soft selected row rather than bordered card; no global palette replacement or change to underlying views.
- Outer frame: fix at its actual source using supported Electron/native behavior; preserve resizing, dragging, snap/maximize/restore and theme contrast. No native FFI workaround, new dependency or disabling thickFrame as a shortcut.

## Verification

Capture current and revised header/rail at identical viewport/theme. Compare with user references and inspect focused crops, not only build success. Check default/mouse/keyboard states so focus stays visible without a black container outline. Test 960px and 1440px, light/dark, project menu/Escape, context collapse and existing navigation/reader regressions. Native frame claims require native capture; browser-only evidence cannot establish them.

Commit plan remains unapproved and will be regenerated after visual acceptance.

Checkpoint update: the user later explicitly said “先提交这一版吧”. This authorizes a local commit of the current checked implementation with native visual QA still pending. The regenerated commit plan records required document-window dependency wiring and excludes unrelated ACP/task work. It does not authorize marking visual acceptance passed or pushing/archiving the task.

## Native source boundary confirmed

Browser inspection found zero border width and no outline on html/body/#root/.my-root; the rounded outer black stroke is outside this renderer surface. Installed Electron 44's supported Windows accentColor API maps to DWMWA_BORDER_COLOR. false selects the OS default and does not promise disappearance. The scoped correction may therefore apply existing light/dark neutral border and canvas colors to the ordinary main window at creation and existing theme updates. Preserve thickFrame, resize/snap, round corners and all auxiliary window behavior. A tiny shared main-process appearance helper plus a patch.theme hook in the existing settings handler is permitted; no new IPC, dependency, native FFI or OS setting is needed. Native screenshots must verify the result.
