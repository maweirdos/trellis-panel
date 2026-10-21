# Workflow boundary revisions and artifact gates

The existing `WorkflowApplicationService` owns structural adoption alongside its
normal stage coordinator. It uses the existing control writer, immutable material
store and ACP driver. There is no additional live-run registry, model loop or
transcript archive. These APIs are main-owned application methods; desktop IPC
and the rendered adoption controls are integrated by the parent task.

## Application API

`src/shared/workflow-revisions.ts` defines strict request and preview/status DTOs:

```ts
app.previewRevision({ taskDir, run, flowId, reason, boundary, startStepId?, inputs? })
app.acceptRevision({ taskDir, run, previewId, commandId })
app.cancelRevision({ taskDir, commandId })
app.revisionStatus({ taskDir, commandId })
```

`boundary` is `after-current-stage` or `now`. Preview resolves the exact current
task/controller and the new source through the existing trusted main definition,
executor and output-policy resolver. A renderer supplies no root, scope, owner,
executable or capability grant. Only preview/adoption permits new task writes;
stopping or cancelling existing control intent also works after an external
archive, deletion, or same-basename replacement, under the exact retained
main-owned run/task scope and owner. Cleanup does not retarget task aliases or
touch the replacement's documents. Without a retained controller after restart,
missing/ambiguous task metadata still requires an explicit recovery identity;
the current task/command DTO does not grant a global command search. The read-only
workspace recovery methods below provide inspection without that mutable path.

### Path-free recovery inspection

`shared/workflow-recovery.ts` defines two strict requests on the same application:

```ts
app.inspectWorkspaceRecovery({ run? })
app.readRecoveryArtifact({ run, ref })
```

Main asks the existing control worker for the retained owner using the actual
application project/repository/workspace identity. It loads only that scope's
head or the exact requested run. No owner yields an empty result; an explicit
unknown run or project mismatch rejects without selecting another run. Journal
projection shares the ordinary snapshot's graph, nodes, turn/history/material
references. Historical inspection has no current native permission actions.

The result carries nullable scope/ownership/projection and display-only source
location facts. Bounded filesystem metadata inspection compares exact taskRef
identity, reports available/missing/ambiguous/unavailable and preserves the known
alias without updating it. It does not guess identity from task titles or names.
Failure to inspect source paths does not hide the saved journal. Artifact reads
require exact run input/output membership and immutable material bytes; they
never substitute the current file or accept renderer-provided scope/body grants.

Inspection never claims, renews or releases ownership, changes a run/outbox,
reconciles cleanup, stops a native process or dispatches/replays a prompt. After
process exit the projection can require recovery while the retained lease still
shows its actual previous state. Neither dead PID nor readable metadata proves
native shutdown. Native restart/drain remains a separately verified protocol.

The returned saved preview contains before/after graphs, source-step mapping,
changed nodes/edges, affected/preserved work, checked reusable material versions,
reason, boundary, selected successor start, fingerprint and expiry. Its bounded
metadata is saved through the existing material store. The accepted command
payload retains the consent data. No third body/version store is introduced.

## Acceptance, drain and continuation

Saving a preview performs no native action. Invalid sources, unsupported tools,
missing policies, malformed expressions or invalid selected starts reject before
reservation or stop. The current accepted definition remains independent of
later mutable source drafts; actual launch configuration fences remain active.
Resolved local output paths, contract values and native task options are copied
at preview, so later edits to caller-owned configuration objects cannot silently
change accepted semantics. Main-owned validation functions retain their identity.

Adoption reserves one expected revision through the durable control command.
Repeated identical commands read the existing state; changed meaning or a
competing command conflicts. At the chosen boundary, old future dispatch stops.
A distinct durable stop intent is claimed before calling the original canonical
native shutdown. Missing native identity, unresolved creation or failed shutdown
stays unconfirmed and prevents successor admission.

A pending execution intent can be claimed/cancelled before the native driver
wins its atomic claim; this provides specific no-native-admission evidence.
Otherwise a past pending read never proves that native admission did not occur.
Stops after driver finalization preserve its actual verified output. Ordinary
task stop suppresses remaining preset work; it does not mark the whole workflow
verified or turn the completed node into a fake native cancellation.

