# Task conversation continuation

## 1. Scope / trigger

Read when changing homepage native conversation entries, external session discovery, task/session persistence, editor navigation or their IPC. Code lives in shared/task-conversations.ts, main/services/task-conversations/, main/ipc/task-conversations.ts and my/use-task-conversations.ts.

This feature locates existing history and prepares selected-task continuation instructions. It does not send prompts, create replacement conversations, rename native titles or infer task completion.

## 2. Signatures

Shared Zod schemas define TaskConversationsApi. All flat preload methods return Promise<{ok:true;value:T}|IpcFail>:

- taskConversationsList({expectedRoot}) → TaskConversationsSnapshot
- taskConversationsDiscover({expectedRoot}) → TaskConversationCandidates
- taskConversationsBind({expectedRoot,taskDir,conversationId}) → snapshot
- taskConversationsSetPrimary({expectedRoot,taskDir,bindingId}) → snapshot
- taskConversationsUnbind({expectedRoot,taskDir,bindingId}) → snapshot
- taskConversationsOpen({expectedRoot,taskDir,bindingId}) → TaskConversationOpenResult
- taskConversationsPrepare({expectedRoot,taskDir}) → TaskConversationContinuation
- taskConversationsContinue({expectedRoot,taskDir,bindingId?}) → TaskConversationContinueResult
- taskConversationsPreview({expectedRoot,taskDir,conversationId}) → TaskConversationPreview
- taskConversationsInspect({expectedRoot,taskDir,conversationId}) → TaskConversationOpenResult

The registered taskConversations:* channels accept strict payloads, not arbitrary URLs, executables, native-home paths or commands. Service open(root,taskDir,bindingId,isCurrent?) checks the final owner guard immediately before launch.

Additive feature tables live in the existing project .trellis/.panel/runtime/control.sqlite: task_conversation_meta, task_conversation_owners, task_conversation_links and task_conversation_ignored. A unique partial index permits one primary link per owner. Feature schemaVersion is independent of the shared control version; future versions and incompatible journal mode refuse writes.

## 3. Contracts

### Metadata and ownership

ExternalConversation uses a real source/sessionId, display title/titleSource, canonical cwd, updatedAt in Unix milliseconds, actual capability and optional destinationLabel. Source identifiers are codex, claude-code and zcode. Title text is never association identity or a command argument.

Main owns source directories (CODEX_HOME, CLAUDE_CONFIG_DIR, standard ZCode metadata root), native protocol checks and launch construction. Reads are bounded and read-only; independent source failures remain visible. Metadata availability is distinct from launch capability and from an empty current-project result.

Main requires the current main window/main frame, expected root and captured project generation. Stale responses never replace the new project; stale native opens do not dispatch. Renderer requests additionally retain their root/request ownership, including A→B→A and inactive retained pages.

### Native paths and roles

Normalize Windows extended drive paths such as `\\\\?\\D:\\repo` before equality/containment checks and SQL project filtering. SQL values are bound; adapter-selected identifiers are allowlisted.

Codex role is derived from native thread_source and structured source.subagent.thread_spawn.parent_thread_id. Explicit subagents are excluded from default discovery and automatic runtime import. Unknown/older role metadata remains unknown; neither titles nor has_user_event establish role. Requested-ID reads preserve an existing explicit child association instead of redirecting it to a parent.

### Durable task relationships

Reuse taskRefFor/readTrellisTaskId and unique task-alias semantics. One surviving same-ID archive target can continue a binding; duplicate/copy ambiguity must not merge. Runtime session files are validated candidates, not durable storage or online heartbeat.

Automatic association is the default experience, not a required manual setup step. Import surviving runtime pointers and recover exact task/session pairs from validated native task-command receipts. A title match, a task path mentioned in ordinary conversation or a read-file/search result, and a command's `--parent` argument do not prove task ownership. Match actual tool calls to successful results and verify native session identity and project cwd. Automatic indexing retains accepted relationships only; it never persists or exposes transcript bodies. Explicit repair preview is a separate, bounded read-only request. Historical recovery must preserve task identity fences and must not turn ambiguous archive paths or reused directories into guessed owners.

Native histories can be hundreds of MiB. Use bounded incremental reads and cache progress instead of rescanning whole transcripts on every list or using head/tail slices as complete history. The optional snapshot `indexing` flag means additional historical work remains; the active, visible homepage automatically continues batches and shows a searching state for unbound tasks. Stop continuation on completion, read failure, page suspension or project change. Existing bound entries remain usable during recovery. Missing reliable evidence offers selected-task continuation instructions; manual selection is restricted to the explicit repair flow.

