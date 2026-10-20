# Managed workflow contracts v1

R0-01 adds a clean-room shared boundary under `src/shared/workflow/`, following
TPD-009 and TPD-026. It validates data and produces a pure definition projection.
It has no scheduler, database, IPC handler, model loop, native permissions or
business-state writer. Existing Flow, ACP and Jira paths are unchanged.

## Public entry points

Import from `src/shared/workflow/index.ts`. All external values are validated by
Zod and public data types are inferred from the schemas.

| API | Meaning |
| --- | --- |
| `workCatalogSchema` | Project issue links, independent local task bindings and requirement-to-issue links |
| `versionScopeSchema` | Jira version/branch scope, query time, known total and explicit completeness |
| `workflowScopeSchema`, `jiraIssueRefSchema`, `localTaskRefSchema` | Stable scoped references, never labels or the selected UI item |
| `executorBindingSchema`, `capabilityFactSchema` | Exact engine/config/adapter versions and supported/unsupported/unknown facts |
| `agentRoleRevisionSchema`, `materialVersionSchema`, `contextManifestSchema` | Pinned role/method/material identity, actual inputs, instruction, source/provided digests and baseline/output contracts |
| `workflowRunSchema`, `workflowStepSchema`, `runManifestSchema` | Managed execution state and adopted snapshots, separate from Jira and local archive |
| `workflowCommandSchema`, `verifyWorkflowCommand` | Versioned intent, expected revision and verified canonical payload digest; no admission or dispatch |
| `executionEventSchema`, `contextReceiptSchema` | Actual source/attribution/sequence and distinct prepared/assembled/emitted/read/check facts |
| `snapshotLegacyTask` | Nonmutating original JSON snapshot with custom status/fields preserved |
| `adaptLegacyFlow`, `readLegacyFlow` | Current Flow v1 parsing and explicit unsupported adaptation, retaining original JSON |
| `compileWorkflowDefinition` | One validated definition to a matching execution-plan/graph projection plus full input fingerprint |

`compileWorkflowDefinition(raw, context, digest, layout?)` returns
`Promise<CompiledWorkflow>`. `digest` implements
`(canonicalJson: string) => string | Promise<string>` and must return lowercase
64-character SHA-256 hex. Node callers can use `node:crypto`; browser callers can
use their existing Web Crypto adapter. The shared module imports neither.

`verifyWorkflowCommand(raw, digest)` recomputes the actual canonical payload
digest. It does not perform the later command-ID dedup, expected-revision CAS,
transaction or remote reconciliation. R1-01 owns those operations.

## Identity and state ownership

Jira identity is `(instanceId, issueId)`, not a human-readable issue key. Local
identity includes repository, workspace and the verified stable task reference.
Definition node identity includes definition revision, phase and step; a step
instance adds project/workspace/task scope, run revision and attempt. Helpers
serialize JSON tuples to avoid delimiter collisions. They never resolve paths,
guess aliases or grant access.

An issue can have multiple local task bindings with independent status/archive
facts. Archiving one binding does not advance the remote status. One requirement
version can link multiple issues. Jira progress, local Trellis progress and
managed runtime progress have no automatic conversion in this module.

An event without verified task/run ownership uses `attribution.kind =
'unassigned'` with a reason. A text payload saying “done” remains payload and
does not create a check pass, issue completion or observed internal child agent.
Assigned step/run identities must agree. Unknown capability facts cannot satisfy
a required capability and do not trigger an implicit engine fallback.

All privileged callers must still resolve trusted scope, authorization,
directories and current capabilities at their application boundary. JSON schema
validation and pinned configuration are not authorization. Generic JSON payloads
must not be published without domain-specific redaction and permission checks.

## Definition, gates and projection

The authoritative `flow` retains the existing Flow v1 agent/tool/gate structure,
inputs and hooks. A versioned wrapper adds adopted role/executor bindings and
explicit Trellis phase mapping. This does not introduce a second editable graph
DSL or a replacement for Trellis Markdown/spec files.

The current shape describes sequential phases/steps. A gate retains its actual
check, abort/continue/goto behavior, explicit retry bound and feedback target.
The projection includes sequence, check, retry and feedback edges. Missing
`feedbackTo` on a goto gate uses its configured goto target, matching the existing
legacy implementation's declared behavior. The default retry bound is one.

