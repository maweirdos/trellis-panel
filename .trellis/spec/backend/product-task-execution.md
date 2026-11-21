# Product Task Execution

## Scope and owners

Read before changing `runtime.taskExecution`, `NativeTaskExecutions`, platform
ACP/Pi session adapters or product task submission and cleanup. The existing
Daemon owns the native controller and workcopy registry. The team service owns
the effective writer, fixed input authorization and confirmed output versions.

This facade executes the current admitted Agent node/attempt. It does not
schedule the whole portable definition, execute tool/gate nodes or approve a
business transition. The result declares `boundary:node-attempt` and the fixed
server execution/generation/node/attempt/input scope. Full-definition completion
cannot be inferred from one native turn or node checkpoint.

Consume [native preparation](./native-task-preparation.md),
[fixed inputs](./team-execution-inputs.md),
[execution authority](./team-task-executions-v2.md) and
[artifact/checkpoint contracts](./team-execution-artifacts.md).
Keep legacy v1 progress, Trellis task bindings and retained cleanup separate.

## Desktop task entry

`ProductTaskEntryService` joins the existing team command journals, immutable
input capture, native preparation and execution owners. Its `productTask:*` IPC
is restricted to the trusted main-window main frame. Read/prepare take only
`workspaceKey`/`taskId` and explicit engine/profile choices; start takes a local
entry handle, instruction and declared output choices. Original controls take
that handle and, for permission, the exact request/option. Main resolves the
connection, task incarnation, resource, directory and native identities.

Closed-task entry reads use the currently authorized task snapshot and V2
execution history, independently of active V1 progress admission. Confirm the
task incarnation, reader account/connection and source ownership around the
history read. A retained native entry with confirmed cleanup is historical and
`readOnly`; do not call preparation or active progress merely to display it.
Business closure alone does not prove native cleanup: retain original
observation/Stop until the native owner confirms termination. Never infer a
successful run from the business stage. Tasks without V2 history keep their
legacy entry. Start/retry/write admission retains its existing current-state
checks.

At the first `productTask.start({entryId, instruction, outputs})`, main composes
the mandatory requirement from `row.source.context.snapshot.snapshot.tasks`.
Fix the full `instanceId`/`projectId`/`spaceId`/`taskId`/`taskCreatedAt` identity,
task `updatedAt`, exact title and complete description, and acceptance criteria
with exact duplicate criteria removed. Missing optional description/criteria
become `''`/`[]`. Recheck the existing source, owner and fixed facts before
dispatch; changed task content or incarnation rejects Start. Serialize the
requirement as a labelled JSON data block, separate from platform instructions
and permissions. A Bug whose adopted policy requires no formal document still
receives its full description and criteria without creating a PRD or approval.

The renderer's `instruction` is an optional supplement and may be empty; it is
not the mandatory requirement source. Main combines the fixed requirement,
mandatory rework feedback/provenance when present, and the supplement through
`taskInstruction`. Use the existing native `instruction` and Runtime bulk
transport. The combined instruction must fit `nativeTaskStartSchema`'s 32,000
UTF-16 code-unit limit and its serialized JSON UTF-8 bytes must fit
`RUNTIME_BULK.valueBytes` (128 MiB). These limits are independent of the
8192-byte fixed control envelope and 32768-byte rendered platform-reference
budget. Preserve adopted documents, rules, native model/effort and output
selections through their existing channels.

Validate mandatory content before a new claim and the final combined content
before saving or dispatching Start. Overflow rejects visibly, preserves the
original content and never truncates it. Main derives `instructionRemaining`
from the same mandatory composition and supplement framing; the renderer uses
it as the supplement field's `maxLength`, and main still validates Start.

Only a first Start with no retained `row.start` fixes the new body and
`instructionPolicy: 'task-snapshot/v1'` before native effects. A saved Start,
including one without this optional policy, keeps its original instruction,
dispatch UUID, command bytes, hashes and receipts on retry, reopen and
reconciliation. Never add current requirements to an old running or unknown
prompt. Original Stop and receipt recovery retain their existing paths.

For new engineering entries, the existing directory confirmation explains local
workflow-package installation. Fix `workflowPackagePolicy: 'fixed-context/v1'`
in the private entry before claim/capture, and derive later preparation only from
that retained policy. Older entries without the field retain their original
intent, including entries still awaiting claim/capture receipts. Do not add the
policy during retry or infer consent from an absent preparation object.
A successor may reuse the same directory's retained package policy. If its
predecessor has no policy, first reuse the existing confirmation dialog for that
exact directory before fixing a new policy; cancellation creates no new entry or
claim. Do not silently migrate the predecessor or require another directory pick.

