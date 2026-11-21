# Published team collaboration UI

## 1. Scope / Trigger

Read when changing `renderer/src/team`, shared publication entry points, native
document publishing or the supplemental Web integration. `Team.tsx` composes the
collaboration entry; it does not replace the existing task/member/report views.
Desktop executes local work; published materials have their own remote owner.

## 2. Signatures

```tsx
<TeamCollaborationEntry root={snapshot.meta.root} />
<PublishWorkflowVersionButton expectedRoot={root} source={source} title={title} />
```

`source` is exactly one of `task-run` with taskDir/run/ref, `recovery` with run/ref,
or `fixed-document` with the selected registered token. Main resolves the original
body/owner. The renderer uses the structured `api.teamDesktop` bridge only; it
does not supply credentials, trusted material bodies or machine execution adapters.

## 3. Contracts

- Opening a task or a linked chat is read-only. Only an explicit analysis or development action may send its initial instruction. Bind it to the actor's conversation, exact task incarnation, workspace and observed `expectedUpdatedAt`. If the destination has a draft, attachments, a pending send or an active turn, preserve it. Opening an existing engineering conversation resumes it; selecting a particular design for implementation passes its fixed revision.
- Project membership is optional on every task. Changing `projectId` preserves the task, workflow history and current handler. A non-triage task with no workflow and an assigned team Agent can enter planning with `begin_development` from the current handler and the matching `expectedUpdatedAt`. Starting analysis needs no acceptance checklist. Confirming the engineering plan can record the first test expectations; a changed task basis still requires replanning.
- Task details put the editable task title before stage controls. In engineering
  implementation, testing, acceptance and closure, actual execution and fixed
  results precede the business handoff controls. Stage and ownership metadata
  must not be repeated in instructional cards above the working controls.
- For an assigned native Agent, highlight `submit_test` only after observed
  finalization or confirmed native cleanup with shared artifacts in `confirmed`
  or `needs-code` sync state. Before that, keep the existing explicit handoff
  available in the secondary menu. Manual/local routes retain their controls.
  This is presentation only: opening or confirming handoff still uses the
  original native finish, recipient, artifact and business transition checks.
  A failed result read or changed task revision clears the presentation hint.
- `productTaskResults.handoffPreflight` reports material readiness. The current manifest must include a confirmed check report and its matching checkpoint must identify the code being tested. One-click submission still requires the handler's confirmation, a resolved tester and rechecking the execution and manifest after `finish`. Report availability does not establish a passing check. Structured handoffs also pass the current delivery ID and revision.
- Outside intake/design, omit a fully loaded absent optional PRD banner and an
  empty inactive planning card. Preserve incomplete/error review states, actual
  planning records, active permissions/Stop and original fixed-version readers.
  Rework and missing-information feedback remain visible.
- A verified closed native task shows execution history and fixed shared
  results. A `readOnly` entry offers no preparation, Start, retry or result
  reconciliation effects and does not poll. Original Stop remains available
  while native cleanup is unconfirmed; the business task's closed state is
  not proof that the native execution stopped.

- A pairing chooses an actual authorized project in the service Web page. Pending
  identity has no project grant. Show real code/state and current server context;
  network loss leaves explicitly labelled last-observed metadata. Reconnection
  revalidates the original person/project and roles without replacing the reader.
- A version is selected explicitly. Passive events, directory refresh, publication
  B, auth refresh and theme/layout updates preserve verified body A, selection,
  scroll, drafts and fixed origin. Explicit next-version selection replaces A.
  A server-access denial locks shared content; ordinary network failure may show
  the verified offline cache with its last-observed authority.
- A cached directory snapshot and committed-receipt clues differ. Receipt clues
  are an incomplete local index, never the full currently authorized catalogue.
  An empty filtered page with hasMore is not end-of-list. Event backlog is separate
  from snapshot completeness.
- Personal visibility is the publication default. A new version selects an
  actually observed owned family and CAS version. Never silently publish a local
  file's newest text or retarget an outbox to a replacement account/device.
- Create and retain one operation UUID/digest before enqueue. After lost reply or
  reload, keep its original source/body binding. A missing local receipt at a read
  point is not proof of absence; retry preserves payload/UUID. Browser storage
  contains bounded metadata only, not full publication bodies or credentials.
- Suspending feedback UI during an admitted save releases its visual busy state
  when the original promise completes. Returning and retrying preserves original
  body/UUID. Do not abandon its identity because the view was temporarily hidden.
