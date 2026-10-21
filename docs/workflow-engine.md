# Managed stage driver and immutable materials

`src/main/services/workflow-runtime/` adds a main-process adapter over the
existing ACP facade. It runs authorized agent stages from the R0 workflow
contracts and records their outcomes through R1 durable control. The existing
facade still owns native processes, prompt transport, permissions, directory
leases, session load, cancellation and transcript history.

This module is independently authored project code. It contains no copied
third-party harness implementation and does not introduce another model loop.
The module exports services; application command/IPC wiring and visual workflow
views are separate integrations.

## Ownership and execution path

1. Main authorizes the actual project/workspace/task and pins source versions.
2. `prepareWorkflowContext` assembles a bounded reference packet and R0 manifest.
3. The coordinator persists the run manifest and pending execution outbox intent.
4. `AcpxWorkflowDriver.dispatch` validates the supplied plan, claims that durable
   intent, and renews its workspace ownership while execution remains active.
5. `createFacadeWorkflowAcpPort` invokes the existing session and prompt functions.
   A backend-only prepared-prompt argument supplies the pinned bytes without
   rereading mutable task files. Public prompt options/preload remain unchanged.
6. Actual admission/write callbacks and scoped native events identify the turn.
7. After the native turn and cleanup settle, the driver captures output versions,
   runs the declared validators, and records step/outbox results. The coordinator
   remains responsible for transitions of the whole run.

Dispatch accepts agent nodes. Tool nodes, human gates, revision adoption, team
approval and Jira changes are owned by their respective coordinators/adapters.
A pending operation whose purpose is `stop-run` or `reconcile` cannot launch an
agent. Legacy missing purpose has the R0 `execute-step` meaning.

## Immutable material API

```ts
const materials = new WorkflowMaterialStore({ directory: mainOwnedDirectory })
await materials.captureFile({ projectRoot, owner, relativePath, kind, expectedRevision })
await materials.captureDocumentRead({ projectRoot, owner, read, kind })
await materials.captureText({ owner, source, kind, text, version })
await materials.readVersion(owner, opaqueMaterialRef)
```

Use one main-owned store instance per repository. `owner` contains projectId,
repositoryId, workspaceId and nullable taskRef. A project spec/wiki read can
precede task creation; it does not require a fabricated task/run.

`captureDocumentRead` registers a **main-owned successful DocumentController
result before the response reaches UI**. It verifies the original-byte count
and revision, reconstructing only the controller's known UTF-8 BOM handling.
If disk is already B, registering the read of A still saves A. Never use a
renderer's old body as an authorized source result. `captureText` similarly
requires the owning source adapter's authorization, for example an existing
versioned KnowledgeArtifact; this store does not replace that artifact store.

Each result contains an opaque `wm-<64 hex>` reference, owner, R0 material
descriptor, full SHA-256 bodyDigest, byteLength, capturedAt and exact UTF-8 text.
Product requirement, Trellis PRD, design, spec and feedback remain separately
typed materials. There is no transcript archive here.

The content-addressed blob store deduplicates identical bytes. The reference
includes owner/source/kind/version identity. Supplying different bytes for the
same source/version fails and preserves the first record. Reads recheck scope,
metadata identity, full digest, size, UTF-8 and the cache path fence. Original
files are not overwritten. Missing/corrupted versions and exhausted capacity are
explicit failures, rather than silent substitution or eviction.

Default bounds are 5 MiB per source, 128 MiB of blobs and 5,000 references.
Writes are serialized within the main-owned instance and use synced temporary
files with immutable final links. This is not a multi-writer database or a
garbage collector. Retention policy and cross-process quota coordination require
their own design; never delete versions still referenced by accepted runs.

## Context and receipts

`prepareWorkflowContext(store, input)` accepts an actual scope, instruction,
structured inputs, pinned selections, engineering baseline, versioned output
contract and byte budget. Selections carry owner/ref/purpose/reason and whether
they are required. A new session receiving feedback deltas must also receive an
included effective baseline. Another task's materials are rejected; authorized
project-level materials may be included.

The packet deduplicates source/version references and accounts for UTF-8 bytes,
JSON escaping and the existing facade reference delimiter. Full, truncated,
index-only and unavailable entries retain distinct evidence and digests.
Deduplication preserves later required selections and recognizes an actually
included baseline even if that source/version was first selected as a spec.
Truncation preserves codepoints. Required material that cannot contribute content
fails assembly. The result exposes the actual packet digest, byte count and
opaque selected references. The byte budget applies to this workflow packet;
native engine instructions and facade knowledge preflight remain additional
inputs.

`effectiveInputsComplete` defaults false. Native hooks, prior session memory and
normal knowledge preflight are not automatically enumerated by this manifest.
Its default completeness is therefore false and automatic result reuse is not
claimed. A future coordinator may assert completeness only after correlating
all those other effective inputs.

Prepared, assembled and emitted-to-host receipts are different facts. Emission
is recorded from the actual native prompt-write path. It does not establish that
the model read or checked a rule. Native tools/children/spec checks are never
inferred from assistant text. Unavailable native observations stay unobserved.