After validated effective successor context and conclusive drain, one control
transaction records stopped predecessor, linked queued successor, active head,
immutable manifest and startup outbox. The same run ID advances its revision;
definition identity distinguishes structural adoption from ordinary preset stage
continuation. Native dispatch consumes that persisted startup intent afterward.

Cancellation while waiting releases the reservation and old work continues.
Cancellation after stopping begins suppresses successor only; old writes never
resume automatically. Durable stop intent and predecessor state retain recovery
requirements even when a reopened reader has no in-memory pending revision.
Configuration failure after confirmed stop reports failed
adoption with the predecessor stopped. Lost commit acknowledgement or process
exit preserves command/outbox/history and reports recovery-required; it does not
blindly reissue a native prompt or pretend an old live pointer owns a new head.

## Context and provenance

Reusable output versions are explicitly input-only. Native extra inputs remain
unobserved, so no cached execution result is automatically skipped. The selected
successor start is explicit; preceding new-graph nodes are recorded not-selected,
not successfully executed. A chosen start cannot exclude a declared gate input
or retry target. Verified boundary output joins the fixed baseline; failed or
unknown output is not silently promoted to reusable success.

Historical graphs, original turns and predecessor outputs remain readable.
Late old events cannot replace the current graph. Node identity is derived from
the adopted definition, so impact mapping compares actual source step semantics,
executor/role and output policy rather than matching version-derived node IDs or
screen positions. A new stage receives effective baseline and relevant recorded
revision/gate feedback, not concatenated raw chat history.

## Supported predefined gates

Agent and deterministic artifact-gate nodes are supported. A gate checks actual
captured declared output files of an earlier agent (at least one required), using declared `contains`,
`notContains` and `minLength` conditions. It records the platform evaluator,
condition, source version refs, checked byte count, attempt, result and action.
It creates no ACP prompt, native session/turn or model read receipt.

`abort`, explicit `continue` after failure, and `goto` an earlier agent work with
zero to five declared retries (default one). Retry feedback must target an agent
inside the retry range. Counter and outcome evidence persists in events/steps;
subsequent manifests also retain the actual counters. Provider/side-effect
uncertainty never enters the goto loop. Explicit continued failure stays failed
in the graph even when the declared overall flow continues.

Tools, native `maxRounds`, `saveOutputAs` variable binding, enabled completion notification/note adapters,
unsupported expression forms and actual parallel execution remain unavailable
and reject before admission. Their owning later tasks still owe the full scope;
no parallel drain or arbitrary graph topology is simulated here.

## Validation and limits

`scripts/smoke/workflow-revisions.mjs` runs the actual coordinator, worker-backed
file SQLite, immutable store and stage driver with an explicitly owned native
transport fixture. It covers invalid drafts, duplicate/competing client requests,
boundary and immediate stops, cancellation, delayed creation, late finalization,
unknown shutdown, late predecessor events, content-gate retry/exhaustion,
ordinary stop precedence, archive, actual child process exits before/after
adoption commit, lost acknowledgement and execution drift after drain.

These tests do not prove vendor shutdown, rendered adoption interaction, actual
parallel drain, installed packaging or team/Jira acceptance. Reopened commands
without a recovered live controller remain explicit recovery-required; no resume
or replay is inferred from saved metadata. Root owns the native/UI acceptance and
canonical spec updates before task closure.

## Conversation revision and recovery surfaces

The existing composer-top workflow panel exposes **调整后续流程** and
**检查保留记录**. These remain in the conversation, including its optional
top-right placement. A conversation with no task binding exposes only the
explicit recovery launcher; it does not invent a task or offer managed startup.

Revision captures the exact current run before editing. Select a real template,
reason, source-defined input values, selected start step and either the current
stage boundary or an immediate canonical stop. The backend validates the source
and returns frozen before/after graphs and semantic mappings. After preview the
form becomes a compact editable summary, giving the node comparison and impact
more space. Added/removed/changed nodes and edges have text as well as restrained
visual treatment. On narrow screens the graphs stack. Prior run geometry and
documents stay mounted underneath the explicit modal.

