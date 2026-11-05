# Trellis source import

## 1. Scope / Trigger

Use for `shared/team-import.ts`, main-only `services/trellis-import/` and the
team service's staged source import. Discovery and capture are local reads.
Import writes selected candidate snapshots and source mappings to the existing
team store. Execution, connector installation, context adoption and material
approval retain their separate owners.

## 2. Signatures

`TrellisImportDiscovery.open(root, options?)` captures the physically selected
engineering root. `preview()` returns `ImportPreview`; `capture(previewId,
selections, authors)` returns `ImportCapture`. Callers are trusted main-process
owners. A renderer cannot supply a filesystem root as authority.

Wire schemas and inferred types live in `src/shared/team-import.ts`.
`canonicalImportJson(value)` supplies canonical bytes for the owning Node
boundary's SHA-256 digest. Contract version is 1.
`importTaskSummary(task)` provides the exact portable task-summary body.

Base HTTP route: `/api/projects/:projectId/imports`.

| Operation | Contract |
| --- | --- |
| POST `/commands` | `ImportCommand`; committed or duplicate `ImportReceipt`. |
| POST `/reconcile` | Full original command; original command reply or null, without dispatch. |
| GET `/namespaces` | Authorized `TeamPage<ImportNamespace>`. |
| GET `/items` | Required `namespaceId`, optional `importId`; candidate page. |
| GET `/items/:candidateId` | Fixed candidate and verified UTF-8 text. |
| GET `/batches/:importId` | Required `namespaceId`; fixed manifest, digest and receipt page. |

List and batch reads accept existing scoped `cursor` and `limit` fields.
`receipts` in a batch reply is a page, not a complete receipt array.

Every command carries `contractVersion`, UUID `commandId`, `instanceId`,
`projectId`, `expectedEpoch`, `expectedActorId` and nullable `expectedDeviceId`.

| Action | Additional fields |
| --- | --- |
| `enroll` | UUID `enrollmentKey`, `spaceId`, `spaceCreatedAt`, `label`. |
| `begin` | `namespaceId`, UUID `importId`, fixed `manifest`, `manifestDigest`. |
| `map-task` | `namespaceId`, `importId`, `sourceTaskKey`, `expectedWorkspaceRevision`, nullable `aliasFrom`, `decision:create` or `decision:link` with exact `TeamTaskRef`. |
| `snapshot` | `namespaceId`, `importId`, selected `itemKey`, exact `text`. |

Service schema 20 adds `import_namespaces`, `import_batches`,
`import_task_mappings`, `import_candidates` and `import_item_receipts` through
the existing owned SQLite migration. Bodies reuse verified immutable blobs;
commands and events reuse the service's existing transaction infrastructure.
Mapping receipt item keys use `task:` plus the SHA-256 digest of the original
UTF-8 `sourceTaskKey`. Retain the full original key in `receipt.mapping`;
prefixing that full key directly would exceed receipt/cursor bounds for valid
512-character source keys. Asset receipt keys remain their fixed item digests.

## 3. Contracts

- Keep the selected native root and its physical identity local. Shared records
  contain source-relative paths and portable identities, never a local root,
  credential, private journal or raw conversation.
- Discovery reads defined task, Spec, workflow, Agent, Skill, command, Hook and
  root-instruction locations. It executes no project scripts, hooks, engine or
  Git command and writes no source file. Linked paths are not followed.
- Exclude private workspace/runtime and editor-history locations by structural
  path. Ordinary selected Spec files named `workspace.md`, `history.md` or
  `logs.md` remain eligible; those names alone establish no privacy boundary.
- Use the published `IMPORT_LIMITS`: 12000 directory entries, 2500 files,
  depth 12, 1 MiB per file, 24 MiB total, 1000 selections/tasks and 100 owners.
  Partial inventory and unavailable sources remain visible. Missing metadata
  cannot prove that no native execution owns the workcopy.
- Scan/capture yield to the event loop between files and bounded directory
  chunks. Individual synchronous reads retain the per-file byte limit.
- Retained owner/session metadata is provenance with unknown liveness. Actual
  native-owner evidence comes from the original owner adapter. Shared root
  instructions and Hooks require root/workcopy conversion review; a selected
  task cannot imply that replacing shared instructions affects only that task.
  Enumerate known retained session metadata through its separate bounded read
  lane even though those paths are excluded from asset/context discovery. A
  missing legacy `.current-task` file cannot hide a session's `current_task`.
  This exception grants no shareable body or general private-path read.
- Capture requires the original preview, item digest, explicit purpose and
  `reviewedForSharing:true`. Revalidate selected bytes, owning task metadata and
  physical root before returning a capture. Missing/external JSONL references
  remain unresolved; they are not read implicitly.
  Malformed JSONL and external, invalid or private references reject source
  JSONL capture until explicitly resolved into portable resources.
- Task metadata defaults to a bounded task summary. Original opaque fields need
  explicit `includeOpaqueTaskFields:true`. Retain unknown-field counts and the
  source digest without automatically publishing opaque metadata. Reject
  recognized credentials, private keys and private absolute paths in shared
  manifests or text.
