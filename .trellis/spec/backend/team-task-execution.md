# Team task execution

Platform service execution contract v2 follows
[the v2 command and receipt contract](./team-task-executions-v2.md). The native
Trellis projection and v1 progress paths below retain their own semantics and
interlock with the v2 effective writer.

## Authority and scope

The team service owns task stages, handlers, acceptance and cancellation. Use the
existing `transitionTask` domain rules for business transitions. A runtime report
updates only a task's latest execution summary; it never proves testing,
acceptance or business completion.

The desktop owns the actual working directory, runtime process and native
conversation. A code task uses the entire selected engineering base, including
its frontend/backend packages. A general task can use an application-managed
working directory without a Git repository. This directory is not an OS sandbox.

## Requirements and review entry

Shared requirements intake uses the existing team content runtime through
`api.teamContent`, not an additional Agent executor. Freeze the original service
instance/epoch, project, actor/device, task creation identity and command UUID.
Captured published material bodies and applicable published governance rules must
be authorized and verified as original UTF-8 bytes. Rule selection reuses task
input applicability and conflict/withdrawal checks. A publication cannot replace
a version captured for an admitted job. No document approval, task-stage advance
or code execution follows from a generated candidate alone.

Draft-only saving and review submission are distinct frozen intents. Both retain
the original triage task and PRD identity through uncertain receipts. Draft-only
save never submits or approves. Allow criteria backfill only for the creator or
triage manager before the first triage decision, workflow history or delivery
state; existing formal task protections remain authoritative.

Project role projection is read-only authenticated data. Do not authorize a role
from a name, editable title, Agent configuration or URL. Space membership changes
accept active members of the same authorized workspace and preserve the active
owner; they cannot alter platform accounts or project roles.

Pending material reviews are derived from actual current submissions and
approver access. Inbox read/clear preferences must not resurrect a resolved or
revoked review. Confirmed material writes signal the workspace revision so active
clients refresh fixed-input candidates. Preserve raw snapshot ownership and
original task creation identity when projecting historical receipts.

See [shared requirements workflow](../../../docs/team-requirements-workflow.md)
for the current user-facing route and boundaries.

## Progress contracts

`src/shared/team-task-progress.ts` defines the service schemas. The task progress
routes are scoped by service project and task identity. Commands retain their
original UUID and service epoch. Binding uses the observed generation and binding
ID; reporting and release use the admitted binding ID and a monotonic sequence.

Store only the latest short step, blocking reason, execution state and server
receipt time. Do not store tool output, token streams, file-read history or
heartbeat history in task progress. Keep progress changes separate from the
shared business snapshot revision and inbox notifications.

Every read and write rechecks current principal, project and space access. A
writer must be the current permitted handler. An old task, handler, device,
service epoch or execution binding cannot acquire authority by replaying a saved
command. A command UUID with a different payload must not be accepted as a retry.
Directory display names and opaque session identifiers do not prove an external
runtime's actual filesystem confinement.

The global `runtime.cruxProgress` control lane requires the protected native GUI
capability in addition to ordinary profile authentication. Bind proof to the
current connection challenge and kernel-verified process lifetime. Actor labels,
client-supplied PIDs and a workspace-less request do not establish GUI authority.
The daemon's internal sender does not depend on an attached GUI capability.

## Desktop execution

`api.cruxProgress` exposes `status`, `start`, `report`, `retry` and `detach`.
`src/shared/crux-task-progress.ts` owns their exact validated shapes. Browser
hosting must not expose native execution as a simulated capability.

Capture the original origin, account, device, service project, space, task,
epoch, canonical directory and native conversation identity. A subsequent page,
space or engineering selection cannot retarget background work. Reusing a saved
conversation requires matching its original execution identity; a project title
or the most recent conversation is insufficient.

Persist commands before transmission. Retain unknown outcomes and reconcile
using the original identity. Merge unsent summary replacements only when no
admitted command is changed. A rejected or conflicted binding stops background
retry until explicitly resolved. A runtime turn ending means idle or interrupted
execution, not successful task completion. Device liveness cannot establish
that an Agent is running or making progress.

The independent daemon owns both the queue and the fixed-purpose HTTP sender.
The existing desktop credential owner issues and revokes an OS-protected
progress credential. The sender reads that original grant without opening a
second team SQLite writer. Closing a GUI attachment must not remove the sender
while its native execution continues. Recheck grant identity around network
calls and reauthorize the fixed task route on every request.

Retain body-free command identity hashes until the owning task is removed.
Compact readable receipts may be bounded, but receipt eviction cannot make an
old UUID available for a new payload. Separate current progress from historical
acknowledgement clues when reconciling an uncertain write.

## Trellis projection

An explicitly team-managed task carries
`task.json.meta.panel_task_authority = "team"`. Its local status is a compatibility
projection of confirmed central state. Plain local tasks retain existing CLI
behavior. Starting or finishing a local conversation cannot approve or complete
a team task. Local archive cannot manufacture central completion. Preserve
developer-edited materials and original task provenance when projecting state.

