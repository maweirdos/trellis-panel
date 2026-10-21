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

For a host-first project knowledge turn, the user row records a validated
host-received question before lookup with `payload.delivery='preparing'`, not an
already-written native prompt. Emit it once. A later owned diagnostic carries
`activityScope='turn'` and `promptDelivery.state='sent'|'not_sent'` from actual
submission facts. The renderer may project its label, never mutate/reorder the
archived question or replay it as an automatic prompt. Preserve drafts/attachments
on failed or cancelled admission. The existing post-write image-only/unbound
contracts remain unchanged. `turn.promptStarted` is the public transport-write
receipt; wait for its evidence checkpoint before ending the owned knowledge turn
even when a native result completes immediately. See `knowledge-access.md` for
bounded host-first retrieval and native configuration/Skills boundaries.

## 3. Contracts

### Task materials and source-bound prompts

`AcpPromptOptions.images?: AcpImageAttachment[]` carries `{id,name,mimeType,data}` with raw base64 (no data URL). `shared/acp-images.ts` defines raster MIME types PNG/JPEG/WebP/GIF and per-message bounds: eight images, 10 MiB per image, 20 MiB combined. `services/acp/images.ts` independently validates shape/unique IDs/base64/decoded byte count and file signature before any turn publication. This is signature checking, not full image decoding. Text may be empty only with valid images. Use the initialized runtime record's `agentCapabilities.promptCapabilities.image === true`; expose the same explicit fact as `session.capabilities.promptCapabilities.image`. Missing/false capability rejects attachments with `E_INVALID_ARG`, without changing connection state or dispatching a turn. Do not infer image support from agent/model names.

Pass admitted bytes through existing public `runtime.startTurn({text,attachments:images.map(({mimeType,data})=>({mediaType:mimeType,data})),...})`. acpx already emits actual ACP image content blocks and supports image-only input; no additional transport/compat patch is needed. After `promptStarted`, attach the submitted images to the app user message's `payload.images` and retain them in schema2 history. Provider-specific model/image restrictions remain provider errors, not a reason to silently send text alone. Existing root/generation/reference/admission/cancellation guards apply unchanged.

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
| Invalid, oversized, duplicate or unadvertised image attachment | `E_INVALID_ARG`; no prompt/event dispatch or status change; caller retains attachments |
| Idle task association / later prompt | Future-only materials; preserve history and native identity |

## 5. Good / Base / Bad Cases

- Image input: good is image-only content arriving on the ACP wire and in saved user-message history; base is an unsupported engine rejecting before publication; bad is dropping the image or replacing it with a local path/text assertion.

- Good: two idle profiles share a directory; one turn acquires its lease, displays
  the adapter's exact approval choices and releases only after canonical result.
- Base: a transcript-only historical attempt remains readable and offers explicit
  New Session, without a misleading Restore button.
- Bad: marking a found stored handle ready before its native load, removing a
  resolver before validating its ID, or allowing new work after failed cleanup.

## 6. Tests Required

- `acp-images.mjs`: isolated actual facade + public runtime + owned peer; verify MIME/signature/base64/duplicate/count/byte bounds, stale generation and unsupported capability with zero dispatch, image-only and mixed wire blocks, next-turn continuity, disk history and renderer timeline projection. This fixture does not establish real provider/model vision or native UI acceptance.

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

## 8. Conversation history archive and explicit model recovery

Read this section when changing ACP transcript retention, history paging, recovery actions, or the worker lifecycle. The panel event archive is a reader/persistence authority for events admitted by Trellis; acpx remains the sole native transport/session authority.

### Signatures and contracts

```ts
acpHistoryList({ limit?, cursor?, query?, filter? })
acpHistorySession(sessionId)
acpHistoryEvents(sessionId, { before?, after?, limit? })
acpHistoryRetry(sessionId)
acpSessionRecoverModel(sessionId, { modelId, expectedConnectionGeneration })
```

`acpHistoryList` searches project metadata and returns an opaque root/query/snapshot-bound cursor. `acpHistoryEvents` returns chronological pages of whole conversational turns with immutable `historySeq`, coverage, `startsMidTurn`, soft byte/count targets and persistence state. `limit` is an event-count target, not permission to cut a turn. Initial/latest, before and after pages preserve each saved user prompt together with all of its saved assistant fragments, tools, permissions and outcome. Summaries contain no event bodies or base64 attachments. Current actionable permissions are a separate live snapshot (`pendingPermissions`, `stateRevision`, connection/turn generation); historical permission events are never actionable, including the snapshot fallback.

