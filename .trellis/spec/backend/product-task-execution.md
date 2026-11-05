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
| `reconcile` | Inspect original native facts and command receipts without replaying an unknown launch, prompt or POST. |

`dispatchId` is a private local admission identity, distinct from the T01 server
execution ID. Another local dispatch cannot concurrently use the same effective
server execution/node/attempt, including through another workcopy.

Reports default to `finalize:false`. Explicit finalization is supported for a
definition containing a single Agent node, after confirmed outputs/checkpoint
and actual native cleanup. Other definitions can seal this node's delivery;
the facade does not claim their remaining nodes or gates passed.

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

## Outputs and handoff

Output selection is fixed at start: a declared output uses an engineering-relative
file or the original native turn's final assistant text. Report bodies cannot
supply substitute assistant text. Baseline selected files before prompt dispatch;
unchanged old files do not become new work after a no-op turn.

Capture only a normally completed matching turn with complete authoritative
history and no unfinished tools. Preserve actual UTF-8 bytes, digest and size.
Use the existing safe native file reader; reject unsafe paths, redirected files,
unsupported output kinds and oversize content. Keep private conversations,
credentials and unrelated engineering files outside shared records.

Persist every original T04 command body and UUID before POST. Confirm versions
before sealing the exact delivery/checkpoint. An uncertain acknowledgement remains
uncertain until the original receipt is read; reconciliation cannot retry it as
a new effect. Code source uses existing T04 selected-file/Git capture and native
availability verification. Missing required code cannot be declared `none`.

Report selected output before Stop closes new native writes. Finalization first
confirms output/checkpoint and canonical cleanup, then requests the server
execution finalization. Task approval, testing and business completion remain
separate operations.

## Stop, restart and storage

Turn idle, provider failure, timeout and process-root disappearance are distinct
from canonical cleanup. Preserve original writer leases for pending creation,
unfinished tools, background work and unknown outcomes. Stop remains available
after task/input/credential/grant loss without restoring sharing authority.
Native retained storage and canonical cleanup check the original Daemon lease,
not whether new application admission is open. Shutdown closes application
admission before draining these owners. Keep readiness, workspace and current
writer checks on new starts, report and permission decisions; closing admission
must not prevent saving the original Stop or cleaning its native controller.

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
Recovered report and permission actions still require their current original
writer/input/resource/configuration checks. Recovery cannot admit a new start
or manufacture another task credential or workspace grant.

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
