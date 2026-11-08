# Jira Business Hooks

## Scope

Jira intake and status synchronization may create or update a platform task
through the current desktop account and device. The GUI issues a separate
protected `business-hook` credential after the selected team connection is
verified. The Daemon reads that credential without opening the DesktopTeamStore
and without receiving a team secret through IPC.

The credential binds the Jira Hook to the original team connection, account,
device, project and service epoch. Disconnect, account/device revocation,
project loss or credential replacement removes the business Hook credential.
An offline or revoked connection returns unavailable or unknown; it never uses
the Jira credential as a substitute team identity.

## Signatures

- NativeTeamBusinessSender.command(operation, input, commandId, { retainUntilEffect? }) sends a scoped Crux command. retainUntilEffect defaults to false; business Hook child commands set it to true.
- confirmBusinessCommands(commandIds) releases only the child identities of a confirmed owning effect.
- linkBusinessTask(input) uses jiraBusinessMappingCommandSchema and recordBusinessEffect(input) uses jiraBusinessEventCommandSchema.
- The local envelope is version 1 with commandId, operation, requestDigest, expectedEpoch and expectedRevision. It contains no provider or team credential.

- `POST /api/projects/:projectId/crux/jira/business-routes/commands` registers the original device route using `jiraBusinessRouteCommandSchema`.
- `GET /api/projects/:projectId/crux/jira/business-dispatches?routeId=...` lists retained pending/admitted/unknown dispatches for that route; `GET .../business-dispatches/:effectId` returns the original dispatch and its current eligibility.
- `POST /api/projects/:projectId/crux/jira/business-dispatches/receipts` uses `jiraBusinessDispatchReceiptSchema`; effect, payload, provider command and job must match before settlement.
- `GET /api/projects/:projectId/crux/jira/business-effects/:effectId` parses the combined path parameters once with `jiraBusinessEffectQuerySchema`.
- `jira_business_routes` and `jira_business_dispatches` retain frozen route/event records inside the existing team-service SQLite writer.

## Jira plan target

Jira plans that enable platform task intake set `platformSpaceId` explicitly.
The Daemon verifies that the current team account can access that Space before
creating a task. A plan without a target Space keeps the existing Jira-local
intake behavior and cannot claim platform task creation.

## Effects and mappings

The team service retains one canonical mapping for `(instanceId, issueId)` and
the returned platform `TeamTaskRef`. A second task mapping is rejected. The Jira
workspace repository retains the original Jira job/effect receipt and the same
platform reference. A platform task is created only after the Jira effect has a
durable owner. Platform create/update commands use their own UUID, current team
epoch/revision and the existing Crux task command writer.
The response must return the same project, account, service epoch and task
identity before the Jira receipt is settled.

An uncertain platform command remains unresolved under its original command
identity. A retry reads the original receipt or reconciles the original task;
it does not create a second platform task or issue. Confirmed platform effects
are recorded with provider job/command identity and a payload digest; the same
effect UUID with another payload is rejected.

Completed status receipts are reusable only for their original job/effect.
A later job may repeat a previously observed status. An unresolved original
status effect fences later jobs and cannot be hidden by a newer applied receipt.

Status updates use the existing task mutation authority and the mapped local
status ID. Ambiguous mappings, unavailable target Space, changed task identity,
or changed task inputs block the effect and preserve the Jira receipt.

Inbound status synchronization crosses workflow categories through the formal
business transition before applying its task patch or recording the effect. A
development-to-testing change must pass `submit_test` and the same published
database-delivery gate as product/editor commands. Gate rejection rolls back
the transition and stops the later patch/effect. Same-category status patches
cannot create a formal business-stage event.

## Committed business actions

