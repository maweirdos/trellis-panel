# ACP runtime and workspace contract

## 1. Scope / Trigger

Read before changing `services/acp.ts`, `services/acp/`, ACP IPC/preload/types,
the Agent workspace, dependency preparation, or Electron packaging. The supported
pair is Codex adapter 2.2.2 and Claude adapter 0.91.0. Legacy custom engine
definitions and snapshots are retained for identification and reading only.
ZCode installation and native startup also follow `zcode-managed-startup.md`.

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

Explicit Runtime connection tests resolve the selected current launch argv and
send only ACP initialize. Managed adapters, native CLIs and bundled bridges use
the same protocol probe; SDK entry validation is
separate and does not prove model credentials. Never create a session, send a
prompt or perform login as part of discovery or connection testing. Advertised
authentication methods do not establish that login is required or completed.

Engine Settings automatically reads local installation discovery on entry,
window focus/visibility return and every30 seconds while visible. Read discovery
uses a one-second burst cache and coalesces matching in-flight work. It never
queries npm latest versions or starts a protocol handshake. Explicit full refresh
may query version registries; local reads reuse matching registry evidence for
at most five minutes. Installation/removal outside the application must appear
on the next local read after the burst cache expires.

Returning to Engine Settings immediately restores its last displayed local list
and revalidates it in the background. Inventory-only Node validation and CLI
version metadata are coalesced and cached in memory for at most 30 seconds,
keyed by the resolved executable/entry identity, selected arguments and relevant
environment. File/path replacement invalidates matching metadata; explicit full
refresh bypasses completed metadata caches. Discovery still checks installation
presence on each inventory read. Execution admission and explicit connection
tests always validate current launch sources independently of these caches.

`Settings.acp.runtimeDefaults[runtimeId]` stores each engine's `modelId`, `env`
and extra `args`. A settings patch replaces only supplied engine entries;
`{[runtimeId]:{}}` resets one engine without changing other engines or paths.
Agent overrides replace same-name environment variables and extra parameters;
order and repeated entries within a scope are retained. Windows environment names
are case-insensitive and canonicalized before spawning; POSIX names and parameter
names remain case-sensitive. Empty environment values are valid overrides.

Agent `modelId` omitted means inherit the engine default; null means use engine
automatic selection; a nonempty string requests that exact model. The role-save
wire value `modelId:''` clears an existing override to inheritance before storing
the normalized profile. Clearing SDK-inapplicable arguments sends `args:[]`.
Capability restrictions follow the actual supported launchKind.

New sessions capture resolved values in `launchOptionsSnapshot`. Environment and
extra arguments use that snapshot after defaults/role edits and during restore.
Historical sessions without it retain only their historical role values. Apply
default models only when creating a session; restoring uses its actual saved model,
with explicit model recovery taking precedence. Reject unacknowledged model IDs
instead of silently substituting another. Pi uses configured complete selection
IDs and rejects extra CLI parameters because it runs an SDK.

Connection verification is bounded, main-process memory evidence keyed by the
exact Runtime definition, resolved argv, selected Node/native paths and actual
executable/entry file identity. Refresh may retain matching evidence; changed
launch configuration/files or process restart requires new evidence. Return the
updated agent list with each test so the visible state changes immediately.
Reject stale probe results after launch-source replacement. The generated
Diagnostic Mock and its exact historical fixture copies are excluded from the
Runtime catalog; other legacy custom definitions remain unavailable.

Ordinary messages do not run a host knowledge search before dispatch. Keep the
admitted project/turn scope available for actual native MCP calls. User messages
are emitted once after public turn.promptStarted acknowledges the transport write.
Failed admission retains the original draft and attachments; it does not fabricate
a sent question, tool call or knowledge result.

User-selected role instructions and additional project skill manifests use a
separate standard ACP embedded resource. Require negotiated embeddedContext=true
before dispatching configured context; unsupported engines reject before writing
or consuming a turn. Do not impersonate vendor-specific system-prompt metadata.
AcpAgentProfile.skillPaths contains at most32 unique normalized project-relative
SKILL.md entries. Each file must be bounded valid UTF-8 within the physical project
root with valid name/description frontmatter. The manifest provides descriptions
and file URIs; full skill bodies remain on-demand native reads. Existing native
skill discovery/enablement remains engine-owned.