## Driver integration contract

```ts
const driver = new AcpxWorkflowDriver({ acp, control, materials, resolve })
await driver.dispatch(dispatch)     // admission acknowledgement
await driver.result(operationId)   // separate completed stage outcome
await driver.requestStop(operationRef)
await driver.reconcile(operationRef)
```

`control` uses the actual R1 getOperation/claimOperation/append/recordStep/
settleOperation/renewWorkspace APIs. `resolve` is the main-owned authorization
boundary. It returns the captured root/task, prepared context, verified executor
snapshot, output contract and `assertCurrent` callback. It must verify engine,
profile/configuration, capability evidence and current project authority; parsing
a renderer request does not grant that authority.

Session reuse is restricted by task scope and adopted executor configuration.
Only driver-owned idle sessions can be retired. The driver checks actual root,
session, task, agent, connection generation and turn identities. Runtime/profile/
capability snapshot digests, protocol and observed model/mode are recorded
separately from the adopted executor binding. An adapter package version does
not establish its actual native executable version; unavailable facts stay
explicitly unknown.

The output policy declares up to 16 files and 0–3 repair turns. Principal PRD
and design paths must be inside the selected task. Required files must exist and
contain text. Optional `validateText` checks the final assistant response;
`validateMaterial` checks actual captured output bytes. Semantic business/schema
requirements require those declared validators. An existing nonempty file alone
does not prove the model authored it. Rejected output snapshots retain their
references, including empty observed files. Explicit invalid/missing outputs may
enter bounded repair; storage/authorization failures or validator exceptions
remain unknown and never cause another model prompt. Optional missing output
files remain optional, while optional-file infrastructure failures still fail
closed. Repairs use the same task/session and cannot exceed the packet
budget. A failed native response or unknown side effect never triggers automatic
repair/replay.

Duplicate in-process dispatch cannot create a second initial prompt. After
restart, a previously dispatched intent remains unresolved until reconciled;
the driver does not treat absent in-memory state as permission to replay.

## Stop, history and native Trellis identity

A real pre-creation stop prevents native admission. If session creation is
already in flight but its ID has not returned, stop is **unconfirmed**. Ownership
stays live; a late ID is canonically shut down before cancellation is confirmed.
Failed shutdown leaves outcome unknown and cannot release work as successfully
stopped. Cancellation can leave partial file changes. The existing facade is the
only process/lease authority.

A stop accepted while outputs or history are still being checked wins over
later valid captured outputs. Confirmed canonical native shutdown yields
cancelled; missing shutdown acknowledgement yields outcome-unknown. Stop/error/
late-create paths join one per-stage shutdown promise. The driver freezes its
result synchronously before any awaited final-result writes. Stop requests after
that boundary reject as `already-settling`; a failed durable acknowledgement
leaves reconciliation work and cannot cause a second guessed final result or
another native prompt.

The event observer is passive and bounded to 32 listeners. Main publishes the
same redacted native event after enqueueing it in the existing history path.
Exact root/session/generation filters, independent clones and contained clone/
callback failures protect native handling. Full transcript text stays in history;
control events keep IDs/status/material references. A `historyCommitted` result
requires flushing history, observing saved persistence and finding the exact
terminal event/turn/generation with a committed historySeq. A model turn can
finish while history is degraded; that state does not become a durable claim.

`bindNativeTrellisTask` uses the project's official Python active-task API with
the actual vendor session identity, isolated from inherited context IDs. It
preserves foreign pointers and task lifecycle status. Missing vendor ID or
unsupported CLI produces unavailable evidence; panel/wire IDs are not
substitutes. A matching pointer is not proof a native hook executed. Actual hook
injection and unsupported child-agent events remain separate observations.

## Verification

```powershell
node scripts/smoke/workflow-engine.mjs
node scripts/smoke/workflow-engine-facade.mjs
node scripts/smoke/workflow-engine-facade.mjs --native-command
node scripts/smoke/workflow-engine-facade.mjs --whitespace
node scripts/smoke/workflow-engine-facade.mjs --deny
npm run typecheck
npm run build
```

The first script exercises exported store/context/driver code with real SQLite
control and explicit deterministic ACP fixtures. The second runs the actual
facade and public patched acpx against an owned stdio peer, including original
permission-option mediation, pinned A versus mutable B, actual PRD/design files,
native event correlation and committed history. Neither substitutes for a vendor
model test.

`workflow-engine-real.mjs --run --report <path>` is an opt-in real-model gate. It
consumes existing installed-adapter baseline metadata, uses an isolated temporary
workspace/userData, and never auto-approves native permissions. The successful
Codex report records two actual output versions containing the selected source
nonce, their full hashes, committed history and confirmed owned shutdown. Claude
remains subject to the separate R0 provider-timeout gate; Jira is unrelated to
this local execution gate. No successful test claims native hook injection,
internal child-agent execution, packaged UI integration or whole-platform
acceptance.
