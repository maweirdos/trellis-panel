# Team tasks and local execution

## Ownership

The Docker team service stores shared task stages, assignments, acceptance and
current execution summaries. Desktop clients execute Pi/ACP sessions against
their own working directories. A service workspace is an authorization scope;
it is not a local repository. Spaces organize collaboration inside that scope.

An engineering directory is an optional execution resource. For
`honsky-governance`, select the whole base containing the frontend and backend.
One business task can change both packages. General research or product tasks do
not require opening either code package or a Git repository.

Deploy and pair clients using [Docker team service](team-deployment.md).

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

The native client can start an explicitly bound Pi or installed ACP engine from
the task. Code tasks first use the existing preparation, plan and acceptance
flow. **在 Agent 继续** opens the original task conversation, retaining its native
identity and return destination. Browser hosting can update manual progress but
cannot execute a local Agent.

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
node scripts/install-team-trellis.mjs --root 'D:/work/honsky-governance'
node scripts/install-team-trellis.mjs --root 'D:/work/honsky-governance' --apply
python -B 'D:/work/honsky-governance/.trellis/scripts/task.py' team-capabilities --json
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
node scripts/install-team-trellis.mjs --root 'D:/work/honsky-governance' --rollback '<backup-id>'
node scripts/install-team-trellis.mjs --root 'D:/work/honsky-governance' --rollback '<backup-id>' --apply
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

## Rules and versions

Ordinary and task-bound native sessions receive selected project rule context.
Task sessions additionally retain their original task input version. The rule
manifest distinguishes provided text, truncated prefixes and index-only sources.
Unprovided sections must be read before changing the affected area. A changed
pinned rule requires explicit adoption through a fresh session context.

The manifest documents the actual supplied range; it does not prove model
compliance. This does not automatically migrate all repository specs into a cloud
rule editor or synchronize arbitrary working-tree files between colleagues.
