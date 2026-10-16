# ACP runtime foundation — proposed technical design

Independent research prose and architecture notes; no source extraction from reference products. The user explicitly approved a locally authored, narrowly scoped compatibility patch to the MIT acpx dependency after validation. Preserve upstream notices, exact version and patch provenance; this approval does not authorize wholesale copying of other reference applications.

Status: implementation approved and task activated on 2026-10-16. Required real vendors: Codex and Claude Code.

Selection resolved by user after executed validation: **exact acpx 0.19.5 with minimum maintained compatibility fixes**. Keep Node/Electron and the existing task authority; no independent service is selected. The updated summary and package/source boundary were reviewed; the user subsequently authorized starting implementation.

## 1. Ownership and architecture

Use the published `acpx/runtime` and `acpx/agent-registry` APIs, with a version-pinned compatibility patch. The library retains protocol transport, native session/turn management, cancellation, persistence primitives, configuration controls and owned-process cleanup. Trellis supplies profile/task/material association, project-action authorization, UI approval mediation, setup policy, directory occupancy and truthful presentation. Keep `services/acp.ts` as the existing facade rather than adding another independent session/process engine.

Executed evidence: 12 selected native Windows lifecycle cases pass; strict fixtures demonstrate multi-turn/Unicode/tool/config/permission/cancel/restore capabilities. Stock initialize version/ID checks, foreign inbound updates and duplicate-kind exact option selection fail. Real Codex completes three turns including a sample read. Claude setting inheritance restores coherent conversation, but sample-file evidence remains failed. These outcomes are not interchangeable; retain every failed fixture as a required regression.

Direct runtime import was exercised through CommonJS on system Node 24.12 and Electron 44.4.3's Node 24.21 in headless mode. This supports embedding in the existing CJS main process; it does not replace packaged GUI acceptance. Pi/AionUi/OpenHands/Paseo comparisons remain selection evidence. Do not adopt OpenClaw Gateway, a new coding loop, or an independent Paseo daemon.

Sections 2–9 express observable integration contracts. Satisfy them by delegating proven library behavior, not reimplementing it. Any residual upstream expansion beyond the three approved boundary areas is documented before enlarging the maintained patch.

Data path:

`Agent profile + task/material snapshot -> Trellis facade -> patched acpx/runtime -> official ACP SDK -> maintained adapter -> vendor Runtime`

`ACP notifications/requests -> session/turn reducer -> scoped persisted events + IPC -> conversation renderer`

`Trellis first-party watcher/bridge/Jira events -> task/project association -> separately identified timeline events`

Extract bounded helpers under `services/acp/` only for residual application responsibility: discovery/setup, profile/history metadata, runtime API mapping and UI event projection. Do not recreate SDK framing, a competing connection pool or process killer. Main IPC remains a thin wrapper using the central registry and typed error envelopes. The ordinary Chat/API conversation stack is unchanged.

## 1.1. Compatibility patch and dependency preparation

Pin `acpx` 0.19.5 and record its original package/tag identity. Use a deterministic checked-in dependency patch (standard patch-package tooling is the default) with exact-version/application checks; no live monkey patch or imports of hashed private modules from product code. Keep required preparation available in supported clean install/build workflows, including production dependency preparation, and fail clearly when scripts were skipped or a version/patch mismatch exists. Preserve MIT notices. Do not silently apply an old patch to another release.

The approved patch is bounded to:

1. **Handshake/readiness:** reject malformed or unsupported initialize before session/new; reject a missing/empty remote session ID before returning a usable session; preserve error and cleanup behavior.
2. **Inbound ownership:** validate raw notification/request session identity before reduction. Buffer only bounded legitimate pre-response/replay updates against the pending new/load target; drain only after authoritative identity is established, and discard/quarantine foreign traffic. Cover new, load/replay, cancellation and generation changes rather than adding an unconditional comparison that drops valid initialization traffic.
3. **Exact permission choice:** add a documented compatible decision shape carrying the selected original optionId, validate it against supplied options and retain existing kind/cancel behavior. Trellis validates invalid/stale GUI responses before resolving a pending callback; the library fails closed for invalid direct callback results. Cancel/timeout/disconnect settle once.

Capture patch revision and package version in diagnostics. Stock regression evidence remains immutable; patched versions must pass the same behavioral cases plus new replay/invalid-choice tests. Larger downstream forks, new features and upstream publication are outside this approval.

## 1.2. Existing Claude configuration and unresolved tool evidence

acpx intentionally excludes user-level Claude settings by default. For this local integration, explicitly enable inherited user/project/local settings according to the recorded run configuration; the tested host flag is `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1`. Establish this host-wide policy before constructing runtimes rather than toggling process.env around concurrent sessions. Do not mistake child-only environment overlays for this host setting. Preserve existing native configuration and do not copy its secret values into profile records.

