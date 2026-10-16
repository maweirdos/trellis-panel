# Content implementation — 2026-10-16

## Ownership and change boundary

Implemented R4/R5 in `pages/Knowledge.tsx`, `pages/Spec.tsx`, `pages/Team.tsx` and `my/pages/YourWorkPage.tsx`. No shell, CSS, generated tokens, main/preload, lifecycle writers or independent runtime integrations changed by this worker. Pre-existing dirty work was preserved. The task worker added the agreed UiSlice one-shot Spec target; the shell worker clears it on actual project changes.

## Result

- Knowledge retains real local indexing and independent company lookup. Project files use the existing DocumentReader, including actual revision/diagnostic behavior; remote WeKnora previews keep their existing plain-content capabilities. Source labels distinguish project notes, task summaries and company knowledge. Notes are not presented as private.
- Knowledge and Spec own their source/result browser. The shell should not add a second source column. The browser is 320px with a width cap, can be hidden without unmounting the reader, and yields to reading when a file is opened in a narrow content area. Focus moves to the reading area when the selected source button becomes hidden.
- Knowledge's original normative path is passed through `openSpecDocument`. Spec consumes it only for a matching root and within-root path, selecting a real tree file where available. Unknown tree targets remain read-only.
- Spec's display predicate accepts any selected document, so search/log/shared results render. Editing remains restricted to actual Spec tree files and uses a fresh content/mtime baseline; writes retain the existing conflict contract. The reader stays mounted while editing, and copy uses the displayed reading version. Sequenced reads and writes cannot replace a later file selection with an earlier reply.
- Overview shows one queue at a time (assigned, created, recent updates), derives creator/update metadata from real tasks and does not impersonate the first member when developer identity is absent. Archive maintenance is secondary and collapsed. Demo data is labeled as demo.
- Team uses assignee only for responsibility, includes unassigned work and filters all/mine/unassigned. File mtime and session lastSeen are described as records, not actors or presence. Existing efficiency, standup, report and workflow tabs remain.

## Checks run

- `npm run typecheck`: passed twice during implementation, including shared one-shot-target integration.
- `node scripts/smoke/reader-wiring.mjs`: passed 40 assertions. This verifies underlying reader services/state/hub/scroll/path behavior, not mounted Knowledge/Spec interaction.
- `git diff --check` on the four owned files: passed (only existing Windows line-ending conversion notices).
- No new dependencies, no process starts and no repository mutations were introduced by these page changes.

## Remaining actual-UI acceptance

Main session/check agent owns combined build and visual/native acceptance. Still verify with real project data: Knowledge to exact Spec file; search/log body; edit/save external conflict; pending update preserved while hiding/reopening browser or entering/leaving edit; company failure with local hits intact; Team owner/creator mismatch and unassigned tasks; Overview view switching and actual updated-time order. Browser preview without IPC cannot establish these native behaviors.

This worker's four product files are frozen for the combined check unless a concrete finding requires repair.