Preparation requires the current handler, ready adopted bundle, a published
portable definition, assigned enabled Agent and selected available code resource.
New implementation claims additionally require the business stage `developing`.
For `dev_ready` or `planning`, return a `phase` blocker directing the handler to
begin development or confirm the plan respectively, with zero claim effects.
The renderer must not attach an input-adoption action to a phase blocker.
Original duplicate requests, Stop and reconciliation continue to address their
retained operation; a phase change never authorizes a replacement claim.
The entry currently supports a single explicitly assigned logical role whose
first node is an Agent and whose current outputs use the native artifact adapter.
Unsupported role bindings, prior nodes and formal document output adapters are
actionable blockers; do not synthesize workflows or Agents. Capture includes
Agent instructions, all bound Skills, adopted rules/template and required/full
adopted confirmed documents. Approval, publication, adoption and task transitions
remain explicit operations of their original owners.

`runtime.taskExecutionPlan` reads the actual native launch configuration without
creating a session or sending a prompt. It requires the GUI capability and a
workspace grant. Product Start carries optional `expectedConfigurationDigest`
and rejects a changed actual plan before native session reservation. Omission
preserves legacy request serialization. Negotiated context capability and model
admission remain enforced by the native execution boundary.

For a platform Codex launch with a combined model/effort selection, retain the
complete logical selection in the launch snapshot and configuration digest.
Bootstrap with the advertised base model, then explicitly set and read back
model and reasoning effort through the existing native configuration interface.
Require the same session/generation and current platform owner before readiness
and again before prompt dispatch. Missing choices, false acknowledgements or
configuration drift reject the prompt. Do not infer effort from defaults or
rewrite a base-only native model observation as a complete logical selection.
Implementation retains its existing mode and permission policy; planning's
read-only/plan controls do not apply to it.
Determine whether the composite-selection gate applies from the retained
platform launch and original owner. Missing current session model or platform
metadata must not turn a required gate into an ordinary/base-only path.
Verify this path with an advertised target whose initial effort differs from
the requested effort: availability admits configuration, each ACK confirms its
own field, and the final readback confirms both. Reject drift before recording
entry into native prompt send; configuration checks alone must not create an
unknown-send outcome.
Mandatory model checks consume the current status/configuration response.
Missing configuration in that response rejects admission even when the display
cache still contains a previously verified selection. A retained launch is the
requested selection, not proof of the native session's present configuration.

Profile-local `product-task-entries` rows retain original claim/capture selections,
UUIDs and the preparation/dispatch join before effects. They grant no authority.
Unknown claim/capture/preparation/dispatch outcomes reconcile original owners;
null or absent receipts cannot authorize a replacement claim or prompt. Bound
storage to 2,000 entries and 4 MiB per entry, reject redirected metadata and
reserve Stop identity independently of ordinary calls. Start rechecks current
facts, physical directory, workcopy and runtime plan. Stop/reconciliation of an
original dispatch bypass current source authorization while retaining the native
owner checks. New starts and permissions do not inherit that exception.

Before dispatch, read and retain original committed claim, input-capture or
preparation receipts under their original task/reporter authority before checking
new implementation admission. An earlier business stage must not hide an
already committed receipt. A missing receipt still requires current admission
before retrying its original command; receipt recovery cannot start capture,
preparation or execution in a prohibited phase.

The task-scoped planning fence receives the full task incarnation. Check it
after asynchronous directory/runtime inspection and synchronously inside the
effect callback before a new or explicitly retried claim. An earlier check
cannot authorize a claim if planning starts during an await. Preserve historical
receipt reads and original dispatched Stop/reconciliation while the fence is active.

The workspace generation counter is a process-local invocation observation, not
durable authority. Each IPC invocation captures it alongside the main-window
fence. After restart, revalidate the retained connection/actor/device/project,
instance/epoch and fixed task/input facts before obtaining a fresh source.
Native callbacks must use that fresh source. Carry it through later
claim/capture/preparation/start stages and check it after asynchronous directory,
runtime and receipt reads. An A-to-B-to-A switch invalidates the invocation even
when the final durable identity matches; a later stage must not renew the source
to bypass that invalidation. Verify both numeric counter reset recovery and
same-invocation switching; reconstructing a service with a generation-insensitive
test port does not establish process-restart recovery.

Existing v1 development/progress owners remain on their original UI and controls.
A fresh native entry never binds v1 progress first. Keep the facade ports
injectable for TEMP integration; distinguish controlled transports from actual
HTTP/native/provider evidence.

`productTask.results` takes `workspaceKey`, `taskId`, `spaceId` and
`taskCreatedAt`. Resolve its current task/space ACL independently of the
developer-only preparation source. Return confirmed T04 artifact references,
manifest/checkpoint, synchronization and finalization facts; no private entry
handle, native path or credential is needed by a receiving tester.
`productTask.artifact` adds the exact confirmed artifact reference and verifies
the original execution/version/body digest through the existing team transport.
Refresh the remote execution projection after local reconciliation so a newly
confirmed synchronization state cannot accompany an obsolete empty artifact list.