Forward/self checks or goto, missing targets, duplicate phase/step identities,
unknown node kinds and incompatible versions are rejected for managed adoption.
The adapter returns `UNSUPPORTED_LEGACY_FLOW` and the original JSON. It does not
rewrite an old definition or change the existing runtime's permissive behavior.
A legacy file with an empty phase is similarly retained but not adopted.

A compiled graph is declared topology, not evidence that a scheduler or engine
executes its edges. Generic parallel scheduling, arbitrary TypeScript analysis,
dynamic revision adoption and actual ZCode driver/journal integration remain
downstream work. Configured gate failure/continuation data remains on plan nodes;
the graph alone must never be used to reconstruct the full execution semantics.

Plan/graph node and edge identities match exactly and the compiled result is
recursively frozen. Layout coordinates/collapse state are a separate validated
view value. Changing them cannot change topology or the input fingerprint;
foreign-revision layout nodes are rejected.

## Materials and input fingerprints

Context manifests carry effective instructions and actual input values, source
material versions, full original/provided-content digests, role/method snapshots,
engine/config/capability snapshots, output schema and engineering baseline.
The fingerprint covers that data and the effective definition/plan. Persistence
timestamps are excluded. Object key order is canonicalized; material arrays
retain their declared order because order can affect the actual prompt.

Whole-file and provided/truncated bytes are distinct identities. Full inclusion
requires matching digests; truncated inclusion requires both full digests;
index-only/unavailable entries cannot claim a provided-content digest. The short
reader revision stays a display/source-check identifier, never a full digest.
Duplicate source/version entries are rejected for the context planner to resolve.

`reuseEligible` is conservative: the context must be declared complete, have a
known engineering baseline and contain only actual full/truncated materials. It
does not prove that a cached result exists, is authorized, is fresh or can safely
be reused. The later coordinator must check those conditions and current access.
Material workspace-relative paths are a transport constraint, not a substitute
for the existing main-owned filesystem root/canonical-path fence.

Immutable method/role/extension lists reject repeated `(assetId, version)`
entries, including identical duplicates; callers deduplicate identical pins
before admission. Reusing a method across different roles is allowed when its
identity/version/digest agrees. Conflicting digests across the adopted role,
method, executor-configuration, extension, baseline and output-contract pins are
rejected. Schema validation cannot prove that a supplied digest matches the
actual stored package; the publishing/adoption service must read and verify it.

## Migration and fallback

### Concrete adapter ports

`ports.ts` exports transport-neutral interfaces and runtime validators for their
request/result values. These are current R0 types; their real implementations
are not integrated. Each adapter validates both sides and correlates returned
operation IDs with the dispatched request.

- `WorkflowDriverPort.dispatch(DriverDispatch)` receives an operation identity,
  owner fence, pinned run manifest, exact step instance, compiled node and selected executor
  binding. Its acknowledgement is accepted/rejected/outcome-unknown with actual
  native session/turn references when known. Acceptance is not step success.
- `requestStop(DriverOperationRef)` distinguishes requested/stopped/unconfirmed/
  rejected. `reconcile(DriverOperationRef)` returns confirmed/unresolved/conflict
  evidence; it never means blindly repeat the external operation. Drivers must
  check the active owner fence and actual directory/process ownership at use.
  The application constructs that node from the adopted definition; validating
  a client-supplied node identity alone is not proof of its instruction content.
- `WorkflowReportSinkPort.append({event, payloadDigest})` returns a durable
  committed/duplicate cursor or an explicit conflict/storage failure. The sink
  must verify actual payload bytes and event identity. Buffered delivery or an
  optional observation write cannot acknowledge a durable control event.
  Its digest covers the canonical full event envelope, retaining attribution
  and source identity as well as payload; the returned control cursor is
  separate from the incoming source epoch/sequence.
- `WorkflowJournalPort.commit(JournalCommit)` receives verified command,
  expected current run, owner fence, run changes, assigned events and outbox
  records. The real R1 store must atomically perform command-ID/payload dedup,
  expected-revision and owner CAS, run changes, event append and outbox append.
  Validation rejects cross-scope batches; it does not implement the transaction.
  A duplicate returns the original committed result. A crash before commit
  leaves the old state. `load(scope, run)` returns the run, adopted manifest and
  committed cursor, or explicit absence.

