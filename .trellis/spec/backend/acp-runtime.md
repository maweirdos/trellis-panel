# ACP runtime and workspace contract

## 1. Scope / Trigger

Read before changing `services/acp.ts`, `services/acp/`, ACP IPC/preload/types,
the Agent workspace, dependency preparation, or Electron packaging. The managed
pair is Codex adapter 2.9.0 and Claude adapter 0.109.1; Claude receives
`CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1` unless an explicit environment override is
configured. Every execution still requires a successful v2 initialize
handshake. OpenCode 2.3.2 is unavailable as an ACP provider because its ACP
server negotiates v1; its HTTP v2 API is a separate provider surface. Legacy
custom engine definitions and snapshots are retained for identification and
reading only.
ZCode installation and native startup also follow `zcode-managed-startup.md`.

The live path uses the vendored T3 `effect-acp` core under
`src/main/services/acp/t3-core/` behind the `src/main/services/acp/v2/` adapter
and persistence boundary. A different negotiated major version yields
`E_INCOMPATIBLE`. A malformed initialize response yields `E_PROTOCOL`. Only a
valid v2 response admits session methods. Runtime requests, responses and
notifications use the T3 v2 RPC groups and schema.
`auth/login` requires the requested ID in the initialize response's
`authMethods`. `auth/logout` requires a nonempty method list. The
`capabilities.auth` tree describes authentication extensions.
T3 owns ACP framing, request correlation and schema validation for both the
connection probe and session execution. Trellis owns root authorization, Agent
profiles, task materials, permission mediation, process ownership and canonical
shutdown. Read legacy archives directly from disk.

Per-request deadlines are applied at the `AcpV2Client.operation` boundary, not
inside the vendored RPC core, following T3 `AcpSessionRuntime`. Defaults
(`ACP_V2_DEFAULT_TIMEOUTS`) are `initialize` 30s, session new/resume/list/
delete/fork/close 90s, config/providers/auth/mcp control calls 30s, and
`session/cancel` 15s; `AcpV2RuntimeOptions.timeouts` overrides any of them.
`session/prompt` has no request deadline because it waits for idle completion;
the turn-level guard below bounds it instead. A request timeout rejects with
`AcpProtocolError` type `E_TIMEOUT` carrying `details.method`.

The adapter accepts at most 64 outstanding RPC requests and rejects incoming
NDJSON frames above 1 MiB before T3 decodes them. Startup retains at most 256
session notifications or 1 MiB before the native session ID is known. Resume
accepts updates only for the original native session ID.

T3's `AcpSessionRuntime` startup transitions share one deferred for the exact
session key, cwd, native session ID, and native record ID. The owner publishes
the handle after initializing, adopting the session, applying buffered updates
for that session, and saving its native record. Failed setup closes the
captured owner before rejecting.

`session/prompt` keeps insertion and completion separate. The vendored core
exposes an insertion callback (`AcpPromptOptions.onInsertion`) that fires once
the agent acknowledges the write; the returned Effect still settles only on
idle or failure. `AcpV2Turn.promptStarted` resolves at insertion, so the app
facade emits the user message, marks the prompt written and returns
`promptAcpSession` while the turn is still running. A terminal update arriving
before the prompt response is held for that turn until insertion is confirmed
or fails. A missing prompt response keeps the deadline armed. T3's deferred
completes on the first fresh session-scoped idle for that turn. A fresh revision
can complete a new turn with the same stop reason and no intervening running
update. Replay, known revisions and subsequent idle notifications cannot settle
the current turn again. After prompt dispatch, an absent or malformed insertion
response and an ambiguous failure return `E_UNKNOWN`. A schema-valid correlated
rejection for invalid request, unknown method, invalid params, authentication
required or resource not found can restore the draft. Keep the prompt unreplayed.

Streamed assistant chunks append under their native message ID and
`payload.meta.acpText`. A full message replaces the matching block. The
`replayConversationTextEvents` reducer applies that contract for transcript,
history and previews. Provider user-message echoes enter the native aggregate.
An active turn's first new live user echo carries the original turn identity
into the snapshot so it can reconcile with the insertion receipt. Replay and
out-of-turn messages retain their native IDs. Coalesce native snapshot writes
within 100 ms and serialize the terminal and cleanup snapshots behind pending
writes. Redact authorized knowledge descriptors before snapshot persistence.

Only matching in-flight session requests share setup. When initialize, create,
or resume fails, close the original owner through the same teardown as explicit
stop. Persist a closed record only after process exit or owned Job cleanup has
been verified. Keep cleanup failures recoverable against the original owner.

The turn guard (`startTurn.timeoutMs`, default 30 minutes) is bounded. At the
deadline the owner notifies `session/cancel`; if the turn has not settled
within a further 10s grace (`TURN_CANCEL_GRACE_MS`, matching the facade's
user-cancel budget) the turn is terminated: it settles as a typed `E_TIMEOUT`
failure, the native record is marked `uncertain`, and the owner is
disconnected through the canonical `shutdown('uncertain')` path. A provider
that ignored the cancel never becomes a clean `cancelled` success, and a later
idle cannot resurrect the terminated turn. User-initiated cancel keeps the
existing `acp.ts` `CANCEL_TIMEOUT_MS` path unchanged.