The existing shared preparation/open path also installs the authority marker;
it cannot depend on entering the newer Agent-progress route first. Adopting an
existing preparation record checks its original metadata and performs a file
CAS without changing its status or developer documents. Do not claim to have
updated a different repository's Trellis scripts unless its adapter was actually
installed and checked.

Shared preparation and opening must probe the selected CLI's actual
`team-capabilities --json` response before creation/adoption. A marker or file
existence alone is insufficient. The source/packaged installer accepts only the
known script/dependency baseline or the current payload, defaults to dry-run,
backs up original bytes and performs revision-checked rollback. It never replaces
unknown custom scripts or mutates task/spec/hook configuration during installation.

## Rule context

`prepareAgentRules` in `services/agent-rules.ts` assembles bounded project rules,
task-curated specs and host-selected team rules. It records source content
digests, exact included bytes/characters and truncation in a manifest. Task
selection manifests are versioned even when their bodies are index-only.

Use the real serialized byte count, including JSON escaping, within the 8 KiB
rule budget. Missing selected rules and invalid or escaping paths fail visibly.
Oversized rules remain index-only with no invented full-content digest.
`assertAgentRulesCurrent` rejects changes to pinned readable project sources;
it does not silently replace an active session's context. Team source revisions
use the installed native task authority for revalidation. Supplying rules does not prove that
the model complied with them or grant tool permissions.

## Fixed inputs and development attempts

### 1. Scope / trigger

Apply to task material preparation, task-scoped Git/application actions and
native Pi/ACP rule delivery. Team drafts, approvals, publications and task input
adoptions are separate records; new drafts/publications never move an adoption.

### 2. Signatures

- `CruxWorkApi`: `development`, `status`, `prepare`, `change` in `shared/crux-work.ts`.
- `resolveContext({workspaceKey,taskId}, {contextId,generation})` is main-only.
- `withNativeWorkcopyPreparation` owns material/CLI write admission and cleanup.
- `installTaskInputRulesAuthority` binds rule loading to the original daemon row.

### 3. Contracts

Change requests retain one UUID, expected context/input revision and explicit
`choose-copy` or `adopt-inputs` intent. Keep the previous private binding and task
files before publishing a successor. Cancellation before confirmation preserves
the active binding. A confirmed new attempt may still be preparing or failed.

Normalize nested task queries to their declared fields. Never spread a change,
candidate or runtime request into a strict task/material transport scope.
Renderer paths and labels cannot grant a workcopy. Resolve the original account,
task creation identity, physical directory, branch and current input version.
Finished/cancelled tasks keep readable history but cannot gain new development
operations; original instances retain their independently authorized stop.

Execution `resolveContext` is a pure ready-binding verifier. It must not call the
presentation/recovery `status` or `ready` path, repair a task authority marker or
remember a candidate directory. Read full source S1 and resource R1, verify the
original private ready record plus actual adapter, task, frozen files and Git,
then read resource R2 followed by full source S2. Explicitly compare task creation,
space, actor/authority/selection generation, material revision, resource proof
and private binding revision; `readCruxWorkSource(expected)` alone does not
compare all of these fields. Recheck local files and physical/Git observations
after the network waits. Missing team authority requires preparation/review.
Every subsequent operation or runtime assertion starts fresh; no result is an
authorization TTL or permission to skip checks after a dialog, queue or Job wait.

The remote development-context GET combines the authorized snapshot, adopted
inputs, code resource and task-linked creations using the same principal in one
synchronous SQLite worker read. No getter yields or skips its ACL. Main obtains
a new response for each boundary, checks its original connection/actor/device,
instance/epoch and selection generation, then uses the existing input and
creation-reference validators. S1/R1 and R2/S2 may each come from this coherent
response; they are never reused across operations. Local workspaces retain their
original read path. A task-scope denial does not revoke an otherwise active
device; the original session is independently checked before that classification.

Execution identity reads repository root, branch, HEAD and actual fetch URLs
without constructing the changed-file presentation snapshot. Preserve active
filter rejection, readable-index checks and native ref/workcopy observations.
Full Git review/mutation snapshots keep their existing content/index checks.
Task application plans refresh automatically at most once per minute while
visible and expanded; process/readiness events update only local facts, not task
permission, environment verification or reuse grants. Actions still reauthorize.

`references/source-materials.json` contains exactly `JSON.stringify(material)`,
without BOM, pretty formatting or a newline; its byte SHA-256 is the input
version. Fixed document/rule/template bodies match digest and byte count.
An old pretty projection requires explicit new preparation. Rules/templates use
task `references/rules/` and `references/templates/`, not a `.trellis/spec` mirror.
Read approved documents through their fixed input transport so newer private
drafts cannot substitute or hide adopted bodies.

Pass the original operation ID and preparation lease into `runTaskCreateCli`.
Ready requires confirmed enclosed-command cleanup. Unknown creation reconciles
its original operation and exact task metadata without another create.

