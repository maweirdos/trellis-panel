# Developer tools workbench

The ordinary window header provides the project/branch selector on the left and
the selected application's run controls on the right. These follow the familiar
IDEA interaction pattern without adding a code editor, debugger or IDE runtime.

## Run applications

Select a named application to start, restart or stop it directly. Open **Edit
configurations** for the grouped list and parameter editor. Drafts stay separate
when switching configurations. **Save** only persists configuration; **Save and
run** explicitly launches through the existing approval and lifecycle checks.

The bottom run window contains application tabs, actual process/readiness state
and bounded output with follow/pause. Drag its top edge or use the focused resize
separator's arrow keys to resize. Collapsing/closing the dock or a tab does not
stop a process. Use its explicit Stop control or the header Stop action. A
running process is not necessarily a healthy service.

Environment files are reread on start/restart. Configuration stays local; stored
override values are write-only. External port occupants are reported, not killed.
The platform does not clean build caches or rebuild an existing JAR implicitly.
See [local application configuration and lifecycle](local-app-runtime.md) for
environment syntax, foreground command examples, approval and Agent CLI details.

## Manual Git operations

The branch dropdown shows the real current branch, including detached/unborn or
unavailable states. **Changes and commit** opens a side panel above the run dock.
Select individual working paths to stage, or staged paths to unstage. Unstaging
does not change the working file bytes. Clicking a file opens its scoped diff;
the existing workspace/history destination remains available.

Enter a commit message and submit the staged content. A native confirmation
identifies the captured project, branch, staged paths and message. If the index,
HEAD or relevant working state changes meanwhile, refresh and review again.
Unselected working changes are not automatically staged or included.

Create local branches with an explicit optional switch, or switch to a selected
existing local branch. Dirty/occupied/conflicted workspaces are rejected rather
than automatically stashed or discarded. Resolve those cases in your normal Git
tool before retrying.

Push is an explicit ordinary push of the reviewed current commit to one configured
remote and selected destination branch; upstream configuration is optional. The
native confirmation shows a credential-redacted destination. There is no force,
automatic fetch/pull, mirror/tag push, reset, rebase, amend or discard control.
Git must already be installed; authentication/signing helpers are Git-owned.

## Failures and recovery

Repository hooks run for commits. Hooks that change the reviewed index or message
are rejected instead of silently committing a different result. Hooks still have
their ordinary local OS permissions; this is not a sandbox. A post-commit hook
failure can occur after a commit exists, and a push can succeed before setting its
upstream fails. Such results identify completed work: inspect state before retry.

Operations are bounded (30 seconds locally, 60 seconds for push, with a bounded
cleanup period). A timed-out push may already have reached the remote. Verify
the destination before retrying; the platform never escalates to force. If child
cleanup cannot be verified, an index lock/private snapshot may deliberately
remain. Verify that no related Git/hook process is alive before manually cleaning
anything; never delete another program's active lock.

Large/conflicted/in-progress repositories, active external filters (including
LFS), submodule staging/switching, executable transport URLs and multiple push
URLs require an independent Git client. The panel exposes no Git writes
to Agent CLI/TPAP clients. Fixture tests use temporary repositories/local bare
remotes only; they do not certify private build scripts, credentials or memory
savings on your real workload.
