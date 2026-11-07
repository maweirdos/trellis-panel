# Fixed execution inputs and portable workflow sources

## 1. Scope / Trigger

Use for portable workflow definitions, captured execution inputs, fixed resource
reads and Pi/ACP context composition. Team business actions, native admission,
engine launch and general artifact submission retain their existing owners.

Reuse adopted `TaskInputBundle`, published governance/material versions, the
existing immutable blob store, service authentication and owned SQLite worker.
Capturing Agent/skill content adds no separate publication or approval system.

## 2. Signatures

`src/shared/workflow/portable-definition.ts` defines
`portableWorkflowDefinitionSchema` with `contractVersion:2`, logical roles,
ordered Agent/tool/gate nodes, capabilities and output policies. Published
workflow-template settings accept optional `execution`. Omission preserves
version-1 settings and canonical hashes; do not default an extra field into
retained versions.

`src/shared/team-execution-input.ts` defines capture, input, resource, receipt
and context-manifest validators. `executionInputAgentDigestText` is the exact
canonical preimage for chosen instructions and ordered resolved skill contents.
`executionInputDigestText` excludes only the input's digest field.

Base route:
`/api/projects/:projectId/crux/tasks/:taskId/executions/:executionId/inputs`.

| Operation | Input / result |
| --- | --- |
| POST `/commands` | `ExecutionInputCommand`; committed/duplicate input receipt. |
| POST `/reconcile` | Original full command; original input receipt or null, without dispatch. |
| GET base | Exact version-2 task query and `purpose:history|use`; original input, current bundle reference and resource availability. |
| GET `/resources/:selectionId` | Same query; fixed source reference, availability and permitted original text. |

The query carries `contractVersion=2`, `instanceId`, `spaceId` and original
`taskCreatedAt`. Capture carries UUID `commandId`, `TeamTaskRef`, expected epoch,
original person/device, execution ID and generation, logical role/Agent digest
selections, and ordered per-node source selections.

Service schema 21 adds `team_task_execution_inputs(executionId,recordJson)`.
Bodies reuse existing blobs; command receipts/events use existing transactions.
One immutable input is captured per admitted execution.
Check the exact worst-case serialized read view against
`TEAM_MAX_RESPONSE_BYTES - 64 KiB` before persisting snapshot bodies or metadata.
A small capture command cannot authorize a snapshot that the worker cannot read.
`executionInputSelectionIdSchema` retains the shared 512 UTF-16-unit limit,
requires well-formed Unicode and rejects exact `.` and `..` URL segments. Every
receiving layer uses it; this constraint does not change legacy workflow IDs.

Main-process source/composition interfaces:

```text
ExecutionInputTransport(task,executionId,actorId,deviceId,authenticatedRequest)
  .command(command), .reconcile(command), .source(purpose)
ExecutionInputSource.read(), .readResource(selectionId)
prepareExecutionAgentRules({executionSource,nodeId})
prepareAgentRules({executionSource,nodeId})
executionDefinitionSource(executionSource)
resolvePortableApplicationDefinition({source,roles,toolCapabilities?,assertExecutionCurrent})
composeExecutionContextResource(prepared)
composeAcpExecutionContext(prepared,embeddedContext)
composePiPromptPacket({text,context,attachments?})
executionContextEnvelopeBytes(resource)
runtimeContextText(context)
```

New fixed context resources carry canonical JSON text using `text/plain`, the
supported textual attachment MIME at the pinned public acpx boundary. Budget and
validate the actual same MIME/URI/text envelope in both native composers. Retain
existing packet/hash checks and historical native manifests; converting the
transport MIME is not permission to alter a captured shared input or replay an
uncertain old prompt.

`adaptLegacyFlowToPortable(raw,{definitionId,revision,roles,phases,nodeRoles,
capabilities,outputs})` explicitly converts supported source declarations.
Unknown fields, active imported Hooks, parameter inputs and unenforceable
restrictions return an unsupported result instead of silently dropping behavior.

## 3. Contracts

- Portable definitions contain logical instructions, roles, capabilities and
  output/gate policies. Resolve concrete engine/model/profile/workcopy through
  device-local configuration. Do not publish another device's configuration or
  credentials inside a definition.
- Keep ordered execution phases distinct from formal business stages. Legacy
  Flow definitions and task/input/rule manifest hashes retain their original
  interpretation. Tool/gate declarations do not invoke tools or add scheduling.
- Resolve Pi, Codex and Claude configurations against explicit, evidence-backed
  adapter capabilities. Pi needs `sdkContext`; ACP needs `embeddedContext`.
  Role/node/tool requirements also apply. Reject missing/unknown support without
  choosing another engine or dropping a required capability.
  Capture local configurations before awaiting the source. Return frozen
  definition/configuration snapshots, with dictionaries that preserve special
  node keys such as `__proto__`. Caller mutation cannot retarget resolution.
- Capture uses the original effective writer and original task/person/device/
  epoch/generation. The adopted bundle and portable definition must match the
  execution's fixed references. Capture is a preparation boundary, not proof of
  native execution or business completion.
- Role bindings capture chosen Agent instructions and resolved shared Skill
  content in original selection order. Verify the expected Agent-content digest
  before writing. Agent display names and logical roles grant no business rights.
  Agent CRUD remains mutable while captured content remains fixed.
