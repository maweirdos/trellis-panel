# Durable workflow control

This independently authored R1-01 implementation extends the existing local
`control.sqlite`; it performs no model, native execution, Jira or network action.
It implements the journal/report ports defined in `src/shared/workflow/`.

## Storage and writer boundary

The trusted application supplies its existing absolute runtime directory,
normally `<project>/.trellis/.panel/runtime`. The worker uses Node `node:sqlite`,
the existing `CONTROL_SCHEMA_V1_DDL`, DELETE journal and FULL synchronization.
No new SQLite package or separate workflow database is introduced.

One serialized workflow worker handles this service's high-frequency writes.
Legacy LocalControlStore and observation-worker control connections still exist;
SQLite short transactions coordinate those connections. This is not a claim
that all legacy writers have moved into one worker.

Legacy main-thread LocalControlStore uses a named **50ms SQLite busy timeout**.
It does not synchronously spin/retry. A failed pre-CLI intent insert performs no
external action; deliberate retry follows the existing idempotent local-task
path. Transient migration lock failures report `currentState='busy'`, preserving
the original file instead of calling it corrupt. Configured SQLite lock budget
and end-to-end wall time are different measurements; smoke evidence records both.

The worker checks both base and workflow future versions before schema writes
and again after obtaining its migration lock. The legacy schema version remains
unchanged. `workflow_meta.schemaVersion=1` and a persistent store epoch are
independent of the base metadata. Missing compatible workflow tables are added
atomically; aliases, source links and local operations are preserved.

## Public service

```ts
const control = new WorkflowControlService(trustedRuntimeDirectory)
await control.open()
const claim = await control.claimWorkspace(verifiedScope)
```

Imports are from `src/main/services/workflow-control/index.ts`.

| Method | Contract |
| --- | --- |
| `claimWorkspace(scope, ttlMs?)` | Acquired/renewed owner+fence or explicit conflicting lease |
| `renewWorkspace(scope, owner, ttlMs?)` | Renew only the exact controller owner/fence |
| `releaseWorkspace(scope, owner)` | Refuse release while dispatched/unknown or active execution remains |
| `reserveCommand(command, owner)` | Durable reservation while waiting for a revision boundary |
| `cancelReservedCommand(scope,id,owner,evidenceRefs)` | Cancel only reserved work, preserve history, release its reservation |
| `commit(journal)` | R0 `WorkflowJournalPort.commit`; no new manifest supplied |
| `commitWithManifests({journal,manifests})` | Atomic command/run/manifest/events/outbox admission |
| `load(scope,run)`, `head(scope)` | Pinned snapshot/current head with committed cursor |
| `append({event,payloadDigest})` | R0 report port; verify the actual whole-event digest |
| `events({scope,cursor?,limit?})` | Scope/store-bound ordered pages and reset indication |
| `getCommand(scope,id)`, `getOperation(scope,id)` | Query the original identity after missing acknowledgement |
| `pendingOperations(scope,owner,limit?)` | Read pending work under a valid, reconciled owner |
| `claimOperation({scope,owner,operationId})` | Persist dispatched+attempt before calling the external adapter |
| `settleOperation({...identity,state,result,evidenceRefs})` | Record confirmed/failed/unknown against actual dispatch ownership |
| `reconcileOperation({...identity,status,result,evidenceRefs})` | Confirm/unresolved/conflict; never reset unknown work to pending |
| `recordStep(record)`, `steps(scope,run)` | Versioned step/evidence refs and acknowledged history links |
| `getAlias(taskRef)`, `upsertAlias(taskRef,id,dir)` | Reuse existing alias/taskRef authority in the worker |
| `syncPage(scope,limit?)`, `confirmSync(scope,ids)` | Stable candidate delivery IDs and acknowledgement, no network send |
| `recoverProcessOwner(scope,expectedOwner)` | Check actual prior process death; preserve uncertainty |
| `health()`, `close()` | Local health and writer shutdown; no implied native-task stop |

The facade bounds requests to 4 MiB, 64 in-flight requests and 16 MiB aggregate
in-flight bytes. The default acknowledgement deadline is 15 seconds. A timeout
retains its in-flight accounting until a real response or worker exit; it does
not make room for an unbounded backlog of still-running writes.

The default worker path is `workflow-control-worker.js` beside the main bundle,
using the existing unpacked-worker path helper. The application's standalone
esbuild worker configuration emits that file. Tests may provide `workerFile`.

## Atomic admission and immutable intent

Within one IMMEDIATE control transaction the service validates current owner,
CAS expectation and revision reservation, writes command/run changes/pinned
manifests, appends events, registers execution outbox and creates candidate sync
records. No model, network, filesystem tool or native process is awaited in the
transaction. Only committed cursors are acknowledged.