A timed-out startup or session setup runs the existing canonical cleanup: the
child and Windows Job are released through the process owner, no native record
is written as `live`, and `uncertain` is recorded only when the process
outcome is genuinely unknown.

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

Runtime connection checks resolve the selected current launch argv and
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

After displaying discovery, visible Engine Settings verifies installed, enabled
managed/native/bundled engines whose connection status is `not_checked`, one at
a time through the existing initialize-only check. SDK, disabled, missing and
legacy custom engines are excluded. Only the current engine shows connection
activity; the list remains visible. Suspend new checks while hidden, inactive or
configuring/running an explicit action. Existing checks keep their bounded native
cleanup; late replies cannot overwrite a replaced scope or external list update.
Failed checks keep their diagnostic state and the explicit retry action. A
successful check displays `可用`; it does not establish model/account access.

Runtime activity uses a neutral status dot and label with a two-pixel dotted
line anchored to the item text. A quiet baseline and end markers show the track
bounds. Fixed dots reveal left to right in a 3.6-second activity cycle while
progress is unknown; intermediate percentages are not inferred from time. An
acknowledged successful operation or automatic handshake fills the track and
shows 100% for two seconds, independently of reduced-motion preferences. Failure,
cancellation, unknown outcomes and late/foreign replies never establish 100%.
Completion feedback is bound to the exact agent/configuration/status source;
retries clear prior feedback. It does not delay subsequent work. Hidden/inactive
scopes and reduced motion keep static status and stop decorative loops.

Engine Settings uses two columns from a measured 680px panel width and one
column below it. Only one details region opens, after its complete card row;
DOM/focus order follows that grouping. Closing details or completing an action
whose focused button disappears returns focus to the original engine control.
The shared Runtime status projection drives both the
Settings and picker icons: verified/SDK readiness uses a green connection icon,
installed-but-unverified stays neutral, missing/disabled uses disconnection and
actual connection errors use an alert. Background discovery retains known
labels and does not animate every engine as working.

The diagram shows a width-dependent group of four, six or eight engines from
the complete catalog, with unique row positions and no horizontal expansion.
Pagination changes only the inspected engine; it never selects an execution
default or starts a session. Selecting any list item locates its diagram group,
including after resize. Emphasize the inspected/working links. Catalog sizes
of 0, 1, 6, 12 and 30 must remain usable; presentation does not enable unsupported
runtime definitions or add adapters. If resizing removes a focused diagram node,
return keyboard focus to the still-visible inspected node in the current scope.

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
executable/entry file identity. Matching results expire after five minutes;
changed launch configuration/files or process restart requires new evidence. Return the
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

`AcpPromptOptions.images?: AcpImageAttachment[]` carries `{id,name,mimeType,data}` with raw base64 (no data URL). `shared/acp-images.ts` defines raster MIME types PNG/JPEG/WebP/GIF and per-message bounds: eight images, 10 MiB per image, 20 MiB combined. `services/acp/images.ts` independently validates shape, unique IDs, base64, decoded byte count and file signature before any turn publication. Text may be empty with valid images. The v2 handshake's `capabilities.session.prompt.image` object establishes support and projects to `session.capabilities.promptCapabilities.image`. Missing support rejects attachments with `E_INVALID_ARG` before dispatch.

The runtime adapter sends admitted attachments as ACP v2 image content blocks. After `promptStarted`, attach them to the user message's `payload.images` and retain them in schema2 history. A provider image rejection follows the original turn's failure path.

`acpSessionBindTask(sessionId,input)` is explicit and requires an idle ready owned session/current connection generation and an actual active task/path. It changes future material assembly only; prior events/snapshots/native identity are not rewritten. Busy/stale binding rejects with `E_CONFLICT`.

`acpSessionPrompt(sessionId,text,options?)` retains two-argument callers. Options may carry expectedConnectionGeneration and sourceReferences. Each AcpSourceReference captures projectRoot/taskDir/relativePath/displayedRevision/targetSessionId/targetConnectionGeneration and optional sectionAnchor/quote. Main independently validates trusted root/generation/path/session/binding, and compares the modern raw-byte sha256-prefix16 identity against the same read used for assembly before turn publication. Drift/unavailability returns `E_CONFLICT`, reason `SOURCE_CHANGED`, and sources[] expected/actual/available details with no new turn/event/snapshot consumption.

Material snapshots distinguish sourceRevision/includedRevision/sourceBytes/includedChars/truncation/availability; whole-file identity differs from a truncated included-segment digest. Unknown old metadata stays unknown. Material events use `kind='material-change',source='trellis',payload.materialChange` with actual scoped add/change/unlink facts. Rootless old notices are generic attention, not verified artifact input. Project generation gates delayed notices/imports/reads; unlink reaches the modern reader. These facts prove neither Agent authorship/compliance nor approval/phase completion.

### Dependencies and launch