Capture the profile snapshot for the session; later default edits affect new
sessions. Re-read/verify selected skill revisions before writing each ordinary
turn. Role instructions plus catalog must fit one128 KiB resource. agentContext
records prepared/sent/not_sent with exact generation, turn and content revision.
Only promptStarted establishes sent. Clear that claim on a new connection;
compaction/actual model reading or compliance cannot be inferred from delivery.
Native slash commands do not acquire host context attachments.

On private runtime-record load, replace only the recognized legacy host-first
knowledge-policy append after its exact frozen role prefix. Preserve other
session options, user-owned prompts, native identity and transcript bytes.
This compatibility update uses the supported append route already present in
the historical record; it is not portable proof of new role delivery. Current
roles continue to use the negotiated embedded resource and actual write receipt.

## 3. Contracts

### Native OpenCode retries

Windows native OpenCode V1 may supplement ACP with read-only `GET /session/status`
for retry evidence that its ACP stream omits. Use public acpx `prepareSpawn` to
assign a loopback port and random process-local `OPENCODE_SERVER_PASSWORD`;
neither the password nor Authorization header belongs in IPC, history, launch
snapshots or logs. Explicit port/hostname/auth overrides skip this auxiliary reader.

Before each bounded, non-redirecting request, verify the listener PID belongs to
the live launch or its descendants and verify the launch birth time. Poll only
after `promptStarted` for the admitted turn. Require current project/session,
connection generation, turn and matching `handle.backendSessionId` and
`meta.backendSessionId`; stop on terminal result, cancellation, exit or replacement.

`AcpStateEvent.runtimeRetry?: AcpRuntimeRetry` contains `turnId`,
`connectionGeneration`, `attempt`, `nextAt`, sanitized `message`, optional `reason`
and `provider`. It is ephemeral evidence, not a terminal result. A native
`free_tier_limit` whose `nextAt` exceeds the turn deadline requests canonical acpx
cancellation and retains the reason after the terminal acknowledgement. A peer
that answers `completed/end_turn` after that request keeps its raw result, with a
separate host-policy stop receipt; it establishes no successful reply, handoff or
native-persistence confirmation. Present the stopped turn and its reason rather
than claiming successful completion from that raw result.
Transient retries retain their native state. Provider failures and cancellation
reasons must survive `acpState` followed by `acpDone`; no automatic model switch,
prompt replay or fabricated successful/failed outcome follows from a retry read.

### Task materials and source-bound prompts

Product-owned platform nodes use [Product task execution](./product-task-execution.md).
The internal platform launch captures its local configuration, stable native
alias and existing lifecycle lease before creation. `platformExecution` metadata
does not create authority: the live private owner and original fixed context
must still match. Do not route these nodes through a Trellis task pointer or a
v1 progress binding. Ordinary session configuration/prompt/resume entrypoints
must not bypass their owning task facade.

Actual node context uses the existing T03 composer and native prompt-write
receipt. Fixed JSON text is carried as supported `text/plain`; keep its strict
packet/digest/envelope validation. A prepared manifest is separate from actual
transport acknowledgement. Original native cleanup and durable task controls
remain available without changing shared task approval or business state.

`AcpPromptOptions.images?: AcpImageAttachment[]` carries `{id,name,mimeType,data}` with raw base64 (no data URL). `shared/acp-images.ts` defines raster MIME types PNG/JPEG/WebP/GIF and per-message bounds: eight images, 10 MiB per image, 20 MiB combined. `services/acp/images.ts` independently validates shape/unique IDs/base64/decoded byte count and file signature before any turn publication. This is signature checking, not full image decoding. Text may be empty only with valid images. Use the initialized runtime record's `agentCapabilities.promptCapabilities.image === true`; expose the same explicit fact as `session.capabilities.promptCapabilities.image`. Missing/false capability rejects attachments with `E_INVALID_ARG`, without changing connection state or dispatching a turn. Do not infer image support from agent/model names.

Pass admitted bytes through existing public `runtime.startTurn({text,attachments:images.map(({mimeType,data})=>({mediaType:mimeType,data})),...})`. acpx already emits actual ACP image content blocks and supports image-only input; no additional transport/compat patch is needed. After `promptStarted`, attach the submitted images to the app user message's `payload.images` and retain them in schema2 history. Provider-specific model/image restrictions remain provider errors, not a reason to silently send text alone. Existing root/generation/reference/admission/cancellation guards apply unchanged.