Journal admission relates every change to the command's target run/revision.
Revision adoption may also change one direct successor with an explicit matching
predecessor; it can use either a new run ID or a later revision of the same run.
Start, stop and reconciliation commands do not admit unrelated successor changes.
Assigned events and outbox records must refer to the target or one of those
admitted run changes. Newly admitted outbox records carry the transaction owner's
exact identity and fencing token; a nullable owner in a standalone operation
record does not permit an unclaimed dispatch inside an owned admission batch.
An available snapshot manifest agrees with both run identity and adopted
definition identity/revision. These consistency checks do not replace the actual
R1 store's current-owner/revision CAS or durable transaction.

Driver dispatch occurs only after committed admission/outbox ownership. External
acknowledgement loss remains unknown until reconciliation; no port promises a
cross-database or remote exactly-once operation. A later native/history reference
does not replace control-store durability. Report-sink append handles later
runtime facts; it must not be used to split journal admission into several
non-atomic writes. R1 owns cursor reset/replay and actual lease expiry/recovery.

| Existing authority | R0 treatment | Downstream integration |
| --- | --- | --- |
| `task.json` and formal Trellis CLI | Snapshot custom fields/status without writes | Existing alias resolver and official task operations remain authoritative |
| `jira-source.ts` / connector identity | Use resolved instance/object IDs | Preserve legacy ambiguous-source diagnosis; never infer from issue key |
| `flow.ts`, `flow-run.ts`, `FlowDef` | Validate/wrap current Flow v1; retain original JSON | Adopt only supported definitions through a future explicit adapter |
| ACP facade and patched acpx | Reference engine capabilities and versions | R1-02 owns real stage/permission/lifecycle behavior |
| Existing document controller | Require version/digest references | R1 material adapter captures actual bytes; no competing reader |
| ACP history and observation stores | Store reference/receipt contracts only | Existing transcript history remains the only full-text archive |
| Local control store | Define command/run/event authority | R1-01 owns worker migration, admission transaction, outbox and recovery |

R0 is additive and is not integrated into the legacy runtime. The immediate
fallback is the unchanged existing execution path. No database/file migration,
external action, new dependency or credential handling is introduced here.
Later adoption must be explicit, versioned and backed by actual environment
acceptance. The four R0 contract checks do not close A05/A08/A17/A19/A25 as whole
product scenarios.

## Fixed-source reuse decision

New code and this document are independently written. No external source,
patches or documentation text has been copied into product outputs. Existing
research quotations stay evidence; this module imports no ZCode/DSH code.

| Reference | Fixed baseline and license evidence | Adopted boundary and remaining work |
| --- | --- | --- |
| ZCode | `0a1fc56d279fd1001f78387bd81aec1c26767411`; root Apache-2.0 license inspected locally | Learn one definition/plan/projection and driver/report/journal boundaries; pure orchestration and runtime packages are source candidates, not integrated. Future reuse must comply with TPD-009 and receive its applicable approval rather than silently vendor code. |
| DeepSeek harness | `687f282e8625c6b8d11ff58211a90524be2e4317`; root MIT license inspected locally | Learn contribution/instance lifecycle boundaries. Cordis scope is not an OS sandbox; retained versions, authorization and cleanup outcomes remain platform responsibilities. No Cordis dependency or plugin runtime is added by R0. |
| Existing acpx | Application pin `0.19.5` with compatibility marker 2 | Retain existing patched transport. Contract projection is not proof of real model cancel/resume/child/structured-output capability. |
| MCP Apps / ZCode UI Plugin | Previously researched mechanisms, not a new dependency in this task | UI Host/resource/tool bridging and native views remain R4 work. ACP does not imply MCP Apps support. |

Primary source identities can be checked at the fixed
[ZCode commit](https://github.com/zai-org/ZCode/tree/0a1fc56d279fd1001f78387bd81aec1c26767411)
and [DSH commit](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317).
The local source check for this implementation inspected both HEAD identities and
root license declarations. This does not assert license coverage for every
vendored asset, example or dependency in either repository.

## Verification

Run `node scripts/smoke/workflow-contracts.mjs`. Its optional
`--report <existing-directory/file.json>` writes the actual result. The smoke
bundles and executes the real shared code and separately bundles it for a browser
target. It covers independent work states, identity/legacy compatibility, invalid
references, matching graph/plan IDs, layout invariance, input invalidation,
capability limits, material provenance, unknown attribution and command digest
integrity.

`npm run typecheck` and `npm run build` check repository compatibility. A
browser-target bundle is not a browser interaction test. No real engine, Jira,
database recovery, UI, permission enforcement or distributed transaction is
exercised by these R0 contract fixtures.
