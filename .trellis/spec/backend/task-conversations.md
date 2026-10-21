# Task conversation continuation

## 1. Scope / trigger

Read when changing homepage native conversation entries, external session discovery, task/session persistence, editor navigation or their IPC. Code lives in shared/task-conversations.ts, main/services/task-conversations/, main/ipc/task-conversations.ts and my/use-task-conversations.ts.

This feature locates existing history. It does not send prompts, create replacement conversations, rename native titles or infer task completion.

## 2. Signatures

Shared Zod schemas define TaskConversationsApi. All six flat preload methods return Promise<{ok:true;value:T}|IpcFail>:

- taskConversationsList({expectedRoot}) → TaskConversationsSnapshot
- taskConversationsDiscover({expectedRoot}) → TaskConversationCandidates
- taskConversationsBind({expectedRoot,taskDir,conversationId}) → snapshot
- taskConversationsSetPrimary({expectedRoot,taskDir,bindingId}) → snapshot
- taskConversationsUnbind({expectedRoot,taskDir,bindingId}) → snapshot
- taskConversationsOpen({expectedRoot,taskDir,bindingId}) → TaskConversationOpenResult

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

A manual primary survives automatic imports. Explicit unlink creates durable suppression so the same runtime record cannot immediately recreate the relationship. Explicit rebind can remove that suppression. Missing native history preserves the cached relation/title with an unavailable capability.

Every projected binding includes main-authoritative `currentTaskRef`: the stored taskRef when its current task still matches, otherwise null. The renderer must require `currentTaskRef === taskRef` as well as the exact directory. It must not rederive eligibility from scanner `record.id`: the main identity reader intentionally has a 256 KiB budget, while the scanner may expose an ID from a larger record. This preserves valid directory-only identities and prevents an orphan from masking a replacement task at the same path. This field is computed after fresh task identity reads, not persisted in link rows.

### Actual native destinations

Codex constructs only the documented technical-thread URI. A valid protocol route is preferred. On Windows, stale registration can fall back to a verified fixed Codex package through LauncherOptions.TargetApplicationPackageFamilyName. The package probe verifies identity, manifest protocol and signature. Positive/negative cache TTLs are 60s/10s with one in-flight probe; activation failure invalidates the cache. Fixed package family and strict UUID URI are checked again at dispatch. No registry repair is performed.

Claude Code restores the existing native ID with `--resume` in the verified cwd through a hidden PowerShell helper that starts an interactive CLI. The UI must say terminal continuation; this is not verified focus of an existing VS Code tab. Quote/encode helper arguments and never run a renderer-supplied shell fragment.

ZCode reads native desktop metadata independently of ACP. The installed workspace route is verified against the actual app archive using Electron original-fs; this is only workspace navigation until a precise session route is independently established. Keep the workspace label visible.

A successful OS dispatch or broker acceptance is not proof of client focus or rendered history. Report those acceptance levels separately.

### UI geometry

Task and conversation/favorite actions are siblings. Task inspection retains its prior action. The middle entry is fixed at 220px with fixed source/text/action slots; long text is ellipsized inside it. Workspace/terminal hints must not enlarge it. Association uses plus; bound destinations use an outgoing arrow.

Hover/focus preview uses a portal in the owning theme root and interaction scope. It must not expand the row, steal focus or survive scope suspension. Escape and reduced motion work; viewport clamping is required. Use the global control radius for entry, preview and matching homepage controls. Keep priority/state glyphs, textual status, time and favorite.

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

## 5. Good / base / bad cases

Good: a task shows the actual native title and opens that exact stored ID with the currently verified destination.

Base: no project conversation exists, so the picker shows an honest empty source result; an unbound task stays unbound.

Bad: matching titles to infer a relationship, treating an ACP ID as a ZCode desktop ID, silently creating a replacement VS Code conversation, importing internal workers as original user sessions, or declaring an AI turn to be a completed task.

## 6. Tests required

- scripts/smoke/task-conversations.mjs: actual temporary source formats, cwd fences/Windows namespace, user/worker/unknown roles, requested old child, title refresh, runtime validation, durable primary/unlink suppression, archive/copy identity, future/corrupt/locked stores and exact injected launch arguments.
- --local / --cache-probe are explicit read-only local capability probes. No real client activation or prompt is performed.
- scripts/smoke/task-conversations-ipc.mjs: real registry/handler/preload, strict payloads, sender/frame/root/generation fences, pending-launch cancellation, lazy creation, cleanup and six routes.
- scripts/smoke/task-conversations-ui.mjs: real production homepage/hook/modal in isolated Electron, equal geometry, global radii, sibling actions, title preview/focus/Escape, picker timestamps/duplicate titles, scope races, error/retry, refresh, reduced motion and cleanup.
- Full typecheck, check:ui, ipc-registry and build. Native UI focus requires separate evidence; mocked ports and a read-only capability probe do not establish it.

## 7. Wrong vs correct

Wrong: grow each conversation control to fit its title, then launch a URL copied from renderer metadata and assume its success completes the task.

Correct: fixed entry geometry; main resolves a durable task/native identity, revalidates source cwd/capability and owner immediately before dispatch, preserves original history, and leaves task lifecycle authority unchanged.