The current configured Claude route passes chat but not the sample-file criterion. Product implementation must diagnose actual tool catalog/request/result delivery and repeat file/tool/approval evidence; neither a generic SDK completion nor a model's claimed inability/success closes that gate. No provider, model, credentials or global tool policy is silently changed to make the test pass.

## 2. Identity and scope contracts

Retain separate identities:

- `profileId`: reusable local/project Agent role.
- `runtimeId` plus a launch/configuration snapshot: selected executable/adapter.
- `panelSessionId`: stable local UI/persistence identifier.
- `backendSessionId` / app `acpSessionId`: opaque ACP identity returned by `session/new` or an accepted load/resume; this is the wire ID.
- `agentSessionId`: optional native vendor/thread identity when the adapter reports one; its absence is not evidence that the ACP wire ID is missing.
- `connectionGeneration`: one process/connection ownership lifetime.
- `turnId/runId`: one accepted prompt and its completion.
- `permissionRequestId`: unique local ID mapped to connection, remote request and active turn.

All ACP session calls use the remote `backendSessionId` through the runtime handle. All UI actions use local IDs resolved in the service after project ownership validation. A connection callback carries its generation and cannot mutate a replaced session. Validate inbound `params.sessionId`; preserve unknown/unrelated traffic in connection diagnostics rather than assigning it to the currently visible task. Experimental child sessions are not advertised until supported.

Use canonical root/directory identity compatible with existing `sameRoot` behavior; retain original display paths. Validate taskDir with the existing task-identity contract. Profile selection never changes project root silently. Working directory defaults to the open project; any explicitly chosen different worktree/directory remains visible in the run summary and is not inferred from agent output.

## 3. Runtime registry, profiles and launch

Separate Runtime definitions (adapter executable, arguments, version/install/health metadata) from Agent profiles (name, description, instructions, default Runtime and directory). Runtime definitions are local machine configuration; project profiles/history are keyed by root. One Runtime can back several profiles.

Use structured executable + argument arrays for new configurations. Preserve existing command strings as explicit legacy records; do not silently rewrite user commands, execute discovery through an arbitrary shell expression, or split quoted paths by whitespace. Windows launch must handle npm shims with tested resolver/wrapper behavior and preserve argument boundaries.

Built-in adapters are installed by a separate visible Setup action into `userData/acp/runtimes/<runtimeId>/<version>/`, with an exact package/version, resolved entrypoint and recorded manifest. Use an explicit external Node >=22.13.0 path, discovered asynchronously and then validated; an explicit saved path takes precedence. Resolve the compatible package-manager launcher without assuming the GUI inherited the development-shell PATH. Missing Node/npm provides a path picker and setup guidance; no runtime is silently bundled or downloaded. Start refuses an absent installation with the Setup action and never installs it. List/discovery never invokes `npx -y`, installs packages or performs model requests. Existing custom commands remain user-managed.

The production gate launches the packaged application from the Windows GUI with a restricted PATH and verifies package/cache resolution, external Node selection and actual child cleanup. The diagnostic mock remains development-only unless deliberately packaged as a separately tested diagnostic artifact; it cannot be unconditionally listed as a usable production Agent.

Refresh bypasses/invalidate cached health. Discovery is asynchronous and reports its measured scope. Health separates:

`not_checked / executable_missing / adapter_missing / launch_error / incompatible / auth_required / directory_unavailable / ready`

An installed CLI is evidence for setup, not evidence of a working adapter. A successful executable probe is not authentication success. Diagnostics include sanitized stage/version/path facts; inherited tokens and full sensitive environment values are excluded.

Read inherited vendor configuration/authentication by letting the maintained adapter/Runtime own it. On advertised auth-required behavior, expose appropriate external/native auth guidance or the supported ACP authenticate operation. No copying this assistant's own credentials into the app, no token harvesting and no secret values in profile instructions/history.

## 4. State projection and delegated cleanup

Connection/session lifecycle:

`configured -> checking -> launching -> initializing -> [authentication_required -> authenticating] -> opening/loading -> ready -> running -> [awaiting_permission] -> ready`

Cancellation adds `cancelling`, followed by an acknowledged cancelled turn or an explicit forced-stop/failed outcome. Terminal connection outcomes are `closed`, `failed` or `disconnected`. Read-only legacy history has no live connection state.

Keep structured available startup observations with start/end time, status and sanitized error. The internal lifecycle above is a conceptual contract, not proof that the public runtime exposes every substep. Render only observed launch/process/session/first-response milestones; never infer a separate handshake/auth duration from ensure completion or wall-clock file timestamps. Repeated auth/retry/resume attempts retain distinct attempt IDs.