History descriptors and `evidence/runtimeAliases/historyProgress` are main-only. Construct discovery responses explicitly rather than spreading NativeReadResult, since these internal fields must never reach renderer IPC. Codex uses the actual indexed rollout path plus session metadata; Claude correlates native Bash tool-use/result IDs; ZCode validates row and snapshot task/workspace/provider metadata. Provider IDs are verified aliases for finding ZCode history, never the desktop destination ID. Requested legacy IDs may be queried beyond the default discovery page, with the same project checks.

Only literal task commands qualify. Dynamic JavaScript argument expressions do not become literals by truncating them. For `functions.exec`, support only static straight-line forms where an actual native call result supplies the printed output; a call token inside a conditional, helper definition or deferred callback is not proof of execution. Independently printed receipts cannot borrow another call's identity. Apply the same conservatism to shell conditions/short-circuiting: skip unsupported scripts rather than scanning arbitrary statements for task.py tokens. Codex `text(r.output)` receipts may lack an exit-code envelope; require the executed task command's exact activation/current receipt and exact native source key rather than assuming any plain output is successful. Known failed envelopes are rejected. A raw path without stable identity cannot introduce an archive association; current paths also require creation-time and stored-owner checks. Structured `current --json` evidence can follow one unique same-ID archive target.

Incremental JSONL scanning retains only bounded incomplete records and pending task-command facts. ZCode is a whole JSON snapshot: restart parsing when it changes, including growth. Bound top-level JSON keys as well as individual metadata/message values, preserve quote/escape tracking while skipping oversized data, and verify later normal records remain readable. Scan caches are memory-only and may restart with the app; accepted relationships remain in the durable control store.

A manual primary survives automatic imports. Explicit unlink creates durable suppression so the same runtime record cannot immediately recreate the relationship. Explicit rebind can remove that suppression. Missing native history preserves the cached relation/title with an unavailable capability.

An existing, enabled and supported observation archive may supply additional read-only evidence through `lib/retained-receipts.ts`. This optional reader never creates, enables, migrates or repairs observations. Validate the fixed local installation identity, exact root/repository/workspace binding, database/protocol metadata, payload digest/envelope, emitted/resolved scope and explicit Codex parent ID. Limit reads to 512 recent rows / 2 MiB decoded payload with a short lock timeout. Missing/disabled/cleared/incompatible/corrupt/locked archives skip only this feed. Request those native IDs before discovery pagination, then import through the same native project/role and task identity/primary/unlink fences. Persist accepted links only in control.sqlite; clearing observations does not remove them. Source evidence and payloads remain main-only.

Every projected binding includes main-authoritative `currentTaskRef`: the stored taskRef when its current task still matches, otherwise null. The renderer must require `currentTaskRef === taskRef` as well as the exact directory. It must not rederive eligibility from scanner `record.id`: the main identity reader intentionally has a 256 KiB budget, while the scanner may expose an ID from a larger record. This preserves valid directory-only identities and prevents an orphan from masking a replacement task at the same path. This field is computed after fresh task identity reads, not persisted in link rows.

### Actual native destinations

ZCode desktop metadata discovery resolves its effective v2 directory on every refresh: deliberate nativeRoots.zcode, ZCODE_DATA_BASE_DIR, validated ZCODE_HOME, bootstrap setting.json.dataBaseDir, then home. Reject malformed or unavailable configured sources without falling back to an old home tasks index. This resolution reads bounded bootstrap metadata, not provider credentials. Failures stay isolated to the ZCode source.

The relocated desktop task index and the CLI session database are independent locations. A CLI-persisted record does not prove desktop indexing. Modern GLM desktop task_id can equal its CLI session ID after the desktop's own sessions-index ingestion; provider aliases and other task kinds may differ. Verify native rows/project/type rather than classifying identity by prefixes. Never manufacture a task row/snapshot to imply existing native history or bypass the desktop host's ownership.

Installed 3.16.3 static evidence establishes only workspace/open path navigation externally. Appending taskId/sessionId is not an exact-session route; --surface desktop controls runtime presentation and --resume is CLI/TUI continuation. The internal shared-store sessions-index bridge is not a verified external register/focus API, and an existing publisher need not reload external DB additions on normal resubscription. Keep dispatch, indexing and visible native focus as distinct acceptance levels.