- Every source author has an explicit active team-account mapping or unresolved
  null. Original developer strings grant no identity, role, task assignment or
  approval. The authenticated importer remains the migration actor.
  Author mappings are keyed associations. Normalize by source-author code-unit
  order before candidate version identity; changing only their row order cannot
  create another version. Context/stage selection order keeps its own meaning.
- Enroll one source with a caller-retained enrollment key in an authorized
  project/space incarnation. Other members select that namespace. Matching
  names, absolute paths or Git remotes cannot identify a global source.
- Map original source tasks to exact team task incarnations. Name collisions
  remain explicit and never cause automatic linking. A changed task location
  requires review against a retained alias. A task without a durable source ID
  requires explicit comparison instead of guessed identity continuity.
- Task assets use original source-task identity plus the task-relative suffix;
  root assets use their source-relative path. A reviewed task-directory alias
  preserves document identity. Portable task summaries omit location and archive
  flags; the fixed manifest retains those provenance fields.
- New imported tasks use the existing business creation rules and triage;
  local completed/archive status remains source provenance. Import grants no
  effective writer, approval or adopted input. Enabled execution-triggering
  automations block automatic task creation in that space.
- Freeze the batch manifest before per-item writes. Reusing an import ID with
  different bytes conflicts. Preserve the original UUID/body through lost
  acknowledgements and reconcile rather than guessing failure.
- Identical source, purpose, representation and author mappings reuse the
  existing candidate. Changed sources create compared immutable candidates,
  retaining the original base. Preserve team drafts, approvals and adopted
  inputs. Product requirements and developer PRDs require explicit purposes.
- On a new snapshot command, receipt `comparison` and `conflicts` compare the
  current team head against the original imported base, including when an
  unchanged candidate is reused. Candidate comparison is historical and stays
  immutable. An old command receipt cannot substitute for a fresh comparison.
- Candidate reads verify stored body digest and length independently of the
  source machine. Recheck current project, space incarnation, task and account
  access on reads, writes and receipt replay. References grant no access.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Root/component replaced, linked or selected bytes changed | Reject capture; retain source files unchanged. |
| Preview ID or selected digest differs | `IMPORT_PREVIEW_EXPIRED` or `IMPORT_SELECTION_CONFLICT`. |
| Inventory budget reached | Visible limit blocker and partial inventory. |
| Unmapped author | Retain explicit unresolved mapping; no inferred team identity. |
| Inactive/foreign account selected as author | `IMPORT_AUTHOR_UNAVAILABLE`. |
| Enrollment key describes another space/label | `IMPORT_NAMESPACE_CONFLICT`. |
| Changed manifest for an existing import ID | `IMPORT_IDENTITY_CONFLICT`. |
| Moved source task without alias review | `IMPORT_ALIAS_REVIEW_REQUIRED`. |
| Snapshot before task mapping | `IMPORT_TASK_MAPPING_REQUIRED`. |
| Body digest/length differs | `IMPORT_DIGEST_CONFLICT`; no advertised candidate. |
| Recognizable secret/private path | `IMPORT_PRIVATE_CONTENT`. |
| Native malformed JSONL or external/invalid/private context reference | `IMPORT_CONTEXT_RESOLUTION_REQUIRED`; no raw-conversation capture. |
| Server context text with invalid JSON or a nonportable `file` | `IMPORT_CONTEXT_INVALID` or `IMPORT_CONTEXT_RESOLUTION_REQUIRED` respectively, with no candidate. |
| Same UUID with changed intent | `COMMAND_CONFLICT`; preserve original receipt. |
| Maximum admitted 512-character source task key | Map and page its bounded receipt without truncating the original source identity. |
| Wrong route/project, person/device or instance/epoch | Reject without retargeting. |
| Revoked membership, missing task or changed space incarnation | Deny current use/read; retain historical records. |

## 5. Good / Base / Bad Cases

Good: a second member selects the existing namespace, reads fixed source
snapshots while the original machine is offline and resumes a staged batch
without another team task or version.

Base: only selected Spec bytes are imported as candidates. Existing Trellis
execution and the original working files keep their current authority.

Bad: infer a project from a matching path, assign a source author by display
name, replace an approved product PRD with developer `prd.md`, or interpret a
local archive flag as team acceptance.

## 6. Verification

Keep validation programs, fixtures, stores and reports in OS TEMP. Run root and
team-service typechecks/builds plus applicable production guards.

Verify actual filesystem immutability, private-path exclusion, symlinks, changed
bytes/root identity, shared Hook scope and retained owner metadata. Use real
HTTP authentication and the owned SQLite worker for two-member mapping,
interruption/restart, UUID recovery, alias review, current access revocation,
purpose conflicts and immutable candidate reads. Assert that team heads and
execution authority remain unchanged. UI, installed connectors, company
deployment and actual engine takeover require their own acceptance.
Exercise the longest admitted source key through task mapping, original command
replay/reconciliation and more than one receipt cursor page.
Verify retained session inventory with no legacy task pointer; assert hashed
session identity, unknown liveness and unchanged private source bytes.
Reimport identical author associations in a different row order and assert the
same candidate/version while preserving the original source bytes.

## 7. Wrong vs Correct

Wrong: two local tasks have the same title, so merge them and mark the team task
completed because one local file says `completed`.

Correct: use the admitted namespace and original source identities; expose the
name collision, retain local status as provenance and leave business acceptance
to authorized task transitions.