One prompt per session is accepted synchronously before awaiting transport. A second send returns a typed busy result and leaves its draft intact. Do not auto-retry an uncertain prompt. Resolve pending permission decisions with cancellation when the owning turn is cancelled. A cancelled/closed generation cannot return to ready after a late initialize/prompt response.

Delegate owned-client/process shutdown to acpx and await its canonical cleanup/turn result. Trellis coordinates its approval promises, directory leases, status projection and one terminal event around those results. Cover spawn error, initialize/new-session failure, stream close, protocol failure, prompt failure, timeout, explicit stop and app quit. Record ownership until exit/cleanup is accounted for; do not replace the library with another competing process killer or equate deleting a map entry with cleanup.

Prevent multiple managed writers on the same effective directory. Idle ready conversations can coexist. Acquire the lease atomically before accepting a mutable turn, a mutating restore or a mutating client callback; retain it through running, pending approvals, cancelling and known background terminal/tool work. Release only after the owning work has actually settled. If an adapter cannot prove background completion, retain the lease until its process ends and show that reason. A conflicting action returns a specific directory-in-use result with its owning session and a stop/retry path. Canonicalization tests include case variants, aliases and junctions. This lease covers Trellis-managed sessions; it does not claim to lock unrelated terminals/editors. Keep the current managed concurrency cap unless a separate reviewed setting changes it.

## 5. Protocol, capabilities and permissions

Product code uses acpx's supported root/subpath exports. The compatibility patch works with the dependency's SDK/types; declare a direct SDK dependency only if application code actually imports its public types. Do not import hashed private modules. Inspect exact published artifacts, because source main contains newer/draft extensions. Negotiate ACP v1 with tested capabilities and preserve agentInfo, protocolVersion, authentication methods and session capabilities.

Map text/message IDs, thought summaries actually supplied by the Runtime, tool creation + partial `tool_call_update`, content/diff/locations, plan updates, advertised commands and effective model/mode/config updates into a typed event reducer. Preserve absence versus explicit null in patches. Keep unknown strings/metadata inspectable without inferring completion. Decode UTF-8 and newline framing through the SDK stream primitives rather than independent per-buffer string conversion.

Permissions retain upstream option IDs/labels and all allow/reject kinds. Kinds are presentation hints, not replacements for the selected option. Do not implement session-global blanket authorization from a single remembered choice. Validate before removing a pending request. Resolve invalid choices as errors while keeping the legitimate pending decision. A user denial returns `selected` with the original reject `optionId`. Turn cancellation and locally expired approval return `{outcome:{outcome:'cancelled'}}` while the stream is writable. If the stream is already gone, clear local ownership exactly once and record that no response was deliverable. No generic transport error is substituted for a denial and no historical record recreates a live resolver.

Defaults: launch/initialize/session setup each have a 30-second deadline, excluding explicit user authentication waits; approval waits expire after 120 seconds and cancel the owning turn. Cancellation waits up to 10 seconds before a clearly reported owned-process stop/escalation. The existing prompt deadline is 30 minutes (`acp.ts` uses `30 * 60_000`), distinct from permission waiting. Retain that documented default maximum turn duration with an explicit profile override and show the effective limit in the run summary; never confuse it with approval or startup deadlines.

Client filesystem/terminal/input services are capability-driven and use acpx's working services. Establish the exact callback profile required by each selected adapter, verify scope/output/cleanup behavior, and add only necessary application policy integration. Optional unsupported callbacks remain unadvertised and produce explicit diagnostics if requested. Do not duplicate delegated handlers or fabricate success. Preserve vendor-native tool execution when the adapter owns it.

Model/mode controls populate from real session configuration/capabilities. Fixed startup arguments can make a control read-only; unavailable capability removes or disables it with a reason. A local preference is distinct from an acknowledged effective value.

## 6. Persistence, compatibility and resume

Use versioned local record/profile files with bounded serialized events and atomic writes, retaining old unknown fields where compatible. Stable session metadata includes panel/remote IDs, root/cwd, profile/runtime snapshot, capabilities needed to explain history, turn outcomes and startup diagnostics. Do not persist credentials or whole environment snapshots.

Read old records without destructive migration. Missing remote ACP identity (`backendSessionId`/app `acpSessionId`) means legacy transcript-only; absence of an optional native `agentSessionId` does not. Stale starting/running/waiting records after app restart become disconnected/interrupted; pending permissions become historical. If stored identity and capability permit native load/resume, use the runtime's same-session operation explicitly and deduplicate replay boundaries. A failed load retains history and offers a separately identified new conversation. Never replay user prompts as a substitute for restore.

Persist bounded event batches during a turn, on meaningful state transitions and at terminal cleanup. Surface persistence failures while retaining live results where possible. History display and live-session control are separate API paths.

## 7. IPC and event design

