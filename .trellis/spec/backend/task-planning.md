# Task-bound technical planning

## 1. Scope / Trigger

Read when changing `shared/task-planning.ts`, `main/services/task-planning/`,
the `taskPlanning` IPC/preload bridge, private planning owners, or the planning
fence in `ProductTaskEntryService`.

Planning belongs to the original Crux code task. It uses a separate
creator-private Codex ACP session and creates neither a T01 implementation claim
nor a T03 execution-input identity. Material approval, input adoption, Crux
`approve_plan`, and implementation admission remain separate operations.

## 2. Signatures

`TaskPlanningApi` methods return `ConversationResult<TaskPlanningView>`:

| Method | Input |
| --- | --- |
| `read` | `{workspaceKey, taskId, spaceId, taskCreatedAt}` |
| `prepare` | Full query plus `{commandId, expectedUpdatedAt, agentId:'codex', modelId, reusePlanningId?}` |
| `selectSources` | `{planningId}` |
| `generate` | `{planningId, sourceDigest}` |
| `respond` | `{planningId, requestId, optionId, expectedConnectionGeneration}` |
| `reconcile`, `stop` | `{planningId}` |
| `saveDraft` | `{planningId, candidateRevision, target}` |
| `recoverSave` | `{planningId, retry:false|true}` |

`saveDraft.target` is either
`{kind:'create', editorIds, approverIds}` or
`{kind:'draft', documentId, expectedDraftRevision}`. The strict schemas in
`shared/task-planning.ts` are authoritative.

`hasTaskPlanningOwner(dataDir, query): boolean` is a synchronous, read-only
preclaim fence. `ProductTaskEntryPorts.planningActive?` receives the full query;
the desktop IPC implementation calls this helper against application userData.

## 3. Contracts

### Source and native owner

- Main resolves the original connection, account, device, service instance,
  epoch, project and full task incarnation. Generation and sharing require the
  current handler, a readable non-archived space, a code task in `planning`,
  and ready adopted-input policy.
- Freeze the task title, description, acceptance criteria and update revision.
  Description and criteria are valid requirement sources; a Bug does not require
  a new PRD unless adopted policy requires it. Include exact approved document,
  governance and workflow bodies when adopted.
- Entering planning records `postInput` on the task's workflow event. It contains
  the title, effective description with confirmed clarifications, acceptance
  criteria, and the source IDs and file revisions shared on this task. A changed
  task requires the handler to adopt its current contents before approving the
  plan. Keep earlier events readable by testers. For historical tasks without
  this field, resolve the existing description and materials.
- Read shared attachment parts under the original task and account. Verify byte
  counts and SHA-256 before making a file available to the local Harness. The
  prompt names each file, revision and local path. It may also include complete
  UTF-8 text within its 8 KiB attachment text budget. A missing part keeps the
  original file pending. A source read never substitutes the sender's latest copy.
- Match the selected code resource to the physical repository. Bind the canonical
  root, directory identity, repository observation and selected full UTF-8
  engineering files. Recheck digests before dispatch and sharing. A changed source
  retains the private candidate but makes `view.current=false`.
- Capture at most 64 engineering observations, each at most 256 KiB. Complete
  serialized source is bounded by 768 KiB and 170,000 characters; the final
  prompt is bounded by 200,000 characters. Reject excess input instead of
  clipping required bodies. Exclude credential paths, dependency directories,
  Git internals, links and paths outside the confirmed root.
- `modelId` includes the selected model and reasoning effort. The main-owned
  `TaskPlanningPolicy` fixes that selection, `mode=read-only` and
  `collaboration_mode=plan`. Native creation/reconnection establishes and reads
  back these controls on one session generation; dispatch verifies them again.
  Deny persistent policy broadening and native `implement_plan`.
  An application AI API cannot substitute for the selected ACP planner.
- New preparation signs optional `permissionMode:'operator-once'` into the
  main-owned policy. Absence retains the original automatic-rejection policy;
  never mutate a retained policy or its prompt to enable new permissions.
- Normal tools admitted by the Harness require no additional Crux confirmation.
  For an actual native permission request under `operator-once`, expose only a
  unique offered single-operation choice and offered rejection choices after
  retaining complete reviewable command, cwd and available native context.
  `AcpPermissionPayload.reviewContext` is optional
  `{command:string,cwd:string,details:string}` with limits of 8,192, 4,096 and
  16,384 characters respectively. Missing, oversized or
  unreviewable context cannot authorize an allow choice. Do not guess command
  contents from the title or silently truncate approval-critical information.
- A user decision is required for a native allow choice; command text and
  read-only labels never authorize one automatically. Reject persistent
  amendments, native `implement_plan`, configuration changes, direct file-edit
  approvals and explicit broad permission grants. A one-operation allowance
  does not establish OS-wide read-only enforcement or Crux implementation
  approval. Preserve the adapter's available context without claiming it
  contains fields the adapter did not supply.
