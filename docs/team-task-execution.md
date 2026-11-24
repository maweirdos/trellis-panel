# Team tasks and local execution

## Ownership

The Docker team service stores shared task stages, assignments, acceptance and
current execution summaries. Desktop clients execute Pi/ACP sessions against
their own working directories. A service workspace is an authorization scope;
it is not a local repository. Spaces organize collaboration inside that scope.

An engineering directory is an optional execution resource. Select the whole
base containing the packages needed by the task. One business task can change
both frontend and backend packages. General research or product tasks do
not require opening either code package or a Git repository.

Deploy and pair clients using [Docker team service](team-deployment.md).

| Object | Responsibility and relation |
| --- | --- |
| Team service project | Account, device and shared-data authorization scope |
| Team space | Members, rules, templates, tasks and planning inside that scope |
| Team task | Formal stage, handler, approved inputs and delivery; independent of a local directory |
| Code resource | Team-approved repository identity selected by a code task |
| Local working copy | Physical directory checked against that resource; another copy can serve a parallel task |
| Development attempt | Original task creation identity, device/account, copy, branch and frozen input version |
| Launch configuration | Commands and environment for a particular engineering directory |
| Running instance | Actual directory, configuration snapshot, environment check and process ownership fixed at start |

Selecting a space does not select a repository. Selecting a repository does not
rebind a task. Saving a launch configuration does not change an existing
instance. A task may reference an explicitly reused instance without owning its
process; releasing that reference does not stop it.

## Views

Use **协作** for team spaces and tasks without engineering controls in the header.
Use **开发** to show the local engineering selector, Git branch and run controls.
The choice is a presentation preference. It does not transfer tasks, change
permissions, stop a running process or select a different conversation.

Space navigation remains in the team workspace. Local Git, run configurations,
Trellis hooks and the `.trellis/spec` directory remain attached to the actual
engineering base. An Agent session retains its admitted directory even when the
user navigates to another space or engineering directory.

## Task progress

Open a task's **执行动态** section to view its latest step, execution state,
blocking reason, responsible person and synchronization information. **更新摘要**
replaces the current short summary. Clearing the blocking-reason field removes a
previous blocker. Saved summaries do not advance the formal task workflow.

**任务对话** opens the ordinary task's conversation in the desktop Workbench
under its current task and assignee. Start formal engineering work from
**本机开发环境** after preparing the task and selecting an available engine and
model. On an upgraded device, **核对原清理** checks the original session's
process ownership and releases its workcopy only after confirming cleanup.
Browser hosting supports manual progress updates.

The primary reporting binding belongs to one current handler and execution
identity. Taking over a binding requires confirming the observed binding and
generation. A takeover invalidates previous reporting authority; it cannot prove
that a process on another machine has stopped.

## Formal state and local Trellis

Use task workflow actions to submit testing, request acceptance or accept a
delivery. A model reply, completed tool call, idle Agent or finished conversation
does not complete the business task.

Preparing a shared task marks its local Trellis task as team-managed. Local
`task.py start` selects the task context and records the actual branch without
advancing the central stage. `finish` clears the local active-task pointer.
Local archive is unavailable for team-managed tasks. Local hooks still execute;
legacy state-upload hooks must honor the team authority marker. Plain local
tasks retain their independent workflow.

Before preparing or opening shared code work, the desktop runs the selected
engineering CLI's read-only `team-capabilities --json` probe. An old CLI that
ignores the authority marker is rejected before task creation or adoption.
Local file status never grants authority to advance the central task.

## Install the local team adapter

Run these commands from the platform source checkout. The engineering root below
is an example; use the actual whole-base directory:

```powershell
node scripts/install-team-trellis.mjs --root 'D:/work/trellis-panel'
node scripts/install-team-trellis.mjs --root 'D:/work/trellis-panel' --apply
python -B 'D:/work/trellis-panel/.trellis/scripts/task.py' team-capabilities --json
```

The first command is a dry run. Stop concurrent Trellis CLI commands before
applying. The installer updates six adapter files, verifies the supported script
and dependency hashes, and backs up original bytes under
`.trellis/.team-trellis-backups`. Task data, specs, project configuration and hook
configuration are preserved. Unknown customized script versions are rejected
without overwrite; they require a compatible upstream update or a reviewed
adapter port. A partial failure attempts only revision-checked restoration of
the files changed by that operation.

The installation result contains a backup ID. Preview and apply rollback with:

```powershell
node scripts/install-team-trellis.mjs --root 'D:/work/trellis-panel' --rollback '<backup-id>'
node scripts/install-team-trellis.mjs --root 'D:/work/trellis-panel' --rollback '<backup-id>' --apply
```

An installed desktop includes the same hashed payload and standalone installer
under `resources/team-trellis`. Its compatibility error supplies an exact command
using the bundled Node runtime and original engineering directory. It does not
silently replace scripts when selecting a directory. After rollback to a legacy
CLI, shared work remains blocked until compatible guards are restored.

