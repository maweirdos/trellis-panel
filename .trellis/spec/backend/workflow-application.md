# Managed workflow application and desktop admission

## 1. Scope / Trigger

Read before changing WorkflowApplicationService, workflow-desktop host, workflow
IPC/preload, managed conversation actions or quit composition. Application owns
task/controller lifetime over existing durable control/material/native ports.
No renderer, reading window or ordinary conversation selection owns execution.

## 2. Signatures

```ts
WorkflowApplicationService.create(options)
preview({ taskDir, flowId, origin, inputs? })
start({ taskDir, commandId, previewId })
snapshot({ taskDir, run? })
events({ taskDir, run?, cursor?, limit? })
stop({ taskDir, commandId, run })
readArtifact({ taskDir, run?, ref })
previewRevision({ taskDir, run, flowId, reason, boundary, startStepId?, inputs? })
acceptRevision({ taskDir, run, previewId, commandId })
cancelRevision({ taskDir, commandId })
revisionStatus({ taskDir, commandId })
inspectWorkspaceRecovery({ run? })
readRecoveryArtifact({ run, ref })
resolveMaterialOwner(relativePath)
activeRuns()
requestShutdown()
close()
```

Actual DTOs are in shared/workflow-application.ts. ResolvedApplicationDefinition
requires immutable definition/node policies, pre-admission `assertCurrent` and
synchronous `assertExecutionCurrent():void`. Desktop API is the typed
`window.trellis.managedWorkflow`; root arguments are expected-owner preconditions.

## 3. Contracts

- Resolve canonical root, actual task/alias and private project/repository/
  workspace identity in main. Pin a local identity mapping once; later observation
  bindings never rewrite existing run scope or implicitly enable collection.
  A future server project binding is explicit and does not turn cache IDs into
  team authorization.
- Preview is side-effect-free with respect to native execution. Validate actual
  source/version, required inputs, supported Flow semantics, output policies,
  executor/configuration and bounded files before admitting a durable command.
  Check file size before loading whole context manifests.
- Source freshness and original conversation readiness are checked at preview/
  start. After admission use the synchronous execution/configuration fence;
  rereading an edited draft must not abort the healthy pinned old definition.
  Origin disconnect is not proof its separate stage stopped. Actual runtime/
  profile drift still prevents an incompatible new native dispatch.
- Persist exact origin conversation/generation, graph identity, stage session/
  turn, execution revision, output refs and committed history watermarks. Do not
  infer associations from title, current selection or latest message. History
  remains its existing store; projections retain references, not duplicate text.
- Preset stage continuation keeps runId/definition stable and advances an explicit
  material-pinned execution revision/predecessor with its own instruction/output
  contract. Aggregate prior node facts with provenance. This automatic continuation
  is not structural revision adoption or business/product approval.
- Reuse immutable output as next-stage input, replacing older versions of that
  same source. Do not append the entire chat history. Unobserved native extra
  inputs preclude claiming a complete fingerprint or safe automatic result reuse.
- Unsupported requested semantics reject before native creation. Sequential
  agent stages and the `platform-artifact-content-v1` gate are supported. A gate
  checks actual immutable declared earlier output using contains/notContains/
  minLength; it does not launch a model or invent a native session/turn. Persist
  bounded retry counters and actual abort/continue/goto decisions. A failed gate
  with continue remains failed; excluded start nodes are not-selected, not passed.
  Unenforceable tool sets/expressions, explicit native maxRounds and enabled
  completion notify/saveNote reject. False/absent completion effects are no-ops.
  Parallel branch execution/drain remains unavailable until actually implemented.
- Executor configuration identity is content-derived and immutable. New stage
  sessions use their verified runtime/profile defaults; temporary model/mode/
  reasoning choices from the originating chat are not inherited by implication.
  Explain that in preview; unknown native versions/configuration stay unknown.
- Stop results come from exact persisted stop operations and actual driver
  shutdown evidence. A terminal run alone does not prove that stop succeeded.
  Duplicate and delayed acknowledgements must reconcile the original intent.