- Revoked/disconnected connections retain readonly original outbox history;
  shared bodies and send/retry actions are locked. A standalone publication dialog
  listens to authority changes. A late response cannot reactivate an invalidated
  form or erase a retained unknown command.
- Quotes/ranges refer to raw source UTF-16, including surrogate-pair boundaries.
  Repeated text remains ambiguous without a real selection; rendered Markdown
  offsets do not establish an original-source anchor. Recorded feedback is not
  claimed applied. Later handling/execution is a separate domain.
- Sanitize published Markdown: no raw HTML execution, automatic image fetching,
  or opening local paths in the current repository. Remote/local images remain
  placeholders until an explicit supported asset adapter exists. Explicit HTTPS
  navigation uses the existing main opener. Remote native document windows remain
  unsupported until their own original-source adapter is implemented.
- Fixed native reader publication uses the currently displayed token and main's
  sender-bound source-active result. Physical root aliases must not look like a
  project switch. Genuine inactivity stays disabled until explicit reopen; a
  transient unknown state can be retried without replacing body/selection.

## 4. Validation & Error Matrix

| Observation | Required display/action |
| --- | --- |
| Offline enqueue accepted | Saved in original local queue; not yet server-published |
| Unknown acknowledgement | Original identity retained; reconcile before retry |
| Revocation during publication | Form locked; late reply cannot restore old authority |
| Passive version B arrives | Notice/metadata may update; reader stays on A |
| Cached role after reconnect | Revalidate actual context; label old information until then |
| Recorded feedback | Recorded only; no applied or QA-success claim |
| Local image in published text | Placeholder, no implicit current-workspace read |

## 5. Good / Base / Bad Cases

Good: product reads published A while the developer's desktop is offline and
records a quote. The desktop restarts with cached A and original queued operations;
on reconnect, original receipts arrive and neither reader silently adopts B.

Base: collaboration is unopened and a local task needs no team account.

Bad: use a newly paired account to send another person's unknown write, turn a
timer into an online indicator, or label a submitted comment as implemented.

## 6. Tests Required

Exercise actual React/shared Modal/InteractionScope/Chromium behavior with wrapped
IPC fixtures for navigation/late replies/reload/retained versions/quotes/ACL loss,
keyboard focus, light/dark, narrow and zoom layouts. Label these fixture boundaries.
Use actual production desktop/service/OIDC/Web connections for
cross-process offline/restart and real selected-native-source publication. Capture
fully repainted frames; a hidden-window compositor blank is not a usable screenshot.
Do not infer company, separate-machine, package or human acceptance from either.

## Task post editing and discussion

Conversation-created tasks appear on the board. Choosing a handler, opening a
canvas, or binding another conversation does not enroll a task in staged handoffs.
The post and board change the same business status. A review request for a
specific output and a human decision to finish the task are separate events.
Only tasks using staged handoffs offer design, development, or general work
as its next step. Each choice keeps the current handler, executor, and iteration.
Show the stage rail for the chosen path after the member selects it.
Ask only for missing acceptance criteria. A different handler is an explicit
transfer. Advancing with the same handler records the stage change without
another intake decision or assignment notification.

Workflow actions and their dialogs use the owning post's source lease in both
the standalone detail and the conversation's embedded post. Leaving that
source invalidates pending actions.

The title and body edit at the reading position. Enter or blur saves the title.
Leaving the body saves Markdown after IME composition ends. Ordinary edits compare
the original field using `expectedTitle` or `expectedPostDescription`. A conflict
keeps the current server text and the member's draft available for review.
Opening, selecting, copying or quoting text does not publish an edit. Preserve
the original Markdown and offer source editing for unsupported rich content.

Selecting rich task text opens one horizontal icon toolbar anchored to the
selection. Paragraph and list choices open from their triggers. Formatting,
including applying a link, acts on the original selection. In a task's bound
conversation, the same toolbar offers quote and polish.
Polish compares a proposed replacement with the selected text. Applying it
requires the original body revision and adoption permission.

Present a generated requirement path in prose as an inline document name.
Resolve it against the member's bound conversation files or the task's explicitly
shared draft identity and fixed document version. Names alone cannot identify
a shared version. Keep inaccessible references inert and keep the original path
in Markdown source. Reading the document does not publish an edit.

