# Workflow material reading and independent windows

Task, conversation and native readers use the same `useDocumentReader` state machine and `DocumentReaderSurface`. Source documents, development PRDs and design documents remain separate materials. Reading does not send an agent message, approve requirements, or change Jira/workflow state.

## What readers can do

- Open the exact displayed version in another native window. Repeated explicit opens create independent views. Legacy IssuePeek `docOpen` still focuses an already open instance of the same root/source.
- Select two saved materials or versions for comparison. The left selection is the baseline, the right is the comparison. Paths, material kinds, revisions and capture times identify both sides. Principal task PRD/design/implementation files are suggested; another project-relative path can be read explicitly.
- Keep the current body while the agent saves a new revision. The reader reports a candidate; only **阅读新版** adopts it. Failed/missing/oversized current reads retain the selected version and show the actual failure.
- Keep independent scroll, raw/rendered mode, outline and width for each view. Width changes set the default for future views without changing other mounted readers. The existing bounded diff worker and Markdown/diagram fallbacks are reused.
- Pin, minimize, maximize and close the window that originated the control event. **返回来源** returns to its recorded project and exact session/task; it never chooses the latest chat.

Return rechecks source existence and any recorded native session generation at
the time of the action. Task origins pin the actual stable task reference; a
unique verified archive move follows that identity, while duplicates and missing
origins fail explicitly. A project change during focus/show does not publish a
late return event into the new project. Native captions use project/task and
Chinese material labels; exact paths, revisions and hashes remain in tooltips.

## Version/source boundary

`document:read` captures verified main-process read bytes through `WorkflowMaterialStore.captureDocumentRead` before returning a fixed descriptor to the renderer. Renderer text is never accepted as a historical source. BOM/original-byte digest and revision are retained; displayed text follows the shared reader's one-BOM stripping behavior.

`DocumentViewService` stores metadata under `.trellis/.panel/runtime/reader-versions/`: owner, immutable `wm-…` reference, source path and descriptor. It does **not** duplicate historical bodies. `rd-…` tokens resolve only in the owning canonical root, through the shared store's owner/ref/digest checks. The reader validates path/kind/revision/byte length against that immutable material on reopening. A file changing from A to B, disappearing, or moving does not cause a fixed A view to read B.

Existing `DocumentSource.workspaceId/taskRef` are presentation/cache namespaces. Main derives the real owner from the source root, verified binding and task source. Project-level documents have `taskRef: null`. The default private `reader-local-…` namespace is a local cache identity, not team authorization. The workflow application injects its trusted owner resolver through `DocumentViewAdapters.resolveOwner`; `storeForRoot` can select the same shared store.

Workflow graph artifacts use the main-only `registerMaterial(root, stored)` adapter after the application verifies run membership and material owner. The adapter rechecks the immutable store reference and never rereads current disk bytes. Currently this adapter supports `trellis-file`; KnowledgeArtifact's existing guarded revision adapter remains separate. An unsupported source explicitly fails instead of inventing a filesystem source.

## Native lifetime and project switching

The main registry binds an opaque view to its source root, fixed token, opening project generation, origin and actual `webContents.id`. Bootstrap does not authorize from a URL path or client view ID. The native renderer seeds the shared controller with the fixed version; its first current read is a candidate, not a replacement.

The window has an independent lifetime and survives closing the origin conversation. Current reads/watches/Git baseline reads require the original root and generation. Switching away and back does not revive an old live lease. Fixed versions and fixed-to-fixed comparisons remain readable; the user can return to the source project and open a fresh view to follow current files. Exact watch IDs and sender ownership protect other readers during cleanup.

Retaining a reader while its interaction scope is inactive cancels comparison
transients and clears their busy state. Late responses do not revive a modal or
affect the destination surface. Markdown component identities remain stable
across scope updates, preserving unchanged body nodes and selection; link and
knowledge-image actions still use their latest guarded source context.

Creation uses `screen.getDisplayMatching` for the source/retained bounds. Sizes are DIP, without a second scale-factor division. Retained in-process bounds are clamped to the available work area, including negative display coordinates and display removal. Explicit multiple views cascade; source bounds are remembered for reopening during the running app session. Restart-persistent placement is not claimed.

App-level theme/font events and token-based controls remain shared. Protected application loading/navigation stays in the existing loader. There is no arbitrary path opening through native bootstrap.

## Checks and remaining desktop acceptance

Focused commands:

```powershell
node scripts/smoke/reading-windows.mjs
node scripts/smoke/reading-window-ipc.mjs
node scripts/smoke/reading-window-hook.mjs
node scripts/smoke/reading-window-renderer.mjs
npm run typecheck
npm run build
npm run check:ui
```

The service suite uses actual files/material snapshots and the real bounded diff worker. The IPC suite executes actual handlers with simulated Electron ownership. The hook suite executes the actual controller with controlled scheduling. The renderer suite mounts actual native reader components, shared store, Markdown and Modal in hidden Electron and asserts DOM selection/scroll retention, independent width/raw mode, explicit adoption, exact version opening, pair comparison, Esc layers and watch cleanup.

These are software checks. They do not establish packaged OS always-on-top behavior, real cross-screen dragging/mixed DPI, human visual quality, native focus during origin close/reopen, or manual assistive-technology behavior. Those gates stay pending until exercised with the packaged application and actual displays. Task evidence is recorded in `.trellis/tasks/10-20-wf-reading-windows/research/implementation-evidence.md`.