Ordinary Crux `transitionTask` and execution-command handoffs share
`CruxWorkspace.applyBusinessCommand`. Preserve the original command UUID through
`TeamTaskExecutions` and `executionTransition`; an empty or regenerated UUID
cannot identify a dispatch. The committed-task callback runs after the new
workspace row is written and inside the same SQLite writer transaction. A
routing failure rolls back both the task transition and dispatch. Command replay
returns the original receipt without invoking the callback again.

A route fixes the authenticated device and owner, team project, target Space,
provider source/binding, Jira plan revision, explicit business actions and
platform-status-to-Jira-transition mappings. A matching canonical issue/task
mapping and real workflow-stage change are required. Generic task updates,
runtime startup, progress reports and archive operations do not dispatch a
business transition. Multiple eligible routes are a conflict.

Space and platform-status IDs use the existing Crux domain schemas, including
IDs produced by `createSpace` and `createStatus`. Team project/device/command
IDs retain their own UUID schemas. Canonical issue ownership is checked by
provider instance and issue across projects; project-local uniqueness alone
cannot authorize conflicting status publishers.

The durable dispatch retains event/effect UUIDs, original business command,
workspace revision, task incarnation, issue and mapping revision, frozen route,
payload digest and provider command/job identities. `pending`, `admitted`,
`unknown`, `applied` and `blocked` remain distinct. Provider settlement requires
original worker evidence. Polling records/adopts work through the existing
integration ledger and scheduler; provider writes stay in the protected worker.
Current task, route, epoch, device, workspace grant, plan and credential authority
are checked again before a provider write. A task-event receipt alone does not
establish Jira delivery.

Pending dispatch reads isolate only `JIRA_TASK_STALE` after current project and
Space access checks. Deleted or replaced task incarnations retain their original
records and cannot settle a provider receipt. Continue through stored batches
until fifty readable dispatches are collected or the retained rows are exhausted;
a first page of stale tasks must not starve healthy work. ACL denial, archived
Space, epoch/device loss and storage failures remain explicit errors.

## Limits

The business Hook uses the existing protected credential directory, task/service
request limits and Jira evidence bounds. It does not create a scheduler, copy
Jira credentials into team records, modify an external repository, or infer a
target Space from the first visible task.

## Error behavior

| Condition | Required result |
| --- | --- |
| Same UUID and changed business input | COMMAND_CONFLICT; preserve original envelope. |
| Wrong issue, project, task incarnation, provider job/command, payload digest or event kind in a response | RECEIPT_MISMATCH; retain the original pending envelope. |
| Envelope unreadable or response lost | ACKNOWLEDGEMENT_UNKNOWN; retain original identity. |
| Credential revoked, absent or ambiguous | Reject before another write; original uncertain receipt remains unknown. |
| Changed epoch, Space, canonical task or source | Block the effect; do not select a replacement identity. |
| Unresolved prior status receipt | E_UNKNOWN; no new conflicting status effect. |
| Same target status in a later resolved job | Admit the new effect; an older applied receipt cannot suppress it. |

## Good / Base / Bad cases

- Base: create the platform task, establish canonical mapping, record the business effect, then release that effect's child envelopes.
- Good: after acknowledged creation but before mapping submission, reconstruct the sender and replay the original create UUID/epoch/revision, then complete the original mapping/effect once.
- Good: after an update commits but its response is lost, replay the original full business patch rather than deriving a different patch from the changed snapshot.
- Bad: release a child envelope on its response before the owning effect settles, reuse an old applied status from another job, or treat a recorded business event as confirmed Jira provider delivery.

## Required verification

Use isolated OS TEMP team accounts, device credentials, Jira responses and
project snapshots. Verify platform task creation/linkage, mapped status update,
duplicate command UUID, changed payload, missing/revoked credential, offline
worker, target Space loss, acknowledgement-unknown recovery, acknowledged-create
interruption before mapping, sender reconstruction with combined status/title
replay, A-B-A-B status cycles and an older unknown hidden by a newer applied
receipt. Run root and
team-service typecheck/build and the applicable ACP guard.
