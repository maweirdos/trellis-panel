# Fixed database delivery gate

## Activation and scope

The supported version-1 converter preserves the selected
`database_delivery_gate.py` behavior. A T02 inventory candidate records the
original namespace, import, item key and source digest. Its bytes remain inert.
A published, required governance rule activates the converter through an exact
`database-delivery` JSON descriptor adopted into the task input bundle. Importing
a script or mentioning its path does not activate a gate.

The descriptor fixes `submit_test`, `developing` and `testing`. Task input
validation consumes the gate inside the original business-command transaction.
Ordinary product transitions and execution-command handoffs use that same
validator. A configured rule without an available validator fails closed.
Other business actions keep their existing validation.

## Fixed evidence

`src/shared/database-delivery.ts` defines the descriptor, evidence and SQL
registration schemas. `TeamDatabaseDelivery.validate` resolves the original
T02 source, adopted inputs, completed execution, confirmed delivery manifest,
checkpoint and output versions. The task incarnation, execution generation,
node, attempt, device, native input digest and code-source digest must agree.
The original development business boundary must remain unconsumed.

A delivery contains exactly one confirmed `database-delivery-evidence`
check-report per selected rule, the adopted `implement` document and every
registered SQL as a confirmed `selected-file` artifact. Artifact bodies use the
existing immutable blob reader and current task/output ACL. Withdrawn,
unconfirmed, missing, mismatched or stale references block delivery. A newer
execution, mutable file or unrelated task cannot supply replacement evidence.

`captureDatabaseDeliveryEvidence` reuses T05's retained binding and ownership
checks and T04's selected-file capture/source verification. The mapped rule and
implementation resources must be available in full at their fixed digests.
Recheck the retained preparation around asynchronous reads and verify the
implementation after reading SQL to reject mixed observations. The server
revalidates all fixed bytes; the device observation remains `device-reported`,
without claiming independent server access to the native filesystem.

## Execution entry points

The authenticated native preparation facade accepts
`operation: 'database-delivery'` with the original preparation ID, command UUID,
artifact ID, fixed rule reference, implementation selection ID and selected SQL
references. `confirmDatabaseDelivery` persists the exact `save-artifact`
envelope before submission and reconciles that same UUID and body after a lost
reply. Receipt inspection resolves it through the original preparation and native
authority; it must not accept a replacement actor, grant or generation.

Product execution selects `nativeTaskStart.databaseDelivery` with distinct
implementation and check-report output IDs. Its existing finalization path
captures the selected SQL files, confirms the report and seals those fixed
references into the delivery manifest before checkpoint/finalize.

After `team_task_claim`, `team_task_capture_input` fixes the original execution
input through the existing input-command transport. Keep the original command
UUID, roles and selections for acknowledgement recovery. Account, device, epoch
and task authority come from the current MCP binding; a capture grants no native
filesystem access. `team_task_execution_input` reads the captured digest and fixed
selection bodies before the editor produces delivery evidence.

The editor uses this authenticated MCP sequence:

1. `team_task_save_artifact` saves each selected SQL and the device-reported
   `database-delivery-evidence` JSON as a confirmed check-report.
2. `team_task_seal_delivery` seals the original confirmed implementation
   document, SQL and check-report references. Its `ref` variant accepts the
   existing typed output references.
3. `team_task_checkpoint` fixes the manifest, selected code and source observation.
4. `team_task_complete` submits the existing execution `finalize` command with
   an explicit original command UUID and `teamExecutionFinalizationSchema`.
5. `team_task_transition` requests the business action; the shared server gate
   validates the fixed evidence inside that transaction.

A progress report does not finalize an execution. MCP completion uses the current
account, device, task incarnation and execution generation and grants no new
native filesystem authority. Editor evidence remains device-reported and is
revalidated against server-held immutable artifact bytes.

## SQL registration rules

Only paths registered in the exact adopted `implement.md` body are selected.
PRD, design and research documents are references and do not add SQL files.
Each registered path has this shape:

```text
sql/oceanbase/<release>/<schema>/<YYYYMMDD>_<description>_HONSKY-N.sql
```

Reject path aliases, traversal, invalid depth or filename, duplicate evidence
paths and mismatched tickets. Resolve the ticket from the canonical Jira
issue/task mapping. An unlinked task may use `HONSKY-1111` only when the
published descriptor explicitly retains that original fallback.

Require one unambiguous numeric `ID` or `id` receipt on the filename line or
within three adjacent lines. This validates the retained registration text; it
does not independently query a database upload provider. Inspect at most twelve
SQL files with a maximum of one MiB per SQL. No registered SQL produces the
explicit skipped check result and an empty SQL selection.

## Failure and verification

`DATABASE_DELIVERY_BLOCKED` identifies the affected `submit_test` boundary.
A failure leaves task state and old execution authority unchanged through the
existing transaction rollback. Do not execute an imported script to recover a
failed check or switch to the latest local file.

Keep verification scripts, controlled provider fixtures and reports in OS TEMP.
Verify both product and execution-command entry paths, original source/input
identity, actual selected SQL bytes, receipt proximity, missing SQL, wrong
ticket, withdrawn implementation, changed code/body digests, stale execution
boundaries, duplicate submission and complete rollback on rejection. Run root
and team-service typecheck/build with the existing ACP lifecycle guard.
