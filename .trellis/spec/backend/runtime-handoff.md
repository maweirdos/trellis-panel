# Cross-Runtime conversation continuation

## 1. Scope

Use for ordinary conversation continuation into a different Runtime. Follow the
released [VS Code Continue In action](https://github.com/microsoft/vscode/blob/618725e67565b290ba4da6fe2d29f8fa1d4e3622/src/vs/workbench/contrib/chat/browser/actions/chatContinueInAction.ts)
and [Copilot Chat context-to-new-session flow](https://github.com/microsoft/vscode-copilot-chat/blob/bfba65da1009f779dace69cf07454abe970baf0d/src/extension/chatSessions/vscode-node/copilotCLIChatSessionsContribution.ts):
require a settled checkpoint, prepare portable context, then create a distinct
target session. Native engine state is not portable conversation history.

Keep the source Runtime, native session ID, saved events and Agent defaults
unchanged. Archive the source only after verifying target readiness. Archive
retains readable history; cancellation before delivery can restore execution.
Independent conversations keep their existing background concurrency.

## 2. Signatures

```ts
acpSessionHandoffPreview(sourceSessionId, { targetRuntimeId })
acpSessionHandoffCreate(sourceSessionId, { operationId, previewId, context })
acpSessionHandoffStatus(sourceSessionId, operationId)
acpSessionHandoffCancel(sourceSessionId, { operationId })
```

Shared schemas live in `src/shared/acp-handoff.ts`. The daemon methods are
`runtime.handoffPreview`, `runtime.handoffCreate`, `runtime.handoffStatus` and
`runtime.handoffCancel`. Preview/status use the read lane; create/cancel are
mutations. Cancel remains an owned cleanup control during workspace rollback,
ownership changes and closed admission. It cannot grant a workspace or launch
a replacement process.

## 3. Contracts

- Session and Runtime IDs use the existing bounded ID schema; operation IDs are
  UUIDs. Inputs are strict. Context must contain non-whitespace text, no NUL and
  at most 32 KiB of UTF-8. Preview expires after 15 minutes.
- Read the acknowledged SQLite archive, not the 800-event compatibility array.
  Require a complete, normally completed latest turn and saved persistence.
  Select whole turns under the context budget using a body-free scan followed
  by bounded text hydration. Report coverage, included/omitted messages,
  attachments, tool calls, truncation and `latestTurnIncluded` truthfully.
- `latestTurnIncluded` describes emitted context, not estimated selection. If
  false, label the omission and reject unedited preview context until the user
  supplies a current-state handoff summary. Attachment and tool bodies remain
  in the source; show their omission and allow explicit replacement context.
- Fence the source checkpoint, archive tail, task/material/role context,
  workspace identity and target launch fingerprint. Revalidate after async
  preparation. Target creation has an explicit trusted Runtime binding; source
  profile defaults cannot override it. Copy portable role instructions and
  selected project Skills, not source CLI args, env, model IDs, credentials or
  prior approvals. Rebuild target launch, tools, permissions and model catalog.
- Persist private preview/operation records under
  `userData/acp/handoffs/<root digest>/`. Use writable-descriptor fsync before
  atomic publication. Bound serialized records to 1 MiB before publication;
  account for JSON escaping of both valid 32 KiB contexts. Reserve an operation
  before native effects; the same operation/payload returns its existing result,
  while a changed payload fails.
  A restart cannot repeat an uncertain native create.
- The operation states are `creating`, `ready`, `sent`, `failed`, `cancelled`.
  Delivery is independently `prepared`, `sent`, `not_sent`. Ready means a new,
  verified native identity with negotiated embedded-context support. It sends
  no synthetic prompt. On the first real user prompt, attach the immutable
  Markdown context as a separate ACP resource and record delivery only from
  that exact generation/turn's `promptStarted`.
- A crash during dispatch without a durable sent receipt is uncertain. Preserve
  source protection, report uncertainty and do not replay or claim rollback.
  A confirmed sent context cannot be withdrawn. Preparation failures restore
  only the operation's own source archive field; preserve later human title,
  pin, archive and unrelated-session changes.
- Public `.handoff` and `.handoffTargets` carry provenance and navigation, not
  context bytes. Going back opens the original source. Continuing the target in
  the old Runtime creates another derived session; do not merge both histories
  or fabricate old messages in the target native transcript.

## 4. Validation and errors

| Condition | Required result |
| --- | --- |
| Active turn, approval, admission, cleanup or unsaved source | Reject; no target native create |
| Stale checkpoint, target config, root identity or expired preview | Conflict; preserve source and drafts |
| Latest turn omitted and context unchanged | Invalid argument; require edited current-state summary |
| Same operation retried | Reuse the one target; do not dispatch another create |
| Operation ID reused with different payload or foreign source/root | Reject without changing the recorded operation |
| Target lacks embedded context or fails creation | Fail visibly; source remains usable; no synthetic prompt |
| Cancel before delivery | Stop only the owned target; restore only owned source archival |
| Cancel races native creation | Terminal cancellation survives late create/cleanup callbacks |
| Delivery already sent or interrupted ambiguously | Reject withdrawal; preserve provenance and truthful state |

## 5. Cases

Good: a completed Codex conversation creates a new ZCode conversation with edited
handoff notes; the first real ZCode instruction carries those notes separately.
Base: cancel a prepared target, return to the original source and retain both
drafts. Bad: overwrite the source Runtime, claim full native history migration,
or resend a context automatically after an uncertain dispatch.

## 6. Verification

Keep all verification scripts, peers and evidence in OS TEMP. Verify the actual
facade/archive and operation persistence across reopen/restart; duplicate create,
cancel races, stale admission, root isolation and archive rollback ownership.
Assert separate context bytes, exact first-turn receipt and zero synthetic
prompts. Verify source/target native identity, unchanged role defaults, readable
source history and background-session/draft preservation. Controlled peers do
not establish native engine acceptance; use real engines to verify useful
first-turn context consumption and state any unverified engine explicitly.

## 7. Wrong versus correct

Wrong: change `session.agentId`, reuse its native ID and replay old prompts into
the new engine. Correct: create a linked new native session with explicit target
configuration and bounded, reviewable handoff context; keep source events intact.
