# Managed workflow shared contracts

Clean-room platform contract documentation. No third-party implementation or
documentation is copied here. Decision: TPD-026; reference policy: TPD-009.

## 1. Scope / Trigger

Read before implementing managed workflow commands, stage drivers, material
assembly, run projections, team synchronization or their legacy adapters.
`src/shared/workflow/` is an additive, transport-neutral Zod boundary. It performs
no scheduling, native Agent invocation, persistence, Jira mutation or permission
grant. Existing Flow and ACP execution stay authoritative for their own paths
until a later explicit adapter integrates the new contracts.

## 2. Signatures

Import the public surface from `src/shared/workflow/index.ts`:

```ts
jiraIssueIdentity(ref: JiraIssueRef): string
localTaskIdentity(ref: LocalTaskRef): string
workflowScopeIdentity(ref: WorkflowScope): string
workflowNodeIdentity(ref: DefinitionRef, phaseId: string, stepId: string): string
stepInstanceIdentity(scope: WorkflowScope, step: StepRef): string

snapshotLegacyTask(raw: unknown, verifiedLocalTask: LocalTaskRef): LegacyTaskSnapshot
adaptLegacyFlow(raw: unknown, ref: DefinitionRef,
  executor: ExecutorBinding): LegacyFlowAdaptation
canonicalWorkflowJson(raw: unknown): string
verifyWorkflowCommand(raw: unknown,
  digest: WorkflowDigestPort): Promise<WorkflowCommand>
compileWorkflowDefinition(raw: unknown, rawContext: unknown,
  digest: WorkflowDigestPort, rawLayout?: unknown): Promise<CompiledWorkflow>

WorkflowDriverPort.dispatch(request: DriverDispatch): Promise<DriverAcknowledgement>
WorkflowDriverPort.requestStop(request: DriverOperationRef): Promise<DriverStopResult>
WorkflowDriverPort.reconcile(request: DriverOperationRef): Promise<DriverReconciliation>
WorkflowReportSinkPort.append(report: WorkflowEventReport): Promise<WorkflowWriteAcknowledgement>
WorkflowJournalPort.commit(request: JournalCommit): Promise<WorkflowWriteAcknowledgement>
WorkflowJournalPort.load(scope: WorkflowScope, run: RunRef): Promise<JournalSnapshot | null>
```

`WorkflowDigestPort` receives canonical JSON and returns a full lowercase
SHA-256 digest, synchronously or asynchronously. Supply the actual Node/browser
hash adapter at the owning boundary; shared code imports neither Electron nor
Node crypto. Contract version is `WORKFLOW_CONTRACT_VERSION = 1`.

The named schemas in `identity.ts`, `contracts.ts` and `definition.ts` are the
runtime validators. TypeScript types derive from their Zod definitions. Parse
untrusted data at the receiving application boundary, not only in the renderer.

## 3. Contracts

### Scoped identity and separate facts

- Jira issue identity contains `instanceId` and stable `issueId`; a display key
  alone cannot identify an issue across servers.
- Local task identity contains `repositoryId`, `workspaceId` and stable
  `taskRef`. Resolve paths/archive aliases through the existing task identity
  service; never infer a task from a title or current selection.
- A managed scope additionally has `projectId`. Definition identity contains
  `definitionId` and positive integer revision. A step instance also has run,
  run revision, node and attempt identities.
- Node IDs identify definition nodes; they are not globally unique live-run
  keys. Consumers pair them with the actual run/scope or use
  `stepInstanceIdentity`.
- `workCatalogSchema` validates issue/task bindings without deriving issue state
  from `localStatus` or `archived`. Remote issue status, local status and managed
  execution status remain distinct.
- `versionScopeSchema` records Jira version identity, explicit branch references,
  query/time, issue list and source total. `complete: true` requires a known
  matching total and unique issues from the same instance. A partial page cannot
  become a completed version scope.
- Revisions and attempts are positive safe integers; timestamps are nonnegative
  safe Unix milliseconds. Digests are 64 lowercase hexadecimal characters.

### Evidence, versions and capability

- Role/configuration/extension references pin version and digest. Executor
  bindings retain engine/adapter versions and capability facts.
- The same asset identity/version must not describe conflicting pinned content
  within methods, roles, extensions or their adopted manifest. Define duplicate
  policy explicitly; a contradictory version cannot be deferred to recovery.
- A supported capability requires an evidence reference. Unsupported and unknown
  facts have explicit reasons. A declaration is not authorization.
- Materials distinguish product requirements, Trellis PRD, design, spec, code
  and feedback. Missing historical digests stay null; a short reader revision
  cannot be substituted for a full manifest digest.
- Context entries distinguish full, truncated, index-only and unavailable
  inclusion. Included content needs the actual source/provided-content digests;
  full inclusion must match. Non-content entries cannot claim content delivery.
- Events either contain explicit assigned scope/run/step correlation or remain
  unassigned with a reason. An assigned step must agree with its run revision.
- Prepared, assembled, emitted-to-host, tool-read and check-result receipts are
  different facts. None alone proves business QA completion.