Codex constructs only the documented technical-thread URI. A valid protocol route is preferred. On Windows, stale registration can fall back to a verified fixed Codex package through LauncherOptions.TargetApplicationPackageFamilyName. The package probe verifies identity, manifest protocol and signature. Positive/negative cache TTLs are 60s/10s with one in-flight probe; activation failure invalidates the cache. Fixed package family and strict UUID URI are checked again at dispatch. No registry repair is performed.

Claude Code restores the existing native ID with `--resume` in the verified cwd through a hidden PowerShell helper that starts an interactive CLI. The UI must say terminal continuation; this is not verified focus of an existing VS Code tab. Quote/encode helper arguments and never run a renderer-supplied shell fragment.

ZCode reads native desktop metadata independently of ACP. The installed workspace route is verified against the actual app archive using Electron original-fs; this is only workspace navigation until a precise session route is independently established. Keep the workspace label visible.

A successful OS dispatch or broker acceptance is not proof of client focus or rendered history. Report those acceptance levels separately.

### UI geometry

Task and conversation/favorite actions are siblings. Task inspection retains its prior action. The middle entry is fixed at 220px with fixed source/text/action slots; long text is ellipsized inside it. Workspace/terminal hints must not enlarge it. An unbound normal entry opens task instructions rather than association management; bound destinations use an outgoing arrow.

Hover/focus preview uses a portal in the owning theme root and interaction scope. It must not expand the row, steal focus or survive scope suspension. Escape and reduced motion work; viewport clamping is required. Use the global control radius for entry, preview and matching homepage controls. Modal panels inherit the shared Modal radius without feature-specific overrides; inner cards use the global container role. Keep priority/state glyphs, textual status, time and favorite.

Product identity uses the shared [ToolBrandIcon contract](../frontend/tool-brand-icons.md). Preserve original colored assets, use theme-aware monochrome marks where selected, and keep unbound/unknown entries neutral. A larger brand catalog does not add native source adapters or navigation capabilities. Avoid repeated metadata such as `Codex · Codex`; retain distinct terminal/workspace destination information.

Candidate selection shows real source, actual destination and native updated time. Same-source duplicate titles include a short native ID, with complete ID accessible in the description; default rows do not expose filesystem paths. Refresh timestamps describe successful reads, never task acceptance/completion.

## 4. Validation / error matrix

| Condition | Result |
| --- | --- |
| Unknown fields, empty/bad root or target | E_INVALID_ARG, no native action |
| No project | E_NO_PROJECT |
| Foreign main window/frame | E_DENIED |
| Root/generation/frame changes | E_CONFLICT; no stale launch |
| Removed task/candidate/binding | E_NOT_FOUND or unavailable relation |
| Duplicate task ID / ambiguous alias | E_CONFLICT; no merge |
| Unsupported/locked/missing native source | Source diagnostic; other sources remain usable |
| Missing protocol/package/CLI or failed dispatch | Visible unavailable/error; no new conversation fallback |
| Future control version / incompatible journal mode | Refuse writes |
| Native title changes | Refresh display by the same source/session identity |
| Explicit unlink while runtime file persists | Suppression prevents automatic reimport |
| Explicit subagent discovery | Hidden by default; retained explicit relationships stay intact |
| Old task directory reused by a different task | Old link retains history with null currentTaskRef; only the new owner can appear in the row |
| Scanner ID exposed from a task file beyond identity-reader budget | Honor main currentTaskRef; do not hide a valid directory identity |
| Clipboard write fails | `E_UNAVAILABLE`; do not request a native launch |
| Clipboard copied, then native dispatch fails | Success packet with `copied: true` and `openError`; never claim the conversation opened |
| Selected task changes during packet/native lookup | `E_CONFLICT`; do not copy or dispatch after the final failed identity check |
| Candidate preview lacks identity proof or exceeds supported source budget | Empty messages and an explicit `unavailableReason` |
| Preview file is rewritten in place or atomically replaced during reads | Empty messages and an explicit changed/unavailable result; never combine verified head and foreign tail |

## 5. Good / base / bad cases

Good: a task shows the actual native title and opens that exact stored ID with the currently verified destination.

Base: no trustworthy project conversation exists, so the normal entry offers selected-task instructions; an unbound task stays unbound. An explicit repair request may inspect verified candidates.

Bad: matching titles to infer a relationship, treating an ACP ID as a ZCode desktop ID, silently creating a replacement VS Code conversation, importing internal workers as original user sessions, or declaring an AI turn to be a completed task.

## 6. Tests required

