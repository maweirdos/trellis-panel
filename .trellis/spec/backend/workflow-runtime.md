# Workflow execution and immutable materials

## 1. Scope / Trigger

Read before changing `services/workflow-runtime/`, managed ACP prompt composition,
context receipts, stage output validation or native cancellation. The existing ACP
facade owns native process/session/permission/directory/history behavior. This
layer adapts that facade; it does not introduce another model loop or transcript
store. Read shared/workflow-contracts.md and backend/workflow-control.md together.

## 2. Signatures

```ts
new WorkflowMaterialStore({ directory, maxSourceBytes?, maxStoreBytes?, maxReferences? })
captureFile({ projectRoot, owner, relativePath, kind, expectedRevision? })
captureDocumentRead({ projectRoot, owner, read, kind })
captureText({ owner, source, kind, text, version? })
readVersion(owner, opaqueRef)
prepareWorkflowContext(store, input): Promise<PreparedWorkflowContext>
new AcpxWorkflowDriver({ acp, control, materials, resolve, ...boundedTimeouts })
dispatch(request): Promise<DriverAcknowledgement>
result(operationId): Promise<StageResult | null>
requestStop(request): Promise<DriverStopResult>
reconcile(request): Promise<DriverReconciliation>
```

Use the exact inferred/exported DTOs from the runtime index. A main-owned resolver
pins task, executor/configuration, output policy and prepared context. Public
renderer prompt options never accept a backend prepared material packet.

## 3. Contracts

- Material bodies are content-addressed immutable versions with full SHA-256,
  exact source/version and project/repository/workspace/task owner. Opaque refs
  never grant foreign scope access. Project-level specs use null taskRef.
- Capture the actual trusted main document read A before returning its descriptor.
  Reconstruct only the reader's known UTF-8/BOM normalization and verify byte
  count/revision. Do not reread a mutable file B or accept renderer old text.
- Context planning enforces UTF-8 plus envelope byte budgets, source/version
  deduplication, stronger required-source constraints and actual included baseline.
  A new session receiving deltas requires its effective baseline. Native/knowledge
  additional input completeness remains unknown unless actually observed.
- Persist outbox dispatch before native admission. Reopening a dispatched or
  unknown operation requires reconciliation, never automatic model replay.
  Session reuse requires matching task scope and pinned executor configuration.
- The managed first prompt preserves admitted instruction/material bytes exactly,
  including leading/trailing whitespace. An advertised native slash command cannot
  bypass its prepared packet. Ordinary console command semantics stay separate.
  Original native permissions remain the only actionable request/option authority.
- Emission receipts require actual prompt-write callbacks and actual receiver
  session/turn/generation. Full transcript remains in existing history; received
  terminal events are not committed-history proof without the archive watermark.
- Read and capture actual output files before declaring the output contract met.
  A success sentence is insufficient. Explicit invalid/missing content can use
  bounded repair. Storage/authorization/capacity/corruption failures or thrown
  validators remain unknown and cannot trigger another model side effect. Retain
  captured invalid/empty output refs as evidence.
- A stop during native creation is unconfirmed until a late session ID is actually
  shut down. Cancellation acknowledgement alone is insufficient. Stop/error/late
  admission paths join one canonical shutdown promise.
- Freeze final disposition synchronously before awaited final writes. Stops
  accepted before this boundary win over subsequently captured valid output;
  cancellation requires confirmed shutdown, otherwise unknown. Later stops reject
  as already settling. Failed final persistence cannot publish a second guessed
  result or release ownership as though cleanup were proved.
- Adapter package version, native executable version, vendor session identity,
  official task pointer, actual hook injection and internal children are distinct
  facts. Never substitute app/wire IDs for missing native IDs or infer hook
  delivery from an official pointer binding.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Live file changed after main read | Keep original A bytes/digest/ref |
| Duplicate optional source followed by required source | Enforce required actual inclusion |
| Same source/version with different content | Immutable-version conflict |
| Native side effect succeeded, response missing | Unknown; inspect/reconcile, no replay |
| Output malformed | Bounded declared repair or visible failure |
| Store/validator throws during validation | Unknown, retain evidence, no model retry |
| Stop accepted while output capture awaits | Stop wins at finalization |
| Stop after finalization starts | Reject already-settling; retain frozen outcome |
| Creation unresolved during stop | Unconfirmed; retain owner and shut down late ID |
| History not committed | Explicit historyCommitted=false |
| Native children/hook not observable | Unknown, no fabricated successful node |

## 5. Good / Base / Bad Cases

Good: a real stage consumes pinned PRD A, creates design D, captures D's bytes,
and links the original committed turn. The UI can open D after disk changes.

Base: ordinary console prompts keep their existing source-reference and native
command behavior. A task-role configuration does not merge unrelated histories.

Bad: report emitted after taking a shortcut that omitted the packet, trim the
admitted prompt, retry a failed store as another model turn, or return passed
after acknowledging a stop during awaited file capture.

## 6. Validation

Run `npm run typecheck`, `npm run build` and `npm run check:acpx`. OS TEMP validation should exercise exported driver/material/context boundaries and actual file SQLite. Through the real facade/public acpx boundary, verify exact received bytes, ordinary approval/denial, advertised commands, whitespace prompts, output references and committed history.

Actual vendor execution is a separate gate; do not repeat paid requests without a new change or unresolved concern. Controlled peers do not prove vendor readiness, native hooks, child agents or UI acceptance.

## 7. Wrong vs Correct

Wrong: “cancel returned and output exists, so the stage passed.”

Correct: respect the accepted stop and finalization boundary, join canonical
shutdown and persist only its observed final disposition with actual evidence.