- Commands retain stable identity, expected revision and payload digest;
  operations can be `outcome-unknown`. Validation does not implement dedup, CAS,
  owner fencing, durable recovery or remote reconciliation; R1 provides those.
  `verifyWorkflowCommand` recomputes the canonical payload digest and rejects a
  mismatch; this verification alone does not admit or dispatch the command.
- Operation `purpose` is optionally `execute-step`, `stop-run` or `reconcile`.
  Missing legacy purpose means ordinary execution. Persist it with admitted
  intent; an operation ID/name cannot imply permission to dispatch superseded
  work. The durable store fences ordinary dispatch to the active head while
  explicitly scoped stop/reconcile can address an admitted old run.

### Driver, report and journal ports

`ports.ts` declares transport-neutral interfaces and request/acknowledgement
validators only. R1 implements the adapters and durable control transactions.
Driver requests pin operation/owner/fencing, adopted run manifest, step, node and
executor; mismatched node/role/executor/run associations must fail validation.

Dispatch accepted/rejected/outcome-unknown, stop requested/stopped/unconfirmed,
and reconcile confirmed/unresolved/conflict remain separate outcomes. Report and
journal committed/duplicate acknowledgements require a committed cursor; they
cannot represent an event merely placed in memory. A declared port or validated
write request is not proof that a durable implementation exists.

Journal validation ties changes to the command's target run and, for adoption,
its explicitly linked successor. Event/outbox run references must belong to the
admitted set. Dispatch outbox owner/fencing must match the admitted owner. A
loaded snapshot must agree on scope, run and complete definition reference;
matching only the run ID is insufficient for versioned recovery.

### One definition, two projections

The definition wraps validated existing Flow steps with explicit version,
default executor, node overrides and Trellis phase mapping. Compilation produces
an execution plan and graph with matching node/edge identities. Sequence, retry
and feedback relations remain distinguishable. Gate retry metadata is not a
claim that the new compiler has executed or scheduled the gate.

Layout is validated separately. Layout changes cannot affect execution topology
or the input fingerprint. Compiled results are recursively frozen. The
fingerprint covers effective definition/input,
role/executor/capability, material/context and engineering-baseline information.
Persistence timestamps are excluded from semantic input identity. The owning
driver must still perform actual capability, authorization and freshness checks;
a reusable-input indication is not permission to skip required verification.

### Legacy preservation

`snapshotLegacyTask` receives an already verified stable local identity and keeps
custom status/JSON fields in `original`. Neither adapter writes back a file.
`adaptLegacyFlow` retains original JSON, validates known semantics and returns
an explicit `UNSUPPORTED_LEGACY_FLOW` result when it cannot represent them.
Never silently discard a gate, custom field or source ambiguity to make a
legacy definition appear executable.

## 4. Validation & Error Matrix

| Input/condition | Required outcome |
| --- | --- |
| Same issue key on two instances | Distinct scoped issue identities |
| Duplicate issue/task pair or foreign binding | Catalog validation failure |
| Custom Trellis status/fields | Preserved in read-only legacy snapshot |
| Empty/ambiguous identity or invalid revision | Zod validation failure |
| Required capability unknown/unsupported | `CAPABILITY_UNAVAILABLE` |
| Same executor binding with conflicting content | `IDENTITY_CONFLICT` |
| Duplicate/conflicting adopted asset version | Validation failure; no contradictory pins |
| Changed command payload under the supplied digest | `COMMAND_PAYLOAD_CONFLICT` |
| Journal event/outbox belongs to an unrelated run | Validation failure |
| Outbox owner/fence differs from the admission owner | Validation failure |
| Snapshot definition differs from its manifest | Validation failure |
| Layout contains another definition/revision node | `INVALID_LAYOUT` |
| Invalid legacy steps/references | Explicit unsupported result; original retained |
| Full material has unequal digests | Context validation failure |
| Assigned step has a different run/revision | Attribution validation failure |
| Unknown outcome after dispatch | Preserve unknown; never infer no side effect |

Schema failures are Zod errors; the pure module is not an IPC failure envelope.
Future IPC adapters map failures to registered structured errors using the
existing IPC convention and preserve useful validation detail.

## 5. Good / Base / Bad Cases

- **Good**: one Jira issue binds two local tasks. One archives; remote issue
  state stays unchanged. A layout move preserves the compiled input identity.
- **Base**: a valid legacy Flow is adapted without modifying its original JSON;
  omitted Trellis stage mappings remain custom rather than guessed stages.
- **Bad**: match an issue only by display key, infer QA pass from archive, hash
  a canvas position as execution input, or display internal child activity
  without actual host evidence.

## 6. Validation

Run `npm run typecheck` and `npm run build` after affected TypeScript changes. Temporary contract checks belong in OS TEMP under the root local-only rule.

Verify exported validators/compiler/adapters with real SHA-256 identities: scope collisions, multiple local tasks, custom fields, malformed revisions/references, matching plan/graph identity, layout invariance and context/role/engine changes. Type/build results do not establish engine execution, persistent recovery, Jira, team or UI acceptance.

## 7. Wrong vs Correct

Wrong: `archived === true` becomes `issueDone = true`; a graph animation becomes
an execution event; a matching title becomes a stable task binding.

Correct: validate separate source facts, retain scope/version/evidence, derive
only the presentation from the accepted definition/run identity, and use the
appropriate application command for real state changes.
