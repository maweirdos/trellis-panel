# Team collaboration

## Scope

Apply this contract to `shared/hifox*`, `shared/hifox-domain/`,
`main/services/hifox/`, `hifox:*` IPC, the renderer collaboration workspace, and
the team service/Web adapters. Local workspaces use a private JSON store; shared
workspaces use the authenticated team's service and SQLite writer. Switching
sources never uploads local records or reassigns an admitted command. Team
document publication remains a separate service. Agent execution stops at a
recorded Runtime wait.

Reference behavior: [tasks](https://help.hifox.com/docs/space/tasks),
[squads](https://help.hifox.com/docs/agent-and-computer/crews),
[versions/iterations](https://help.hifox.com/docs/space/iterations), and
[triage](https://help.hifox.com/docs/space/triage).
Space and directory behavior follows [spaces](https://help.hifox.com/docs/space/spaces)
and [Agents](https://help.hifox.com/docs/agent-and-computer/agents).

## Interfaces and persistence

- `HifoxApi` is the renderer/preload contract. Mutations return
  `{ ok: true, data: HifoxSnapshot, context? }` or
  `{ ok: false, error, code?, context?, pending?, outcomeUnknown? }`.
- Pure domain commands validate exact input schemas and execute inside an owned
  synchronous snapshot scope. Desktop file adapters and the service worker reuse
  those rules; the service never imports Electron or opens local task files.
- `loadSnapshot()` returns an independent snapshot. `mutate(fn)` clones the
  committed state, validates and writes synchronously, then publishes it. Failed
  validation or disk writes leave both memory and the saved file unchanged.
  Nested or asynchronous mutation callbacks fail.
- The default file is `userData/hifox/store.json`. `HIFOX_STORE_DIR` overrides
  its directory for isolated verification. Invalid JSON or structure produces a
  visible error and preserves the original bytes. First launch has one local
  person and no sample tasks; sample reset is explicit.
- Existing ISO timestamp fields retain their serialized representation. Version
  start/end fields use valid `YYYY-MM-DD` calendar dates with start <= end.
- The renderer serializes writes; initial/periodic reads cannot overwrite a
  newer mutation. Preload captures the original workspace key; main checks it at
  admission and after asynchronous source changes. Refreshes preserve live editor
  drafts. Source/authority loss locks or removes original shared content.

## Shared service and identity

- Independent registration/login creates ordinary people using random-salt
  scrypt credentials and opaque HttpOnly sessions. The first visitor gains no
  platform administrator grant. Authenticated users may create their own team;
  ownership comes from that creation, not browser arrival order.
- GitLab/OIDC is optional. Validate issuer, signed token, audience, state, nonce
  and PKCE. Never merge provider/local accounts by a matching name or email.
  Optional native GitLab authorization validates the provider subject before
  protected credential persistence; it is not a task-admission dependency.
- Invitations have explicit recipient identity, role, expiry and revocation.
  Acceptance uses a real signed-in account and one original command identity.
  Links are generated for the user to share; no email send is implied.
- `GET /api/projects/:projectId/hifox/snapshot` returns a current authorized
  projection. Bounded `afterRevision`/`waitMs` reads recheck account, device and
  project while waiting. Space membership is checked independently of old roles.
- `POST /api/projects/:projectId/hifox/commands` accepts an original UUID,
  expected service epoch, expected workspace revision, operation and exact input.
  Conflicts reject atomically. The service derives task/comment/triage actors
  from the verified principal.
- Snapshot instance/epoch/authorization heads are server-owned. A restored epoch
  cannot inherit a client's newer cache or pending command. Historical receipts
  are projected against current space access before returning their old result.
- Inbox recipients come from assignees, mentions, followers or rule targets.
  Read/clear/snooze preferences belong to one account, not the shared event.
- Pending commands persist the original origin/account/device/project, UUID,
  epoch, revision and payload before network admission. Unknown outcomes use that
  same operation for reconciliation/retry. Another source cannot adopt it.
- HTTPS is the deployment default. Local mode supports loopback HTTP; an intranet
  HTTP deployment explicitly allows its exact private origin. Credentials never
  enter renderer snapshots, source files, ordinary logs or command-line arguments.

## Business contracts

- Public spaces can be discovered and joined by an authorized project member.
  Private bodies/member lists require space membership. Administrative roles
  permit allowed metadata changes without granting membership or body access.
  Archived spaces keep readable history and reject writes until restored;
  unfinished tasks must be handled before archival.

- `assigneeIds` contains people. `executor` independently selects one Agent or
  squad. All references are checked against the task's space; organization
  labels, skills and task relations are the explicit cross-space exceptions.
- Disabling `multiAssignee` preserves historical task sets and permits editing
  those tasks. New tasks remain single-person until it is enabled again.
- `triagePending: true` explicitly admits a task to triage. An unassigned
  Backlog task is ordinary work. Accepting triage removes the flag; it can assign
  responsibility, enter a version, remain in Backlog, or close the task.
- Agent dispatch is queued in Backlog and waiting for Runtime in Todo or
  In Progress. Review, blocked, completed, cancelled, pending triage and
  unavailable executors do not dispatch. No UI may claim an Agent ran or
  completed work from a configuration save or dispatch receipt.
- Squad captains are people or enabled Agents from the same space and are included in
  the member roster. `saveCrew` supplies exactly one of `captainMemberId` and
  `captainAgentId`. Human-only squads require no Agent or Runtime. Squad membership
  may contain people and Agents. Exclusive
  Agents cannot receive new individual task assignments or join another squad.
  Archive preserves historical references and stops new dispatch.
- `task.iterationIds` and `iteration.taskIds` are reciprocal indexes. All write
  paths maintain both. `completeIteration({ id })` rejects unfinished tasks;
  completion never carries work into another version or removes it from history.
  Explicit scope edits precede closing. Closed version task membership is immutable,
  including completed tasks. User-facing text calls iterations **版本**;
  persisted identifiers and existing reciprocal historical links remain stable.
- `predecessorId` is an optional same-space, acyclic version dependency. Independent
  versions can run in parallel. Starting a dependent version requires its predecessor
  to be completed. Changing a dependency does not move tasks or change task statuses.
- `versionDeliveries` records incremental code/artifact references between distinct
  versions in one space. Source work may be unfinished. `recordVersionDelivery`
  changes only this ledger, never source/target task membership, completion or counts.
  Registration records a reference; it does not execute or certify a Git merge.
- Parent links cannot cycle or cross spaces. Blocking relations preserve their
  direction and render an inverse on the target. Saved views persist status,
  people, type, priority, label, project and version filters. Selected labels
  combine with AND; selected people combine with OR.
- Scheduled automations tick while the application runs. Each enabled rule
  records at most one scheduled occurrence per local date, with configured
  weekdays. Startup catches up today's occurrence; older dates are not replayed.
  Agent/squad outcomes remain `waiting_runtime`. Paused/unavailable targets do
  not generate successful execution claims.
- Inbox task groups apply read, clear, snooze and restore operations consistently
  to their constituent reminders. Snoozing an entry without a task affects only
  that entry. Clearing never removes the underlying task or discussion.

## Lifecycle and local development

The Team module is available without a local project snapshot. Its header selects
the collaboration space, not a code directory. Local code roots remain machine
bindings used when a person starts code work. Team service project IDs identify
shared authorization scopes; they do not require Git repositories or Jira.

Task lists, boards, spreadsheets, Gantt and calendar use the original
`my/pages/WorkItemsPage` with an explicit `WorkItemsSource`. Its native source
retains existing local behavior. Collaboration projections must not enter the
native store or fall through to native task/workflow mutations. Managed task
state and assignment changes use lifecycle commands. `IssueDetailLayout` owns
the common preview header, content and property rail for both task sources.

`workflow` is additive. Old records retain their original behavior until explicit
arrangement adopts them. New tasks can enter triage, be accepted without a version,
and proceed to design/research before scheduling. `transitionTask` atomically
updates stage, current handler, artifacts, history and reminders. Runtime intent
and actual execution remain distinct. Titles/job descriptions can suggest an
editable recipient but never grant authorization.

Lifecycle commands retain one task identity and version history through design,
technical planning, development, test returns and product acceptance. Code work
requires acceptance criteria before planning, a confirmed plan before submission
to testing, and current-round test confirmation before final acceptance. Test
confirmation covers every exact acceptance item. General work can deliver without
a code project. Reassignment preserves stage and artifacts. `expectedStage` and
`expectedUpdatedAt` protect a form's original task state from later changes.

The native-only `hifoxWork.status/prepare` bridge binds workspace, actor, epoch,
space, task identity and machine root. It reuses the local task command registry,
creates planning material with `--no-start`, and never changes the active task
pointer or starts Runtime. Retries reconcile the original command and task.
Developer PRD edits and changed source material require review, not replacement.
Absolute machine paths stay out of shared snapshots. Browser hosting has no local
work bridge; unsupported capability is explicit rather than simulated.

Entering a prepared native task refreshes the real project snapshot before
opening the existing reader, including when the same project is already selected.
The return intent retains original actor/epoch/task creation identity. Source
switches, authority changes and later navigation cannot reactivate it. Returning
from the native workspace restores the original business task after the native
two-write return operation completes.

## Navigation and icons

The Team module opens route `hifox`, with one resizable context sidebar and one
global task-detail surface. Global overview/inbox/my-tasks/All Agents precede the
joined-space tree. Each space owns tasks, nested board/version/triage/view/project
entries, its Agent/squad directory, automation and skills. Organization people
and space settings remain separate. All Agents aggregates currently authorized
records while retaining their owning space; same-space assignment stays enforced.
Keep the desktop shell's left module rail, top project header and single context
sidebar. Browser hosting uses the same rail/header/sidebar arrangement; browser
modules stay in the left rail and account/project controls stay in the header.
Do not replace the global module rail with a horizontal navigation bar or add a
second context sidebar. The legacy desktop project activity/report route remains
reachable from the footer. An empty shared overview offers creation to managers
and space discovery/joining to ordinary members.

Navigation, command entries, general buttons, section headings and module icons
use the existing Lucide shapes and inherit neutral theme ink. `FlowIcon({ name,
size })` defaults to that presentation; do not add per-destination colors, tinted
fills or private navigation palettes. The outer Team rail retains its Users icon.

Color expresses business data: task priority, workflow state or an explicit state
transition. `PriorityBadge` reuses `my/icons.PriorityIcon` and the canonical
`--my-priority-*` colors. `FlowIcon({ name, size, semantic: true })` opts a business
state into the glyphs in `src/shared/collaboration-icons.ts`, with the 24-unit
grid, 1.6 stroke and subtle second tone. Its matched light/dark colors belong to
`my-tokens.css`. Keep visible labels for priorities and states.
`node scripts/generate-collaboration-icons.mjs` exports both theme sets and the
gallery under `resources/collaboration/`; `--check` detects generated drift.

## Validation and errors

| Input or transition | Required outcome |
| --- | --- |
| Missing/cross-space reference or parent cycle | Reject atomically; preserve numbering and saved state |
| Archive a captain used by an active squad | Require replacing the captain or archiving the squad first |
| Add an exclusive Agent to another squad or an individual executor slot | Reject; preserve existing history |
| Complete a version with unfinished tasks | Reject without changing tasks, indexes or version status |
| Add or remove work from a closed version | Reject without changing either reciprocal index |
| Register incremental delivery from v15/v16 into v17 | Keep all three task scopes and completion percentages unchanged |
| Corrupt saved snapshot or failed rename | Report failure without resetting the store or leaking draft changes |
| View contains foreign status IDs | Reject the view |
| Repeated scheduler tick/restart on the same date | Retain exactly one scheduled occurrence |

## Required verification

Run `npm run typecheck`, `npm run build`, `npm run check:ui`,
`node scripts/smoke/navigation.mjs`, `node scripts/smoke/uiux-wiring.mjs`,
`npm run check:hifox`, and `node scripts/smoke/acp-settings-detour.mjs` when
shared dialog ownership changes. The collaboration command includes domain,
roster, task-page and workspace UI checks plus the icon generator's `--check`.
Run `node scripts/smoke/hifox-lifecycle.mjs`,
`node scripts/smoke/hifox-task-workspace.mjs`, and
`node scripts/smoke/hifox-lifecycle-ui.mjs` for lifecycle or native handoff changes.
Run the remote-client and workspace-IPC smoke checks for source/credential/
acknowledgement recovery changes. Run each service/Web package's typecheck,
build and test commands. Freeze both package builds before
`node scripts/smoke/hifox-connected.mjs --no-build`; the connected check uses
independent real accounts, HTTP, SQLite and browser partitions. A single-host
check does not establish separate-machine, intranet deployment or company GitLab
acceptance. Use a verified staged restore to rotate the service epoch/cursor
secret while preserving the original backup and store identity.
Domain checks require isolated files and real rollback/transition assertions.
The UI check mounts production components through actual preload, IPC and local
services in Electron. Check both themes, font presets, narrow layouts, focus,
draft retention, task navigation and sealed version scope. These checks do not
establish remote multi-user or Runtime behavior.

## Examples

Good: a person remains responsible while a squad occupies the executor slot;
moving the task to review removes its dispatch wait. Base: a person completes
a task without an executor. Bad: saving a squad configuration claims that its
members started working.

Wrong: infer triage from `backlog && assigneeIds.length === 0`.
Correct: use `task.triagePending === true`; Backlog remains independently usable.