`productTask.finish` uses the same task query and optional explicit code-source
selection. The existing testing-handoff action calls it before the separate
business transition. Retain its original native command UUID through a lost
reply; confirmed native completion does not resolve an uncertain business
transition. Manual/legacy tasks retain their original handoff owner. Do not add
a compulsory extra finish action or approve/adopt a formal document here.

After an ordinary return, read may expose `successor` only for the exact latest
completed local execution and unconsumed authorized return event on the same
task incarnation. `prepare.successor` must name that predecessor entry, return
event and current adopted bundle. Never infer the next run from a workspace/task
first match, timestamp ordering, or a server head without an active writer.

Successor admission requires the exact predecessor completed manifest and
checkpoint, current adopted bundle, latest authorized feedback assigned to the
current handler, and canonical native cleanup. Unknown earlier claims
(including a claim with no execution ID), captures, preparations, dispatches,
output writes or finish intents remain admission blockers. Read the current
server head immediately before claim and use its `generation`,
`predecessorExecutionId`, and `attempt:1`; never calculate the next generation
from the predecessor record. Persist each new entry/claim/capture/preparation/
dispatch UUID once. Duplicate preparation or a lost claim acknowledgement
resumes that exact successor; an old handle only stops or reconciles its own
dispatch.

The ordinary return body is launch instruction content, not a T03 document.
Freeze its event ID/body/digest, predecessor identity and current bundle in the
successor row. Compose mandatory successor instruction and optional supplement
with the same backend function and validate the actual native start limit before
saving/transmitting a successor claim. Do not truncate feedback or create a new
approval document merely because a return occurred. A formal input change or
adopted policy retains its existing approval/adoption gate.

For predecessor selected-file code, derive exact native `targetPaths` from the
predecessor retained output selections and confirmed artifact versions. Missing,
ambiguous, or unapplied mappings must block preparation; the application must
not apply or replace code as a side effect. Git sources retain the existing Git
receiver verification. The task result view distinguishes current successor
artifacts from `previous` fixed delivery; old artifacts cannot satisfy fresh
required successor outputs.

## Reprepare a confirmed unsent attempt

`retryPrepare({entryId})` prepares a new attempt of the same execution and
generation. It never starts an engine, sends a prompt, claims another writer,
releases authority or changes the business stage. The user starts the prepared
attempt separately through the existing Start action.

The current runtime computes `canRetry` from private records and actual owners.
Require a stopped dispatch, confirmed cleanup, no turn, written prompt, outputs,
registration, permissions or pending side effects. Admit either:

- No native entry: no admission, lease, context or session; the matching cleaned
  task-session intent has `not-entered`, `not-created` and `not-sent` evidence.
- Created but unsent: retained admission and native entry, a `not-sent` platform
  delivery receipt bound to the original task/epoch/node/attempt/input, no admitted
  turn in that receipt, and a matching `closed` native session. Its cleaned
  task-session intent must retain `entered`, `cleaned`, `not-sent`, and matching
  session/backend/connection/workcopy identity. A historical released lease or
  prepared context is not a live owner. A receipt still marked `prepared` after
  session-creation failure is eligible only with the same complete native
  no-send and cleanup evidence; `prepared` alone never permits retry.
  When that failure precedes the created-session receipt, require the retained
  `native-session` failure, an absent intent session, and the exact matching
  disconnected or closed native session instead. Match its backend, connection
  and workcopy, require no turn, and verify the cleaned Job and absence of live
  owners. Do not fabricate a successful creation receipt or rewrite history.

Check the physical workcopy, actual native sessions, Job owners and other retained
executions in both cases. Preserve old record provenance. A created unsent dispatch
may come from a GUI that reopened its preparation: the preparation creator and
dispatch creator must share the OS user and physical application, with the same
grant and fixed preparation. The durable native admission establishes the prior
handoff; it does not grant current authority.
`hasAcpJobOwner` means a historical owner record exists. For created unsent
recovery, require `isAcpJobOwnerCleaned(directory, owner)`: the matching owner must
exist, every retained launch must be `cleaned`, and no current host registration
may still spawn work. Missing/malformed launch evidence or `prepared`/`running`
launches deny recovery. Do not delete owner files to make this check pass.
Missing or inconsistent evidence denies recovery. An old DTO without the field
grants nothing; a new runtime may recheck complete old private evidence.

The desktop's retry visibility and retry admission use the same proof predicate.
Fresh native reconciliation must confirm `canRetry`, stopped state and cleanup,
with retained Start/preparation and no pending effects. A desktop `stopId` is
the identity of a GUI-issued Stop, not evidence that all native stops originated
in that GUI. A daemon-issued Stop may satisfy the native proof without it.
Do not manufacture a GUI Stop record or require another Stop to retry.

A new GUI may read the original stopped unsent record only after proving the
original GUI exited, under the same OS user, application, profile and root.
Preserve `nativeOwner`, preparation, request, dispatch and failure provenance.
This exception permits original Stop/reconciliation, not output, permission or
finish operations on the old dispatch.