- Pin the ACP SDK and Effect versions declared in `patches/acp-v2-sdk.json`.
  Install, dev, build, typecheck and dist run `npm run check:acpx`, which
  verifies the installed versions, lockfile, v2 SDK export and Effect loading.
  The existing Vite 8 / electron-vite 5 peer mismatch requires
  `npm ci --legacy-peer-deps`.
- Pin electron-builder26.0.11 for the supported Windows package. Version25.1.8
  can place shared transitive dependencies under an unrelated package, making
  the packaged daemon fail at startup. Verify actual packaged control/host
  startup, build stamp and canonical exit in the actual packaged application; a successful
  archive layout check alone does not prove dependency resolution.
- Package the Effect dependency alongside the CommonJS Electron roles and the
  original T3 MIT notice under `resources/licenses/`.
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
  `execFile` directly: route through `cmd.exe /d /s /c`, and `findExecutable` must prefer
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
  ids, then confirms Windows Job cleanup or POSIX process exit. On POSIX,
  wait again within a bounded grace period after `SIGKILL` and fail the
  probe if exit remains unconfirmed. It must never send
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

- App `sessionId` is the panel identity. `backendSessionId` is the ACP wire
  session ID; optional `agentSessionId` is a different native vendor identity.
  Missing native ID is not missing ACP identity.
- Persist app schema 2 records in `userData/acp-sessions/` and native v2 runtime
  records in `userData/acp/runtime-v2-store/`.
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
  `session/resume` checks the stored v2 record, its session ID, cwd and launch
  identity, and replays history without sending a prompt. Publish ready after
  the resume acknowledgement and metadata refresh.
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
- Model, mode, reasoning, collaboration and boolean controls use the same
  confirmed v2 option set. Normalize `configId`, keep the type discriminator
  and flatten grouped select choices. A full config acknowledgement replaces
  the prior set. Acknowledge through the runtime before displaying effective
  values. Preserve prior values on rejected changes. Public record retention includes only non-secret Agent/auth
  display metadata and mode choices, including store/restart/load.
- A unique explicitly categorized `mode` or `model` config option is the current
  public authority when modern controls coexist with stale legacy fields. Retain
  `category` through projection and hide duplicate generic controls in the UI.
  Do not infer category from arbitrary IDs/names; absent/ambiguous categories use
  legacy values. Rejected updates preserve effective values.
- Retain the confirmed v2 configuration in `runtime-v2-store`.
  On resume, verify the original native session and the latest advertised model
  ID/name mapping before publishing effective controls.
- Treat v2 capability objects as present markers. Pass the already authorized
  knowledge bridge HTTP descriptor to `session/new` and `session/resume` when
  the peer advertises `session.mcp.http`. Keep existing root, generation, turn,
  and authority checks on tool calls.
- Unrecognized provider updates project as passive status/diagnostic
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

Verify identity and generation fences through initialize/new/resume, early updates, failed admissions, permissions and canonical cleanup. Restore must keep the same native session without prompt replay, retain the complete model catalog, reject notice overflow and consume queued desktop events before readiness. Independent configuration fields must survive equal and out-of-order revisions.

Verify resource/image byte bounds, source revisions, unsupported-capability zero-dispatch, cancelled turns and subsequent reuse. Rejected controls preserve effective values; stale root/selection replies cannot publish readiness or permissions. Connection timing spans must remain bounded, current-attempt facts.

For UI changes, verify drafts, IME, focus, scroll, pending approval and explicit recovery across root changes and narrow/light/dark layouts. For native and packaged acceptance, exercise real file reads, controlled writes, allow/deny, cancel/next-turn, same-identity restore and restricted-PATH launch. Keep vendor, native and packaged results distinct from controlled validation; a greeting or compiled fixture is insufficient. Hook equivalence and artifact checks follow `zcode-managed-startup.md`.

## 7. Wrong vs Correct

Wrong: use a permission kind to pick the first same-kind option; expose ready from
an installed command or treat fixture results as provider validation.

Correct: select the unique original option ID, show measured readiness only,
retain the public dependency boundary, and report fixture, vendor, native and
packaged evidence separately with their actual limits.

## 8. Conversation history archive and explicit model recovery

This archive serves dedicated ACP sources by original session ID. Ordinary Work, Code and task history use `conversationList` and the scoped v2 thread reads. The active ACP owner controls the native connection.

### Signatures and contracts

```ts
acpHistorySession(sessionId)
acpHistoryEvents(sessionId, { before?, after?, limit? })
acpHistoryRetry(sessionId)
acpSessionRecoverModel(sessionId, { modelId, expectedConnectionGeneration })
```

`acpHistoryEvents` returns chronological pages of whole conversational turns with immutable `historySeq`, coverage, `startsMidTurn`, soft byte/count targets and persistence state. `limit` targets the number of events and preserves whole turns. Initial/latest, before and after pages preserve each saved user prompt together with all of its saved assistant fragments, tools, permissions and outcome. Summaries contain no event bodies or base64 attachments. Current actionable permissions use `pendingPermissions`, `stateRevision` and the live connection/turn generation. Historical permissions are read-only, including the snapshot fallback.