- For automatic rejection, prefer a unique offered rejection with known
  semantics (`decline`, `reject_permissions`, `revise_plan`) over cancellation;
  never fabricate option IDs. Retain offered IDs/kinds and actual decisions.
  A denied tool does not prove successful project inspection.
- Offering a persistent option alongside a valid single-operation option does
  not reject the whole request. Exclude the persistent choice from actionable
  options and reject forged selection of it; retain the original offered
  IDs/kinds in event metadata outside the actionable permission payload.
- The logical model ID retains its effort suffix, such as `[high]`. For planning
  creation, pass its parsed base model to native bootstrap: the native config
  catalog advertises base model IDs. Establish and read back the selected effort,
  model and planning controls before readiness. A base-model bootstrap ACK alone
  does not establish the full policy, and cannot authorize a prompt.
  Mandatory readback consumes the current response's complete configuration;
  missing fields cannot be replaced by the conversation's display cache.
- Use only the existing private native lifecycle and its Job/workcopy owners.
  Bind policy from the durable planning record, including during cleanup.
  Ordinary chat, requirement editing, file import and reclassification cannot
  repurpose the planning conversation.
- Serialize preparation and generation by task scope. Reject superseded
  preparations and other unclean planning owners. Before native prepare can
  create a session, persist `nativeStarted=true`, `cleanupConfirmed=false` and
  the original request. Source revalidation and this intent write have no
  intervening await.
- Store records under `userData/task-planning/<planningId>.json` with private
  creator ownership and CAS replacement. Reentering an original preparation, or
  its first generation after restart, idempotently restores a missing private
  conversation record before native intent. Do not create a replacement task,
  conversation ID or request ID.

### Pending native requests

- `TaskPlanningApi.respond` enters the existing trusted task-planning IPC
  invocation scope. A main-only private-conversation `beforeRespond` hook
  rechecks original task, creator, current handler and source authority.
  Generic private responses cannot bypass this hook. Do not weaken the
  main-window `AsyncLocalStorage` guard to accommodate another IPC family.
- Live `read` and permission responses must not wait for `generate` to finish
  or acquire its long-held lane. Project only the original live session,
  connection generation, turn, prompt request, status and pending permissions
  into optional `TaskPlanningView.nativeView`; do not expose the full private
  transcript or runtime configuration.
- Before dispatching a response, match the original sent prompt, current
  pending request, exact unique option and expected generation. After async
  source checks, reload the record and recheck Stop, policy and source identity.
  The private native response then obtains fresh model/mode/plan readback and
  revalidates owner, pending request, expiry, turn and generation before
  consuming the decision. Do not convert display cache into authority.
- The planning hook returns a synchronous validity guard through the existing
  private native port's `current` parameter. After connection/scope preparation
  and immediately before sending the RPC, check the original window,
  workspace generation, planning record, local source bytes and expiry.
  Remote task/source authorization is the snapshot admitted for this exact
  response intent. It is not an atomic transaction with native consumption;
  a later remote reassignment cannot retroactively revoke an already-sent
  command. Preserve original Stop and report uncertain responses without
  claiming that a returned error proves the native choice was not consumed.
- A native response cannot create an implementation claim, approve the plan,
  publish a material or advance business state. Source loss disables new
  grants while original Stop/End remain reachable.

### Candidate and material command

- Main captures the plan into private storage; the model does not write
  `candidate.json` in the engineering root. Require the exact request, session,
  connection generation and turn, normal `completed/end_turn`, no host
  cancellation, a confirmed turn opening and complete saved history.
- Replay assistant text updates and prefer the final-answer phase when present.
  Validate with `requirementCandidateSchema`; reject an empty or short
  acknowledgement. A ready/idle session, partial output, cancelled turn or
  send ACK is not a candidate. Candidate revision is the SHA-256 of its
  canonical value.
- Save only the selected plan body to the original TaskMaterials `implement`
  draft. Retain candidate revision, command UUID, complete body, destination,
  original epoch and draft CAS before calling the material service. Creation
  first checks the task material directory; an existing `implement` document
  must use its authorized draft instead.
- Reconcile uncertain replies through the original material command. Explicit
  retry preserves UUID/body/target/CAS. If reconciliation returns exact
  `NOT_FOUND` because the planner intent preceded material-journal admission,
  explicit retry re-admits that same retained command through `materials.command`.
  Other errors do not authorize a send. Receipt-only recovery may outlive source
  changes; sending still requires current source authority.
- Preserve conflict receipts and their exact document/version for comparison.
  Saving does not submit, approve, adopt inputs or transition the task. Do not
  attach invented execution provenance or share the private transcript.

### Cleanup and implementation fence

- Original Stop and reconciliation remain available after stage, handler or
  source changes. They use the stored private owner without a fresh team grant.
  Only successful original native end, after any in-flight send settles,
  establishes `cleanupConfirmed`; idle, disconnection and request acceptance do
  not. Stop during delayed prepare keeps the fence until late completion and
  original cleanup are reconciled.