Main rechecks the original task incarnation, handler/device/roles, developing
stage, directory/workcopy, runtime digest and captured input availability. The
active server authority must still be the original unfinalized
execution/generation/node/attempt. A live or unknown native writer blocks the
operation; retaining the original active server authority is required for the
next-attempt report.

Persist one child entry, next-attempt `report` command UUID and native IDs before
the POST. Use the existing report sequence CAS and current generation; never
derive a new command or sequence after an unknown acknowledgement. Reconcile
the original UUID and preserve the same child on reopen and repeated clicks.
Once that child has a saved preparation, reconcile its exact preparation UUID
through the original runtime command. Its own preparation lease must not trigger
another parent `canRetry` admission check. Current source and native preparation
checks still apply; an unknown runtime command remains blocked.
Select entries by explicit retry lineage, not creation time. Reuse the original
immutable input capture and completed workflow installation; create a fresh
preparation bound to the confirmed next attempt. Retain the exact original
instruction and output choices for the later explicit Start. Completed-delivery
rework remains a separate path with its existing return-feedback requirements.

An ended turn without any registered delivery has a separate explicit restart
path. `canRestart` requires the exact written delivery receipt, a known terminal
native outcome, confirmed Stop/cleanup, matching closed native session and
cleaned Job/intent, and no candidate, output, registration, report, mutation,
checkpoint, manifest or pending effect. A live owner or unknown send/outcome
denies it. This is not non-send evidence and must never enable `canRetry`.
`retryPrepare({entryId, afterCompleted:true})` records `retry.mode:'finished'`
with the same next-attempt transaction. Omitted consent accepts only the
original unsent path. Both paths retain history and current files, revalidate
the current task/input/workcopy/runtime, and require a separate Start.
An existing child remains the only child; reconciliation never repeats Start.

Output selections identify what to synchronize, not the complete list of files
the task may require. Preserve the task's file requirements when describing an
assistant-reply output. A completed model turn without the selected file is a
failed delivery: retain the output-capture classification and never show it as
successful task completion. Renderer reads for an existing entry must not move
an accepted dispatch back to its earlier preparing/prepared projection.

An unknown `runtime.taskPreparation/prepare` command can resume its exact UUID
and request only through native preparation recovery. Retain the original
receipt epoch as `originalEpoch`, join one pending recovery and cache its result.
Other unknown runtime mutations still cannot replay. Recovery accepts a ready
binding or the exact private fixed-context intent whose local workflow release
is fully installed and verified. Without a binding, reject partial material
directories, changed request/root/configuration/release, live workcopy owners,
foreign user/application/grant and an original GUI whose exit is unverified.
Preserve the original intent owner in the recovered binding; authenticate the
current GUI separately. Recheck current team/task/input authority through the
ordinary preparation path. Recovery never starts an engine, sends a prompt,
submits a business command or changes the prior next-attempt receipt.

Desktop Start inspects the exact retained native preparation and checks its
task/execution/node/input/workcopy identity before durable dispatch. It must not
repeat the full remote preparation verification while holding the GUI Start
request. The accepted native controller performs that live verification before
engine creation or prompt send. Retain current desktop source/runtime checks,
native owner/grant checks and the exact binding comparison; removing a duplicate
verification does not authorize a different preparation.

HTTP 429 without a separate error code is `RATE_LIMITED`, not `INVALID_INPUT`.
Preserve status, `Retry-After` and the configured threshold. Error classification
does not establish recovery or authorize automatic POST/Start/prompt retries.

The native task operation may recover a received HTTP 429 inside its existing
task-scoped GET chain, including session and code-resource authorization reads.
All those reads share at most two additional GETs and one 90-second recovery
window. Honor `Retry-After`; reject an absent/invalid delay or a delay beyond the
remaining deadline. Each fetch keeps its 15-second timeout, capped by the
remaining recovery deadline; waiting occurs after that fetch timer is cleared.
Recheck the original credential fingerprint, owner, source/workcopy and
in-memory Stop guard during the wait and before resending the exact GET.
Do not retry from a remote code string, schema failure, POST, session creation,
Start or prompt operation. A 60-second GUI RPC timeout does not cancel a pending
Daemon command; inspect the same eventual receipt.

Retain only bounded status, method, route template without query/identifiers,
parsed delay, stable code, actual phase and diagnostic reason before wrapping
the failure. Never retain credentials, cookies, bodies, remote prose or stacks.
The original runtime command's unknown protection is unchanged. Budget
exhaustion, process exit and partial installation across owner replacement remain
blocked; this policy does not recreate an already unknown preparation.

## Native interface

`shared/native-task-execution.ts` defines the native-only request/result schema.
`runtime.taskExecution` uses the existing authenticated RuntimeWire, command
journal and bulk transport. It is not exposed as generic preload RPC.