Summaries carry `hasConversation`, derived from actual scoped message text, tool or permission events; a diagnostic/status event count cannot establish conversational content. They also carry a bounded `conversationPreview` and `conversationPreviewAt` for unloaded sidebar hints. Assemble only the coherent latest real message across exact role/turn/connection/producer-message boundaries, including fragments from prior archive batches. Exclude thoughts, tools, diagnostics and attachment bodies. Preview text does not extend the declared title/role/task metadata search scope.

- Every admitted panel/Trellis event enters `userData/acp/history.sqlite` before the bounded compatibility snapshot is trimmed. Worker acknowledgement advances `committedThroughSeq`; a live view never implies durable history without this acknowledgement.
- Schema2 JSON and legacy sources are imported non-destructively. Original bytes are backed up by SHA-256. Repeated `(source,digest)` imports are idempotent; unsupported/damaged sources remain available for diagnosis and are not overwritten.
- Imported bounded records have `historyCoverage=unknown`; exact verified native prefixes may be `partial` with provenance. A verified prefix import is allowed only before an archive sequence exists for that session; otherwise return a conflict rather than reorder cursors.
- A changed compatibility snapshot may contain events not acknowledged before a crash. Re-import its safe suffix after the archive's known last original event ID, deduplicating by original ID/digest. Retain first-seen bytes on conflicts and report them without blocking safe new tail events. Do not append uncertain earlier events after a canonical suffix: preserve the original source/backup, report the unresolved ordering and mark coverage partial. Import markers, safe rows and metadata commit together; repeating the same source digest remains idempotent.
- Persisted event canonicalization is a storage contract. New hashes use ordinal key ordering, not locale-sensitive sorting. Early version1 rows may use recursive `localeCompare` ordering: accept that known digest only when the stored payload verifies against it and canonical stored/incoming content is identical. Apply this comparison to append and snapshot import. Preserve original payload, digest and sequence; never treat an unexplained digest mismatch or changed body as an upgrade artifact. Test an actual old-format row across reopen/import, not only a freshly created archive.
- Archive pages target 200 events/2 MiB, stopping only between turns. If one turn exceeds either target, return that entire saved turn and mark the page `oversized`; never split its streamed answer, Markdown, attachments or tools. Native identity includes connection generation and turn ID; retain turn-scoped preparation before the user event. Legacy records without turn IDs use actual user/outcome boundaries, without inventing a user prompt or successful completion. The SQLite worker and degraded snapshot reader follow the same boundary rules. Derive boundaries from lightweight metadata before reading selected payloads; do not hydrate the full archive just to select a page. Full history has no 800-event retention cap. During sustained worker failure, explicit write-queue bounds change coverage to partial/degraded and never report saved.
- `startsMidTurn` describes an already incomplete saved prefix, not ordinary pagination. A page beginning with legitimate preparation/connection facts must not be classified incomplete solely because its first event is not a user message. A running turn returns all currently saved content with its actual running state; paging cannot manufacture an ending. Immutable sequence cursors remain scoped and monotonic; concurrent tail appends and old cursors must not lose or duplicate events when pages merge. A cursor at a valid turn edge remains usable; an old interior cursor or a tail edge invalidated by growth returns a typed conflict/reset instead of silently returning half a turn.
- `acpSessionRecoverModel` accepts only an exact last-known candidate ID and current connection generation. It verifies the original session identity and uses the v2 configuration option with a provider acknowledgement. Recovery never dispatches a prompt. `modelConfirmed` may be true while connection remains failed.
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

Verify a dedicated archive beyond the in-memory event cap by paging its original session, preserving exact event bytes and whole-turn boundaries. Exercise migration, damaged archives, prefix recovery, failed worker writes and expired historical permissions. Recovery must retain the exact native ID with no new session or replayed prompt, distinguish confirmed model selection from connection failure, and respect root/generation/stop/lease/capacity fences. Native/vendor acceptance remains separate.

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
```

### 3. Contracts

- Project/session preferences persist independently of runtime-generated session
  metadata. Effective titles expose `customTitle`; pin/archive expose optional
  `pinnedAt`/`archivedAt`. Later status, append, import and reconnect metadata
  cannot overwrite human choices. Direct session, event-page summary and
  degraded snapshot reads apply the same preferences.
- Capture the current root and project generation at IPC entry. Validate the
  exact owned session and recheck the captured owner before mutation. Acknowledge
  only a durable save; update no native lifecycle, prompt or permission state.
- Preference changes keep original event-sequence cursors intact.

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

Good: rename a disconnected dedicated session and read its new title by the same
session ID after restart. Base: archive the session and read back `archivedAt`.
Bad: store a temporary row label that the next runtime event replaces.

### 6. Tests Required

Verify rename, pin and archive with real persistence and exact-session readback.
Exercise archive and snapshot reads, root isolation, stale project callbacks,
invalid input and save failures. Check that preference writes preserve transcript
bytes and native dispatch.

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


## Text-only discussion alongside history pages

`AcpHistoryEventPage.discussion?: { events: TimelineEvent[]; truncated: boolean }`
is independent of the visible timeline. Initial/latest pages hydrate this in the
archive worker; directional paging retains its original cursor contract. Never
merge discussion events into `WorkspaceEntry.events` or execute them.

`readHistoryDiscussion(db, root, sessionId)` selects the first four and last twelve
user turns. Replay authoritative Pi blocks; join legacy assistant chunks only for
the same source/root/session/generation/turn and message identity. Include user
text and assistant proposals, no thoughts, tool bodies or image bytes. Bound text
to 60000 characters, 8000 per message, balanced per-turn budgets and sixteen
messages per selected turn. Mark selection/size/read omissions `truncated`.
Validate context ownership before display or requirement seeding. Keep original
archive bytes, sequence, turn boundaries, coverage and request receipts unchanged.

## Conversation control-plane projections

### 1. Scope / Trigger

Read this section when changing `src/shared/acp-projections.ts`,
`src/main/services/acp/control-plane-*`, the daemon `runtime.conversation*`
routes, the preload ACP projection APIs, or the renderer conversation projection
cache. The projection store is a read model parallel to the authoritative
archive; it must never become a second native session authority.

### 2. Signatures

```ts
acpConversationListSnapshot(input?: AcpConversationListInput)
  -> AcpConversationListSnapshot | IpcFail
