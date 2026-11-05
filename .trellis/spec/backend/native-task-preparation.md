# Native Task Preparation

## Scope and owners

Read before changing `native-task-preparation.ts`, `runtime.taskPreparation`,
platform engineering bindings or retained legacy workspace discovery. The existing
Daemon owns preparation, protected team credentials and workspace admission.
The team service owns the current execution writer and fixed input authorization.

Preparation consumes [execution authority](./team-task-executions-v2.md),
[fixed inputs](./team-execution-inputs.md) and
[delivery/checkpoint references](./team-execution-artifacts.md). It neither starts
an engine nor claims, approves, finalizes or transitions a team task.

## Native interface

`src/shared/native-task-preparation.ts` defines the request and binding schemas.
The native-only `runtime.taskPreparation` method uses existing RuntimeBlobs;
preload exposes no generic RPC.

| Operation | Preconditions and result |
| --- | --- |
| `prepare` | Original preparation UUID equals the Runtime command UUID; request fixes the task, protected connection, execution generation, node/attempt, input digest, workcopy observation and selected resource revisions. Returns one retained ready binding. |
| `verify` | Rechecks the original binding against current server use authorization, physical directory, material bytes, repository, occupancy and predecessor code. Does not replace the original snapshot. |
| `inspect` | Reads original local evidence for its exact authenticated native process and retained grant. It grants no current execution authority. |

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

After awaiting a shared command result, require the original published binding
and recheck its process/grant. Generic `runtime.command` inspection uses the
journal's actual saved method to apply the original preparation-owner check;
missing binding metadata cannot bypass it. The desktop native helper uses its
existing GUI pool for preparation operations. The common Daemon method also
accepts authenticated ordinary editor-owned clients.

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
temporary tree-change lease encloses awaited reads and private publication;
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

## Required verification

Keep scripts, fixtures and reports in OS TEMP under the root local-only rule.
Verify both origins against real team device credentials and fixed inputs; plain
directories; selected repository mismatch/change; stale claim/input/access;
duplicate and changed-UUID payloads; material alteration/redirection; physical
replacement; active/unknown overlapping occupancy; partial publication; retained
legacy stores and original cleanup; and missing/unapplied predecessor code.
Check the authenticated native method, original command receipts and bulk wire.
Report native startup and actual engine execution only when exercised separately.
