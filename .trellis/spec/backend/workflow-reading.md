# Fixed document sources and native reading views

## 1. Scope / Trigger

Read before changing document version selection/comparison, native reader windows,
workflow artifact opening or return-to-origin. Reuse the existing document
controller/watch/diff worker and WorkflowMaterialStore. Do not introduce another
body history, Markdown renderer, transcript store or task identity authority.

## 2. Signatures

```ts
configureDocumentViews(authority, adapters?): DocumentViewService
getDocumentViews(): DocumentViewService | null
service.captureRead(root, trustedRead): Promise<DocumentReadSuccess>
service.capturePath(root, relativePath)
service.registerMaterial(root, trustedStoredMaterial): Promise<FixedDocumentVersion>
service.readFixed(root, opaqueToken, presentationNamespace)
service.compare(root, { left, right, requestId })
```

Use exported shared/document-windows.ts DTOs and exact service signatures.
Adapters resolve the actual main-owned material owner/store. Legacy reader
workspaceId/taskRef fields remain presentation/cache namespaces, not grants.

## 3. Contracts

- Capture trusted main read A before returning its version descriptor; later disk
  B cannot substitute A. Store immutable bodies only in WorkflowMaterialStore;
  view/version records contain bounded validated metadata and owner/ref links.
- Main workflow artifact opening first checks actual run membership through the
  application, then registers that stored version without reading current disk.
  The registry's opaque token never authorizes arbitrary root/path/body input.
- Preserve full source digest, selected revision, source kind/path and actual
  material owner. Metadata tampering, directory junctions, corruption, quota and
  missing versions fail visibly without falling back to a newer body.
- Before a workflow application exists, explicit reader-local identities mean
  private cache namespaces. Injecting actual application owner resolution never
  silently migrates old pinned records or creates team authorization.
- Native view IDs permit independent windows/selection/width/raw/outline state.
  Sender identity owns bootstrap/current read/watch/pin/return/window actions.
  A request from an ordinary renderer cannot control another native view.
- Fixed A remains readable while current reads/watch notices offer candidate B.
  Adoption is explicit. Project generation changes fence current reads and watch
  leases; they cannot retarget the fixed source or queued comparison result.
- Compare two explicitly selected versions/materials through the existing bounded
  diff worker with both source/revision labels. A selected pair is distinct from
  current-file or latest-Git comparison.
- Return stores and revalidates exact original session, optional connection
  generation and stable taskRef. Resolve unique actual archived/moved task
  identities; reject missing/ambiguous replacements. Recheck origin/view/project
  generation before/after showing main. An explicit Return Source may reopen only
  its recorded project; never select a same-named task in the current project.
- Place windows within the source display's work area using actual DIP geometry.
  Keep per-view restore bounds separate from global theme/font. In-process
  placement retention is not an OS-restart guarantee.
- Use human project/task/material labels. Exact path/revision/full digest stays
  discoverable without printing opaque cache IDs as the main caption.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| File updated/deleted after selected snapshot | Retain selected body; report current-source state |
| Snapshot registration unavailable | Keep readable current body with explicit fixedVersionError |
| Wrong root/token/sender or tampered metadata | Reject; no current-file substitution |
| Project changes during async read/compare/return | Discard stale result or explicit conflict |
| Task archived/moved with unique actual identity | Return to verified current task path |
| Same-name or duplicate identity ambiguity | Reject, do not guess |
| Original session missing/stale generation | Visible unavailable origin; no substitute conversation |
| Unsupported published source adapter | Explicit unsupported result, no invented local path |
| Interaction scope suspended | Cancel transient comparison tickets/busy state; keep reader body |

## 5. Good / Base / Bad Cases

Good: open PRD A, let AI write B, select text in A, compare explicit A/B and open
two independently pinned windows. Return targets the exact recorded source.

Base: ordinary modern readers retain their existing watcher/controller behavior;
legacy IssuePeek opening uses the same guarded fixed-source route.

Bad: copy renderer old text into a new trusted snapshot, open the latest disk file
for an old output link, or return successfully after its source was removed.

## 6. Validation

Run `npm run typecheck`, `npm run build` and `npm run check:ui`. Verify retained DOM/selection, current guarded callbacks, independent watch leases, layered Escape and exact origin through actual reader/preload/main behavior.

Native window acceptance uses an isolated temporary profile/project with unrelated login/protocol/shortcut registration disabled. Verify A/B retention, pinned sender, minimize/maximize/restore and close/reopen. Keep temporary validation scripts in OS TEMP; development-window results do not establish installed-package, mixed-DPI or human OS-stacking behavior.

## 7. Wrong vs Correct

Wrong: “the token's filename still exists, so show today's text.”

Correct: resolve the selected immutable owner/ref, verify exact bytes and show
the live source only as a separately offered version.