| Operation | Preconditions and effect |
| --- | --- |
| `start` | Local `dispatchId` equals the original Runtime command UUID. Consume a T05 preparation, explicit Pi/Codex/Claude selection, instruction and declared output selections. Admit one fixed current node. |
| `report` | Select retained output IDs, remaining work and code source. Save confirmed T04 versions, delivery manifest and checkpoint under original remote command UUIDs. |
| `permission` | Resolve one exact current native request/option for this dispatch, session, connection and turn. Current task, input, resource and configuration authority are required. |
| `stop` | End only the original owned native lifecycle, including pending/late creation. Preserve uncertainty and occupancy until canonical cleanup is confirmed. |
| `reconcile` | Inspect original native facts and command receipts without replaying a launch or prompt. Optional `retryOutputs` requests resumption of retained output commands after original receipt lookup; it does not select new bytes or UUIDs. |
| `finish` | Retain a separate finalization intent for the original dispatch. Require confirmed outputs/checkpoint and canonical native cleanup before finalizing the server execution. |

Permission observation retains the adapter's available operation context through
the native result and product view. A tool title alone is not a complete command
or file-change description. Preserve exact commands, working directories and
file changes when supplied; do not invent missing fields or silently truncate
approval-critical content. Mark unavailable or incomplete context explicitly.
Legacy records without context remain readable.

`shared/acp-permission-review.ts` owns the optional `reviewContext` contract:

```ts
{
  command?: string
  cwd?: string
  changes?: Array<{
    path: string
    oldText?: string | null
    newText?: string | null
    patch?: string
  }>
  details: string
  unavailable?: string
}
```

Bound the serialized UTF-8 context to 32 KiB, commands to 8,192 characters,
directories/paths to 4,096 characters, changes to 64 and unavailable reasons to
500 characters. Preserve native paths; a displayed absolute path is not an
authorization decision. Missing or incomplete facts return an explicit
`unavailable` reason with empty `details`, without invented command/diff text.
Protected bridge descriptors and oversized content must not appear as a clipped
but complete operation.

Capture raw tool facts before history/display clipping. A permission may reuse
preceding tool facts only from its original session, connection generation,
turn and tool-call ID. Edit changes must match all requested target paths;
conflicting, missing or unsupported diff data is unavailable. Consume the
correlated snapshot for that request; later tool events cannot change its
already presented context. Native result and product view copy this context
independently and retain optional `sessionId`, `connectionGeneration`, `turnId`,
expiry and option kind. Absent legacy fields remain absent.

This projection does not change Harness permissions or authorize an operation.
Implementation must support its authorized file edits and checks; planning's
read-only restrictions must not be reused as an implementation permission
classifier. Keep exact pending-request/option and current-use checks, original
rejection and Stop paths, and no automatic permission selection.

Task reads observe an existing dispatch independently of the Start action lock.
Revalidate current source and original dispatch identity around the read;
completed cleanup/outcome and consumed permissions cannot regress because an
older observation returns late. Permission responses and original Stop must
remain reachable while Start awaits its result.

Verify complete command/edit context, unavailable context, exact tool/path
correlation, independent snapshots and old serialization. Exercise one pending
Start with read, response and Stop, including duplicates, expiry, source
changes and late results. A title-only request is not reviewable; an explicit
native rejection remains available without fabricating missing context.

`dispatchId` is a private local admission identity, distinct from the T01 server
execution ID. Another local dispatch cannot concurrently use the same effective
server execution/node/attempt, including through another workcopy.

Reports default to `finalize:false`. Explicit finalization is supported for a
definition containing a single Agent node, after confirmed outputs/checkpoint
and actual native cleanup. Other definitions can seal this node's delivery;
the facade does not claim their remaining nodes or gates passed.
Keep retained legacy `report.finalize` requests intact. A new later `finish`
must not rewrite the original registration request to `finalize:true`.

## Credential and admission boundary

The GUI remains the sole owner of the team DesktopTeamStore and credential
issuance/revocation. It authorizes the existing protected native task credential
before preparation. The Daemon uses the existing `NativeTaskProgressSender`
bounded execution transport; it must not open a second DesktopTeamService store.
Preserve the retained credential envelope/purpose and current device/actor,
connection, project, task incarnation, epoch and fingerprint fences. A path,
task ID, cached snapshot or former receipt grants no new authority.

Initial product admission requires the actual native GUI capability and original
T05 owner/grant. Verify sources and physical workcopy, then synchronously transfer
the existing preparation admission into the existing native lifecycle ownership.
Do not introduce an await gap that leaves neither owner holding the workcopy.

Admitted background work uses the retained grant, original protected device and
current server writer. It does not retain the GUI connection's capability as
perpetual authority, depend on current page/project selection or manufacture a
kernel actor after reconnect.

## Native inputs and evidence

### Durable Start acknowledgement