- If failed preparation already removed the live session, a later original End
  may acknowledge cleanup only from the matching durable workcopy-owner and
  native Job witnesses. Match original owner/generation and released workcopy
  identity, reconcile its Job, and recheck that no live or pending replacement
  owner appeared during awaits. Missing, corrupt or mismatched evidence remains
  unresolved. Preserve the failed End receipt rather than rewriting it as success.
  Alias-wide recovery may clean an older generation, but its recovered-owner
  count cannot acknowledge the current generation. Recover an original retained
  lease when needed, then require the current generation's exact witnesses.
- `hasTaskPlanningOwner` returns true for matching
  `nativeStarted && !cleanupConfirmed`, including unknown preparation/sending.
  An absent planning directory returns false without creating it. Existing
  unreadable, malformed or ownership-mismatched records throw; never repair
  storage or treat damage as no owner.
- Product reads and fresh admission expose a phase blocker while that fence is
  active. Recheck after awaited directory/runtime inspection and synchronously
  at the effect callback immediately before a new claim or explicit replay of
  an unconfirmed claim. Read historical receipts
  before applying current admission gates. Preserve already-dispatched Stop
  and reconciliation.

## 4. Validation & Error Matrix

| Condition | Required result |
| --- | --- |
| Wrong task incarnation, account, handler, stage, directory or resource | Reject new generation/sharing; retain original owner and stored candidate |
| Changed requirement, adopted bundle or selected engineering file | Preserve candidate for comparison; reject treating it as current |
| Missing native controls, model acknowledgement or changed generation | No planning prompt |
| Native implementation approval, persistent amendment or broad grant | Reject; do not start implementation |
| New-policy reviewable native one-operation request | Await the user's actual choice without blocking live task reads or Stop |
| Native options contain both `allow_once` and `accept_execpolicy_amendment` | Present the one-operation choice and valid rejection; never expose or accept the amendment |
| Forged option, changed source/handler, expired request or changed native generation | Reject response; preserve original cleanup |
| Retained policy without `permissionMode` | Preserve automatic rejection; do not widen on load or reconnect |
| Partial history, ACK-only, cancellation or non-`end_turn` completion | No candidate |
| Crash between planning record and private conversation creation | Restore the same conversation before native intent |
| Crash before material-journal admission | Explicit retry admits the retained command without changing its UUID or target |
| Lost material ACK | Reconcile the original receipt; no duplicate document |
| Concurrent draft change | Preserve conflict version; no silent overwrite |
| Delayed native prepare completes after Stop | Keep implementation fenced until original cleanup is confirmed |
| Older same-alias generation cleans while current generation has no witness | Keep current planning fenced; no successful End acknowledgement |
| Damaged planning record during preclaim | Fail closed; preserve files and original controls |

## 5. Good / Base / Bad Cases

Good: a developer generates a plan from the original Bug description and adopted
rules, selects its private candidate, and saves it into that task's existing
`implement` draft with the observed draft revision.

Base: a task has no formal PRD and its adopted policy requires none; the original
description and criteria remain fixed planning input.

Bad: claim an implementation writer to obtain a planning identity, accept native
“implement this plan” as business approval, or create another document after an
unknown save reply.

## 6. Tests Required

Keep scripts, fixtures and reports in OS TEMP. Assert actual persisted source,
request, candidate and material-command identities through the production
services. Cover source invalidation, complete-turn capture, creation/admission
crash gaps, lost ACK, original-CAS conflict, superseded preparation, delayed
prepare/Stop and damaged-record preclaim rejection.
Start planning during directory/runtime waits and just before the retry effect
callback; assert zero new claims while original committed receipts are retained.
Exercise a base-only native model catalog with a logical model/effort selection.
After a failed preparation has cleaned its original Job, verify original End
acknowledgement and rejection of missing/wrong-generation witnesses or a new
pending owner appearing during cleanup.

Hold the actual generate promise pending while reading and responding through
the task IPC invocation scope. Verify request visibility and continuation after
one exact user choice, rejection through generic private IPC, duplicate-click
handling, changed source/handler, timeout, Stop during async verification and
changed native configuration/generation. Ensure no business or material side
effect and no new per-file permission request for Harness-admitted reads.

Exercise the real authenticated team HTTP path and verify that only selected
plan text reaches the original task. Test native policy enforcement and actual
provider behavior separately from controlled lifecycle responses. Neither a
candidate nor configured controls prove semantic compliance or an OS-wide
sandbox.

Run applicable `typecheck`, `check:acpx`, `check:ui` and build checks. Build only
in a physical TEMP copy under the project verification rules.

## 7. Wrong vs Correct

Wrong: clear an unknown save and create a new command, infer cleanup from idle,
or let a mutable confirmation textarea override the approved plan used later
by implementation.

Correct: reconcile the retained command, retain the planning fence until
canonical cleanup, and confirm the exact adopted reference/body under the
[task collaboration UI contract](../frontend/team-collaboration.md).