- Sources are exact adopted governance versions, approved document versions,
  captured Agent instructions or captured skills. Confirmed predecessor
  documents, artifacts and supported published HTML must belong to the original
  declared predecessor's fixed completed finalization. Explicitly carried refs
  retain older producer identity through that immediate predecessor; their
  current authorization and version rules follow
  [Execution artifacts](./team-execution-artifacts.md).
  Arbitrary paths, caller text and unsupported artifact kinds grant no source.
- Per-node selections retain phase, stage, order, reason and obligation. Require
  captured Agent instructions, every bound skill, globally required adopted
  rules and the adopted template at each applicable Agent node. A caller cannot
  omit or downgrade this baseline through its selection list.
- New publication or Agent/skill edits do not replace captured bytes. A task's
  latest adopted bundle and an execution's original input remain separate.
  Explicit new adoption/ownership boundaries keep their existing generation
  fences; capture never silently repairs an old execution.
- History reads recheck current task/resource ACL and expose permitted original
  bytes with withdrawal status. Execution use additionally requires the original
  active writer/owner and available required versions. Withdrawal blocks use;
  current ACL denial is not an optional omission or a historical-access grant.
- Source ports resolve fixed bytes without local `.trellis`, JSONL, task
  pointers or a current project selection. An authenticated source failure
  cannot become offline admission or a guessed successful refresh.
- Composition preserves exact source and delivered SHA-256 digests, byte/character
  counts, order and reasons. Full, partial, index-only, omitted and unavailable
  remain distinct. Required content must be full; unavailable/corrupt/oversized
  required sources reject before native prompt composition.
- Budget actual serialized UTF-8 bytes, including JSON escaping and Pi/ACP
  resource framing, under the existing 8192-byte implicit context limit. Source
  count alone or raw text size is insufficient. Do not remove required text to
  make room for optional recommendations.
  `serializedBytes` describes the exact packet;
  `envelopeBytes:{acp,pi}` describes actual implicit transport framing. User
  messages, images and unrelated native context have separate bounds.
- Native packet composers validate the prepared manifest against actual packet
  bytes. Prepared context is backend-owned; ordinary renderer requests cannot
  inject a prepared packet or an authorization callback. Recheck current source
  authority before returning/using prepared context.
- A manifest's `state:prepared` records composition only. Model receipt, tool
  reading, compliance and native completion require their separate evidence.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| New workflow fields absent on retained settings | Preserve the original version-1 canonical bytes/hash. |
| Unsupported local capability or context transport | Reject capability resolution/composition. |
| Capture person/device/task/execution/generation differs | Reject before creating input or blobs. |
| Selected Agent content changed after preview | Reject expected-digest mismatch; do not capture newer content implicitly. |
| Required baseline omitted or downgraded | Reject capture. |
| Same UUID with changed intent | Conflict; preserve the original receipt and immutable input. |
| New publication after capture | Retain original input and resource bytes. |
| Required version formally withdrawn | Block execution use; permitted history remains marked withdrawn. |
| Current resource/task membership revoked | Deny use and reads under the current ACL. |
| History-only source supplied for execution | Reject; no upgrade of authority. |
| Required source unavailable or serialized budget exceeded | Reject; no full-delivery receipt or native prompt. |
| Optional source omitted/partial/unavailable | Report actual inclusion and reason; do not claim full delivery. |
| Packet text/digest/counts or node selection differs | Reject native packet composition. |
| Valid-sized command expands beyond the readable metadata envelope | Reject before snapshot/blob persistence. |
| Selection ID is a dot-only segment or malformed Unicode | Reject selection before persistence; preserve legacy workflow IDs. |

## 5. Good / Base / Bad Cases

Good: implementation and checking reference distinct ordered rules from the
same captured input. A later Agent edit and new Spec publication preserve both
original packets; formal withdrawal blocks further execution use while an
authorized collaborator can inspect marked historical content.

Base: a retained local Flow and version-1 rule manifest keep their original
composers, identity and recovery behavior.

Bad: reread the latest Spec at every turn, merge implement/check JSONL into one
platform context, use another device's profile, or call truncated required
content fully delivered because its raw text fit before JSON serialization.

## 6. Verification

Use OS TEMP for validation programs, fixtures, accounts, stores and reports.
Run root/team-service typechecks and builds plus applicable production guards.

Verify exact legacy rule-composer output and real schema-20 data preservation.
Use real HTTP/SQLite authorization for immutable capture, UUID recovery,
publication/edit changes, current bundle versus execution input, withdrawal,
member/device revocation and fixed resource reads without Trellis locators.
Exercise actual ACP and Pi composers, ordered phase reasons, UTF-8/JSON escaping,
required rejection, optional inclusion receipts and capability mismatch.
Composition does not establish provider execution, installed-workcopy admission
or company deployment.
Cover expanded multi-role metadata, 512-character and special identifiers,
mutation during asynchronous source reads, and returned snapshot immutability.

## 7. Wrong vs Correct

Wrong: a task still has the same Agent name, so load its current instructions
and use the latest published rules for the old execution.

Correct: resolve the original captured input, recheck current rights and required
version availability, and compose the selected node from its fixed references.
