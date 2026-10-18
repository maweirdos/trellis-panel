# ACP runtime and workspace contract

## 1. Scope / Trigger

Read before changing `services/acp.ts`, `services/acp/`, ACP IPC/preload/types,
the Agent workspace, dependency preparation, or Electron packaging. The supported
pair is Codex adapter 2.2.2 and Claude adapter 0.91.0. Generic custom commands are
retained without claiming the same compatibility evidence.

Use the public `acpx/runtime` and `acpx/agent-registry` exports. acpx owns framing,
processes, native sessions, turns and canonical shutdown. Trellis owns current-root
authorization, Agent profiles, explicit setup, task materials, approval mediation,
directory occupancy and presentation. Do not add another competing transport,
prompt queue, process killer or transcript authority.

## 2. Signatures

The main facade takes the trusted project root as its first argument:

```ts
listAcpSessions(root, limit = 20)
listAcpProfiles(root)
saveAcpProfile(root, input)
deleteAcpProfile(root, profileId)
newAcpSession(root, { agentId, profileId?, taskDir? })
promptAcpSession(root, sessionId, text, options?, isCurrent?)
bindAcpSessionTask(root, sessionId, { taskDir, expectedConnectionGeneration }, isCurrent?)
cancelAcpSession(root, sessionId)
killAcpSession(root, sessionId)
resumeAcpSession(root, sessionId)
configureAcpSession(root, sessionId, { kind: 'model' | 'mode' | 'config', id, value? })
respondAcpPermission(root, requestId, optionId)
shutdownAcp(): Promise<void>
```

`src/main/ipc/acp.ts` supplies `getProjectRoot()`; the renderer never supplies a
trusted root. Public preload methods use the corresponding `acpSession*`,
`acpProfile*` and `acpPermissionRespond` names. `acpAgents`, `acpRuntimeRefresh`,
`acpRuntimeSetup(runtimeId)` and `acpRuntimeNodePick` manage local setup separately.
`api.acpSessions()` currently exposes the service's default history limit.

## 3. Contracts

### Task materials and source-bound prompts



`acpSessionBindTask(sessionId,input)` is explicit and requires an idle ready owned session/current connection generation and an actual active task/path. It changes future material assembly only; prior events/snapshots/native identity are not rewritten. Busy/stale binding rejects with `E_CONFLICT`.

`acpSessionPrompt(sessionId,text,options?)` retains two-argument callers. Options may carry expectedConnectionGeneration and sourceReferences. Each AcpSourceReference captures projectRoot/taskDir/relativePath/displayedRevision/targetSessionId/targetConnectionGeneration and optional sectionAnchor/quote. Main independently validates trusted root/generation/path/session/binding, and compares the modern raw-byte sha256-prefix16 identity against the same read used for assembly before turn publication. Drift/unavailability returns `E_CONFLICT`, reason `SOURCE_CHANGED`, and sources[] expected/actual/available details with no new turn/event/snapshot consumption.

Material snapshots distinguish sourceRevision/includedRevision/sourceBytes/includedChars/truncation/availability; whole-file identity differs from a truncated included-segment digest. Unknown old metadata stays unknown. Material events use `kind='material-change',source='trellis',payload.materialChange` with actual scoped add/change/unlink facts. Rootless old notices are generic attention, not verified artifact input. Project generation gates delayed notices/imports/reads; unlink reaches the modern reader. These facts prove neither Agent authorship/compliance nor approval/phase completion.

### Dependencies and launch

- Pin `acpx=0.19.5`, SDK 1.8.0 scoped through the acpx override, and
  `patch-package=8.0.1`. The installed license remains intact. Check
  `patches/acpx-compat.json` and the public `TRELLIS_ACPX_COMPAT_VERSION` marker.
- `postinstall` runs `scripts/prepare-acpx.mjs`. Standard dev/build/typecheck/dist
  run the guard. `npm ci --legacy-peer-deps` is required by the repository's
  existing Vite 8 / electron-vite 5 peer mismatch; do not change the build stack
  silently. An install with scripts skipped must be explicitly prepared.
- `electron.vite.config.ts` externalizes acpx and its subpaths. Bundling its ESM
  runtime into CommonJS destroys package-relative `import.meta.resolve` paths.
  The published export is ESM; the supported Node/Electron version loads it from
  the CommonJS main using `require(ESM)`. Do not describe it as a separate CJS build.
- Managed Setup installs exact adapters under
  `userData/acp/runtimes/<id>/<version>/`. Discovery and Start never download.
  Managed launch uses an absolute external Node >=22.13 executable and the
  installed adapter's absolute entry, independently of GUI PATH.
- Structured custom `{executable,args}` preserves argument boundaries. A legacy
  complete command keeps explicit platform shell semantics; never split it on
  spaces. `launchKind: 'managed' | 'custom'` freezes snapshot provenance. Later
  Settings overrides cannot reinterpret existing conversations.
