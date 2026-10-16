# Project workspace UIUX — design QA

Date: 2026-10-16. Scope: the approved fixed module rail/contextual sidebar, unique top project header, central task presentation, current-style continuity and stronger light hierarchy.

## Source, implementation and normalization

- Style baseline: `C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a1436e-1074-7543-b63b-a091acb889ed/uiux-qa/before-overview-dark-1280.jpg`.
- Matching implementation: same directory, `after-overview-dark-1280.jpg`.
- Both are 1280×720 pixels at a 1280×720 CSS viewport, dark theme, unbound browser preview, assigned-work view and the same demo data. No density scaling was used.
- Full comparison: `uiux-qa/overview-comparison.png` under the artifact directory above; focused comparison: `uiux-qa/navigation-focused-comparison.png`. Both combined inputs were opened and inspected. The focused view uses unscaled 280×600 crops, including a small portion of adjacent content.
- Approved structural truth: `.trellis/tasks/10-16-project-workspace-uiux/design.md`. The earlier images in `docs/proposals/2026-10-16-workbench-layout/assets/` are concept references; their sidebar project selector, four-scope rail and hypothetical approvals are superseded. This is an approved redesign, not a pixel clone of those illustrative states.
- Renderer implementation: `http://localhost:5373/?my=1`; native Electron: `http://localhost:5373/` with real project snapshots and IPC.

## Findings and comparison history

1. **[P2, fixed] Light selected-module label contrast.** Actual green text over its composited translucent selection background was about 4.34:1. The label now uses the existing primary token, approximately 15.17:1; icon/background/indicator retain green. Final DOM values were rechecked.
2. **[P2, fixed] Central task used peripheral canvas gray.** Native inspection found the full task and body visually merging with the rail. Workspace presentation now uses surface-1; the preview retains its established surface. Post-fix evidence: `uiux-qa/task-workspace-pending-light.jpg` (1362×862 native capture).
3. **[P1, fixed] Escape dismissal crossed overlay boundaries.** Shared menus and modals now use the existing layer stack. Actual final browser sequence: open task preview → priority menu → Escape closes menu only → second Escape closes preview. Component regression also covers workspace/context/modal order.
4. **[P1, fixed] Late note-edit reads could replace a newer selection/draft.** Existing page sequence guards now cover edit reads and failures. Actual-component hook regressions verify stale/failure outcomes; this is not claimed as native write/conflict E2E.

Post-fix full/focused comparison found no remaining actionable P0/P1/P2 visual or core navigation findings. The new hierarchy, smaller welcome area, exclusive queue and collapsed maintenance are intentional approved behavior changes.

## Required fidelity surfaces

- **Typography:** existing Inter/system Chinese fallbacks, size/radius tokens and density retained. Primary titles, secondary metadata, module labels and visible keyboard focus have distinct roles. No new font family or decorative display typography.
- **Spacing/layout:** stable peer rail, useful context only, central-first layout and optional right material context. 960px and 1280px work-item/iteration headers had no offscreen buttons or document-wide horizontal overflow; 1440px overview/preview interactions were checked. Context collapse preserves rail destinations.
- **Colors/tokens:** final light rail `(242,242,243)`, context `(249,249,249)`, center `(255,255,255)` plus structural borders. Selection, hover and keyboard focus remain separate; Tab focused iterations with a visible 2px outline while work items stayed selected. Dark style and green accent retained; generated tokens untouched.
- **Images/icons:** existing logo/icon family reused; no generated raster artwork, replacement art or placeholders introduced into the application. Screenshots are QA evidence only.
- **Copy/content:** demo is visibly labeled. Native task phases remain read-only, notes are project notes, company source has its own scope, temporary comments are labeled temporary. No fictional approvals, online presence, process state or integration success.

## Actual interaction evidence

- Browser: fixed peers, items/iterations, context collapse, Knowledge and ACP honest no-project states, theme switching, nested Escape, keyboard focus and 960px controls. Final reloaded browser console contained no error entries.
- Native: switched honsky-governance → trellis-panel through the real project menu; opened this task from overview, entered its PRD centrally, returned to source preview, and expanded again. Native maximize/restore changed its label through real window events.
- Native version probe: temporary append to this task's own PRD changed disk revision `73e53fa1` → `efc5a179`. A clean reader kept `73e53fa1` displayed and showed the new candidate. The same notification accessibility node survived workspace → preview → workspace. Explicit “阅读新版” displayed `efc5a179` with opening baseline `73e53fa1`. The source file was restored byte-for-byte afterwards.
- Version evidence: `uiux-qa/task-workspace-pending-light.jpg`, `task-preview-pending-light.jpg`, `workspace-pending-ax.txt`, `preview-pending-ax.txt`, `read-new-version-ax.txt` in the artifact directory above.

## Limits and follow-up polish

- The first development window, after several HMR replacements, did not show a file-update notice. Closing and reopening the reader after product files were frozen restored the live notification behavior. The cause was not established; no backend fix is claimed.
- Native drag/minimize/close, independent doc/capsule/quicktodo windows and every real-data Knowledge/Spec edit-conflict combination were not exhaustively exercised. Related unchanged paths and root/target/edit semantics received code and automated review; browser preview is not proof of native IPC behavior.
- Existing project-note save API has no expected-mtime protection. Existing watcher deletion events are not forwarded to the reading bridge. These pre-existing backend limitations remain deferred and are not presented as fixed.
- No P3 visual change is required for this handoff; further density/label preferences can be reviewed in the running app.

## Implementation checklist

- [x] Approved root/header and peer/context layout implemented.
- [x] Light hierarchy and selection contrast corrected and recaptured.
- [x] Source/implementation full and focused comparisons inspected.
- [x] Nested Escape and live pending-version continuity verified.
- [x] Typecheck, build, focused regressions and token-class checks pass; see task `research/final-check.md`.
- [x] Known limits recorded without inflating capability claims.

## Reopened after user review

The user rejected the visual finish of the sidebar/project header and the heavy native outer frame. Prior passing status is withdrawn for this visual iteration. See task `research/visual-refinement.md`; capture, correct and compare again before handoff. Functional regression evidence above remains historical evidence, not visual approval.

Renderer refinement is implemented: integrated borderless project title, desktop icon rail,
quiet context rows and retained keyboard focus. Browser capture `uiux-polish-qa/02-refined-overview-light.jpg`
was inspected, but it predates the last rail alignment adjustment. Native appearance now uses
the supported theme-aware DWM accent/background API, preserving frame sizing options.
The user stopped Computer Use with physical Escape before a valid final native frame capture;
all further UI input stopped. Code checks passed; final visual/OS verification remains blocked.
See task `research/visual-refinement-audit.md` and `research/visual-refinement-check.md`.

The user subsequently requested committing this version first. That checkpoint is allowed
with this blocked visual status preserved; it is not a claim that the native frame was verified.

final result: blocked
