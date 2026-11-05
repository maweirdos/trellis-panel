# Platform task executions v2

## 1. Scope / Trigger

Use for shared execution identity, claim/report/finalization/release/transition,
historical receipts and the typed desktop execution bridge. Native launch,
filesystem admission and resource authoring keep their existing owners.

The HTTP service and desktop bridge reuse their existing owned SQLite workers,
authentication, business actions, mutation receipts and events. Version 2 is
independent of the version 1 team/progress contract and local WorkflowScope keys.

## 2. Signatures

Schemas and inferred types live in `src/shared/team-task-execution.ts` and are
exported by the team-service entry point. `teamTaskIdentity(TeamTaskRef)` encodes
instance, project, space, task ID and original task creation identity. Epoch is
an admission fence, not a durable task ID. References contain no task directory.

Base route: `/api/projects/:projectId/hifox/tasks/:taskId/executions`.

| Operation | Input / result |
| --- | --- |
| GET base | Query `contractVersion=2`, `instanceId`, `spaceId`, `taskCreatedAt`; returns `TeamExecutionView`. |
| POST `/commands` | `TeamExecutionCommand`; returns committed/duplicate `TeamExecutionReceipt`. |
| POST `/reconcile` | The full original command; returns its receipt or null without dispatch. |
| GET `/:executionId` | Same task query; returns retained `TeamExecutionRecord` under current access. |

`DesktopTeamApi` exposes `executionRead`, `executionHistory`, `executionCommand`,
`executionReconcile` and `executionPending`. Scope is `{connectionId,task}`;
commands add `command`, history adds `executionId`. Pending adds optional cursor
and limit and returns `{contractVersion:2,connectionId,task,items,hasMore,nextCursor}`.
It defaults to 50 items, at most 100, with a serialized page ceiling of 3 MiB
minus 64 KiB under the existing RPC limit. A valid near-2-MiB command must remain
readable with its page/intent metadata. `TaskExecutionTransport` validates the
original task, person/device, canonical payload digest and receipt.

Service schema version 18 adds `team_task_execution_heads` and
`team_task_executions`; version 19 adds the private `businessBoundaryJson` to
separate business advancement from write/input fences. Retained v18 boundaries
remain unknown rather than being reconstructed from current inputs. A partial
unique index admits one active execution per project/task. Command identities
and results use the existing commands infrastructure. Desktop schema version 5
retains original intent identities across bounded queries and restarts.

## 3. Contracts

- Every command carries version 2, UUID, task reference, expected epoch,
  original `expectedActorId`/nullable `expectedDeviceId`, generation and nullable
  execution ID. The authenticated principal must match those original facts.
- `claim` captures ownership mode, method/executor references, selected input
  reference, predecessor and node/attempt. It does not invoke native execution
  or establish that a model used the supplied references.
- Claim is current-handler-only and generation checked. A v1 progress binding
  excludes a new v2 claim; an active v2 execution excludes a new v1 binding.
  Legacy tasks without a v2 writer keep their original progress behavior.
- `report` accepts bounded single-line step/blocker, monotonic sequence and
  owner-reported native state. Write authority (`active`, `released`, `revoked`)
  is separate from native state. Native verification remains `owner-reported`.
- `finalize` validates supplied fixed approved task-document versions and content
  digests through the existing document authority. It neither passes business QA
  nor grants final acceptance. Other artifact kinds remain unsupported until
  their actual resolver is installed.
- Ordinary business handoff requires completed finalization with confirmed
  outputs. Revalidate those versions at transition. Releasing a writer cannot
  bypass the ordinary handoff gate. Existing task domain roles still decide
  which actions and recipients are allowed.
- Keep business-boundary identity separate from the full input/resource/write
  fence. Summary changes, withdrawal or revoked authority do not prove a
  business handoff occurred and cannot skip finalization. An unknown retained
  boundary must not silently exempt the task from required output checks.
- V2 transition and existing business-command paths share transition admission
  and progress/execution invalidation in the same service transaction. Forced
  manager reassignment/cancellation may revoke writes while native state stays
  unknown. Preserve retained history and original cleanup/reconciliation access.
- Historical receipt authorization checks current task read access, original
  actor/device/reporting owner, exact command scope/hash and service epoch.
  Handler changes, revoked execution authority and a successor generation do
  not erase an otherwise authorized receipt. A duplicate confirms the original
  effect and cannot restore write authority or populate a current-run cache.
