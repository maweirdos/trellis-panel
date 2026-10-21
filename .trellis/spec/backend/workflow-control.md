# Durable workflow control

Clean-room platform contracts. Read together with shared/workflow-contracts.md
and the existing database/IPC/ACP contracts. This service does not execute native
Agents or external business actions.

## 1. Scope / Trigger

Read before adding workflow admission, command recovery, run projection,
dispatch/reconciliation, ownership or team outbox consumers. Implementation is
`src/main/services/workflow-control/` and the standalone built worker is
`out/main/workflow-control-worker.js`.

Workflow tables live in the existing project's `control.sqlite`. Their schema
version is separate from the legacy `control_schema_meta` version. Preserve task
aliases, source links and local operations; do not create an observations or
transcript store merely to open workflow control.

## 2. Signatures

The main-owned service implements the shared journal/report ports:

```ts
new WorkflowControlService(runtimeDir: string, options?: WorkflowControlServiceOptions)
open(): Promise<WorkflowControlHealth>
workspaceOwner(identity: { projectId: string; repositoryId: string; workspaceId: string }): Promise<WorkspaceLease | null>
claimWorkspace(scope: WorkflowScope, ttlMs?: number): Promise<LeaseResult>
renewWorkspace(scope: WorkflowScope, owner: WorkflowOwner, ttlMs?: number): Promise<WorkspaceLease>
releaseWorkspace(scope: WorkflowScope, owner: WorkflowOwner): Promise<void>
commit(journal: JournalCommit): Promise<WorkflowWriteAcknowledgement>
commitWithManifests(input: WorkflowCommitInput): Promise<WorkflowWriteAcknowledgement>
load(scope: WorkflowScope, run: RunRef): Promise<JournalSnapshot | null>
head(scope: WorkflowScope): Promise<JournalSnapshot | null>
append(report: WorkflowEventReport): Promise<WorkflowWriteAcknowledgement>
events(input: z.input<typeof eventPageInputSchema>): Promise<WorkflowEventPage>
claimOperation(input: z.input<typeof operationInputSchema>): Promise<OperationRecord>
settleOperation(input: z.input<typeof settleOperationInputSchema>): Promise<OperationRecord>
reconcileOperation(input: z.input<typeof reconcileOperationInputSchema>): Promise<OperationRecord>
recoverProcessOwner(scope: WorkflowScope, expectedOwner: WorkflowOwner): Promise<WorkspaceLease>
close(): Promise<void>
```

Exact inferred DTOs and command/alias/step helpers are exported by `types.ts` and
`service.ts`. The owning application resolves trusted root/task/project and
current grants. Parsing a client-supplied scope is not authorization, and the
renderer never supplies the controller's owner identity.

## 3. Contracts

### Storage, admission and delivery

- Use the existing DELETE/FULL baseline. Migrate additive `workflow_*` tables
  atomically and reject unsupported future schemas before new writes.
- The service serializes workflow RPCs through its worker. Legacy local-task and
  observation connections still exist; SQLite short transactions coordinate the
  shared database. Do not describe this as migration of all writers to one worker.
- Command identity, canonical payload, expected run/revision, run/manifest
  changes, events and outbox admission are one control transaction. Reuse the
  same command ID after lost acknowledgement; inspect persisted facts before
  deciding what happened.
- Outbox pending → dispatched is persisted before an adapter is invoked.
  Dispatched/unknown operations cannot be claimed as a new attempt automatically.
  Settlement/reconciliation needs actual evidence references, not an assumption
  that a failed response means no side effect occurred.
- Ordinary execute-step dispatch belongs to the current active head, excluding
  stopping/terminal/unknown heads. Missing operation purpose is ordinary execution.
  Explicit stop-run/reconcile intents can address real admitted predecessors under
  the same owner/fence; an arbitrary operation name does not grant that exception.
- Commit/duplicate acknowledgements refer to committed control cursors. History,
  observations, remote team storage and Jira have separate transaction domains.

### Owner and recovery

Workspace ownership carries controller PID, opaque owner ID and fencing token.
Lease expiry or writer exit alone cannot prove native execution stopped. A live
controller may still own tools/background work after its database worker exits.
Reopen the writer and query facts under the same owner; another owner cannot
steal the workspace simply because a response timed out.

Recovery checks the recorded owner/fence and actual process liveness. Preserve
uncertain operations for reconciliation. A task/window selection does not own the
run; closing a reader must not release execution ownership.

`workspaceOwner` is a read-only lookup using the actual pinned workspace identity.
It returns the original retained scope/lease, including released or uncertain
ownership facts, or null; it does not fabricate a taskRef, renew a lease, write an
event, create authority from UI history or reinterpret expiry as release. Reject
a project mismatch. An uncertain operation can still fence a released row; callers
must apply actual operation/recovery semantics before admitting a competing writer.

### Events, history and bounded work

Event `payloadDigest` hashes canonical JSON of the complete source ExecutionEvent.
Keep source epoch/sequence while using the control log's own committed cursor.
Late old-revision events remain history and do not change the active run head.
Cursor reset/gaps are explicit. Workflow stores session/turn/history references;
the existing history service alone owns transcript text and its commit watermark.
Input fingerprints and ordered material-version pins are immutable within a
step attempt. Later session/turn/history/output evidence may fill in; changed
effective input requires a new attempt or revision. Preserve a run's original
creation time when updating its status.

Requests, pending bytes/counts, event pages and deadlines are bounded in the
exported constants. A worker timeout is acknowledgement-unknown; it is not proof
the queued write was cancelled. Legacy main-thread LocalControlStore waits at
most its named 50ms lock budget and does not spin synchronously; transient busy
is distinct from corruption, with the intent-before-CLI boundary preserved.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Same command and same canonical request | Return existing committed result |
| Same command ID with different payload | Explicit payload conflict |
| Wrong expected revision or competing successor | Conflict; no partial run/event/outbox |
| Stale owner/fence | Reject protected write/dispatch |
| Writer exits while controller remains alive | Preserve ownership and dispatched facts |
| External acknowledgement missing | Unknown; query/reconcile before retry |
| Unknown or foreign cursor | Explicit reset semantics; no fabricated completeness |
| Legacy alias/source/operation tables exist | Preserve them across workflow migration |
| Legacy main write contends | Bounded busy result, no CLI call without intent |
| Unsupported future schema | Refuse writes, retain existing files |

## 5. Good / Base / Bad Cases

Good: two clients race one expected revision and only one successor commits.
After a response is lost, querying the original command returns its real outcome.

Base: open workflow control in an unobserved project without creating either an
observations database or a second transcript archive.

Bad: release the workspace after a writer crash, reset unknown outbox work to
pending, or report history persistence from a received-but-uncommitted event.

## 6. Tests Required

`node scripts/smoke/workflow-control.mjs` exercises real file SQLite, distinct
processes, actual worker RPC, rollback/exit, command races, ownership/fencing,
outcome uncertainty, legacy preservation/contention and bounded queue behavior.
Its build-path check must actually load the emitted workflow worker and retain
diff/observation/history worker outputs. Process exit is not power-loss proof.

Run typecheck/build and the affected legacy local-task/observation checks after
changing shared control behavior. R1 control acceptance alone does not prove a
native driver, live graph, team service or Jira action works.

## 7. Wrong vs Correct

Wrong: “the database worker stopped, so the old coding process is dead.”

Correct: verify controller/execution ownership, preserve durable unknown intent
and require actual stop/reconciliation evidence before conflicting work starts.
