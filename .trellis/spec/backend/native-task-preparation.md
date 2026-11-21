# Native Task Preparation

## Scope and owners

Read before changing `native-task-preparation.ts`, `runtime.taskPreparation`,
platform engineering bindings or retained legacy workspace discovery. The existing
Daemon owns preparation and workspace admission. The GUI's existing team service
owns the local team store and protected credential issuance/revocation; the
Daemon reads the original protected native task credential through the existing
bounded sender. The team service owns the current execution writer and fixed
input authorization.

Preparation consumes [execution authority](./team-task-executions-v2.md),
[fixed inputs](./team-execution-inputs.md) and
[delivery/checkpoint references](./team-execution-artifacts.md). It neither starts
an engine nor claims, approves, finalizes or transitions a team task.

Imported tasks additionally follow [workcopy cutover admission](./workflow-cutover.md). Preparation and verification recheck active service evidence and any required original local installation identities before engine admission, including cached native receipt paths.

## Native interface

`src/shared/native-task-preparation.ts` defines the request and binding schemas.
The native-only `runtime.taskPreparation` method uses existing RuntimeBlobs;
preload exposes no generic RPC.

| Operation | Preconditions and result |
| --- | --- |
| `prepare` | Original preparation UUID equals the Runtime command UUID; request fixes the task, protected connection, execution generation, node/attempt, input digest, workcopy observation and selected resource revisions. Returns one retained ready binding. |
| `verify` | Rechecks the original binding against current server use authorization, physical directory, material bytes, repository, occupancy and predecessor code. Does not replace the original snapshot. |
| `inspect` | Reads original local evidence for its exact authenticated native process and retained grant. It grants no current execution authority. |

### Reopening a prepared product task

An existing ready `product-managed` binding can be verified and continued from
the original product entry after the original GUI process has demonstrably
exited. Keep the same entry, claim/capture commands, execution generation,
preparation UUID, input bytes, binding owner/grant and installer intent.

- Require the current protected native GUI capability, the same OS user and the
  same physical executable. This exception does not extend editor-owned or
  unrelated database-delivery authority.
- Query the original process identity. Only absence or reuse of its numeric PID
  with a different birth proves exit. A live original process, failed query,
  unknown result or empty session inventory cannot authorize recovery.
- Capture original binding bytes, owner, grant and executable before the
  asynchronous query; recheck them and current capability afterwards. Cache only
  the irreversible exit fact for the complete original identity.
- Await this authorization before normal preparation/verification, duplicate
  preparation and cached receipt access. `RuntimeCommands.inspect` has a
  synchronous callback: identify its actual journal method there, then await
  preparation authorization before exposing the result and recheck the original
  receipt. Do not place an unawaited asynchronous check inside that callback.
- Stored workflow-package verification retains the stored original owner/grant,
  including temporary installation scopes. Return the original binding without
  rewriting its provenance.
- Exit proof permits verification of the retained preparation; actual Start
  still requires the existing facade and native checks for current task,
  account/device/connection, inputs, resource, directory/workcopy, configuration,
  package bytes and execution occupancy. Recovery never replays an admitted
  launch or manufactures a stopped result.

Verify original-entry continuation after process replacement without a new
claim or preparation, and rejection for a live/unknown original owner, different
user/executable, or binding/grant changes during the query. Cover both normal
verification and cached receipt paths. Prepared cancellation and active-process
handover require separate contracts; they are not implied by this exception.

The dispatcher supplies the kernel-authenticated process and workspace grant;
request bodies cannot supply them. Product origin requires `product-managed`
ownership and the existing protected native GUI capability. Editor origin
requires `editor-owned` ownership. Both must match the effective server writer,
actor, device, task incarnation, epoch, generation, node and attempt.

Keep runtime-valued process/grant schemas in the dependency leaf
`shared/daemon/identity.ts`. Native request schemas must not import the Daemon
protocol barrel: the protocol imports Runtime schemas and would evaluate
partially initialized schema objects. Verify actual module loading as well as
TypeScript compilation.

Check native authority before returning a cached Runtime command receipt.
A duplicate preparation receipt describes its original result. Execution must
freshly verify and acquire the actual executor's lifecycle ownership; a ready
binding is neither a live process nor an authorization TTL.

An in-flight preparation may expose its command state before `binding.json`
exists only to its original kernel-authenticated process and exact workspace
grant. Retain that authority in memory for the admitted operation and remove it
on settlement; persisted `dispatching` alone is not live authority. No result
is fabricated for an unfinished operation. During an authorized receipt read,
the same original command may advance from dispatching to completed or unknown;
recheck its method and native authority before returning the newer state.