- Structural revision requires an explicit frozen before/after preview, reason,
  affected/preserved mapping, boundary and actual reusable input references.
  Saving/accepting is not native startup. Preserve the same workspace owner/fence
  while draining the predecessor and atomically committing successor/head/outbox;
  unknown stop cannot create a successor. Ordinary Stop suppresses pending
  adoption. Cancellation after stop suppresses the successor, not resumes writes.
  Reused input is not proof a prior result can be skipped with an incomplete
  native context fingerprint. Preview output policies/configuration are cloned
  and pinned, never retained as mutable resolver objects.
- Live controller ownership authorizes exact old-run cleanup after source task
  deletion/archive/replacement; a basename match never substitutes another task.
  Path-free recovery inspection derives its scope from the actual retained
  workspace lease and loads only the requested run or that owner's head. It is
  read-only, accepts no task path/scope/owner grant, preserves missing/ambiguous
  source diagnostics, and reads original immutable artifacts after membership
  verification. A dead old main PID, missing directory or saved metadata does not
  authorize owner release, native stop confirmation, replay or mutating recovery.
- Protect original and stage composers/bind/end actions while a run is active or
  uncertain, including after controller reopen. Consult existing durable workflow
  markers/heads without creating a control DB for untouched ordinary chats.
  Boundary feedback remains explicitly unavailable until its real adapter exists;
  do not launch a competing ordinary prompt as feedback.
- Workspace admission uses actual canonical physical Git worktrees: nested
  projects/cwd share one boundary, verified linked worktrees are distinct. Query
  actual retained owner, claim the synchronous main token, then query again before
  ordinary preflight; include token validity in the facade's synchronous final
  prewrite predicate. Hold through actual native occupancy. A once-read free
  owner or current task association cannot authorize a competing prompt.
- Managed start inspects `listOwnedAcpSessionFacts()` across all project roots.
  This main-only copied scalar inventory comes from actual native session/internal
  flags, including starting/accepting/draining/unfinished work, not preferences,
  history or presentation metadata. An occupied session with unverifiable cwd/
  generation fails closed. Do not expose handles, credentials or this inventory
  as a renderer authority API.
- Ordinary new/resume/model-recovery/config IPC acquires the same workspace token
  and rechecks actual source cwd/profile and retained ownership. Native init/load
  can run hooks; it cannot race past a managed-start inventory check. Private
  managed driver calls retain their durable owner, without a renderer bypass.
  End/cancel remain available to drain. Mark lifecycle admission settled before
  awaiting native connection completion while retaining occupancy, so quit can
  reach the native shutdown needed to finish that connection.
- A handed-off ordinary token may authorize recovery of its exact retained native
  session and connection generation. Derive that identity from the actual owned
  inventory, never history's saved `connectionOwned` field. Synchronously replace
  the old token without exposing an unowned interval. Permit this only for an
  error/disconnected owner with no accepting/closing/lease/cleanup/background/
  unfinished-tool/turn/settling/permission work and no other busy owner in that
  physical workspace. Pending lifecycle work and managed, foreign or stale owners
  remain fenced. Recheck durable managed ownership under the replacement token;
  recovery still uses canonical original-connection cleanup and same-session load,
  never prompt replay or an invented idle status. Retain a sole actual blocker
  after a rejected lifecycle action so its own explicit recovery remains reachable.
- A disconnected connection can still be owned even when `cleanupRequired` is
  false. Keep an explicit End action for actual owned/cleanup-required connection
  projections, alongside normal live/restore states. A failed resume does not
  authorize automatic repeated loads; repeated receipt timestamps alone do not
  establish a renderer retry loop.