- Set host `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1` once before runtime construction.
  Inherit user/project/local vendor settings through the adapter; never harvest
  tokens into instructions, profiles, diagnostics or records. A child-only env
  overlay is insufficient for this host policy.
- Current profiles use adapter-native tools and unadvertised optional client
  filesystem/terminal callbacks. Retain the exact per-turn permission mediator;
  do not switch to blanket `approve-all` to make delegated callbacks work.

### Identity, persistence and admission

- App `sessionId` is the panel identity. acpx `backendSessionId` is the ACP wire
  session ID; optional `agentSessionId` is a different native vendor identity.
  Missing native ID is not missing ACP identity.
- Persist app schema 2 records in `userData/acp-sessions/`; runtime records are
  owned by the public acpx store under `userData/acp/runtime-store/`.
- Profiles use schema 1 envelopes keyed by canonical root hash under
  `userData/acp/profiles/`. Preserve compatible unknown profile/envelope fields;
  reject unsupported versions without rewriting them. IDs are bounded safe
  strings, explicit cwd is absolute, and max turn duration is 1–120 minutes.
- Legacy history has no resumable remote identity. New failed/cancelled startup
  records remain new transcript/error records. Restart normalizes stale active
  state and clears historical pending approvals.
- `resume` locates the same remote identity without prompt replay or replacement.
  Opening a selected resumable conversation requests native load immediately.
  The pinned revision2 `connectSession` reuses acpx's owner/lock/checkpoint and
  same-session-only load without a prompt. Publish ready only after load and
  metadata refresh. Do not manufacture readiness from a stored handle.
- Resumes for the same session/canonical root share one in-flight promise;
  foreign roots cannot join. Ready owners are reused without load/spawn.
  A new connection clears active turn identity and startup observations.
  Connection observations/capability facts carry payload activityScope=connection
  and no turnId; first response observations remain activityScope=turn.
  Preserve diagnostics in history without presenting connection work as a new
  message turn. Do not retry a failed background load merely on view selection.
- Normal turn completion retains a healthy persistent connection. A failed
  provider/model request is a turn failure, not a reason to terminate or replace
  the native session. Keep subsequent explicit prompts/configuration available
  when the transport survives; disconnected/cleanup failures remain distinct.
- First model response timing requires meaningful text/thought, tool or plan;
  status/configuration/usage metadata cannot establish it. Observe turn admission
  and actual prompt-written acknowledgement independently. Process launch timing
  uses onBeforeSpawn/onSpawned; protocol initialization and session readiness are
  combined unless the public runtime supplies independently observed milestones.
- Reserve connection capacity and ownership before asynchronous resume work.
  Recheck after new-session discovery. Concurrent resumes cannot replace a map
  owner or exceed the cap of four. Idle crash recovery canonically stops the old
  owner before restoring the stored identity. A late result cannot revive a
  stopped generation.
- Canonical directory leases allow multiple idle conversations, but serialize
  starts/restores/mutable turns. Retain ownership during approvals, cancellation,
  and known background work; uncertain background work requires ending the owned
  process. Failed cleanup keeps ownership and remains explicitly retryable.
- A model turn ending is not a tool-exit observation. Track reported tool IDs:
  pending/in_progress and status-less/unknown partials retain unresolved ownership;
  only explicit completed/failed clears that ID. If a turn ends with unresolved
  tools, retain the directory lease with a visible reason until the owned process
  stops. Canonical stop/exit clears live tool state. Ordinary completed tools do
  not prevent a subsequent conversation acquiring the directory.

### Events, configuration and permissions

- ACP session events carry real project/session identity, connection generation and
  current turn ID when a turn exists. `onAcpState` is nonterminal; `onAcpDone` reports settled turns
  or terminal connection outcomes. Renderer root/generation guards also apply to
  early output/permission events before a create response.
- Project-wide Trellis facts and task-linked facts stay distinct. Explicit task
  binding validates the active task and captures source material/profile fields.
  A model turn ending does not approve a Trellis/Jira state or a commit.
- Render only measured launch/process/session-ready/first-response observations.
  Do not invent handshake/auth substep timings or success from executable probes.
- Models, modes and select configs come from negotiated data. Acknowledge through
  the runtime before displaying effective values. Preserve prior values on
  rejected changes. Public record retention includes only non-secret Agent/auth
  display metadata and mode choices, including store/restart/load.
- A unique explicitly categorized `mode` or `model` config option is the current
  public authority when modern controls coexist with stale legacy fields. Retain
  `category` through projection and hide duplicate generic controls in the UI.
  Do not infer category from arbitrary IDs/names; absent/ambiguous categories use
  legacy values. Rejected updates preserve effective values.
- Public acpx already persists explicit model requests in its session options and
  reapplies them on native reconnect. Inspect that requested value and the latest
  advertised ID/name mapping before diagnosing lost preferences. Vendor alias
  mappings may change with inherited local configuration. Do not introduce a
  second model-preference authority or mistake an alias-ID change for a proven
  provider/model switch. Validate a fresh nonce with an actual tool after restore.