acpConversationDetailSnapshot(sessionId: string)
  -> AcpConversationDetailSnapshot | IpcFail
acpConversationEvents(sessionId: string, input?: AcpConversationEventsInput)
  -> AcpConversationEventPage | IpcFail
acpHistoryEvents(sessionId: string, { tail: resumeCursor })
  -> AcpHistoryEventPage | IpcFail
```

The additive control-plane database is `userData/acp/control-plane.sqlite`. Its
first schema contains normalized conversation, turn, turn-item, runtime-session,
runtime-thread, provider-instance, monotonic event, and migration rows. Legacy
`history.sqlite` is opened read-only as the archive source.

The renderer cache is root-scoped and bounded. Selection renders its last known
detail immediately and merges newer item revisions by stable ID. It validates
the conversation, root, and source session ID, replaces the read scope with each
root change, coalesces duplicate reads, and requests a fresh snapshot on a
typed cursor reset.

### 3. Contracts

- Projection list/detail reads derive the trusted canonical root only in the
  main/daemon workspace context. Renderer input contains filters, limits,
  cursors, and session IDs only.
- List projection reads materialize archive metadata and can ingest native
  updates for an already indexed conversation. Detail and event reads ingest
  up to 256 archive and native rows or 2 MiB combined per pass. One oversized
  first archive row may be read to advance the archive cursor.
  The `(sourceEpoch, sourceSequence)` checkpoint advances
  by raw archive sequence, including text fragments that update an existing
  item. It advances in the same transaction as the items and delta events.
- ACP v2 text and tool updates share items with the native snapshot by native
  session and entity ID. The insertion receipt and live user echo reconcile by
  turn ID. Older uncoupled user echoes can match exact receipt text by occurrence.
  Keep the first event anchor and position. Archive streaming appends use only
  the archived prefix. Each delta retains its own item revision, so a later
  update cannot erase an earlier cursor page.
- `acpConversationEvents` returns the next scanned cursor and `hasMore`.
  Its final changed page can carry conversation metadata and coverage. Cached
  reads apply deltas directly; a non-advancing or invalid page stops the drain.
- An initial rich archive page returns `resumeCursor`. The mutually exclusive
  `tail` input reads later raw events through the session's SQLite sequence
  index, including additions to an unfinished turn. `resumeCursor` advances
  even when a page has no `afterCursor`. `before` and `after` retain whole-turn
  paging. A tail cursor for another archive epoch, root or session returns a
  conflict and requires a fresh snapshot.
- Conversation, runtime, provider, turn-item, and projection-event writes commit
  in one SQLite transaction. The global monotonic sequence is allocated only
  inside that transaction.
- Detail and event pages have a 2 MiB body budget. Text uses T3's
  `truncateDetail` UTF-8 bound. Coverage reflects both the projection
  checkpoint and the source archive's state.
- `archive='all'` means all archived states inside the same canonical root. It
  never removes the root predicate through SQL operator precedence.
- Projection reads never spawn, resume, authenticate, probe, install, or prompt
  a provider. They do not alter `acpHistory*` data or behavior.
- Existing history tombstones are checked on migration and every read. A
  tombstoned conversation is absent, not empty.
- The journal worker and its dependencies are Node-only. Main supplies the
  trusted app-data directory explicitly for provider-record reads. Exercise
  `init` on the production worker bundle and require a real SQLite archive.
- v2 records are attributed to their persisted trusted project root. Older v2
  records use their canonical cwd. Archive metadata and user receipts take
  precedence. A matching native snapshot contributes replay and out-of-turn
  content after the archive checkpoint catches up. Each native snapshot has a
  separate bounded ingestion checkpoint. A live or uncertain record on disk is
  an unverified runtime state.
- Cursor failures are typed conflicts: cursor-ahead, conversation-reset, or
  store-reset. A generic I/O failure must not replace a reset response.
- Missing legacy provider metadata degrades to explicit identifiers such as
  `unknown`; it must not fail SQLite non-null binding or invent a provider.
- The rich archive is authoritative for transcript presentation when available.
  Projection summaries provide an initial visible transcript before rich history
  arrives. The live stream remains independently fenced by generation and turn.

### Conversation optimistic sends

- Send commits the renderer-owned pending user row, clears the active draft and
  submitted references/images/knowledge, and starts truthful submission feedback
  before its first asynchronous operation.
- The pending row is renderer state only. It is never written to history,
  SQLite, or the projection store, and never establishes transport delivery.
- Definite admission failure removes that row. Restore the exact submitted
  payload only when the current draft is still empty; preserve and prioritize any
  newer draft and expose the failed payload through a bounded recovery action.
- Aborted sends with an ambiguous runtime outcome remain marked unknown; the UI
  must not restore them as definitively unsent or replay them automatically.
- Only the authoritative `promptStarted` user event replaces the pending row.
  The optional UUID `AcpPromptOptions.promptRequestId` is echoed on that user
  event. The renderer binds its pending row to the verified connection before
  dispatch and reconciles by request, turn when available, and connection
  generation. A transport failure after dispatch preserves unknown delivery.

### 4. Validation / Error Matrix

| Condition | Required result |
| --- | --- |
| Foreign or missing canonical root | No projected conversation row is returned |
| Deleted/tombstoned source session | Read returns not-found or conversation-reset |
| Client cursor exceeds store sequence | Typed cursor-ahead reset |
| Conversation removed or store epoch changed | Typed conversation/store reset |
| Same source migrated again | No duplicate conversation/turn/item rows |
| Later fragment or final replacement for a rendered message | One updated item with its original anchor and order |
| Cached rich transcript switches away and back | Read only events newer than `resumeCursor` |
| Page exceeds projection byte budget | Partial migration and truthful coverage |
| Legacy archive damaged/unavailable | Projection unavailable; legacy archive remains unchanged |
| Metadata lacks agent id/name | Degrades provider identity without binding error |

### 5. Good / Base / Bad Cases

Good: a stopped runtime conversation remains listed and its detail snapshot
returns items from the projection without touching a provider process.
Base: a bounded migration leaves partial coverage and continues from the
committed raw archive sequence. Bad: resuming a provider to satisfy a projection read,
rewriting authoritative legacy events, or treating a foreign-root row as local.

### 6. Tests Required

Exercise real SQLite files under OS TEMP: idempotent repeated migration,
partial then resumed migration, streaming message replacement across pages, root
isolation for all archive filters, tombstone suppression, snapshot cursor
ordering, rich history tail, and all typed reset paths. Run `npm run check:acpx`, `npm run typecheck`,
`npm run build`, and `npm run check:ui` for affected layers.

### 7. Wrong vs Correct

Wrong: making the normalized projection the native transcript authority, using
renderer-supplied roots, or collapsing cursor resets into `E_IO`.
Correct: preserve the authoritative archive, migrate read-only/idempotently,
return bounded snapshots plus a monotonic cursor, and require a fresh snapshot
on any unresumable cursor state.

## Runtime session manager

### 1. Scope / Trigger

Read this section when changing `src/main/services/acp/runtime-session-manager.ts`,
connection reservation, idle release, runtime telemetry, or the runtime marker
projection in `control-plane-store.ts`.

### 2. Signatures

`RuntimeSessionManager` owns provider-family capability lookup, family usage,
connection reservations, verified-idle candidates, recent-use pinning, and an
atomic release claim. Existing `killOwned` / `closeOwned` / ACP shutdown /
Windows Job cleanup remain the only process-termination authorities.

Current family declarations are explicit for Codex, Claude, OpenCode, DSH,
ZCode, Pi, and unknown/legacy records. All currently supported launch paths use
independent process owners (`sharedProcess:false`,
`runtimeThreadCapacity:1`). Shared-process or multi-thread capacity may only be
enabled by an explicit future capability declaration; it must never be inferred
from a provider name or protocol version.

### 3. Contracts

- Capacity is counted per provider family. Asynchronous startup reserves a
  placeholder before the real native session id exists and atomically replaces
  it once known.
- Capacity release selects a verified-idle owner and atomically claims it before
  awaiting canonical stop. Concurrent reservations must not stop several idle
  owners when one release is sufficient. A stale claim is released and selection
  retried; stop failure retains ownership and reports cleanup uncertainty.
- Capacity-triggered and timed release share T3's keyed lock per provider
  family. Recheck current owner identity, activity and protected work while
  holding the lock. Timed release yields to a capacity claim in the same family.
- Verified-idle release starts after 30 idle minutes. A ten-minute recent-use
  pin prevents rapid switching from thrashing owners. Protected work never
  depends on this timer.
- Active/admitting turns, live permissions, unfinished tools/background work,
  managed/platform task owners, directory leases, uncertain cleanup,
  nonrecoverable records, transient states, and ZCode owners without confirmed
  native persistence are not capacity-release candidates.
- Capacity failures carry the bounded family, typed capacity reason, and family
  usage; generic "capacity reached" text is insufficient.
- Runtime telemetry covers startup, resume, capacity release, idle release,
  provider/auth/protocol/process-exit failures, and cleanup pending/succeeded/
  failed. Duration is bounded to `[0, 86400000]` ms; family labels are a fixed
  bounded union. Never emit credentials, tokens, or raw provider frames.
- Projection list/detail/events never enter startup, resume, authentication,
  model probing, or capacity-release paths.

### 4. Validation / Error Matrix

| Condition | Required result |
| --- | --- |
| One family full while another has capacity | Reject only the full family with typed reason |
| Concurrent capacity reservations | At most the required idle owner is claimed/stopped |
| Claimed owner disappears or is replaced | Release stale claim and reselect without recursive stop |
| Canonical stop fails | Retain owner, emit cleanup uncertain, do not retry blindly |
| Timer observes protected owner | Do not release; report its typed blocking classification |
| Recent verified-idle owner | Honor recent-use pin before idle release |
| Runtime telemetry payload is not an object | Ignore rather than project malformed telemetry |
| Projection read | Zero runtime side effects and zero disconnects |

### 5. Good / Base / Bad Cases

Good: eight archived conversations switch repeatedly from projections while all
runtimes remain untouched. Base: a verified-idle owner is released after its pin
and idle windows with a recorded reason and recoverable conversation projection.
Bad: evicting an owner with an unfinished tool, stopping multiple owners for one
capacity slot, or labeling every provider error as a protocol error.

### 6. Tests Required

Use OS TEMP and the real service/daemon path. Exercise the provider-family
capability matrix, atomic concurrent claims, stale-owner retry, every protected
classification, telemetry bounds, projection zero-side-effect switching across
at least eight conversations, and real duplicate resume/end behavior with a
supported authenticated provider other than OpenCode. Run `npm run check:acpx`,
`npm run typecheck`, `npm run build`, and `npm run check:ui`.

### 7. Wrong vs Correct

Wrong: a global owner count, inferred shared-process capacity, a non-atomic idle
candidate selected by multiple callers, or telemetry that exposes provider text.
Correct: explicit family capability, atomic release claims, protected-work
classification, bounded typed telemetry, and canonical cleanup through the
existing process owner.

## Provider ecosystem

### 1. Scope / Trigger

Read this section when changing `src/shared/acp-provider-ecosystem.ts`,
`src/main/services/acp/provider-registry.ts`,
`src/main/services/acp/local-providers.ts`, provider ecosystem IPC/preload,
or the Engine Settings provider catalog.

### 2. Signatures

```ts
acpProviderCatalog(input?: { query?: string; refresh?: boolean })
  -> AcpProviderCatalogSnapshot | IpcFail
