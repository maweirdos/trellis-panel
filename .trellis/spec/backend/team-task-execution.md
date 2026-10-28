# Team task execution

## Authority and scope

The team service owns task stages, handlers, acceptance and cancellation. Use the
existing `transitionTask` domain rules for business transitions. A runtime report
updates only a task's latest execution summary; it never proves testing,
acceptance or business completion.

The desktop owns the actual working directory, runtime process and native
conversation. A code task uses the entire selected engineering base, including
its frontend/backend packages. A general task can use an application-managed
working directory without a Git repository. This directory is not an OS sandbox.

## Progress contracts

`src/shared/team-task-progress.ts` defines the service schemas. The task progress
routes are scoped by service project and task identity. Commands retain their
original UUID and service epoch. Binding uses the observed generation and binding
ID; reporting and release use the admitted binding ID and a monotonic sequence.

Store only the latest short step, blocking reason, execution state and server
receipt time. Do not store tool output, token streams, file-read history or
heartbeat history in task progress. Keep progress changes separate from the
shared business snapshot revision and inbox notifications.

Every read and write rechecks current principal, project and space access. A
writer must be the current permitted handler. An old task, handler, device,
service epoch or execution binding cannot acquire authority by replaying a saved
command. A command UUID with a different payload must not be accepted as a retry.
Directory display names and opaque session identifiers do not prove an external
runtime's actual filesystem confinement.

The global `runtime.hifoxProgress` control lane requires the protected native GUI
capability in addition to ordinary profile authentication. Bind proof to the
current connection challenge and kernel-verified process lifetime. Actor labels,
client-supplied PIDs and a workspace-less request do not establish GUI authority.
The daemon's internal sender does not depend on an attached GUI capability.

## Desktop execution

`api.hifoxProgress` exposes `status`, `start`, `report`, `retry` and `detach`.
`src/shared/hifox-task-progress.ts` owns their exact validated shapes. Browser
hosting must not expose native execution as a simulated capability.

Capture the original origin, account, device, service project, space, task,
epoch, canonical directory and native conversation identity. A subsequent page,
space or engineering selection cannot retarget background work. Reusing a saved
conversation requires matching its original execution identity; a project title
or the most recent conversation is insufficient.

Persist commands before transmission. Retain unknown outcomes and reconcile
using the original identity. Merge unsent summary replacements only when no
admitted command is changed. A rejected or conflicted binding stops background
retry until explicitly resolved. A runtime turn ending means idle or interrupted
execution, not successful task completion. Device liveness cannot establish
that an Agent is running or making progress.

The independent daemon owns both the queue and the fixed-purpose HTTP sender.
The existing desktop credential owner issues and revokes an OS-protected
progress credential. The sender reads that original grant without opening a
second team SQLite writer. Closing a GUI attachment must not remove the sender
while its native execution continues. Recheck grant identity around network
calls and reauthorize the fixed task route on every request.

Retain body-free command identity hashes until the owning task is removed.
Compact readable receipts may be bounded, but receipt eviction cannot make an
old UUID available for a new payload. Separate current progress from historical
acknowledgement clues when reconciling an uncertain write.

## Trellis projection

An explicitly team-managed task carries
`task.json.meta.panel_task_authority = "team"`. Its local status is a compatibility
projection of confirmed central state. Plain local tasks retain existing CLI
behavior. Starting or finishing a local conversation cannot approve or complete
a team task. Local archive cannot manufacture central completion. Preserve
developer-edited materials and original task provenance when projecting state.

The existing shared preparation/open path also installs the authority marker;
it cannot depend on entering the newer Agent-progress route first. Adopting an
existing preparation record checks its original metadata and performs a file
CAS without changing its status or developer documents. Do not claim to have
updated a different repository's Trellis scripts unless its adapter was actually
installed and checked.

Shared preparation and opening must probe the selected CLI's actual
`team-capabilities --json` response before creation/adoption. A marker or file
existence alone is insufficient. The source/packaged installer accepts only the
known script/dependency baseline or the current payload, defaults to dry-run,
backs up original bytes and performs revision-checked rollback. It never replaces
unknown custom scripts or mutates task/spec/hook configuration during installation.

## Rule context

`prepareAgentRules` in `services/agent-rules.ts` assembles bounded project rules,
task-curated specs and host-selected team rules. It records source content
digests, exact included bytes/characters and truncation in a manifest. Task
selection manifests are versioned even when their bodies are index-only.

Use the real serialized byte count, including JSON escaping, within the 8 KiB
rule budget. Missing selected rules and invalid or escaping paths fail visibly.
Oversized rules remain index-only with no invented full-content digest.
`assertAgentRulesCurrent` rejects changes to pinned readable project sources;
it does not silently replace an active session's context. Team source revisions
need their own authoritative revalidation. Supplying rules does not prove that
the model complied with them or grant tool permissions.

## Required validation

- Duplicate commands and lost acknowledgements produce one committed effect.
- Old sequences and superseded bindings cannot overwrite the current summary.
- Revoked actors/devices and a restored service epoch stop saved operations.
- Closing an Agent turn or losing device contact never completes a task.
- Switching space, engineering directory or conversation cannot reroute a report.
- Ordinary local Trellis behavior remains unchanged; team CLI status is guarded.
- Rule serialization handles multilingual text and escaping within the byte cap.
- Modified rules, selection manifests and foreign roots fail version checks.
- Progress UI labels cached, pending, stale and rejected state truthfully.
- Use OS TEMP for all verification scripts, fixtures and reports.
