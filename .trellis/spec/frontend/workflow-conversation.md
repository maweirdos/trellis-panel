# Managed conversation, revision and recovery views

## 1. Scope / Trigger

Read before changing acp/workflow, its Console integration, workflow history,
revision command references or graph interactions. Pair with backend/workflow-
application.md, backend/workflow-reading.md and conversation-workspace.md.

## 2. Signatures

```text
useManagedWorkflow({root,taskDir,sessionId,generation,enabled})
WorkflowPanel({root,taskDir,session,controller,onOpenHistory})
WorkflowRevision -> actual managedWorkflow revision APIs
WorkflowRecovery({root,run,originKey,onOpenHistory})
StageHistory({target:{sessionId,turnId,run,historySeq,historyCommitted},...})
```

Actual DTOs are shared/workflow-application, workflow-revisions, workflow-recovery
and workflow-desktop. Root/task/run references are not renderer authority grants.

## 3. Contracts

- Use the existing composer-top collapsible node/edge panel by default; optional
  corner docking shares the same state/component. Stable mainline stages and
  bounded dependencies express the workflow, not every raw tool invocation.
  Graph appearance is not execution proof. Read actual journal/node/event state.
- Geometry depends on topology and explicit user view choices. Passive event/
  status updates never refit, pan, move focus, replace a draft, scroll a reader
  or reset text selection. Comparison graphs offer explicit accessible zoom/fit
  controls; small screens must retain access to the adoption action.
- Adopt snapshots by actual committed cursor/epoch and execution revision. A
  delayed older or retired-epoch snapshot cannot replace newer state. Reset
  clears incompatible live buffers and exposes a gap. Retain selected evidence
  independently of bounded live-buffer rollover; page exact old facts on demand.
- Display prepared/assembled/emitted-to-host material receipts separately from
  actual native observations. Match full scope/run/step provenance, including
  cross-revision stage handoffs. Unknown native hooks/children stay unknown.
  Main platform gates use their exact gate-result/gate-aborted payload.nodeId
  with matching run even when attribution.step is null. Do not invent native
  sessions/turns for gates, pass a failed-continue gate or pass not-selected nodes.
- Live permission choices keep exact current session/generation/request/option
  identity and reject stale interaction lifetimes. Historical rows never recreate
  active resolvers. Preserve reject options; no automatic permission approval.
- Stage history uses original session/turn/run and committed watermark plus the
  server's opaque before cursor. Exclude unsequenced/above-watermark rows from a
  known committed version and disclose missing/truncated coverage. Bounded page/
  byte limits require explicit continuation, not an implied complete transcript.
- Revision captures an exact target before editing and previews real before/
  after semantic mappings, reason, inputs, boundary, affected/preserved work and
  input-only reuse. Editing invalidates preview; expiry or a changed target blocks
  adoption. Saving, waiting-boundary, stopping, stop-unconfirmed, stopped,
  successor-starting, running, adopted, failed and cancelled are distinct facts.
- Persist the original adoption command reference before dispatch, retaining its
  exact owner/run/preview identity through unknown replies/reload. Reopen queries
  that original command; a missing read-point receipt is not permission to create
  a new command. Damaged/conflicting local entries fail closed without deleting
  evidence. Cleanup checks the exact command, and writes cannot overwrite a
  retained different intent. The bounded local reference store is not an atomic
  cross-process execution lock; actual main reservation/CAS owns execution.
- Cancellation after old execution stops suppresses the successor; it does not
  resume old writes or resolve an unconfirmed shutdown. An emitted input does
  not prove product feedback was applied, business accepted or QA completed.
- Project recovery is reachable without an active/selected/native conversation.
  It calls the path-free main API with actual project lifetime and no fabricated
  task/session/scope. After an owner-head lookup, retain the exact selected run
  for refresh/artifacts. Display missing/ambiguous source/ownership diagnostics;
  old PID/lease time does not authorize force unlock, replay or stop-success.
- Exact document returns resolve original metadata even before the asynchronous
  paged catalogue arrives. Reject old target/source/lifetime replies; do not use
  a same-title/latest session. Document and workflow-history source selection is
  read-only and suppresses automatic reconnect, preserving original generation
  until an explicit native action. An unavailable history stays an explicit error.
- An unsupported boundary-feedback adapter remains unavailable; never bypass
  managed ownership by routing a product comment as a competing ordinary prompt.
  Selected publication uses its own main immutable-source/team authorization
  adapter and explicit visibility, not graph state or renderer old body.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| More than500 passive updates | Viewport, stage positions, draft DOM and selection remain |
| Older snapshot/old run arrives late | Do not roll current projection back |
| Permission lacks current generation | Non-actionable evidence, no guessed response |
| Revision saved or predecessor stop unknown | Never label successor running |
| Command storage corrupt/full/conflicting | Preserve originals; block new dispatch |
| Historical full-stage view selected | No implicit reconnect/native start |
| No native session after restart | Project recovery remains reachable |
| Source missing/ambiguous | Original run/body or explicit failure, no retarget |
| New body appears during reading | Offer comparison/adoption; retain selected body |

## 5. Good / Base / Bad Cases

Good: a developer inspects the fixed PRD and actual spec receipt while the design
stage continues; a later explicit revision shows its affected stages before stop.

Base: a project with no engine session can inspect an empty retained owner without
installing/starting an adapter. Ordinary local conversations remain available
when no managed workspace owner or uncertainty fences them.

Bad: a late saved preview switches to another live revision, a history click
reconnects a native engine, or a grey/green graph node substitutes for real evidence.

## 6. Tests Required

Use actual React/ReactFlow/InteractionScope/Chromium for retained positions,
focus/selection, narrow/dark/zoom, command reference failures, stale scope/ACK,
permissions, exact paged history and platform gate event shapes. Exercise initial
metadata-before-catalogue returns and sessionless recovery with zero native calls.
Actual production Electron clear-task/model and navigation/recovery-launcher
reports have separate bounded scopes; fixtures do not replace native structural
adoption/drain, restart, parallel, packaged/human or full business acceptance.

## 7. Wrong vs Correct

Wrong: "The request timed out, so clear its reference and adopt a new preview."

Correct: retain the original command and exact source, reconcile actual main
status and show uncertainty until evidence permits an explicit next action.