acpLocalProviderList()
  -> AcpLocalProviderSnapshot[] | IpcFail
acpLocalProviderSave(input)
  -> AcpLocalProviderSnapshot | IpcFail
acpLocalProviderDelete(id)
  -> { ok: true, id } | IpcFail
```

Registry metadata and local provider definitions are additive identities. They
never replace built-in `AcpAgentConfig` IDs or infer runtime capabilities from
provider names.

### 3. Contracts

- The registry endpoint is the official HTTPS ACP Registry index. Discovery may
  fetch only that endpoint, with a fixed timeout, a streamed body limit, strict
  full-index validation, and an atomic app-data cache.
- A corrupt cache is ignored. A failed refresh may return the last complete
  cache only with an explicit stale/offline state; it never disables installed
  built-in engines.
- Catalog list/search/refresh does not spawn, install, authenticate, prompt, or
  alter runtime settings.
- A local provider stores a stable instance ID, display name, bounded agent ID,
  canonical absolute executable path, literal bounded argv, bounded environment
  snapshot, enablement, and file provenance. Renderer input supplies fields, not
  a trusted project root or shell command.
- Local executables must be regular local-disk executable files. Reject relative
  paths, UNC/remote paths, directories, symlinks/junctions, and Windows formats
  that cannot be launched through the existing batch wrapper.
- Local provider persistence is app-data scoped and atomically written. Startup,
  resume, restore, selection, family resolution, and historical matching compare
  executable identity plus recorded size/mtime/digest and reject drift.
- Capability evidence remains one of registry-declared, negotiated initialize
  evidence, or unknown. Registry declarations never become runtime capabilities.
- Every ACP provider must negotiate protocol version 2 through the strict
  initialize probe before execution; registry metadata alone never provides that
  evidence.

### 4. Validation / Error Matrix

| Condition | Required result |
| --- | --- |
| Non-HTTPS, oversized, malformed, or partial registry body | Typed catalog failure; no cache overwrite |
| Refresh fails after a valid prior cache | Return cached rows marked stale; built-ins remain available |
| Corrupt local provider store | Visible storage failure; built-in runtime list remains readable |
| Relative/UNC/link/junction/directory executable | Reject save and admission |
| Local provider ID collides with built-in or another agent identity | Reject without overwriting either identity |
| Recorded executable size/mtime/digest changes | Reject launch/resume/restore; require explicit re-save |
| Registry-declared capability lacks initialize evidence | Display unknown/unverified, not enabled capability |

### 5. Good / Base / Bad Cases

Good: a local absolute executable with literal args starts after provenance
revalidation and reports only initialize-confirmed capabilities. Base: registry
refresh fails offline, so the stale catalog remains visible while installed
runtimes stay usable. Bad: accepting a shell command string, launching through a
replaced symlink, or presenting registry metadata as negotiated capability.

### 6. Tests Required

Use OS TEMP fixtures. Exercise malformed/oversized registry responses, cache
schema/corruption/offline fallback, local executable rejection matrix, provenance
drift, ID collisions, environment/argv bounds, capability unknown state, and the
initialize-only probe cleanup path. Run `npm run check:acpx`,
`npm run typecheck`, `npm run build`, and `npm run check:ui`.

### 7. Wrong vs Correct

Wrong: introducing arbitrary custom commands again, allowing a provider catalog
read to install or launch an agent, or labeling `acpx` upgrade as ACP v2.
Correct: validate bounded metadata separately, persist an explicit local
provider identity with immutable-enough provenance, and admit it only through
the existing launch/security boundary.

## Daemon runtime service boundaries

### 1. Scope / Trigger

Read this section when changing `src/main/daemon/runtime/` or code imported by
the daemon runtime.

### 2. Signatures

```ts
AdmissionService
  .classify(method, payload): RuntimeAdmissionClass
  .assertIntakeAdmitted(method, payload): void
  .assertWorkspaceAdmitted(method, root): void
  .assertCommand(method, commandId, payload): void