Scope: `NativeTaskExecutions.execute(root, start, authority, dispatchId)` returns
the original persisted dispatch in `starting` state without awaiting model
configuration, session creation or prompt delivery. The unchanged Start schema
still requires `dispatchId === commandId`. `starting` confirms durable acceptance,
not native entry or delivery. Runtime command completion acknowledges this
acceptance; `reconcile` reads the live or retained execution outcome.

Contract: the existing owned `live.start` promise retains all preparation and send
work. Stop and shutdown join that exact promise. Background errors are observed
and durably recorded; they cannot become unhandled rejections or trigger another
Start. Restart projects incomplete work as `unknown` and never launches it again.

After awaited preparation authorization and immediately before persisting the
dispatch, recheck the initiating GUI capability and workspace grant. There must
be no await between this check and durable acceptance. After acceptance, capture
an internal `NativeTaskPreparationAuthority` from the original dispatch: keep
its actor and grant, but check the current daemon owner, current workspace grant,
same live dispatch, Stop flag and cleanup instead of the initiating GUI
connection. Remote device/task/input/resource checks remain current during
preparation. This capture is in memory only and cannot be submitted through IPC,
recreated after daemon restart, or used to authorize another dispatch.

Disconnecting the GUI before acceptance rejects without launching. Disconnecting
it after acceptance does not cancel preparation or the original turn. A newly
authenticated GUI queries the same dispatch; only explicit Stop, revoked
execution authority or an execution failure can end the owned work.

`NativeTaskExecutionResult.failure?` and `IpcFail.taskFailure?` use
`nativeTaskFailureSchema`: bounded `phase`, `code`, optional classified `reason`
and optional `transport:{status,method,route,retryAfterMs,reason}`. Old records
without these fields remain readable. ACP preserves the original typed
classification across its IPC failure envelope. Native retention stores no
arbitrary error prose, prompts, credentials or stacks. Main renders the retained
failure through the existing blocker view until safe retry is available.

| Condition | Result |
| --- | --- |
| Native launch delayed after durable reservation | Return `starting`; query the same dispatch |
| Later context/transport failure | Retain phase/code/reason/transport; query original state |
| Duplicate Start UUID or restarted incomplete dispatch | Reject replay; reconcile original |
| Stop races with launch | Join original launch, then canonical cleanup |
| Unknown or written prompt | No retry capability |

Good: GUI receives `starting`, later reads a retained `RATE_LIMITED` failure and
stops the original dispatch. Base: a fast launch still returns its original
identity and proceeds to `running`. Bad: treating a completed runtime command as
proof of prompt delivery or creating a new UUID after a timeout.

Verification: hold configuration unresolved and assert Start returns with a
durable record; reject configuration later and query the typed failure through
restart. Race Stop with the unresolved launch. Assert one launch, the same Stop
UUID, confirmed cleanup and no unhandled rejection. Verify unknown/written send,
missing cleanup, wrong input/session identity and actual pending owners deny
retry; a matching created/unsent/cleaned record permits explicit reprepare.
Include the real historical Job files in this fixture; an always-absent Job stub
cannot establish created-session recovery.
Also disconnect the original GUI while configuration is unresolved, then allow
preparation and prompt delivery. Assert the captured background authority remains
valid, the new GUI reads the same dispatch and only one native prompt is sent.
Repeat with grant revocation and Stop: both must still reject before native send.
Disconnect during awaited initial authorization and assert no dispatch is saved.

Wrong: await the entire native launch in the command acknowledgement or increase
the GUI timeout to hide it. Correct: acknowledge the persisted intent and query
the same owned execution.

### Current authority with retained fixed bytes

Within one native execution HTTP operation, authorize the credential once and
use that same fingerprint for the code-resource incarnation check and target
request. A code-resource target reuses that operation's already validated
response. Retain owner/current checks, endpoint authorization, before/after
credential checks and the shared bounded GET retry budget. There is no
cross-operation authorization cache.

`withExecution` supplies its freshly validated `ExecutionInputView` as the fourth
callback argument. `executionRules` uses it for initial availability and reads
the matching private retained material via `readRegular`; exact UTF-8 length,
digest and resource identity remain mandatory. It performs a fresh input read
after assembly. Later `assertCurrent` reopens execution/resource/input authority,
checks current source availability and retained bytes, and compares that fresh
view with the original. It does not download immutable bodies again.

Verify one logical ordinary GET uses three HTTP exchanges and a code-resource
GET uses two; revoked credentials or changed task incarnation fail before the
target. Verify `executionRules` uses four logical reads, its later assertion
uses three, and neither fetches resource bodies. Withdrawn required inputs,
changed views and tampered local bytes must still reject.

- Capture the local launch, profile/options and request before asynchronous
  source reads. Recheck actual launch/configuration at the native creation and
  prompt boundaries. Match the server's engine/adapter selection.
- Use the existing Pi native SDK port and public acpx controller for Codex and
  Claude. Keep their model loops, session/turn authority, permissions and native
  cancellation. Product initiation does not control an arbitrary open editor.