`acpSessionBindTask(sessionId,input)` is explicit and requires an idle ready owned session/current connection generation and an actual active task/path. It changes future material assembly only; prior events/snapshots/native identity are not rewritten. Busy/stale binding rejects with `E_CONFLICT`.

`acpSessionPrompt(sessionId,text,options?)` retains two-argument callers. Options may carry expectedConnectionGeneration and sourceReferences. Each AcpSourceReference captures projectRoot/taskDir/relativePath/displayedRevision/targetSessionId/targetConnectionGeneration and optional sectionAnchor/quote. Main independently validates trusted root/generation/path/session/binding, and compares the modern raw-byte sha256-prefix16 identity against the same read used for assembly before turn publication. Drift/unavailability returns `E_CONFLICT`, reason `SOURCE_CHANGED`, and sources[] expected/actual/available details with no new turn/event/snapshot consumption.

Material snapshots distinguish sourceRevision/includedRevision/sourceBytes/includedChars/truncation/availability; whole-file identity differs from a truncated included-segment digest. Unknown old metadata stays unknown. Material events use `kind='material-change',source='trellis',payload.materialChange` with actual scoped add/change/unlink facts. Rootless old notices are generic attention, not verified artifact input. Project generation gates delayed notices/imports/reads; unlink reaches the modern reader. These facts prove neither Agent authorship/compliance nor approval/phase completion.

### Dependencies and launch

- Pin `acpx=0.19.5`, SDK 1.8.0 scoped through the acpx override, and
  `patch-package=8.0.1`. The installed license remains intact. Check
  `patches/acpx-compat.json` and the public `TRELLIS_ACPX_COMPAT_VERSION=3` marker.
- `postinstall` runs `scripts/prepare-acpx.mjs`. Standard dev/build/typecheck/dist
  run the guard. `npm ci --legacy-peer-deps` is required by the repository's
  existing Vite 8 / electron-vite 5 peer mismatch; do not change the build stack
  silently. An install with scripts skipped must be explicitly prepared.
- Pin electron-builder26.0.11 for the supported Windows package. Version25.1.8
  can place shared transitive dependencies under an unrelated package, making
  the packaged daemon fail at startup. Verify actual packaged control/host
  startup, build stamp and canonical exit in the actual packaged application; a successful
  archive layout check alone does not prove dependency resolution.
- `electron.vite.config.ts` externalizes acpx and its subpaths. Bundling its ESM
  runtime into CommonJS destroys package-relative `import.meta.resolve` paths.
  The published export is ESM; the supported Node/Electron version loads it from
  the CommonJS main using `require(ESM)`. Do not describe it as a separate CJS build.
- Managed Setup installs exact adapters under
  `userData/acp/runtimes/<id>/<version>/`. Discovery and Start never download.
  Managed launch uses an absolute external Node >=22.13 executable and the
  installed adapter's absolute entry, independently of GUI PATH.
- Reject custom commands and `{executable,args}` at discovery, connection test,
  setup, session admission and snapshot restore. Preserve old settings and history;
  settings clients cannot add, change or remove legacy definitions. A saved custom
  ID overrides a same-ID builtin only as unavailable, never as a redirect. Reject a
  provenance-free snapshot when its ID has a saved custom override. Validate supported
  launch provenance and exact definitions at the final argv boundary; do not clean
  up an old owner before rejecting its unsupported snapshot.
- A held unavailable session rejects new prompts, configuration changes, permission
  choices and resume requests. Recheck admission before dispatch; preserve already
  running work, history reads, explicit cancellation and explicit session cleanup.
  A pending permission may expire as cancelled without automatically stopping the
  unavailable session's process.
- History metadata, filters and task reconciliation use the same snapshot, saved
  override ID, session `agentId` and `engine` checks. An absent legacy `engine`
  means ACP. A provenance-free exact managed snapshot remains eligible only when
  no same-ID custom override is retained. The archive remains readable.