- scripts/smoke/task-conversations.mjs: actual temporary source formats, cwd fences/Windows namespace, user/worker/unknown roles, requested old child, title refresh, runtime validation, durable primary/unlink suppression, archive/copy identity, future/corrupt/locked stores and exact injected launch arguments.
- scripts/smoke/task-conversations-history.mjs: successful Codex/Claude/ZCode task receipts and negative prose/read/error/dynamic-call cases; runtime deletion and overwritten history; identity/creation-time/archive/copy fences; persistence and manual overrides; old requested provider aliases; incremental limits, partial/oversized records, bounded keys and rewritten ZCode snapshots. No native client activation.
- scripts/smoke/task-conversations-retained-receipts.mjs: existing receipt/binding/native formats, optional-source authority and failure isolation, no observation creation/enabling, old native IDs, stable archives, manual-primary/unlink persistence and receipt deletion. `--local` is read-only and uses in-memory persistence for real-source acceptance, not client activation.
- --local / --cache-probe are explicit read-only local capability probes. No real client activation or prompt is performed.
- scripts/smoke/task-conversations-ipc.mjs: real registry/handler/preload, strict payloads, sender/frame/root/generation fences, pending-launch cancellation, lazy creation, cleanup and all registered routes including continuation and repair.
- scripts/smoke/task-conversations-ui.mjs: real production homepage/hook/modal in isolated Electron, equal geometry, global radii, sibling actions, title preview/focus/Escape, picker timestamps/duplicate titles, scope races, error/retry, refresh, reduced motion and cleanup.
- Full typecheck, check:ui, ipc-registry and build. Native UI focus requires separate evidence; mocked ports and a read-only capability probe do not establish it.
- scripts/smoke/task-conversations-continuation.mjs: selected-task packets for a shared parent, phase/history intent, safe binding language, task identity changes, material budgets, clipboard/dispatch partial outcomes, visible source previews and independent inspection.
- scripts/smoke/task-conversations-preview-boundaries.mjs: unknown-role ordinary positive control, explicit native child roles, foreign replacement, in-place mutation between head/tail reads and atomic path replacement.

## 7. Wrong vs correct

### Selected-task continuation and repair

Opening a conversation does not select a task: several task IDs can share one native parent. Active-task entries disclose that they copy selected-task instructions and request opening the existing destination. The user pastes and sends those instructions. Preparing or copying does not prove delivery, execution, approval or completion, and must not force a native session pointer to another task.

The main process resolves the current task identity, builds a bounded deterministic handoff package and owns clipboard writes. Reuse the handoff builder with an explicit intent that respects the current Trellis phase and approval boundaries. Task JSON has a 256 KiB read budget; optional PRD question extraction has 64 KiB, and output is limited to 32768 characters. Do not carry full PRDs by default. This fast packet explicitly omits repository Git scanning. Recheck sender/frame/root/generation and selected task identity immediately before each clipboard or launch effect. Copy failure prevents launch; a launch failure after copying returns a truthful partial result. An absent binding copies only. Completed/archived entries default to history viewing.

Normal entry activation never asks the user to guess a conversation from project titles. Missing, ambiguous and unavailable destinations offer a compact task instruction view. Keep manual repair in task details under More → Repair execution entry; do not expose universal right-click or Shift+F10 association management on normal entries. Saving a repair does not itself execute work.

Repair preview accepts an opaque candidate ID and selected task, never a filesystem path. Main derives a verified native history descriptor and reads bounded snippets: at most twelve visible user/assistant messages and 4096 characters per message. JSONL identity proof uses at most 128 KiB of head and snippets use at most 512 KiB of tail; ZCode snapshots have a 2 MiB whole-file limit. Exclude analysis/reasoning/thinking, system/developer instructions and tool calls/results. Reject explicit native child-role evidence even if older index metadata was unknown. Verify the open file and current path retain initial device/inode, size and nanosecond modification/change timestamps before returning text; in-place changes or atomic replacement invalidate the whole preview. Display plain text without executing markup or fetching media. Tail snippets must be labelled partial; unavailable or unsupported sources must state the limitation. Native inspection can open a verified candidate without saving a relationship. Root, selection and interaction ownership also fence renderer preview responses.

Required regressions include two tasks sharing one native parent, exact selected-task text despite a different surviving pointer, phase/archived intent, bounded reads, role exclusion, foreign native identity/cwd, stale project/window, copy failures, copy-success/launch-failure, ordinary-entry versus repair routing and retained equal geometry.

Wrong: grow each conversation control to fit its title, then launch a URL copied from renderer metadata and assume its success completes the task.

Correct: fixed entry geometry; main resolves a durable task/native identity, revalidates source cwd/capability and owner immediately before dispatch, preserves original history, and leaves task lifecycle authority unchanged.