The desktop's passive task read may accept a completed original preparation
receipt and project ready state. It must preserve entry, execution, preparation
UUID and fixed inputs, deduplicate concurrent reads, and reject stale sources
before saving. Pending observation never calls prepare, recovery, Start or
output retry. The UI polls only an observed pending preparation and clears a
wait-timeout message when that original operation is observed pending or ready.
An unknown or absent receipt retains the explicit recovery path.

After awaiting a shared command result, require the original published binding
and recheck its process/grant. Generic `runtime.command` inspection uses the
journal's actual saved method to apply the original preparation-owner check;
missing binding metadata cannot bypass it. The desktop native helper uses its
existing GUI pool for preparation operations. The common Daemon method also
accepts authenticated ordinary editor-owned clients.

Before a product preparation, the GUI helper authorizes the original native
task credential through the existing DesktopTeamService owner. The internal
preparation transport receives the fixed task reference in addition to its pin,
guard and action. The Daemon must not open another DesktopTeamStore for these
reads; GUI closure does not make the original credential a new connection.

[Product execution](./product-task-execution.md) can consume fresh verification
inside the existing admission boundary and synchronously transfer its lease to
the admitted native lifecycle. Admitted background validation uses the retained
grant and actual owning lease; it cannot recreate GUI authority or start an
unconfirmed native execution during reconciliation.

## Directory and resources

- Admit an existing canonical engineering directory without requiring Git or
  Trellis. A selected code resource additionally requires its actual repository
  identity and current resource/selection/space revisions to match.
- Capture the selected directory's physical identity separately from the Git
  workcopy identity. Replacing a nested directory must not inherit a binding
  merely because its surrounding repository and path remain unchanged.
- Capture request, process, grant and callbacks before asynchronous reads.
  Recheck original grant, physical identity, admission and workcopy observation
  around awaits and immediately before publication.
- During a preparation's read-only HTTP credential/session prerequisites,
  recheck the original native capability, physical directory, admission and
  exact held lease without starting another Git observation. The enclosing
  logical preparation step must observe current Git identity before and after
  awaiting its result. Installer and publication guards retain full workcopy
  checks before filesystem effects. A lease-only check grants no filesystem or
  execution authority, and no remote authorization result is cached.
- Read the execution and resources through the existing protected team transport.
  Preparation submits no team mutations. Fixed input use must retain the exact
  adopted bundle, portable definition digest, source digests, byte lengths,
  stage selections and current required-version availability.
- Compare resource, input and authorization observations again before publication.
  A changed timestamp alone on a server read is not a resource change.
- For a completed predecessor, verify its exact final manifest/checkpoint and
  actual receiver code using the existing native handoff reader. A selected code
  resource or required code output makes missing code a blocker. Available but
  unapplied selected files/patches are not ready.

## Private material storage

New bindings live under
`<daemon directory>/native-task-preparations/<preparation UUID>/` outside the
engineering workcopy. They never create or change project `.trellis` paths,
invoke Python/Trellis commands or write native task pointers.

- `binding.json` retains the original native owner/grant, physical directory,
  execution, fixed input, selected resource revisions, predecessor evidence and
  material mapping.
- Input files use SHA-256 of the selection ID. Output slots use SHA-256 of the
  node/output identity. Caller titles and paths do not select storage targets.
- Keep input ordering, purpose, required/optional status and source identity in
  the mapping. An output slot declares a destination; it is not a produced or
  confirmed artifact.
- Publish directories and files without replacement; never adopt a partial
  directory after a crash. Existing unrelated bytes and altered material remain
  available for explicit inspection rather than being overwritten.
- Verify material directories and files before reuse. Reject redirection,
  malformed metadata, changed fixed bytes and mismatched mappings.
- Bound one material to 1 MiB, total input material to 16 MiB, binding metadata
  to 2 MiB and retained preparations to 2,000. Use the existing bulk transport
  for results above the native control-frame limit.

## Occupancy and retained owners

Reuse the existing workspace admission fence and workcopy-use registry. A
temporary tree-change lease encloses awaited reads, opted-in local workflow
installation and private publication;
settling it asserts only that preparation ended. It proves no engine shutdown.
Physical aliases, nested paths, active writers and unknown retained leases
remain blockers. Lease age never clears occupancy.

`assertNativePreparationAvailable` checks actual native session ownership and
`assertRetainedWorkflowAvailable` reads existing legacy control stores without
initializing a workflow application, creating markers, migrating databases,
changing identities or releasing owners.

Discovery covers the selected root, physical ancestors, known controllers and
registered workspace projects. Missing registered roots/stores, malformed
identity, unsupported schema, active/recovery owners, unresolved dispatches and
runs without a confirmed terminal boundary block admission. The database remains
read-only and its original identity is checked around inspection. Discovery is
bounded to 64 ancestor levels, 512 candidate roots, 256 owners, 2,048 runs and a
512 MiB original control database.