Source options have independent loading/readiness ownership. Editing the reason
does not discard an in-flight field-schema read; unreadable/loading source options
block preview until a successful read. Main still validates actual source/input
semantics before any adoption.

The preview shows affected/preserved definitions, pending boundary output and
actual material references. Existing artifacts are input-only: retained source
does not imply skipped execution, business approval or native memory reuse.
Platform gate provenance identifies artifact evaluation rather than a fabricated
native Agent session. Failed-continue and not-selected nodes retain their own
truthful labels.

Adoption requires an explicit action on the current unexpired preview. The UI
saves one lookup identity locally before sending: root/task, original run,
preview ID and command UUID, with no body, credentials or authority scope. It
does not evict old unresolved identities at its64-record bound. Corrupt/full or
unwritable storage blocks dispatch and preserves existing records. Main's actual
durable command remains authoritative. A lost response enters reconciliation;
retry is offered only after an explicit missing-receipt read and uses the same
command/payload. A missing receipt is not proof an in-flight request cannot commit.
Reopening the task reloads its original command identity. Historical terminal
records can be explicitly closed before preparing another revision.

Status reads distinguish saved, waiting-boundary, stopping, stop-unconfirmed,
stopped, successor-starting, running, adopted, failed, cancelled and
recovery-required. They poll only while the active source's dialog is open and
visible. Cancellation keeps the same command and preserves unresolved stop
evidence; cancellation after stop does not resume the old writer. Project/task/
interaction changes immediately hide old owned portals and discard late UI
completions without pretending already admitted commands rolled back.

Recovery is an explicit read-only retained-owner request. An exact requested run
cannot fall back to a newer head; an initial owner-head read becomes fixed after
its first real reply. Missing/ambiguous source details remain visible alongside
the original graph, immutable outputs and session/turn/history watermark. Artifact
opening uses recoveryArtifact and a main-owned fixed-version token. No renderer
historical body, replacement task path or guessed title grants access. Historical
permissions are not reconstructed. There are no force-unlock, replay, guessed
stop-success or automatic resume controls.

Returning from a native document can precede the first asynchronous conversation
catalogue. Console resolves that exact source through acpHistorySession rather
than waiting on mutable catalogue initialization or selecting a neighbour. Current
project/session/interaction checks reject late old targets. An explicit fixed
source return does not automatically restore a closed native connection or
replace its recorded generation; native recovery remains a separate action.

`scripts/smoke/workflow-revision-render.mjs` mounts actual React, ReactFlow,
InteractionScope, shared modals and Console in isolated Chromium. Its backend,
native-window and provider calls are declared fixtures. It covers invalid/expired
drafts, source inputs/boundaries, acknowledgement loss, original command persistence,
storage failure/bounds, actual status distinctions, fixed recovery/history,
missing/ambiguous/foreign sources, late source replies, stable DOM/selection/
viewport and light/dark/narrow/zoom captures. This UI evidence does not replace
actual vendor revision/drain, installed/human display or full source acceptance.


### Independent renderer review refinements

Pending-command storage rejects a damaged same-task lookup or a different
observed command instead of overwriting it. Explicit terminal-history cleanup
must match the command being closed. Reopening rereads that task's retained
lookup without dispatching it. These are local lookup safeguards; localStorage
is not the cross-client execution mutex. Durable main control reservation/CAS
still prevents competing successors.

Readonly recovery is also reachable from the project header when no conversation
is selected, without creating a native session or inventing task/session metadata.
Opening an original stage's full transcript through a workflow reference suppresses
automatic reconnect, just like fixed-document source return. Ordinary sidebar
selection retains its existing behavior; explicit native resume remains separate.

Coordinator gate-result/gate-aborted evidence has an actual payload nodeId and no
native step/session. The renderer uses that platform event identity with its exact
run rather than dropping the evidence or fabricating native provenance.

Both frozen comparison graphs have explicit zoom and full-graph controls, including
keyboard-focusable buttons, for narrow/high-zoom views. User-invoked fitting may
change their viewport; passive workflow/status updates do not reset it.
