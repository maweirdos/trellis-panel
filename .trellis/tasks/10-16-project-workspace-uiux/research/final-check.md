# Final code and quality review — 2026-10-16

## Scope and result

Reviewed the approved R1–R8 / AC1–AC9 implementation against the task artifacts and the 116-file implementation-entry baseline. Existing main/preload/ACP changes and unrelated task metadata were preserved. No staging, commits, task archival, dependency changes, new IPC, process starts or platform integrations were performed by this reviewer.

Automated checks pass. Mounted/native acceptance remains owned by the main session and must be read together with `design-qa.md`; these smoke tests do not prove focus/scroll geometry, OS controls or file-watch behavior in the live window.

## Findings fixed

1. **Escape could close a menu and the task behind it; browser preview had no shared dispatcher.** `my/ui.tsx` Dropdown and Modal now register stable `useId` layers through the existing `useEscLayer` contract. `App.tsx` owns one ordinary-window dispatcher shared by native and no-IPC preview; document, capsule and quicktodo modes keep independent behavior. The keyboard-help overlay also registers its own layer. Public component call signatures are unchanged. Real-component hook tests cover menu → modal → preview, context before workspace, and workspace → preview → close with re-registration.
2. **A delayed Knowledge note-edit read could replace a later selection or new note; a failed read could create an empty draft.** `pages/Knowledge.tsx` uses its existing document sequence for edit reads, selection/new-note/close invalidation and stale save/delete UI replies. Failed reads show an error and do not create an editable replacement. Unmount invalidates local/remote search and document callbacks.
3. **Known context manifests were hidden from their intended material groups.** `reader/task-materials.ts` places exact `implement.jsonl` / `check.jsonl` basenames in execution / validation. Unknown machine records and `task.json` stay in the raw-record group. This is navigation classification only; it infers no run, approval or success. Regression assertions cover case, nested paths, both separators and unknown JSONL.
4. **Selected light-theme rail labels narrowly missed the agreed text contrast target.** Existing green foreground `(4,120,87)` over the composited selected background `(210.36,234.02,227.04)` produced approximately **4.34:1**. A light-only `my.css` rule uses the existing primary text token `(15,15,16)` for the label span, producing **15.17:1**. The icon, background and edge indicator remain green; dark mode and generated tokens are unchanged. Rendered values were supplied by the main session's actual UI inspection.
5. **Central TaskDetail used the same canvas surface as surrounding navigation.** Following native screenshot evidence, workspace presentation now uses `bg-my-surface-1`; preview keeps its previous canvas surface. Material navigation and optional context retain their existing secondary surfaces. No new palette was added.
6. **A one-shot Spec target could pass the lexical root prefix with a parent segment.** `pages/Spec.tsx` now rejects `..` in the derived relative path before the legacy absolute read. Matching-root original file targets remain supported. The real component test confirms a parent-traversal target issues no read, alongside foreign-root rejection and valid-target rendering.
7. **The preview branch did not enforce its documented no-IPC condition.** `App.tsx` now explicitly requires `!hasIpc` for `?my=1`. Native windows always use MainApp's real data/event wiring, even if that query is supplied. This was a narrow consistency guard; the main session confirmed its native test URL was the ordinary `/` URL, so this is not claimed as the cause of the first native probe result.

## Contracts checked in code