- Register bounded verified project-root discovery references before managed
  ownership. The index is not ownership: each referenced control store remains
  authority. Use the actual per-worktree Git directory, or the non-Git runtime
  namespace; bind canonical workspace, <=128 roots/one MiB. Missing/corrupt indexed
  identities fail closed. Serialize metadata dead-lock recovery separately and
  never equate metadata-lock recovery with native execution release. Recent UI
  projects and arbitrary repository scans are not exhaustive ownership discovery.
  Pre-protocol unindexed owners or external deletion of the entire namespace need
  an explicit migration/recovery policy; do not claim that case is discovered.
- Artifact reads verify selected run membership and exact owner/ref before
  registering a native fixed-source version. Neither the client ref nor a
  current-file path proves that membership.
- Subscriptions are sender-owned, bounded, cursor-based and project-generation
  fenced. Switching views/projects releases the projection lease, not execution.
  Current native permission snapshots preserve original request/option IDs; a
  historical page cannot recreate actionable permission resolvers.
- Quit closes admission, confirms actual stage drain, awaits execute promises
  including lease release, then closes writers/ACP/history. Unknown shutdown
  refuses successful teardown and retains controller access for deliberate retry.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Source changes after preview, before start | Reject stale preview without native execution |
| Draft edited or origin disconnects after admission | Continue pinned old definition if execution config remains safe |
| Runtime/profile configuration changes | Execution fence rejects incompatible launch |
| Same command ID, different semantic request | Explicit conflict; no overwrite/replay |
| Stop duplicate while prior acknowledgement uncertain | Query exact stop evidence, never infer stopped |
| Controller reopened with unknown head | Retain recovery/composer protection; no guessed replay |
| Application close during final lease-release work | Drain promises before writer close |
| Unsupported explicit Flow option | Preview rejection before side effects |
| Project changes during accepted command response | Stale/conflict reply; do not claim rollback |
| Foreign ref, body or scope supplied by client | Reject before trusted artifact registration |
| Revision accepted but old shutdown unknown | Show stop-unconfirmed/recovery-required; no successor dispatch |
| Source deleted and same-name replacement exists | Inspect/stop the original owned run; never retarget replacement |
| Restart with missing task source | Read exact retained owner/run; no guessed cleanup success |
| Another nested project's native session is starting/draining | Reject managed start in that same physical workspace |
| Ordinary connection requested after managed inventory check | Same token/retained owner prevents lifecycle race |
| Quit during native init/load | Close admissions, reach actual shutdown; no token/connection deadlock |

## 5. Good / Base / Bad Cases

Good: PRD and design stages receive distinct pinned instructions, publish actual
versioned outputs and preserve their original native turn when a session is reused.

Base: ordinary conversations/reading remain usable without creating workflow
control stores or team identities.

Bad: close a writer before its run releases the lease, treat terminal state as
proof of stop, follow an edited Flow automatically or silently apply a chat's
temporary model choice to a new stage session.

## 6. Tests Required

workflow-application smoke uses actual worker SQLite/application/driver/material
with explicit native fixture, including two-stage lineage, stale drafts, origin
disconnect, permissions, stop races, corruption and unsupported-option rejection.
workflow-desktop-host tests retained-head guards, marker-only reopen, immutable
configuration versions and unknown quit outcomes. workflow-desktop-ipc tests
actual registry/preload/sender/root/cursor/artifact boundaries. Run affected
typecheck/build and preserve prior failed evidence plus final source hashes.
These fixtures do not replace real native, graph UI, team or packaged acceptance.
workflow-admission tests actual SQLite/worker/real linked Git boundaries, durable
discovery and ordinary/managed lifecycle races. The owned ACP inventory regression
uses the actual facade/public acpx with an explicit local stdio peer, preserving
all other facade source; it is not a real vendor execution proof.
workflow-revisions additionally covers frozen preview/configuration, actual
artifact gates/retry counters, reservation/adoption crash checkpoints, late Stop,
path-free reopened inspection, missing/ambiguous sources and foreign artifacts.

## 7. Wrong vs Correct

Wrong: “the saved draft changed; stop the current agent and use it now.”

Correct: retain the admitted definition, validate a separate proposal and adopt
it only through the real revision boundary/command protocol.