Confirmed service state is projected into the original local task using source,
epoch, revision and file-version checks. This preserves PRD edits, design
documents, branches and reference files. A damaged or conflicting projection is
reported instead of overwriting the local file.

## Synchronization and recovery

Only meaningful summary and lifecycle changes are sent. Task progress contains
no token stream, tool output, raw runtime logs or history of every file read.
The latest summary overwrites the previous one. Compact command identity hashes
support retry safety without retaining old summary bodies.

Pending and unknown outcomes retain their original command identity. A retry
cannot select another account, device, space or task. After network recovery,
the service rechecks the original authority before accepting queued changes.
An offline cache is last-observed information, not confirmation of current
access or task completion. Device heartbeat indicates connectivity, not work
progress. Older step summaries remain explicitly dated.

The independent local runtime service retains the progress queue and sender
when a GUI attachment closes. Stopping that runtime service also stops local
execution and sending. Reopening the GUI reconciles the original pending
commands rather than replaying the task's first prompt.

A known terminal command result keeps its original body/identity without being
shown as an unknown request still awaiting transmission. Uncertain outcomes keep
their uncertainty. Explicitly replacing a stopped primary preserves its pending
records in the old attempt, checks the current server binding and still requires
original process cleanup or an independently proven copy. This is a new primary,
not a replay or retargeting of an old command.

A startup interrupted before the GUI receives its result remains a creation
recovery, not a failed task or permission to create another conversation. Retry
checks the original native alias and persisted creation intent. A confirmed
original conversation can be rebound using the original reporting command;
sent or uncertain first prompts are not sent again. An unknown original process
keeps its workcopy exclusion. A replacement on another copy requires explicit
selection and proof that its physical directory is independent.

Older executions without a complete native process witness remain unknown on
their original copy. Process absence or deleting a local record cannot clear
that exclusion. Use the original controller to confirm cleanup, explicitly
select an independent copy, or reconcile after a verified full Windows restart.
Original history and files remain available.

## Rules and versions

Ordinary and task-bound native sessions receive selected project rule context.
Task sessions additionally retain their original task input version. The rule
manifest distinguishes provided text, truncated prefixes and index-only sources.
Unprovided sections must be read before changing the affected area. A changed
pinned rule requires explicit adoption through a fresh session context.

The manifest documents the actual supplied range; it does not prove model
compliance. Team rules/templates can be edited, reviewed and published in
**空间设置**. Task **固定输入** selects exact approved documents and published
rule/template versions. A newer draft/publication leaves that selection intact.
Explicit adoption creates a new input bundle; the native development panel then
compares it with the current attempt before preparing a successor. Local code
and arbitrary repository files are not automatically shared.

## Bind and continue development

Select the code task's permitted resource, then an existing local copy. The
native review shows the actual repository, directory, branch and working
changes. The currently viewed engineering directory is only a candidate.
Cancelling creates no local task. Preparation creates materials; Agent execution
and application startup remain explicit actions.

Continue the original development context to retain its task and fixed input.
Changing copy or adopting new input creates another attempt while preserving
the old directory and edits. A task already in development can be bound on a
receiving member's device without resetting its formal team phase.

Browsing another engineering directory is independent viewing, not a conversation
or process migration. Return to the task context before task-scoped Git/launch
operations. Returning to collaboration restores the original task/list context
and leaves local applications running.

Reconcile unknown preparation results using the original command. Missing or
replaced directories, changed branches and adopted input changes require review.
Finished tasks retain their history; further development needs an explicit team
handoff. Inspect or safely stop old instances from the global local-run center.
Saving a configuration affects a later start, while an existing instance keeps
its original snapshot. Task launch/reuse requires a native environment check.
Local service addresses do not establish a shared test environment or acceptance.

The expanded task service panel refreshes its full plan once per minute and on
explicit refresh. Local process/readiness events update runtime facts without
granting task execution or changing an existing environment check. Hidden or
collapsed panels do not poll full task plans. Every actual action still checks
the original task, current permission, input and local environment.

## Return local outputs to the team

Open **开发环境、任务服务与产物** in the original development context. Select a
supported task output, its destination team draft and approvers, preview its full
content, then confirm in the native dialog. Only that registered file is managed;
arbitrary source files and frozen references are not shared.

Stable saves update the original team draft using its confirmed revision. A
concurrent team edit retains a conflict candidate and pauses that file. Compare
the actual local and team content before explicitly resuming. An uncertain
request retains its original command and body for reconciliation; a later save
cannot replace it. Stopping synchronization does not delete either copy.

The generated `prd.md` preparation index is not a complete requirement document
and cannot be uploaded unchanged. An edited PRD is a working draft and requires
comparison with the original team PRD or full frozen input before registration.
Approval, input adoption and formal handoff remain separate team actions.

Native output versions record their reporting device, original attempt and input
digest. This is device-reported provenance, not server proof of filesystem
contents or model compliance. A newer adopted input is shown as a difference;
it does not silently retarget an already registered output.