- On ACP restore compare the native record's command, saved argv and session identity
  with the admitted snapshot and captured options. For a supported managed, native
  or bundled engine, executable/adapter path changes may be projected onto the same
  native session while fixed and extra arguments remain identical. Keep the original
  record until the native session confirms its original identity and post-connection
  status; stage intermediate writes and their model/config projection separately
  from persisted Panel metadata. An acknowledged model may be reported through
  `recovery.modelConfirmed` while connection recovery is still incomplete. Reject
  incompatible or unidentifiable commands. After restore, require exact admitted
  argv on every runtime-store load. Handoff targets re-resolve their previewed launch
  before session creation and the native creation boundary.
- Closing a recovering session marks it as stopping immediately and waits for any
  in-flight native-record commit and matching Panel projection before runtime cleanup.
  A stop during that commit must not publish a ready state. A successful commit is
  retained as the same session's current record; a failed commit preserves the prior
  record while cleanup and error reporting remain available.
- Before committing a staged native-record change, persist the Panel snapshot with
  `recovery.commitPending: true`, the original session identity and any acknowledged
  model. A failed marker write prevents the native commit. Publish ready/closed only
  after the final Panel snapshot is written; a failed final snapshot retains the
  pending marker and reports failure. History reads surface that marker and its saved
  connection generation so the original session can be retried. The two files are
  not one atomic transaction; the marker makes an interrupted commit explicitly
  recoverable when its snapshot is available. The Panel snapshot uses atomic rename
  without an fsync durability guarantee, so power loss can still leave the marker or
  either file unconfirmed; do not claim cross-file crash atomicity.
- Native presets (`NATIVES` in `services/acp/runtime-definitions.ts`, currently `opencode` via
  `acp` and `dsh` via `--profile acp`) are CLIs that ship their own ACP server
  mode. Detection is read-only probe (settings `acp.nativePaths[id]` override,
  then PATH via `findExecutable`, then version) and never installs; missing
  CLIs render an actionable install hint with `executable_missing`. Native
  launch argv is `[detectedPath, ...launchArgs]` re-resolved at launch time.
  `AcpAgentStatus.adapterVersion` carries the CLI's own `--version` for native
  entries, and diagnostics state the detection source (手动指定/自动检测).
  Windows batch shims (`.cmd`/`.bat`) must never be fed to Node spawn or
  `execFile` directly: route through `cmd.exe /d /s /c` (as `run()`, the
  connection probe and acpx all do), and `findExecutable` must prefer
  extensioned executables over the extensionless POSIX sh shims npm also
  installs.
- Native install/upgrade is the same explicit Setup action
  (`setupAcpRuntime`): `npm install -g <npmPackage>` through the validated
  external Node's npm-cli with `--loglevel=error` and a 600s timeout; install
  equals upgrade (no version pin), and concurrent invocations reuse the
  `setups` dedupe map. Discovery and Start still never install.
- `services/acp/connection-probe.ts` implements 测试连接: it spawns the real
  launch argv, sends exactly one ACP `initialize` over NDJSON (10s handshake
  timeout), collects agentInfo/protocolVersion/capability labels/authMethod
  ids, then tree-terminates (win32 `taskkill /T /F` with `child.kill()`
  fallback, POSIX kill with post-grace `SIGKILL`). It must never send
  `session/new` or any prompt — the probe has zero user-data side effects and
  never authenticates; non-empty `authMethodIds` is surfaced as a hint only.
  Probe business failures return `{ok:true, probe:{ok:false}}`, not IpcFail.
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
  Selecting history only reads its saved transcript and metadata. Explicit Send
  reuses the current connection, joins an in-flight start, or loads the same
  native identity before dispatch. Selection never starts or stops a process.
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
  uses onBeforeSpawn/onSpawned; protocol initialization and session readiness are combined unless independently
  observed. The bundled ZCode adapter writes measured process/storage/account/
  session/subscribe durations to its generation-owned diagnostics directory. Read
  only fresh bounded validated fields; a skipped stage has no invented duration.
  Per-stage failure does not independently override native overall readiness.
  Independent account preparation and storage spans may overlap; their sum is
  not the end-to-end connection duration.
  New ZCode sessions retain their complete creation snapshot and subscribe with
  includeSnapshot=false and afterSeq=0 to avoid repeating native snapshot work.
  Validate the actual subscription session ID/watermark and consume queued
  changes before readiness. Restores retain the complete resume snapshot and
  also omit the duplicate subscription snapshot. Establish their baseline from
  the acknowledged desktop-continuous namespace, without replaying old turns.
  Buffer matching configuration notices from before the resume reply, bounded
  to256 notices/1MiB; overflow fails the connection. Preserve newer fields
  independently when partial patches arrive out of order. Clear pending notices
  on failure/closure. Native permission/configuration/model changes cannot be
  dropped for speed.