Retained legacy execution continues to use its original controller, identity,
store and bounded cleanup controls. New platform storage does not re-key or take
over an old execution. Loss of task authority cannot manufacture a stopped
result or authorize a replacement owner.

## Ordinary project workflow package

New opted-in requests carry `workflowPackagePolicy: 'fixed-context/v1'`.
`NativeTaskBinding.workflowPackage` retains version, handler, installer operation
UUID, release digest, installer manifest digest and private intent digest.
Absent policy preserves the original request and binding serialization. Never
install retrospectively while inspecting or recovering an older preparation.

`buildOrdinaryPackage({ input, rules, codeResource, rootObservations })` validates
the captured input and portable definition digests and returns the complete
add-only installer file plan. Pass governance selections from every captured
node with exact bodies and availability, not only the current node.
`manifestDigest` identifies the installer plan; `manifestFileDigest` identifies
the manifest file bytes. They are not interchangeable.

Install only `.crux/workflow/releases/<releaseDigest>/manifest.json`,
`workflow.json`, `ENTRY.md` and `rules/<bodyDigest>.md`. Definition order, role,
gate and output instructions come from the captured portable definition.
Canonical release content excludes its self-digest and derived path, task,
execution, selection, bundle, session, reporter, device and timestamp fields.
Do not write credentials, private native paths or mutable current-task pointers.
Required missing/withdrawn bodies reject; optional unavailable sources retain
their references and status with `inclusion: 'unavailable'` and no body path.
Preserve available body bytes exactly. Enforce the installer's 64-file, 1 MiB
per-file and 8 MiB total limits without truncating required content.

`ProjectWorkflowInstallation` wraps the existing guarded installer inside the
original tree-change lease. Its private `project-workflow-installations`
directory holds intents, release ownership, plans and Hook receipts outside the
engineering root. Preserve original process/grant, directory/workcopy,
preparation, operation and preview identity across recovery. Reuse another
preparation's completed release only after verifying its original journal and
installed bytes; never adopt its incomplete operation or stage an empty plan.

Observe `AGENTS.md`, `CLAUDE.md`, `.codex/config.toml`, `.codex/hooks.json`,
`.claude/settings.json` and `.claude/settings.local.json` read-only, including
explicit absence. Changed observations or unowned/modified release targets
produce conflicts and preserve user bytes. Updates add releases without
rewriting earlier pins. A crash leaving a directory without recorded ownership
remains an explicit conflict; do not infer ownership or delete it automatically.

The application-managed `fixed-context/v1` Hook verifies the retained binding,
package pin and required fixed sources before native creation and prompt.
Receipts fix task/execution/node/attempt, input/release/operation, native
dispatch/session/generation, boundary and outcome. Retain at most the first pass
and first fail for each of the two boundaries per dispatch. Repeated assertions
do not append rows. Long-lived permission/session callbacks do not rerun this
task-start Hook after launch; original Stop/reconciliation remain available
even when package or installation metadata is missing.

| Condition | Required result |
| --- | --- |
| Old request/binding without policy | Original behavior; no installation, pin or Hook record. |
| Original interrupted install with recorded ownership | Recover the same operation and preview under current admission. |
| Changed required source/package before creation | Failure receipt, zero native session creation. |
| Drift after session creation but before prompt | Prompt-boundary failure receipt, zero prompts; original cleanup remains available. |
| New adopted release | New immutable release and preparation pin; earlier release bytes/pins retained. |
| Optional unavailable rule | Explicit unavailable manifest reference; no fabricated body or new required gate. |

Verification uses actual builder, installer, preparation and execution owners.
Cover those cases, root-file preservation, per-preparation isolation, bounded
receipt growth and wrong-owner recovery rejection. Controlled native ports
cannot establish real provider or native SessionStart/PreToolUse compatibility.
Wrong: treat an existing same-named directory or an embedded context packet as
installation/native-Hook proof. Correct: verify original installer ownership and
bytes, and report application task-start separately from native provider events.

## Required verification

Keep scripts, fixtures and reports in OS TEMP under the root local-only rule.
Verify both origins against real team device credentials and fixed inputs; plain
directories; selected repository mismatch/change; stale claim/input/access;
duplicate and changed-UUID payloads; material alteration/redirection; physical
replacement; active/unknown overlapping occupancy; partial publication; retained
legacy stores and original cleanup; and missing/unapplied predecessor code.
Check the authenticated native method, original command receipts and bulk wire.
Report native startup and actual engine execution only when exercised separately.