Summaries carry `hasConversation`, derived from actual scoped message text, tool or permission events; a diagnostic/status event count cannot establish conversational content. They also carry a bounded `conversationPreview` and `conversationPreviewAt` for unloaded sidebar hints. Assemble only the coherent latest real message across exact role/turn/connection/producer-message boundaries, including fragments from prior archive batches. Exclude thoughts, tools, diagnostics and attachment bodies. Preview text does not extend the declared title/role/task metadata search scope.

- Every admitted panel/Trellis event enters `userData/acp/history.sqlite` before the bounded compatibility snapshot is trimmed. Worker acknowledgement advances `committedThroughSeq`; a live view never implies durable history without this acknowledgement.
- Schema2 JSON and legacy sources are imported non-destructively. Original bytes are backed up by SHA-256. Repeated `(source,digest)` imports are idempotent; unsupported/damaged sources remain available for diagnosis and are not overwritten.
- Imported bounded records have `historyCoverage=unknown`; exact verified native prefixes may be `partial` with provenance. A verified prefix import is allowed only before an archive sequence exists for that session; otherwise return a conflict rather than reorder cursors.
- A changed compatibility snapshot may contain events not acknowledged before a crash. Re-import its safe suffix after the archive's known last original event ID, deduplicating by original ID/digest. Retain first-seen bytes on conflicts and report them without blocking safe new tail events. Do not append uncertain earlier events after a canonical suffix: preserve the original source/backup, report the unresolved ordering and mark coverage partial. Import markers, safe rows and metadata commit together; repeating the same source digest remains idempotent.
- Persisted event canonicalization is a storage contract. New hashes use ordinal key ordering, not locale-sensitive sorting. Early version1 rows may use recursive `localeCompare` ordering: accept that known digest only when the stored payload verifies against it and canonical stored/incoming content is identical. Apply this comparison to append and snapshot import. Preserve original payload, digest and sequence; never treat an unexplained digest mismatch or changed body as an upgrade artifact. Test an actual old-format row across reopen/import, not only a freshly created archive.
- Archive pages target 200 events/2 MiB, stopping only between turns. If one turn exceeds either target, return that entire saved turn and mark the page `oversized`; never split its streamed answer, Markdown, attachments or tools. Native identity includes connection generation and turn ID; retain turn-scoped preparation before the user event. Legacy records without turn IDs use actual user/outcome boundaries, without inventing a user prompt or successful completion. The SQLite worker and degraded snapshot reader follow the same boundary rules. Derive boundaries from lightweight metadata before reading selected payloads; do not hydrate the full archive just to select a page. Full history has no 800-event retention cap. During sustained worker failure, explicit write-queue bounds change coverage to partial/degraded and never report saved.
- `startsMidTurn` describes an already incomplete saved prefix, not ordinary pagination. A page beginning with legitimate preparation/connection facts must not be classified incomplete solely because its first event is not a user message. A running turn returns all currently saved content with its actual running state; paging cannot manufacture an ending. Immutable sequence cursors remain scoped and monotonic; concurrent tail appends and old cursors must not lose or duplicate events when pages merge. A cursor at a valid turn edge remains usable; an old interior cursor or a tail edge invalidated by growth returns a typed conflict/reset instead of silently returning half a turn.
- `acpSessionRecoverModel` accepts only an exact last-known candidate ID and current connection generation. It uses public acpx `setModel`/same-session load plus a subsequent same-session connect; it never parses error text, creates a replacement session, replays a prompt, or silently changes provider. `modelConfirmed` may be true while connection remains failed.
- `connectionOwned`/`cleanupRequired` are ephemeral lifecycle facts derived from the active owner, never inferred from persisted `status='error'`.

### Validation matrix

