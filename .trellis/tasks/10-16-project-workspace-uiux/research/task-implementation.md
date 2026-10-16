# Task presentation implementation evidence — 2026-10-16

## Change boundary

The broken behavior lived in task presentation and the UI slice: expansion forced the tasks route, while the shell always displayed the same drawer. This slice makes the existing TaskDetail content presentation-aware and keeps route identity independent. Shell integration remains owned by the shell implementer; document services, revision parsing, execution, lifecycle commands and native process APIs are unchanged.

## Files and behavior

- `pages/TaskDetail.tsx`: optional `presentation: 'preview' | 'workspace'` (default preview); one DocPane/DocumentReader keyed by actual file identity; workspace fills the available region and has no drawer resize handle. Return/Escape goes to the existing source preview. A material group filters navigation only, without changing the selected reader. All actual files remain discoverable, including raw JSON/JSONL and unknown names; unsupported file types show the shared reader's existing diagnostics. Optional context overlays the content instead of squeezing a narrow reader and reuses actual ObservationPanel receipts with the task ID/relative directory scope.
- `reader/task-materials.ts`: filename-based convenience groups, including an all-material fallback. No approval/success inference.
- `my/pages/IssuePeek.tsx`: explicit central expansion and selected-file entry; independent document windows retained as secondary actions. Stage is read-only. In-memory comments are explicitly temporary and not sent to teammates. Escape uses the shared layer stack.
- `store/types.ts` / `store/slices/ui.ts`: `taskExpandOrigin !== null` means workspace; expansion does not change page. Return preserves the current selected task. One-shot task-material target and root-bearing Knowledge→Spec target added by agreement with the content implementer; deliberate navigation clears both.
- `store/slices/session.ts`: only the `showTask` action was changed by this implementer. Closing clears the expansion origin/material target and archived flag. All existing asynchronous root/revision guards are preserved.
- `scripts/smoke/task-presentation.mjs`: exercises real composed UI/session/reader actions, not a copied state machine.

Existing IssuePeek/session dirty changes were preserved. No staging or commits were performed.

## Checks run

- `npm run typecheck`: passed, exit 0 after integration with current shell/content work.
- `node scripts/smoke/task-presentation.mjs`: passed, exit 0. Covers source-route preservation, pending displayed/base/latest state, current selection on return, idempotent return, close/navigation cleanup, one-shot Spec targeting, and known/unknown material fallback.
- `node scripts/smoke/reading-session.mjs`: passed (58 assertions).
- `node scripts/smoke/task-reader.mjs`: passed.
- `node scripts/smoke/reader-wiring.mjs`: passed (40 assertions).

## Review / UI follow-ups

- Main session owns real mounted/native verification. State smoke does **not** prove React instance lifetime, file-watch subscription continuity, source focus/scroll restoration, theme contrast or native window behavior.
- Shell must keep one TaskDetail in its stable slot with a root/task identity key only; changing presentation must not rekey DocPane/DocumentReader. Source route remains mounted/inert while expanded. Actual root reset must clear taskMaterialTarget and specDocumentTarget (shell implementer has integrated this).
- TaskDetail deliberately changes the Escape layer ID across presentation changes so a consumed workspace layer registers again as preview; context and reader diff consume their own higher layer first.
- Knowledge→Spec consumer must reject a stale target with a mismatched project root. The target is a navigation request, not authority to read an arbitrary file.
- Existing Git/GitLab actions retain prior behavior; no new Git/platform capability was introduced. Optional observation binding remains its existing explicit operation.
- Temporary peek comments remain non-durable; this change labels that limit rather than inventing shared discussion.