ConversationReadService.handles(method): boolean
ConversationReadService.execute(method, raw, root): Promise<unknown>

RuntimeSessionService.handles(method): boolean
RuntimeSessionService.execute(method, raw, root, context): Promise<unknown>

LifecycleService.status(): Promise<RuntimeStatus>
LifecycleService.shutdown(): Promise<void>
LifecycleService.release(): Promise<void>
```

### 3. Contracts

- The daemon remains one physical authority. A service split must not add a
  daemon process, socket, ACP transport, prompt queue, or process killer.
- `runtime/index.ts` is composition only: wire/blob parsing, command receipt
  execution, and explicit special native routing belong there; domain behavior
  belongs to its services.
- `ConversationReadService` owns projection, legacy history, Pi image, and
  session inventory reads. These calls must not start, resume, authenticate,
  probe, cancel, disconnect, or kill a provider.
- `RuntimeSessionService` owns ordinary ACP session/profile/history mutations,
  prompt, permission, handoff, signals, and workflow application calls. It must
  run the admission prologue before a domain switch.
- `AdmissionService` owns method classification, retained command-ID policy,
  intake/workspace admission, lifecycle-control exemption, and global/profile
  scope policy. It never executes provider operations.
- `LifecycleService` owns status, blockers, activity, idle assertions, workspace
  ownership, shutdown, and release. Shutdown closes ACP/workflow admission and
  stops knowledge reads synchronously before its first await.
- Runtime and read services must not import integration adapter internals.
  Integration adapters remain explicitly composed by the daemon application.
- Runtime catalog constants and local-provider persistence must stay in
  dependency-free modules. `local-providers`, `provider-registry`, and
  `runtime-definitions` must not reintroduce an import cycle.
- A local provider is supported only when its saved snapshot revalidates the
  admitted provider record. Historical local argv must match exactly.
- Optional renderer inputs entering typed daemon schemas must be normalized by
  the daemon-client facade; `undefined` must not cross the wire where the
  schema requires an object.

### 4. Validation / Error Matrix

| Condition | Required result |
| --- | --- |
| New or removed runtime method | Update the method contract and route comparison; no silent fallback |
| Conversation read calls a runtime-control facade | Reject as a service-boundary violation |
| Mutation lacks a stable UUID | `E_INVALID_ARG`; no provider operation admitted |
| Shutdown encounters rejected cleanup | Preserve unknown ownership as `E_UNKNOWN` |
| Local provider snapshot or provenance drifts | Reject launch/resume/restore |
| Optional projection-list input is omitted | Send `{}` so the daemon schema defaults apply |

### 5. Good / Base / Bad Cases

Good: projection list/detail/events return bounded snapshots without a runtime
owner. Base: shutdown closes admission synchronously, tries every owned cleanup
domain, and retains uncertain ownership. Bad: moving a provider call into
`ConversationReadService` to reuse a transport queue.

### 6. Tests Required

Use OS TEMP fixtures. Compare old/new body-method routes; exercise read
zero-side-effect, admission classification, mutation command identity, closed
admission, cursor reset, lifecycle close-before-await, and uncertain cleanup.
Run a static import-cycle check. For release, run an isolated real GUI profile
through authenticated `daemon.status` and projection list/detail/events through
the production preload API, then stop only the isolated processes. Production
gates are `npm run check:acpx`, `npm run typecheck`, `npm run build`, and
`npm run check:ui`.

### 7. Wrong vs Correct

Wrong: treating a module split as a second owner or letting a read service
resume a session for convenience. Correct: keep authority, ownership, cleanup,
and transport semantics unchanged while making each service port explicit.