- Deliver the actual node-scoped T03 Agent/Skill and selected materials through
  the existing native composers. Do not expose private T05 material paths or
  generic credential/HTTP access to the model.
- Retain actual session, connection generation, backend/vendor IDs, acknowledged
  model, configuration digest, turn and prompt-write evidence. The T03 inclusion
  manifest describes prepared bytes; actual transport acknowledgement establishes
  written input. Neither alone establishes model compliance.
- Require the actual engine's context capability (`sdkContext` or
  `embeddedContext`). Other required capability IDs without adapter evidence
  reject explicitly. Formal document/creation output adapters and non-Agent
  scheduling are not silently approximated.

The fixed packet is strict JSON text in a `text/plain` attachment, supported by
the pinned public acpx context boundary. Its MIME type participates in actual
envelope budgeting and validation. Do not change the dependency's allowlist or
discard packet/hash/size checks to bypass a rejected attachment. Retained native
histories and their original manifests stay unchanged; no old unknown prompt
is replayed in the new format.

Product ACP nodes may move designated captured required/full confirmed documents
to the backend atomic platform input. The final prompt boundary rechecks current
use and retained preparation bytes, and derives the complete disjoint control/
reference partition from the original node. Legacy prepared context accepts only
its original complete-node preparation. The control envelope remains 8192 bytes;
the exact rendered reference collection, labels, separators, terminators and
256-byte framing reserve must fit `PLATFORM_REFERENCE_BUDGET_BYTES` (32768 bytes)
without clipping or fallback. Other explicit-material budgets remain unchanged.

Optional `referenceDelivery` retains the task incarnation, epoch, generation,
node/attempt/input, control/instruction digests, ordered source receipts and
original native session/connection/turn. Absence retains legacy serialization.
`onAdmitted` still runs before `startTurn` and proves no write. Persist `unknown`
before entering native send; only that original turn's `promptStarted` establishes
`written`. Record observed write before fallible persistence callbacks. `not-sent`
requires positive non-entry evidence. Recovery reads the original saved receipt;
unknown delivery never authorizes replay. Transport write proves no compliance
or business acceptance, and later withdrawal blocks new use without erasing it.

## Outputs and handoff

Output selection is fixed at start: a declared output uses an engineering-relative
file or the original native turn's final assistant text. Report bodies cannot
supply substitute assistant text. Prefer explicit final-answer phases; otherwise
use the last identified assistant message and its chunks, excluding earlier
progress messages. The native instruction requires complete assistant-source
deliverables, including report commands, environment and expected/actual results,
rather than completion summaries or local-file links.

Baseline selected files before prompt dispatch. Unchanged old files do not
become new work after a no-op turn, except an exact file mapped by the successor's
`targetPaths` to its natively verified, applied predecessor code. A report-only
return may retain that correct code. Capture and verify its current bytes under
the successor; do not substitute an old artifact for new reports or skip current
authority, workcopy, turn-completion or predecessor checks.

Capture only a normally completed matching turn with complete authoritative
history and no unfinished tools. Preserve actual UTF-8 bytes, digest and size.
Use the existing safe native file reader; reject unsafe paths, redirected files,
unsupported output kinds and oversize content. Keep private conversations,
credentials and unrelated engineering files outside shared records.

Optional Start `sharing:{task,outputIds}` fixes the original destination and
declared output subset. Capture durably retains these immutable candidates
before scheduling registration in the existing Daemon owner. Capture and
canonical native cleanup do not wait for upload. Original Stop and permission
resolution must remain independent of stalled synchronization; do not keep a
workcopy writer lease merely to upload.

`withCapturedOutputs` permits only retained artifact, delivery, checkpoint and
finalization commands for the original prepared execution/generation/node/attempt.
It revalidates the current original device, writer, fixed input and code resource
before POST, without reviving a released workcopy grant or model authority.
Historical receipt access cannot grant a new write. Once candidates are fixed,
read their retained private bodies; changing the working file cannot change a
queued version.

Persist every original T04 command body and UUID before POST. Confirm versions
before sealing the exact delivery/checkpoint. An uncertain acknowledgement remains
uncertain until the original receipt is read; reconciliation cannot retry it as
a new effect. Resume remaining registration steps only after resolving their
original predecessors. A permitted retry sends the identical saved UUID/body
after receipt lookup. Code source uses existing T04 selected-file/Git capture
and native availability verification. Validate an explicit code selection before
freezing its report; missing required code remains `needs-code`, never a guessed
`none`.

Project synchronization as `captured`, `pending`, `unknown`, `denied`, `failed`,
`needs-code` or `confirmed`, with bounded attempts, next-attempt time and error.
Retain denied/unknown work through restart; startup scheduling cannot resend a
prompt. Registration may continue after Stop only through captured-output
authority. Finalization first confirms output/checkpoint and canonical cleanup,
then requests server execution finalization under a separate durable intent.
Task approval, testing and business completion remain separate operations.