Command identity is scoped to the actual task. Canonical intent hashes include
target, kind, expected revision and verified payload digest. The committed
request also pins effective run/manifest/event/outbox intent, so a reused command
cannot silently substitute different materials or operation IDs. Transport
receipt/request timestamps and retry ownership fields do not turn a legitimate
retry into a new business request. Same ID+same intent returns the original
commit cursor; changed intent returns payload conflict without overwriting it.

Different adoption commands cannot reserve the same expected revision. A
scheduled command stays reserved while the current stage continues; final adopt
commit requires one related successor. Cancelled reservations retain their
record/event, release the slot and cannot later be revived. Completed commands
cannot be cancelled or erased.

Run definition/predecessor identity and adopted manifests are immutable. Runtime
status changes do not mutate those pins or rewrite the original run creation
time. An existing step attempt retains its effective input fingerprint and
canonical ordered material references; changed input requires a new
attempt/revision, while later output/history evidence can
still be recorded. Older run events may be appended as
history; they do not overwrite the current head. Callers must still select and
validate applicable real materials and capabilities before dispatch.

## Ownership, uncertainty and shutdown

The lease covers repository+workspace, with the actual project/task scope and a
monotonic fencing token. Another task in the same workspace cannot bypass an
unresolved prior execution. A deadline expiring does not prove the owner dead.
Recovery probes the recorded process and refuses an alive or unverifiable owner.
PID reuse therefore fails safely instead of stealing a workspace.

The execution owner is the controller process. A SQLite writer worker exiting
does not prove its native/background execution stopped. The same service may
reopen its writer and query existing commits under the same controller identity;
it does not release its lease or resend work automatically.

`claimOperation` commits pending→dispatched before the adapter executes. A second
claim fails. The admitted optional operation `purpose` is immutable with its
command intent. Absent purpose means `execute-step` without rewriting old
serialized records. Step execution requires the exact current head run/revision
and refuses stopping, stopped, cancelled, failed, verified or unknown runs.
Explicit `stop-run`/`reconcile` operations may target a persisted older run,
including during recovery, but still require the actual scope owner, valid
lease and fence. Unknown run references never dispatch. This boundary does not
infer scheduler dependencies or step readiness.
Verified dead-owner recovery turns dispatched actions and uncertain
active runs into outcome-unknown. This does not imply the side effect did not
occur. Confirmed reconciliation needs actual evidence, and unresolved/conflict
results remain unknown. Run uncertainty also needs an explicit justified control
update; confirming a dispatch is not final business success.

Recovery and reconciliation update the corresponding dispatch-attempt state in
the same control transaction as the operation. A confirmed operation must not
leave its last attempt falsely reported as still dispatched.

`close()` closes only the database writer. Root application lifecycle must first
stop/drain native work where required, record the actual stop/result, and call
`releaseWorkspace` when safe. Closing a document window or writer is not that
proof. If native outcome/cleanup remains uncertain, retain ownership and expose
the actionable uncertainty rather than allowing conflicting work.

## Events, references and sync

Source event IDs/epoch/sequence are preserved. The stored log has its own
monotonic position. Returned epoch is derived from persistent store identity and
scope, so foreign task/store cursors reset instead of skipping another stream.
Event ID/content conflict preserves the first record and rejects the new one.

The worker stores run manifests and material/step/output references, not a second
full conversation transcript. History links include session/turn/committed
sequence; an uncommitted history reference cannot claim reliable archive. The
existing history/observations databases remain independent transactions.
Deleting optional observation/history fixtures leaves control snapshots intact.

Candidate sync records contain stable event/delivery identities. The later team
publisher must select authorized shareable content; a local outbox row does not
authorize uploading private content or indicate remote delivery succeeded.

## Verification and limits

```text
node scripts/smoke/workflow-control.mjs
npm run typecheck
npm run build
node scripts/smoke/workflow-control.mjs --built-worker --report <existing-report-path>
```

The acceptance smoke uses real file SQLite, actual child process exits before
and after commit, two-process competition, owner/fence checks, an actual file
side effect before owner death, worker exit/deadline/queue cases, legacy lock
contention, caller heartbeat and the actual emitted workflow worker. It also
checks preservation of the legacy worker output files.

Those tests are not power-loss/storage-hardware proof, native engine coding,
full Electron/asar acceptance, actual team synchronization or Jira integration.
Public application/root/IPC authorization and real engine coordination remain
their declared R1 integration tasks. Corrupt/future-version storage is preserved
and refused; this service never deletes/rebuilds it automatically.