- One header/project selector; native controls are guarded by `hasIpc`; independent window modes remain outside the normal shell. All 17 Page destinations remain in typed navigation metadata and the command palette.
- The fixed rail contains peer modules. Context collapse does not remove the rail. Iteration identity uses explicit `workItemsView`, independently of ordinary cycle grouping; existing cycle storage and rollover remain unchanged.
- `MyApp` keeps source `PageBody` mounted and marks it inert/hidden while expanded. Scroll hosts and focus targets are captured for return. One task slot and one TaskDetail/DocPane exist; their keys do not include presentation. DocumentReader's load/watch effect does not depend on its compact/full visual variant.
- Task closure, deliberate navigation and real root changes clear presentation/material/Spec targets. Initial root synchronization preserves deep-linked tasks. Root preference and ACP generation/isolation tests remain intact.
- Knowledge uses the original local file paths and shared reader while retaining independent company retrieval. Company previews do not claim local revisions. Spec displays selected search/log documents independently from an editable tree selection and validates one-shot targets against the current root and authorized path.
- Overview renders one real-data queue at a time, with actual creator/updated time. Team responsibility uses assignee; file/session timestamps are described as records rather than actors or online presence. Temporary comments remain labeled temporary.
- New external-app and developer run/log/Git capabilities remain deferred. The shell introduces no corresponding backend calls or executable placeholder controls.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS, including after reviewer fixes |
| `npm run build` | PASS after reviewer fixes; output in `research/final-build.log` |
| `node scripts/smoke/navigation.mjs` | PASS: all routes, explicit iteration identity, roots/preferences/deep links and recent-project races |
| `node scripts/smoke/task-presentation.mjs` | PASS: composed task/source/reader actions and known/raw material grouping |
| `node scripts/smoke/uiux-wiring.mjs` | PASS: real component hook/event wiring for Escape ordering, Knowledge stale edit reads, local results after company failure, Spec log rendering and root-owned/traversal target guards |
| `node scripts/smoke/acp-project-scope.mjs` | PASS, 24 regression cases |
| `node scripts/smoke/acp.mjs` | PASS, lifecycle/permissions/events |
| `node scripts/smoke/reading-session.mjs` | PASS, 58 assertions |
| `node scripts/smoke/task-reader.mjs` | PASS |
| `node scripts/smoke/reader-wiring.mjs` | PASS, 40 assertions |
| `python .trellis/tasks/10-15-unify-plane-uiux/check_my_classes.py` | PASS: 86 used classes, 0 missing |
| `git diff --check` | PASS; Windows line-ending notices only |
| Lint | N/A: repository has no lint script/configured lint gate; no new tooling installed |

The new component harness exercises actual React component hook/event code with controlled adapters, without mounting child DOM or Electron. It complements, rather than replaces, the main session's UI/native walkthrough.

## Findings not fixed / verification limits

- **Pre-existing note-save API limitation:** `kbSaveNote(fileName, content)` has no expected-mtime/version argument. Spec editing retains its existing `writeSpecFile(..., expectedMtime)` conflict contract; project-note editing must not be represented as providing the same external-conflict protection. Extending this public IPC/backend contract is outside the approved UI change and reviewer ownership.
- **Pre-existing watcher deletion gap:** `services/watcher.ts` forwards add/change file events but routes `unlink` only to the debounced snapshot callback. The document change bridge supports missing-file events when called, yet the actual watcher does not forward deletion to it. This was found during read-only diagnosis and was not changed because backend watcher contracts are outside this task. The passing pure service test does not establish live deletion notification.
- **Development-window probe limitation:** the first live probe in a repeatedly hot-replaced development window retained the displayed revision but did not show an update notice. No cause was established; no backend change was made to explain it away. After the main session cleanly closed and reopened the reader with product edits frozen, the native repeat probe passed: the displayed/base revision stayed `73e53fa1`, candidate `efc5a179` and the pending controls survived workspace → preview → workspace with the same accessible node IDs; explicit “阅读新版” changed displayed to `efc5a179` and retained base `73e53fa1`. Main restored the PRD's original bytes. Evidence is under `C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a1436e-1074-7543-b63b-a091acb889ed/uiux-qa/`: `workspace-pending-ax.txt`, `preview-pending-ax.txt`, `read-new-version-ax.txt`. This reviewer read the three saved AX records; the main session owns the interaction/screenshots and final QA verdict.
- Actual 960px/1440px light/dark geometry, keyboard focus/scroll restoration, native controls, exact Spec edit conflict interaction and company/knowledge UI states require the main session's recorded walkthrough. Reader source/keys are correct by inspection; a build is not evidence of mounted continuity.

## Documentation handoff

The main session owns frontend spec/roadmap/design-QA updates. Include the ordinary-window Esc dispatcher and stable menu/modal layers, peer navigation and task presentation lifetime, central light-theme surface, exact manifest groups, and the additional `uiux-wiring.mjs` command. Keep deferred integrations and developer tools unimplemented in roadmap status.