| Condition | Required result |
| --- | --- |
| More than 800 streamed events | First/middle/last events survive a fresh archive reopen |
| One turn exceeds count/byte target | Its prompt, all saved fragments/tools and outcome remain in one oversized page |
| Multiple turns, latest/before/after pages | Boundaries preserve turns; concatenated event IDs/bytes match the archive exactly |
| Legacy/no turn ID or reused ID after reconnect | Use real user/outcome boundaries and generation scope; never merge unrelated turns |
| Missing saved opening / currently running tail | Truthful prefix/running metadata; no fabricated prompt or completion |
| Archive worker unavailable/write failure | Current content remains visible; persistence becomes degraded with pending/unarchived count and retry |
| Root/session/epoch/cursor mismatch | Typed conflict/reset; no cross-project read |
| Historical pending permission | Read-only/expired display; no resolver or actionable approval |
| Exact model candidate rejected | No prompt/new session; effective model unchanged |
| Model acknowledged, second load fails | Preserve confirmed candidate metadata and report connection failure separately |
| Stop/project change during recovery | Cancel/retain ownership; reject late result and do not revive stopped source |

### Tests and wrong/correct pair

Run `acp-history.mjs` for >800 exact events, >20 catalogue/search/direct-ID, cursor races, oversized images, migration/backup/damage, verified prefix recovery, worker/write failure and live permissions. Run `acp-recovery.mjs` for exact-ID same-session two-load, zero `session/new`/prompt dispatch, confirmed-but-connect-failed split, stale/root/generation/stop/lease/cap/cleanup cases. Native/vendor acceptance remains separate.

Wrong: use the 800-event `AcpSessionRecord.events` array as the full archive, slice an assistant reply at the 200th event, or make `pending:true` in a historical page clickable.

Correct: write to the acknowledged archive, page whole saved turns from immutable sequence, and derive actionability only from the current live permission map.

## Conversation organization

### 1. Scope / Trigger

Read before adding conversation rename, pin or archive actions. These are local
organization preferences, independent of native process/turn state and saved
transcript bytes. Archive is reversible and never implies deletion or shutdown.

### 2. Signatures

```ts
acpHistoryUpdate(sessionId, { title?: string, pinned?: boolean, archived?: boolean })
// -> { ok: true, version: 1, session: AcpHistorySummary } | IpcFail
acpHistoryList({ archive?: 'active' | 'archived' | 'all', ...existingInput })
```

### 3. Contracts

- Default list scope is `active`. Apply archive selection, effective-title search
  and pinned-first ordering before page slicing, including unloaded records.
- Project/session preferences persist independently of runtime-generated session
  metadata. Effective titles expose `customTitle`; pin/archive expose optional
  `pinnedAt`/`archivedAt`. Later status, append, import and reconnect metadata
  cannot overwrite human choices. List, direct session, event-page summary and
  degraded snapshot reads apply the same preferences.
- Capture the current root and project generation at IPC entry. Validate the
  exact owned session and recheck the captured owner before mutation. Acknowledge
  only a durable save; update no native lifecycle, prompt or permission state.
- Preference changes invalidate stale catalogue snapshots rather than mixing old
  cursors with changed filters/order. Keep existing event-sequence cursors intact.

### 4. Validation / Error Matrix

| Input or condition | Required behavior |
| --- | --- |
| Title with leading/trailing whitespace | Trim; require 1–200 characters |
| Empty patch, unknown keys, non-boolean flags or invalid ID | Typed invalid-argument failure; no write |
| Foreign/missing session or changed project owner | Reject without changing another source |
| Save failure or malformed existing preferences | Visible failure; preserve original file and prior effective values |
| Repeated pin/archive boolean | Idempotent state; unpin/unarchive reverses it |
| Archived running session | Keep the actual running state; no implicit cancel/kill |

### 5. Good / Base / Bad Cases

Good: rename an old disconnected conversation, restart, and find it by its new
title. Base: archive it and recover it through the archived filter. Bad: store a
temporary row label that the next runtime event replaces, or hide only the first
loaded page while search/pagination continue to return archived records.

### 6. Tests Required

Verify rename/pin/archive and inverse actions through real persistence/reopen,
search and pagination; verify legacy and fallback reads, root isolation, stale
project callbacks, invalid inputs, failed saves and unchanged transcript/native
dispatch. The renderer must exercise actual row menus, modal validation,
acknowledgement/failure, selected title updates and retrieval of archived rows.

### 7. Wrong vs Correct

Wrong: changing the title only in component state or interpreting archive as
remote conversation deletion. Correct: persist scoped organization metadata,
project it consistently on reads, and expose only the supported reversible actions.