The post opens on activity. Order task events and root comments by time and keep
replies attached to their discussion. Show a posted comment once. Preserve its
reply target and unsent text together when switching tabs. The conversation
tab lists bindings visible to the current member. From an ordinary task, opening
its saved design shows the canvas beside its source conversation. A Code
conversation uses a directory chosen by that member. Sending a request with a
selected design gives the agent readable HTML for that exact revision.

## Task-bound technical planning

Use `api.taskPlanning` from the original task's `TaskPlanningCard`; backend
identity, source, candidate and recovery contracts are in
[Task-bound technical planning](../backend/task-planning.md). Reuse the shared
Runtime/model pickers and TaskMaterials editor. Planning does not require a new
business task, transcript copying or an implementation writer.

Show the original planning ID's pending state and Stop as soon as generation is
submitted, including while native prepare awaits its reply. Keep that card and
its original Stop/reconcile available in later task stages. Source or handler
loss disables generation and sharing, not original cleanup. Pass changes in
planning ownership through `planningOwnerRevision` to the existing development
card's read effect; do not change its React key or clear paths/instructions.

While generation is pending, poll the original `taskPlanning.read` independently
of the generate/reconcile action lane. Scope read tickets and per-request
response state to the task and planning identity; stale results must not replace
another task or restore a consumed request. Stop remains usable.

Render an actual pending native request in the task card using the existing
permission presenter. Show complete `reviewContext.command`, `cwd` and
available `details` with its actual actionable options. Submit through
`taskPlanning.respond`, including the exact permission request and connection
generation. Do not use generic private response IPC or treat a permission choice
as plan confirmation. Harness-admitted reads produce no extra application
approval. Do not add a permission setup page or expose internal owner/receipt
identifiers as user tasks.

A candidate and a current candidate are distinct states. Retain stale candidates
for comparison. Save only the selected body through the retained original
TaskMaterials command; open its exact returned document/version, including a
conflict version. An existing authorized `implement` draft uses its observed
draft CAS. A new document requires an actual approver selection. Saving is not
approval or input adoption.

For `approve_plan`, one adopted approved `implement` reference opens read-only
fixed Markdown. “修改材料” opens that original document's material editor.
Include the full fixed reference in this branch's dialog key and draft
`creationContext`; obtain the reference from the selected source, not a retained
draft field. Preserve other actions' keys and the original handwritten path when
no formal plan exists.

Submit the exact displayed fixed body only after rereading current adopted
inputs, requiring the same unique reference and exact body. Reject changed,
removed or ambiguous sources. If a formal plan is adopted while a handwritten
confirmation is open, require reopening against that fixed version. Never let
a confirmation textarea produce a shadow plan that differs from the material
later delivered to implementation.

Pin the input read that supplied the displayed plan when opening its dialog.
Do not substitute an older task-panel projection. Plan confirmation and design
submission/approval compare the opening input identity before sending and attach
the matched `expectedInputs` fence to the business transition. Reuse that same
read for fixed-plan checks; a later read must not silently update the approved
baseline. Input changes during the final document read or transport are rejected
by the existing server transaction, preserving the dialog draft.

Validate readonly-body behavior, exact submission, old-draft preservation, new
version isolation and source-change rejection with actual dialog/draft hooks.
Exercise same-page Stop to automatic development-read refresh without remounting
the development card.

## Native task development entry

Task delivery actions reuse the current `TaskInputPanel` read for workflow role
hints. Clear that projection while its read is pending or unavailable. For
submit-test, test-pass and general delivery, intersect existing fixed task
responsibility with the adopted target stage's product/development/testing/space
owner requirement. Authenticated project roles, explicit task responsibilities
and space ownership determine those hints; names, job titles and administrator
status do not grant a configured approval role. Exact design-document approver
grants remain validated through the existing material/service boundary.

Disable delivery approval for a current handler who lacks its configured role,
with the reason available on the action. Keep cancellation, feedback and
reassignment usable while input approval is unavailable. Before finalizing native
results or submitting a delivery transition, reread the original task inputs and
compare their task identity, epoch, authorization revision and adopted bundle
identity with the dialog's opening read. A changed or unavailable source retains
the draft and requires rechecking; it cannot silently switch the intended
workflow or material version. Include the matched `taskInputTransitionFence`
as `expectedInputs` on the original business transition, so the service also
rejects changes between the last read/native finalization and commit.
UI hints never replace transactional server
authority, fixed-output, recipient-access or acceptance checks.