- SDK-delivered updates unknown to acpx project as passive status/diagnostic
  events with bounded `rawUpdate`. Limits before redaction: depth 4, 128 visited
  nodes, 16 keys/object, 8 elements/array, 256 UTF-16 units/string, 64/key and
  128/tag. The serialized raw value remains at most 6144 UTF-8 bytes after
  redaction; excessive content sets `rawUpdateTruncated`. Secret-like keys and
  common Bearer/key/assignment/private-key strings are redacted. Treat all data
  as untrusted, without inferring tool completion, readiness or authority.
- Tags rejected by the pinned SDK's public schema enum produce only an owned,
  tag-only diagnostic with `payloadUnavailable:true`. The admission tap consumes
  the rejected raw frame before SDK logging. Do not claim its original payload
  survived schema validation. Foreign/early/replay/cancel gates still apply;
  known text `_meta` allowlisting and terminal semantics remain unchanged.
- Permission options preserve original ID, label and all four kinds. Require
  exactly one matching current option ID before consuming a pending resolver.
  Same-kind choices remain distinct. User denial is a selected reject ID;
  cancellation/timeout/disconnect is cancellation, settled once. Historical
  events never recreate approval callbacks.
- Startup deadline is 30s, permission wait 120s, cancellation deadline 10s;
  default turn limit is 30 minutes with an explicit profile override. Await
  canonical runtime result/shutdown before releasing leases or quitting Electron.

## 4. Validation & Error Matrix

| Input / boundary | Required result |
| --- | --- |
| No current root for live/profile IPC actions | `E_NO_PROJECT`; no live action; service `listAcpSessions('')` returns an empty list |
| Foreign active root / request | `E_DENIED`; owner unchanged; historical foreign resume returns `E_NOT_FOUND` |
| Busy, occupied directory, duplicate restore, connection cap | `E_CONFLICT`; preserve draft and owner |
| Missing adapter/Node, bad profile/cwd/task/option | Explicit setup/validation error; no hidden download or replacement |
| Invalid or ambiguous original option ID | `E_INVALID_ARG`; legitimate request stays pending |
| Expired permission | `E_NOT_FOUND`; no resolver resurrection |
| Native load fails / remote identity changes | Explicit failure; preserve history; no new session or replay |
| Unsupported profile schema | Preserve original bytes; refuse overwrite |
| Runtime cleanup fails | Visible error; retain End/retry and process ownership |
| Patch/SDK version or hash mismatch | Fail preparation/build; never report ready |
| Changed/unavailable referenced bytes | `E_CONFLICT` + `SOURCE_CHANGED`; no turn/events; caller retains draft |
| Idle task association / later prompt | Future-only materials; preserve history and native identity |

## 5. Good / Base / Bad Cases


- Good: two idle profiles share a directory; one turn acquires its lease, displays
  the adapter's exact approval choices and releases only after canonical result.
- Base: a transcript-only historical attempt remains readable and offers explicit
  New Session, without a misleading Restore button.
- Bad: marking a found stored handle ready before its native load, removing a
  resolver before validating its ID, or allowing new work after failed cleanup.

## 6. Tests Required


- `acp-materials.mjs`: source/included digests, zero-dispatch drift, future-only binding, junction fences, material add/delete and delayed project/watcher generations.

- `acpx-runtime.mjs`: original strict failures, valid/foreign/early/replay identity,
  bounded buffering, duplicate-kind exact IDs, invalid decisions, cancellation,
  metadata/store/load and owned-process cleanup.
- `acpx-preparation.mjs`: skipped scripts, idempotence, SDK/patch drift and clean
  locked production install with automatic postinstall.
- `acp.mjs`, `acp-project-scope.mjs`, `acp-foundation.mjs`: actual facade-owned
  peer, all actions' scope checks, stale/timed-out permissions, profile versions,
  frozen launch definitions, idle PID crash, concurrent restore/stop/capacity,
  failed cleanup retry, rejected configs and honest callback capabilities.
- `acp-ui.mjs`: root A→B→A, early replies, drafts/double-submit/IME, approvals,
  lazy restore, activity grouping, meaningful tool titles, visible errors/End.
- Typecheck/build, IPC/navigation/UIUX/render checks. Real vendor/native/packaged
  rows remain separate from fixtures: test both required vendors with nonce file
  reads, controlled writes, allow/deny, cancel/next turn, same remote restore,
  themes/narrow/IME/scroll and packaged restricted-PATH launch. Keep failures and
  external provider limitations explicit; a greeting is not coding acceptance.

## 7. Wrong vs Correct

Wrong: use a permission kind to pick the first same-kind option; expose ready from
an installed command; bundle acpx; claim all tests passed because the mock worked.

Correct: select the unique original option ID, show measured readiness only,
retain the public dependency boundary, and report fixture, vendor, native and
packaged evidence separately with their actual limits.