- ZCode hook compatibility changes only the verified Windows `ebo` command
  request with `n.shell===undefined` and either SessionStart sync/context or
  UserPromptSubmit nudge, using the exact quoted Bash/HOME commands specified in
  [Managed ZCode startup](./zcode-managed-startup.md#windows-codegraph-command-hooks).
  Set only `command.shell` from the native `hoe` Git Bash provider; preserve
  generic shell execution without `posix-bash` or shell-init snapshots. Missing,
  non-Git, invalid or throwing resolution retains the original shell. Preserve
  actual execution, permissions, resolved timeout, cancellation and cleanup.
  PostToolUse sync,
  UserPromptSubmit sync/context, PreToolUse/PermissionRequest gate/nudge and
  project Python workflow hooks retain native behavior. This correction is independent
  of the optional asset cache; preparation never executes hooks.
- Windows process inventory may reuse a hidden query process, but every capture
  must query a fresh process table at the existing lifecycle boundary. Preserve
  PID/birth identity, root-exit and unknown-cleanup semantics. Bound framing,
  requests, replies and deadlines; a timed-out or invalid query cannot establish
  absence. Do not reuse completed tables by TTL or remove either startup capture.
  Query-helper lifetime follows its host; pipe EOF and shutdown must leave no
  helper process running and must not keep a closed host alive.
- Reserve connection capacity and ownership before asynchronous resume work.
  Recheck after new-session discovery. Concurrent resumes cannot replace a map
  owner or exceed the cap of four native connections. History count is independent.
  At capacity, canonically disconnect the least recently used verified idle owner
  only when its capability, native identity and launch snapshot support restore;
  retain its native identity for Send-time restore. Never evict active turns,
  approvals, background work, held leases or uncertain cleanup. If all are busy,
  reject admission and preserve the draft. Explicit Stop fences pending restore.
  Stock ZCode can advertise load for an empty session that exists only in RAM;
  conservatively retain a newly created owner until a normal completed turn or
  successful same-identity native load establishes its private persistence fact.
  Idle crash recovery canonically stops the old
  owner before restoring the stored identity. A late result cannot revive a
  stopped generation.
- Canonical directory leases admit independent ordinary conversations concurrently
  within the same canonical project. Managed workflow turns remain exclusive;
  another project's alias cannot share the directory. Retain each exact owner
  during approvals, cancellation,
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
| Verified Windows SessionStart sync/context or UserPromptSubmit nudge without an explicit shell | Select only native `hoe` Git Bash shell; preserve generic execution, results, errors and cleanup |
| Native hook shell resolver unavailable, invalid, non-Git or throws | Original shell; no environment or provider substitution |
| Other hook event, command or shell; non-Windows or unsupported CLI | Original hook execution request and artifact behavior |
| Unsupported profile schema | Preserve original bytes; refuse overwrite |
| Runtime cleanup fails | Visible error; retain End/retry and process ownership |
| Patch/SDK version or hash mismatch | Fail preparation/build; never report ready |
| Changed/unavailable referenced bytes | `E_CONFLICT` + `SOURCE_CHANGED`; no turn/events; caller retains draft |
| Invalid, oversized, duplicate or unadvertised image attachment | `E_INVALID_ARG`; no prompt/event dispatch or status change; caller retains attachments |
| Idle task association / later prompt | Future-only materials; preserve history and native identity |

## 5. Good / Base / Bad Cases

- Image input: good is image-only content arriving on the ACP wire and in saved user-message history; base is an unsupported engine rejecting before publication; bad is dropping the image or replacing it with a local path/text assertion.

- Good: ordinary A and B run concurrently; switching views leaves A running.
  Each turn retains its exact approval choices and releases only its own lease
  after canonical result. A managed workflow waits for exclusive ownership.
- Base: a transcript-only historical attempt remains readable and offers explicit
  New Session, without a misleading Restore button.
- Bad: marking a found stored handle ready before its native load, removing a
  resolver before validating its ID, or allowing new work after failed cleanup.

## 6. Validation

Run `npm run check:acpx`, `npm run typecheck`, `npm run build` and `npm run check:ui` for affected layers. Keep temporary peers, scripts and evidence in OS TEMP.

For native OpenCode retry telemetry, verify listener ownership, ephemeral-secret
redaction/non-persistence, bounded invalid/oversized responses, stale launch/turn/
backend rejection, native retry time and canonical cancellation. Exercise a real
provider rejection followed by an explicit model change and a complete response
in the same native session. Retry evidence must not count as successful inference.

Verify identity and generation fences through initialize/new/load, early updates, failed admissions, permissions and canonical cleanup. Restore must keep the same native session without prompt replay, retain the complete model catalog, reject notice overflow and consume queued desktop events before readiness. Independent configuration fields must survive equal and out-of-order revisions.

Verify resource/image byte bounds, source revisions, unsupported-capability zero-dispatch, cancelled turns and subsequent reuse. Rejected controls preserve effective values; stale root/selection replies cannot publish readiness or permissions. Connection timing spans must remain bounded, current-attempt facts.

For UI changes, verify drafts, IME, focus, scroll, pending approval and explicit recovery across root changes and narrow/light/dark layouts. For native and packaged acceptance, exercise real file reads, controlled writes, allow/deny, cancel/next-turn, same-identity restore and restricted-PATH launch. Keep vendor, native and packaged results distinct from controlled validation; a greeting or compiled fixture is insufficient. Hook equivalence and artifact checks follow `zcode-managed-startup.md`.

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

### History and recovery acceptance

Verify archives beyond the in-memory event cap and across multiple catalog pages, preserving exact event bytes and whole-turn boundaries. Exercise migration, damaged archives, prefix recovery, failed worker writes and expired historical permissions. Recovery must retain the exact native ID with no new session or replayed prompt, distinguish confirmed model selection from connection failure, and respect root/generation/stop/lease/capacity fences. Native/vendor acceptance remains separate.

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
project it consistently on reads, and keep archive separate from confirmed permanent deletion.

## Permanent local deletion and semantic titles

### 1. Scope / Trigger

Read before changing session deletion, automatic titles, history text extraction,
management IPC or the conversation menu. These actions operate on the exact
project/session identity; selection and catalogue loading never request a model
or delete a session.

### 2. Signatures

```ts
acpHistoryDelete(sessionId, { expectedRoot, expectedConnectionGeneration? })
// -> { ok: true, sessionId, deleted: true }
//  | { ok: true, sessionId, cancelled: true } | IpcFail
acpHistoryRegenerateTitle(sessionId)
// -> { ok: true, version: 1, session: AcpHistorySummary } | IpcFail
onAcpHistoryChanged(({ projectRoot, sessionId, deleted? }) => void)
```

The daemon routes are `runtime.historyDeletePreview`, `runtime.historyDelete`
with `{sessionId,input:{token}}`, and `runtime.historyRegenerateTitle`. A preview
token is insufficient authorization: deletion must consume the single-use,
two-minute app-private receipt issued by native GUI code after confirmation.
Renderer DTOs contain neither a confirmation boolean nor deletion paths.

### 3. Contracts

- Deletion IPC requires the live originating main frame, its original URL,
  process/routing identity, current root and project generation. Main-frame
  navigation, including same-URL reload, invalidates the request. The native
  warning lists deletion/preservation scope and defaults to Cancel. Cancellation
  creates no confirmation receipt or tombstone.
- Block connected owners, active/admitting turns, permission waits, unfinished
  tools, background work, restore/recovery, cleanup uncertainty and managed
  workflow associations. Provide the applicable Stop/End/retry-cleanup or
  workflow action; deletion never implicitly stops an engine. Pending or
  uncertain Runtime continuation must finish or be cancelled first.
- After confirmation, recheck source/connection/root/file fingerprints, drain
  acknowledged history writes, then persist `acp/history-deletions` intent before
  erasing anything. Archive append/import/recovery, compatibility persistence and
  title CAS honor that identity. Incomplete cleanup remains `deletionState=pending`
  with explicit retry; success requires every selected cleanup to complete.
- Delete this session's SQLite rows/import markers, compatible snapshot and its
  abandoned writes, matching original backups and preferences, source handoff
  previews and failed/cancelled `delivery=not_sent` operation contexts. Preserve
  delivered successor context/receipts. Delete the app-owned ACP runtime record
  and matching `runtime-store/sessions/acpx-write*/record.json` abandoned copies
  only after verifying schema, native record ID, cwd, backend ID, app-session
  name and any recorded vendor identity; a live recorded PID blocks deletion.
- Pi deletion derives only `userData/pi/sessions/sha256(originalProjectRoot)/sessionId`:
  its native JSONL, images and attachments belong to that app conversation.
  Never follow `pi.sessionFile`, cwd, document links or artifact paths as deletion
  authority. Preserve project source/generated files, user exports and external
  CLI global sessions/logs.
- All targets must be absolute descendants of the physical app-data directory.
  Reject links/junctions and nonregular descendants. Hash files in bounded chunks
  and verify descriptor/named inode, size and mtime before/after reading. Compare
  the confirmed fingerprint again after asynchronous archive cleanup. Complete
  tombstones retain only suppression identity, without titles or role metadata.
  This is application-level removal, not forensic secure erasure.
- Automatic titles run in the background after an actual completed ordinary
  reply. Summarize the actual first question and delivered content into a short
  semantic phrase, using an enabled configured model, no tools, 160 output tokens
  and a 20-second request timeout. Prefer available `final_answer` text. Missing
  configuration/provider/save failure preserves an honest fallback and cannot
  reject an admitted prompt. Existing conversations require explicit regeneration;
  list/search/page reads never incur title requests.
- Preferences persist `automaticTitle`, `customTitle` and `titleProvenance`
  (`source=manual|generated|fallback`, revision, pending/ready/failed state,
  source digest, optional model/time/error). Per-session CAS, exact connection,
  root identity and material digest prevent stale writes; manual titles always
  win. All history/live/fallback summaries project the same effective title.
- Title, preview and handoff text hydration uses text-only rows with block
  metadata and `replayConversationTextEvents` before extraction. Authoritative
  replacement never appends its discarded prefix. Original archive events remain
  immutable; conservative handoff byte overestimates do not permit duplicate text.

### 4. Validation / Error Matrix

| Condition | Required result |
| --- | --- |
| Child/destroyed/replaced/navigated frame, foreign root or stale generation | Reject without issuing approval or deleting |
| Preview token without native receipt | `E_DENIED`; no tombstone or erasure |
| Source/file change during confirmation or awaited cleanup | Reject or retain pending cleanup; require new confirmation |
| Partial erase, worker failure or unsafe path | `IpcFail`; never `deleted:true`; retry remains discoverable |
| Manual title or late root/connection/material/CAS result | Preserve the current title |
| Old preload lacks either management API | Visible instruction to fully restart the application |

### 5. Good / Base / Bad Cases

Good: end a conversation, confirm the listed local scope, erase its attachments,
and keep project files. Base: cancel without writing deletion state. Bad: turn a
preview token into deletion approval, retain unsent handoff copies, or overwrite
a manual title with a delayed generated result.

### 6. Tests Required

Use OS TEMP exclusively. Verify native cancellation/default choice, main-frame
and same-URL navigation fences, approval consumption, cross-root isolation,
source replacement during archive awaits, partial failure/retry, process restart
and stale-source reimport, abandoned ACP copies, unsent handoff contexts,
delivered/foreign-record preservation, Pi attachments and junction refusal.
Catalogue cursors advance by scanned positions when tombstones filter a page.
Exercise model failure and title races against manual edits, deletion, new
connection/root/material, with persisted provenance and consistent history views.
The history hook exposes current-root `ReadonlySet<string>` deleted IDs;
`remove(id)` can return true only for `deleted:true`, never cancellation.

### 7. Wrong vs Correct

Wrong: recursively delete a renderer-supplied path, append replacement text,
claim success after one failed cleanup, or generate titles while listing history.
Correct: confirm an exact native-owned scope, fence/drain/tombstone it, verify
every removal, and apply separately requested background summaries through CAS.