## Stop, restart and storage

Turn idle, provider failure, timeout and process-root disappearance are distinct
from canonical cleanup. Preserve original writer leases for pending creation,
unfinished tools, background work and unknown outcomes. Stop remains available
after task/input/credential/grant loss without restoring sharing authority.
Native retained storage and canonical cleanup check the original Daemon lease,
not whether new application admission is open. Shutdown closes application
admission before draining these owners. Keep readiness, workspace and current
writer checks on new starts, fresh code observations and permission decisions.
Retained-output writes use their narrow current sharing checks; closing
admission must not prevent saving the original Stop or cleaning its native
controller.

Retained rows live in Daemon-private `native-task-executions`, with original
native intents, prepared scope, observations, selected output bodies and remote
mutation receipts. Storage is bounded and rejects redirection. On restart,
unconfirmed native lifecycle remains unknown; saved permissions do not recreate
resolvers. Reconciliation never automatically starts another native session.
Daemon idle/shutdown and workspace ownership changes include these retained facts.

Keep the original Stop intent in its dedicated retained slot independently of
ordinary command retention. Persist its original UUID before cleanup; a full
ordinary ledger cannot exclude Stop or silently evict unknown intents. Another
Stop request observes/joins that original owned cleanup rather than selecting a
replacement process.

A reopened GUI preserves the original creator's provenance. Recovery requires
the existing current profile/installation GUI capability, matching OS user and
physical executable, and native process evidence that the original PID/birth
is no longer live. Unknown queries fail closed. Only confirmed irreversible
original-process exit can be cached; it grants no source/device/task authority.
Recovered permission and fresh code-observation actions still require their
current original writer/input/resource/configuration checks. Already captured
output publication uses current shared authority without reviving native write
authority. Recovery cannot admit a new start or manufacture another task
credential or workspace grant.

Bound retained dispatches to 2,000, ordinary native intents to 128, shared
mutations to 64, metadata to 4 MiB and each selected output body to 1 MiB.
Reserve 4 KiB within the metadata bound until the original Stop UUID is saved.
Include derived pending-command and output projections when budgeting candidate
persistence before committing live record changes. Preserve uncertain command
bodies and UUIDs when ordinary capacity is exhausted.

## Required verification

Keep all fixtures and reports in OS TEMP. Verify real Pi/Codex/Claude file and
fixed-context nonces, captured Agent/Spec versions after edits/publication, exact
native identity and selected confirmed outputs. Separately exercise check-stage
selection, permission decisions, unsupported capabilities, unchanged/failed
output, same-writer duplicate starts across workcopies, source/configuration and
authority changes, late creation, cancellation, lost replies, GUI loss, restart
and original cleanup. Verify the GUI store remains live during Daemon preparation
and execution. Report fixture, actual provider, native and packaged acceptance
separately; a protocol handshake or build is not model execution.

For result synchronization, assert that a completed capture reaches the same
task/receiver, working-file mutation cannot replace queued bytes, missing
acknowledgements resume artifact/manifest/checkpoint/finalization under their
original UUIDs, and Stop completes while upload is stalled. Reject revoked
sharing and peer reads outside the original task incarnation. Verify that a
later finish preserves the registration intent and that receiver discovery
works after the separate handoff or release makes `active` null.
Also verify one two-account ordinary sequence: predecessor delivery, old pass,
return, explicit successor, fresh V2 outputs, current-round retest; replaying
the old pass UUID must not advance the task. Include lost successor claim
recovery/restart and cleanup/unapplied-code blockers, and an oversized
mandatory feedback rejection before a new claim.

For task requirements, verify a description/criteria-only task with an empty
supplement through main, the actual native launch/composer boundary and the
matching write receipt. Assert exact decoded requirement text and identity,
separate formal references, rework feedback, Unicode/escaping, exact and
overflow capacity, and changed source/account/incarnation rejection. After a
lost Start reply and reopen, assert unchanged saved body/UUID/hash and no
prompt replay, including records without `instructionPolicy`.

Good: captured outputs remain pending offline, native cleanup releases the
workcopy, and the original authorized upload resumes before explicit testing
handoff. Base: a manual task keeps its existing handoff without a native entry.
Bad: uploading current file bytes under a replacement UUID or interpreting an
artifact receipt as business acceptance.

Wrong: changing the saved registration to `finalize:true` on the next click.
Correct: preserve registration and retain a separate finish command whose
receipt can be reconciled independently of the business transition.

Wrong: selecting the first local row or reusing the old return after a later
handoff.
Correct: resolve the exact predecessor and latest unconsumed authorized return
under the full task incarnation, then claim once from the current server head.

Wrong: depend on a renderer-generated title/material summary as the complete
implementation requirement.
Correct: main fixes the original task's complete requirement and criteria in
the first Start; the renderer supplies only the optional supplement and outputs.