- A new write still requires the current handler, active original execution,
  generation and current selected input/resource authority. Current account,
  membership or device revocation also applies to receipt reads. Later access
  restoration does not reactivate a revoked device credential.
- Reconciliation with no receipt checks the supplied current scope/CAS and may
  return null. Null does not prove an in-flight request cannot commit. Do not
  invent a replacement UUID, target or payload after acknowledgement loss.
- Desktop persists the exact original intent as profile-local SQLite JSON before
  transmission. Credentials use the existing protected secret owner; command
  bodies are not additionally encrypted and must contain no credentials or raw
  private transcripts.
  States distinguish dispatching, acknowledgement-unknown, committed and
  rejected. Retries are explicit original-command operations; a changed
  connection/person/device/project cannot adopt an old intent.
- Command preflight performs one connection/UUID lookup. Pending reads filter
  by original task and noncommitted state before returning bounded pages under
  the actual RPC byte limit. A large committed history cannot make a new command
  fail merely because a client tried to hydrate that history.
- Count intent storage usage in actual UTF-8 bytes, including existing rows.
  Quota rejection of a new UUID must retain original records and permit their
  bounded lookup and recovery-state updates.
- Execution IPC admits only the original trusted main-window main frame.
  Credentials and native grants are never renderer arguments. Supplemental Web
  views and independently opened editors do not inherit that GUI capability.

## 4. Validation / Error Matrix

| Condition | Required result |
| --- | --- |
| Two initial claims for one task/generation | One committed writer; competing claim conflicts. |
| Same UUID and exact body | Original receipt, no repeated semantic effect. |
| Same UUID with changed body or target | Conflict; retain original intent. |
| Lost acknowledgement after successful handoff | Authorized original reporter can recover the receipt; former writer remains revoked. |
| Fresh report from a former writer | Reject without reviving progress or native ownership. |
| Wrong account/device/instance/incarnation/epoch | Reject before mutation; no retarget. |
| V1 reporter versus v2 claimant | Both directions preserve the single effective writer. |
| Draft, wrong-scope or changed-digest output | Reject finalization/handoff dependency. |
| Release without ordinary handoff evidence | Release cannot turn missing output into business acceptance. |
| Forced reassignment with unknown native state | Revoke shared writes; retain unknown process fact. |
| Current permission or resource/input loss | Reject further use/replay as required by its current authority. |
| Unsupported command version | `UNSUPPORTED_EXECUTION_VERSION`; no effects. |
| Worker/HTTP acknowledgement loss | Retain original identity and reconcile; no guessed failure or stop. |

## 5. Good / Base / Bad Cases

Good: a completed handoff loses its HTTP reply. The original reporter still has
task read access, recovers the old receipt and reads the new active projection
separately. A fresh old-generation report remains rejected.

Base: a task receives a v2 claim and short owner-reported progress while no
engine or local project exists. The record makes no claim of native execution.

Bad: require current write ownership to read a committed handoff receipt, use a
cached receipt as a new grant, or infer native shutdown from writer revocation.

## 6. Required Verification

Use isolated OS TEMP accounts/stores and actual authenticated HTTP routes plus
the owned worker. Verify claim races, UUID/body conflicts, sequence monotonicity,
both v1/v2 interlocks, approved-document gates, handoff/revocation, restart and
recovery after the former handler changes. Include original actor/device and
current access rejection paths. Verify schema 17-to-18 migration preserves v1
records, schema 18-to-19 retains conservative unknown business boundaries, and
future schema versions fail before writes.

Exercise the production typed transport using an actually enrolled device;
verify identity mismatch fails before a network write and receipt digests match
the original payload. Desktop worker checks with an injected encryption adapter
do not establish real Electron window authorization or OS-protected storage.

Run affected root/team-service typecheck and build. Preserve `check:acpx`,
`check:ui` and packaging guards, running the applicable ones. Keep validation
scripts/results outside the repository and do not add test-only dependencies.

## 7. Wrong versus Correct

Wrong: `currentHandler && activeExecution` is required for every historical
receipt, so a committed handoff becomes unknowable after changing the handler.

Correct: authorize the original receipt against current readable task scope and
original reporter/command identity. Apply active handler/generation checks only
when admitting a new write; returning history never renews authority.