The daemon rules authority uses the original pin, native alias, current row and
task ACL, independently of GUI browsing. Recheck account/device/epoch, adopted
bundle, physical workcopy, branch and exact input bytes. Select the latest task
row; an old capture cannot adopt a successor. Native task creation, prompt
preparation and Pi initialization pass main-owned `taskProgress` as `teamTask`
into `prepareAgentRules`. Required rules/templates must fit fully in the
serialized budget; recommended omissions remain explicit. Supplied text and
verified whole-body Pi reads are different evidence; ACP/partial/failed/foreign
events do not prove reading.

Formal template input/output/role gates execute inside the SQLite mutation,
after the pure transition and before progress invalidation or snapshot writes.
Failure rolls back the business revision and command. Do not add a second engine.

### 4. Validation / error matrix

| Trigger | Outcome |
| --- | --- |
| Unrelated valid project already open | Require native resource/copy selection |
| Source/project A → B → A or branch drift during review | Reject the original generation/preview |
| Explicit new input/copy | New attempt; retain old files and input |
| Unknown creation | Original cleanup/reconciliation; no duplicate create |
| Old context, closed task or revoked access | Reject new development, retain history/safe stop |
| New unadopted publication | Existing version stays fixed |

### 5. Good / base / bad

Good: adopt r2 and explicitly prepare a successor while retaining r1. Base:
continue the same valid context. Bad: use the current GUI root or latest draft
to rewrite an existing session's inputs.

### 6. Required checks

Verify actual filesystem/Git identity and changes, original-command recovery,
two-account fixed inputs/withdrawals, template rollback, private binding/byte
tampering and original native authority. Isolated source/CLI fixtures do not
establish joined HTTP/native or installed-provider acceptance.

### 7. Wrong vs correct

Wrong: pass a whole Git request to the task resolver or claim supplied rules were
read. Correct: pass the exact query/expected pair and retain observed evidence.

## Native creation recovery

Reserve the freshly generated native alias before persisting a `preparing` row
or entering engine creation. Retain the original bind UUID, observed server
generation/binding ID and prompt dispatch evidence. Reconciliation uses that
alias and exact engine/task/input metadata; it must not create another session
or reset a sent/unknown first prompt to unsent.

An unknown original process keeps its workcopy exclusion. A replacement requires
explicit confirmation and native proof of an independent physical copy, or
confirmed cleanup of the original owned process. Different path strings, absent
PIDs and a new GUI selection do not prove independence or cleanup. Restored
`preparing` rows expose the original alias and recovery state even when the
original session is found but its current inputs no longer pass admission.

Capture the GUI source generation before queueing an operation and check it
around native dispatch. A switch after a mutation was dispatched has an unknown
outcome; do not report it as an operation that never ran. Only the current actual
main window's main frame may admit task execution and output registration.

## Managed task outputs

`shared/crux-task-outputs.ts` defines the native schema factory and renderer
API. The existing daemon owns `TaskOutputCoordinator`, its queue and pump even
when there are no task-progress rows. Main provisions the original OS-protected
sender grant before the first output-only request; it does not create a progress
binding to obtain that grant.

Only registered `prd.md`, `design.md`, `implement.md` and `delivery.md` files in
the original private task directory can be uploaded. Validate original task
creation, actor/device/epoch, physical copy, resource, branch, attempt and frozen
reference bytes. Native preview and confirmation bind to the original main
document and source generation. The dedicated output resolver may report newer
adopted input as `inputOutdated`; it must not relax AI, Git or task-launch gates.

Persist each full command/body/UUID and confirmed draft baseline before POST.
Stable saves cannot replace an unresolved pending command or silently rebase on
a team edit. Conflict candidates pause synchronization; explicit comparison and
native confirmation pin the reviewed remote revision and local digest. Unknown
outcomes require original receipt reconciliation or explicit same-command retry.
Keep automatic output actions limited to shared-draft creation and save.

The generated PRD index cannot be presented as a complete PRD. Modified PRDs are
working drafts and require comparison with an actual team PRD or complete frozen
input before registration. Approval, input adoption and task transitions remain
separate server actions.

`shared/task-output-origin.ts` defines optional immutable version provenance.
Derive it only for newly queued commands from the private binding. The server
accepts it only from a device principal, validates file/kind and any historical
bundle under the original task scope/current ACL, and supplies the actual device
ID with `verification: 'device-reported'`. Do not retrofit pending commands,
inherit provenance into a manual edit, mutate Markdown/body digests, or present
device claims as server proof of local files or model compliance.

## Required validation

- Duplicate commands and lost acknowledgements produce one committed effect.
- Old sequences and superseded bindings cannot overwrite the current summary.
- Revoked actors/devices and a restored service epoch stop saved operations.
- Closing an Agent turn or losing device contact never completes a task.
- Switching space, engineering directory or conversation cannot reroute a report.
- Ordinary local Trellis behavior remains unchanged; team CLI status is guarded.
- Rule serialization handles multilingual text and escaping within the byte cap.
- Modified rules, selection manifests and foreign roots fail version checks.
- Progress UI labels cached, pending, stale and rejected state truthfully.
- Use OS TEMP for all verification scripts, fixtures and reports.