Retain compatibility wrappers for existing ACP APIs while introducing reviewed registry entries for profile CRUD, runtime health/diagnostics, explicit authentication, capabilities/configuration and native resume as needed. New names live only in `shared/ipc-channels.ts`; preload and handlers consume constants. Validate structured inputs at the main boundary.

Every output/permission/state/terminal payload carries enough project/session/connection/turn identity for deterministic filtering. Align output/done pairing with TPD-003; do not continue using a terminal channel for every nonterminal status transition. The service validates root ownership for prompt/cancel/kill/config/resume/permission operations, even if the renderer already filters them. Failure envelopes use `ipcFail(code, error, extra)`.

Keep task- and project-wide first-party event scopes distinct. A task-specific Trellis event is delivered to matching task-bound sessions, not every conversation of the project. Unbound events remain a visible project/diagnostic scope, not proof that a particular task progressed.

## 8. Frontend interaction

Use the existing conversation module and project context. Offer an Agent profile view and recent conversations without adding another global navigation hierarchy. The profile detail panel contains working identity/instruction, Runtime, directory and supported configuration controls; inherited tools/configuration are labeled with their source. Deferred IM/squads/remote-machine sections are not active placeholder buttons.

A run opens with a collapsible measured startup group and a visible actual Runtime/directory. The conversation reuses Markdown and shared follow-scroll behavior; tool and thought groups expand on demand. Drafts, scroll/follow state and selected history are per project/session. Drafting while running is allowed; sending waits for ready unless a separately supported action is explicitly chosen. Preserve draft text on rejection, guard IME composition and lock concurrent submit handlers.

Stop/retry/config/approval controls reflect pending and acknowledged outcomes. Display unknown, waiting and failed states distinctly. The detail pane yields before the main transcript becomes unreadable; verify actual native width/theme/focus behavior. Keep existing project-generation, early-event and live-permission safeguards from the entry baseline.

## 9. Rollout and rollback

Implement in bounded stages behind the existing ACP route. Preserve old configuration/history backups until migration and real validation pass. Stage isolated smoke fixtures so failures never require replaying a prompt in the user's working repository. No automatic Jira transition, task lifecycle change, commit, push or publication is part of rollout.

SDK integration can be reverted as a code/dependency unit; new-format records remain versioned and readable or reported as newer-format, never silently overwritten by old writers. Roll back a failed vendor session to a known terminal/disconnected state, not an automatic duplicate request.

## Implementation review clarification (2026-10-16)

The first integrated review found that stock public acpx records discard negotiated mode lists, agentInfo and authMethods. Exposing controls without these values leaves required mode selection and authentication diagnostics unusable. The readiness/session metadata correction therefore also retains optional, typed, non-secret initialize metadata and `acpx.available_modes` through the public record/store, including load/restart. This is bounded data retention within the existing handshake/session patch, not a new runtime supervisor, private-module import or authentication implementation. Regression tests must verify both persistence and absence when the peer omits these values.

Runtime snapshots must preserve whether a launch definition was managed or explicitly custom; changing a preset override later cannot reinterpret a saved session's command. Compatible unknown profile fields are retained on read/save. Concurrent and disconnected-session resume admission must obey the same cap, root, generation and canonical cleanup rules as new sessions.

The production build must externalize `acpx` and its public subpaths. Bundling its ESM runtime into the app's CommonJS main rewrites `import.meta.resolve`, invalidating package-relative owner paths. Native and packaged validation loads the public ESM export through CommonJS `require(ESM)` on the supported Node/Electron version, with the dependency present in the application package; there is no separate published CJS runtime build.

The final review found that acpx's optional filesystem/terminal callback policy does not use the per-turn host permission mediator and rejects work under the selected deny-all default. Current profiles therefore unadvertise these optional callbacks and use the adapters' native tools with exact host-mediated tool permissions. This avoids a misleading capability advertisement and blanket approval. Real vendor tool acceptance is rerun on this native-tools profile; delegated callbacks remain a separately testable future addition, not a claimed feature.

R3 also requires passive diagnostic visibility for updates unknown to acpx. The inbound-ownership correction permits bounded, redacted `rawUpdate` data for SDK-delivered updates that the runtime otherwise discards. A tag rejected by SDK validation may produce only an owned-session, tag-only diagnostic with unavailable-payload labeling; it is never treated as a valid tool/state update. Reuse the internal admission tap, add no host observer/private import, and suppress rejected raw-frame logging. Foreign, oversized, replayed and closed-generation traffic remains subject to the same gates. Known text `_meta` allowlisting remains unchanged.

Final native/review follow-ups retain directory occupancy for unresolved reported tool IDs even after a model turn ends; partials without a known terminal tool status cannot prove exit. A unique explicitly categorized model/mode config is authoritative over stale legacy fields, and duplicate generic selectors are hidden. Original long permission labels wrap inside narrow cards without changing their option IDs. These are application projection/ownership corrections, not additional dependency features.