Every nonterminal formal task stage exposes the existing `decline` action in
the secondary workflow menu for its authorized handler. Before intake acceptance
it means rejecting the request; after acceptance label it “取消任务” and require
a cancellation reason. Reuse the original transition command, task revision and
retained draft. Cancellation preserves the task/history and uses the cancelled
status category, never successful acceptance or fabricated output finalization.
Shared writer revocation does not prove native shutdown; retain original
execution observation and Stop until its cleanup is confirmed.

The native task development card uses `productTask` for fresh shared-task
preparation/start and exact original permissions, Stop and reconciliation.
Keep Start unavailable until main confirms prerequisites and the prepared entry;
lost acknowledgement offers original reconciliation. Retained v1 owners use
their existing development/progress controls. An unknown owner must not expose
a new v1 start/report binding. Keep original Stop available after handler or
source authority loss without enabling Start or permission decisions.

When main reports `preparationPending`, show preparation activity and poll the
same entry through `productTask.read`. A completed original receipt reveals the
existing Start action without a manual reconciliation click. Clear an earlier
wait-timeout message only when the same entry is observed pending or ready.
Stop polling preparation when main can no longer verify it as pending; retain
the original explicit recovery action. Passive reads never call prepare or Start.

Show resource/directory/node names, concise actual status and adopted material
names. Internal task/execution/command UUIDs and native preparation paths are
not ordinary card content. Reuse the shared Runtime picker, fields, buttons and
theme/density tokens. Missing material/workflow/resource/runtime prerequisites
point to their existing panels; preparation cannot approve or adopt them.

For a real pending Harness permission, show the available command/directory or
file changes beside the original choices. Additional native metadata can use
the existing details disclosure; internal identifiers are not ordinary content.
Missing details must not be presented as a verified complete operation. Do not
add an application confirmation for reads or writes already admitted by the
Harness, or apply planning's no-edit restriction to implementation.

Pending permission reading, per-request response state and original Stop remain
usable while Start awaits its reply. A visible choice must not silently do
nothing because the ordinary action lane is busy. Retain single-flight Start,
prevent duplicate responses and reject stale task/request results in the UI.

Task-level `TaskExecutionResults` reads confirmed T04 versions through
`productTask.results` and `productTask.artifact` using the original
`spaceId/taskCreatedAt` as well as workspace/task. Keep this section accessible
after development handoff; a tester need not own the developer's local entry.
Show local capture, pending/unknown/denied synchronization and confirmed shared
availability separately. Read the selected immutable body in the shared Modal;
keep execution/version/digest provenance in its version details.

The existing “交给测试” action resolves `productTask.finish` before its separate
business transition. When required code is missing, request the actual fixed code
source in that action; do not default to no-code or add a compulsory finish
button. Keep the original finish receipt when the business transition fails.
An artifact receipt or execution finalization cannot approve formal materials,
adopt inputs, pass tests or accept the task.

After a tester return, the original task exposes the exact authorized feedback
and one explicit “准备返工” action. It binds the selected predecessor, return
event and current adopted bundle; it does not create another business task or
ask the user to copy the previous requirement. Keep prior entry Stop/reconcile
scoped to that entry. A successful state change notifies the task result reader
to distinguish an empty current successor from the previous fixed delivery.
Oversized mandatory feedback surfaces the backend rejection without creating an
unusable pending writer. Ordinary tester comments do not require a new feedback
document; only actual formal input changes or adopted policy gates do.

## Task results to rule drafts

Offer an explicit “沉淀规范” action from a selected fixed textual result of a
completed task. Open the existing `SpaceGovernancePanel` for an existing rule;
preserve the original result and task navigation. Do not open a second editor,
copy the source to a chat, or save/publish as a side effect of navigation.

Show the fixed source alongside the compared current rule draft. Capture that
draft's version/digest and package revision for the explicit save's
`lessonOrigin`; backend validation follows
[Completed task evidence in rule drafts](../backend/task-lessons.md).
Keep proposed text and original command recovery available after conflicts.
Never silently replace the compared base or drop a rejected source binding.

Existing reviewers can inspect retained provenance and request the fixed source
through its original authorized reader. Source-access failure does not substitute
another version or imply that the published rule body is unavailable.
Use existing submit, publish and task-input adoption actions. No useful lesson
means no promotion and no additional task-completion gate.

## 7. Wrong vs Correct

Wrong: “The response was missing, so start a new publication and clear the draft.”

Correct: preserve the original command and exact payload; reconcile its real local
and remote state under the original binding before any deliberate retry.
