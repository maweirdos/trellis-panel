# Workcopy workflow cutover

## 1. Scope / Trigger

Use for shared cutover contracts, team activation storage and routes, the main-only workflow-cutover service, native preparation and editor admission. The cutover boundary is one quiescent physical workcopy, including every affected task and shared dispatch surface.

## 2. Signatures

Portable version-1 schemas live in `src/shared/team-cutover.ts` and native requests in `src/shared/native-workflow-cutover.ts`. `CutoverManifest` fixes the source import UUID/digest, native connector identity, task mappings and adopted input bundles, file before/after digests and reviewed conversions.

`CutoverCommand` carries `commandId`, `operationId`, `instanceId`, `projectId`, `namespaceId`, `workcopyDigest`, original actor/device/epoch, expected revision and one action:

| Action | Payload / result |
| --- | --- |
| `stage` | Fixed manifest and manifest digest; fences new affected writers. |
| `installed` | Exact installed manifest, connector and file digests; keeps the fence. |
| `activate` | Requires installed evidence and current task/input authority. |
| `suspend` | Fences new writers before local restore. |
| `rollback` | Records rollback without undoing committed team facts. |

Base HTTP route: `/api/projects/:projectId/cutovers`. `POST /commands` accepts the full original command; `POST /reconcile` accepts that same body and reads its original receipt without dispatch. `GET /workcopies/:workcopyDigest` requires the original instance/namespace and optionally operation UUID. `GET /tasks/:taskId` requires the task's instance, space and creation identity. Replies retain exact scope, operation, manifest digest, command digest, actor/device/epoch and revision.

Service schema 23 adds `team_cutover_operations`, `team_cutover_heads`, `team_cutover_task_fences` and `team_cutover_commands` through the existing SQLite migration. Reuse the existing team command/mutation authorization and transaction owner.

Native `runtime.workflowCutover` accepts `propose`, `preview`, `apply`, `recover`, `suspend`, `rollback` and `inspect`. `propose` takes a native preparation pin, the original stage envelope without `manifest`/`manifestDigest`, and source pins `{ importId, importManifestDigest, tasks, conversions }`. It returns `{ preview, blockers, ready, enforcement }`; `preview` contains the native-generated original stage command, complete files and digests. The caller returns that exact preview for guarded staging, then applies its operation UUID and preview digest. Later actions address the retained operation UUID. The engineering root comes from the authenticated workspace grant; no caller root, file bytes or filesystem attestation is accepted by `propose`.

`WorkflowCutoverInstaller` retains byte-exact plans, backups and per-file intent under the existing private team-platform cutover directory. `stage` takes `operationId`, `rootDirectory` and bounded `CutoverFileChange[]`. A change contains `relativePath`, nullable `expectedBeforeDigest`, nullable `afterDigest` and matching nullable `afterBytes`. A null after digest explicitly removes a reviewed dispatch file.

Known baseline conversion is selected by exact path and SHA-256 in `connectors.ts`, covering the reviewed repository baseline and Trellis 0.6.17 template bytes with their recorded LF/CRLF forms. The native workflow replaces the known `.trellis/workflow.md`; reviewed local task/bootstrap/context/journal entrypoints are retired through guarded removal. Source task, workspace, spec and journal records remain. Recognition proves which bytes were reviewed; it does not prove custom provider automation or native editor Hook enforcement. Unknown or modified executable surfaces require a supported conversion before activation.

## 3. Contracts

- Inventory every actual source task and shared root/Skill/Hook/configuration/prompt dispatch surface, including `.claude/settings.json`, `.claude/settings.local.json` and `.codex/hooks.json`. Apply the same provider-file coverage to ordinary-directory retained-dispatch checks. A selected import manifest is not a complete workcopy inventory. Check imported mapping receipts and exact digests against the physical source before installation.
- Partial inventory, omitted mappings, unresolved required conversion or retained owner of unknown liveness prevents cutover. Discovery never executes source scripts.
- `.claude/settings.local.json` uses metadata-only import classification. Retain its path/digest and unresolved behavior blocker; selecting its raw body for shared capture rejects with `IMPORT_SELECTION_CONFLICT`. Main-only conversion review may inspect original bounded bytes without copying credentials into shared resources, manifests or logs.
- Reuse workspace admission, the existing tree-change lease and actual native/legacy owner checks. Retain and revalidate the physical root and path components around asynchronous boundaries.
- `propose` retains the original input and generated preview under `team-platform/cutovers/proposals`. It writes no source files, creates no installer stage and sends no service mutation. Identical input returns the retained generated body; source drift adds blockers without replacing it. Changed input or an altered returned preview rejects with `COMMAND_PAYLOAD_CONFLICT`.
- Persist the complete original mutation before dispatch. An uncertain reply reconciles that UUID and body. A null reconcile result cannot prove an in-flight command will never commit. Explicit recovery may resend the exact retained UUID/body through the idempotent service after fresh authority checks; never replace that command or rebuild it from a newer head.
- Private journal, proposal, native-command and lease readers use the immutable-publication reader. A crash may retain one `.publish-<UUID>/prepared` hard-link alias; admit it only when physical identity, bytes and the single-entry scratch directory match the published record. Reject unowned aliases and changed ownership. Lease recovery ignores only bounded generated publication scratch names; unexpected receipt entries remain errors.
- A fresh protected native command may recover a retained operation after process restart using a current authenticated grant for the same physical root and original team actor/device. Revalidate the new native process/grant while preserving the original service mutations and receipts. Cached native command receipts keep their original process/grant authority.
- Keep server staging, local installation, installation acknowledgment and activation as separate observed milestones. Installation alone does not authorize writers.
- Stage, installation acknowledgment and activation use the original actor/device. Future claims use current legitimate task-handler/device authority. Initial adopted inputs remain fixed through activation; later approved T03 adoption is pinned by the new execution command and normal input checks, without re-migrating the source.
- New v2 claims and new v1 progress bindings obey the same cutover fence. Original history, reconciliation, report/release and native cleanup retain their existing ownership rules.
- Inject locally verified `cutoverAdmission: { operationId, manifestDigest }` before saving a new claim intent. A retry may omit only this injected proof; compare the rest of the semantic intent and reuse the exact saved command.
- Revalidate installed instruction and connector bytes plus the installer-retained file and directory identities at fresh admission, native preparation and verification, including cached native receipt paths. Identical bytes in a replaced connector directory do not preserve installation ownership. Server activation alone cannot attest a filesystem.
- Suspend new server admission before rollback. Restore only files whose bytes and installer-owned identity still match. Later local edits become explicit conflicts. Never delete private source records or reverse committed tasks, resources, artifacts or business effects.
- Platform connectors use current MCP operations and the current desktop account/device connection. Explicit Python commands receive the existing process environment. Provider context Hooks discover the existing local TPAP credential through the native-fixed profile descriptor described below. Project files never contain a credential. Generated registration bytes require separate actual provider-event verification.
- Reject unsupported custom executable conversion visibly. Do not count an extra instruction file as conversion of old dispatch surfaces that remain executable.

### Standard provider context Hooks

Only the complete Trellis 0.6.17 standard Hook map and exact reviewed LF/CRLF Python sources in `provider-hooks.ts` are supported. Recognized Python commands are `python`, `python3`, `python.exe` and `python3.exe`. Each provider requires one unambiguous registration and all referenced standard sources; custom or partial behavior remains blocked.

- Claude registration: `.claude/settings.json` or `.claude/settings.local.json`; sources: `session-start.py`, `inject-subagent-context.py` and `inject-workflow-state.py`. Replace SessionStart (startup/clear/compact), PreToolUse (Task/Agent) and UserPromptSubmit with `python -X utf8 .crux/workflow/v1/provider-hook.py claude <event>` using the reviewed Python executable name and fixed registration event.
- Codex registration: `.codex/hooks.json`; sources: `inject-subagent-context.py` and `inject-workflow-state.py`. Replace UserPromptSubmit and SubagentStart (reviewed Trellis roles), and add the PreToolUse `^(?:spawn_agent|Agent)$` gate before creating those subagents. The command uses the same adapter with `codex <event>`. Each handler sets `additionalContextLimit: 0`; the adapter itself enforces the 8192-character context bound.
- Replace only `hooks`, preserve other parsed top-level settings and retire the reviewed old scripts. The installer independently reconstructs the allowed settings result from original bounded bytes and rejects unrelated setting changes. Backup and rollback retain exact original bytes, including local settings. Private local settings bodies never enter shared import resources or the portable manifest.
- `connector.json` contains the absolute `accessDescriptorPath` supplied by the native runtime as `join(userData, 'access-endpoint.json')`. The adapter requires a running version-1 descriptor at `http://127.0.0.1:<port>/tpap/v1`, reads the sibling `access-token` and calls only `team_editor_hook_context` at `/tpap/v1/mcp` through initialize/initialized/tools-call. It refuses proxies, redirects, non-loopback endpoints, malformed credentials and oversized input/output. It never echoes credentials or provider response errors.
- Each generated registration fixes its event in the adapter command before stdin is read. The payload must report that same event; malformed, non-object, invalid UTF-8, oversized or mismatched input cannot bypass the registered Codex PreToolUse denial.
- Native `session_id` is mandatory. Codex subagents use the parent session ID, not `agent_id`. No task selection is inferred from cwd, current-task files, the first connector task or an agent role. Responses must match provider/session and a complete connector task identity.
- Before context injection, explicitly claim the selected task, capture its fixed execution input, then call `team_editor_session_bind` with the connection, provider/session, full task identity, execution/generation/input digest, root node and role-to-node mapping. First bind uses `expectedRevision: 0`; rebind requires the current binding revision. A role chooses context within that binding; it never selects another task.
- An unbound root SessionStart/UserPromptSubmit returns only binding instructions with the native session identity. It admits no task resource. Subagent/tool context requires the binding and explicit mapped role. Stale execution, revoked account/device/connection, missing required body or installed-file drift returns an explicit failure. Bindings are bounded to 64 in memory and must be re-established after bridge restart.
- Claude preserves all original tool-input fields and prepends the fixed role context to `prompt`. A check prompt containing `[finish]` selects the explicit finish mapping. Successful Hooks omit `permissionDecision` so provider permissions still apply. Claude failures report a bounded reason to stderr and exit 2. Codex PreToolUse failures return `hookSpecificOutput` with `hookEventName: "PreToolUse"`, `permissionDecision: "deny"` and the bounded `permissionDecisionReason`, then exit 0. Exit 2 alone does not enforce the Codex spawn gate. Other event failures report to stderr and exit 2; SubagentStart cannot prevent startup, so the separate PreToolUse gate must reject before spawning. No automatic permission allow is generated.

Physical installer identity stores exact decimal `BigIntStats` strings. Windows inode values may be negative; accept the signed decimal representation and compare it unchanged. Absolute-value conversion would merge distinct identities and is forbidden.

### Required behavior ownership

Conversion review must identify the actual source behavior and its executing owner. Removing a known baseline entrypoint retires that dispatch path; its digest match alone does not establish behavior equivalence. Generated instruction, Skill, Python and Hook files prove installation content, while registration and execution require their own evidence.

| Required behavior | Executing owner / evidence |
| --- | --- |
| Physical engineering root, fixed preparation inputs and installed-file admission | Native task preparation and cutover admission using the authenticated workspace grant and original installer journal. |
| Current handler/device, single writer and current adopted inputs | Team execution command authorization and input validation. |
| Delivery before transition and configured required database check | Existing delivery and task-input gates; preserve their command receipts. |
| Configured Jira mapping and route | Protected business routing and durable dispatch; a queued job alone does not prove the remote side effect. |
| Source-required editor context injection, stop checks, tool interception or custom side effects | Actual supported native registration or explicit equivalent platform owner; otherwise a preview blocker. |

Do not infer required editor interception from a generic registration descriptor. Conversely, do not require an editor Hook for a business invariant already enforced at the owning platform mutation. Preserve ordinary project instructions outside a uniquely validated managed span byte for byte. Old dispatch references and unsupported required behavior outside that span remain explicit conversion blockers.

## 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Partial source inventory, omitted task mapping or unsupported required behavior | Preview returns blockers; apply rejects with `CUTOVER_BLOCKED`; no installation or activation. |
| Active/unknown legacy owner | Refuse quiescent switch; preserve old cleanup route. |
| Wrong actor, device, epoch or expected revision | Reject the original mutation under existing team authorization. |
| Same UUID with changed semantic payload | `COMMAND_PAYLOAD_CONFLICT`; never create a replacement UUID automatically. |
| Missing local journal or changed connector bytes / physical identity | `CUTOVER_LOCAL_PROOF_MISSING` or `CUTOVER_DRIFT`; reject fresh writer/preparation while preserving original reconciliation and release. |
| Replaced root/component or link | Installer rejects with `CUTOVER_PATH_CHANGED`; admission reports `CUTOVER_DRIFT`. Ambiguous root markers block preview. |
| Unknown local/server milestone | Retain original operation and keep new admission fenced. |
| Later local edit during rollback | Preserve the edit and return a file conflict. |
| Partial/custom provider map, missing reviewed Hook source or missing native descriptor path | Block proposal/preview; do not install a pretend provider registration. |
| Unbound root event | `SESSION_UNBOUND` permits binding instructions only; no task resources. |
| Unbound child role, stale binding/execution, authority change, missing context or cutover drift | Return the explicit `SESSION_*` failure without fallback task context. Claude PreToolUse uses exit 2; Codex PreToolUse uses explicit deny JSON and exit 0. SubagentStart failure alone cannot prevent startup. |
| Same native session rebind with stale revision or changed original intent | `SESSION_BINDING_CONFLICT`; preserve the current binding. |

## 5. Good / Base / Bad Cases

- Good: two mapped tasks share root instructions; one quiescent workcopy operation fixes their source/input versions, installs verified bytes and activates only after matching service evidence.
- Base: an ordinary T05 engineering directory remains usable without Trellis initialization; authority comes from the native grant and task execution contracts.
- Bad: activating a selected task while an omitted sibling still uses the shared old Hook, treating a lost reply as failure, or restoring a backup over later manual edits.

## 6. Tests Required

Use isolated TEMP roots, profiles and service stores. Assert complete two-task mapping, retained-owner rejection, exact UUID replay/conflict, interruptions before and after local install and service mutation, persisted recovery, verified private-publication alias recovery and unowned-alias rejection, drift and link/root replacement rejection, guarded rollback and continued old-execution cleanup. Exercise the actual protected public `propose → preview → apply` dispatch with two providers and no caller-generated file bytes/digests. Assert no source writes/service dispatch during proposal, original-body recovery, preservation of unrelated settings and negative-inode journal reload. Verify the actual MCP session bind/context loop for two tasks in one directory, CAS retries, restart, revoke/rebind, generation changes, role mapping, required Agent instructions and drift. Separately run actual Claude/Codex registration/events and inspect the context received by the model; direct Python execution or mock MCP replies cannot establish native provider acceptance. Include prompt bootstrap before binding, Claude tool-input preservation and Codex pre-spawn rejection. Keep tests, fixtures and reports outside the repository. Run root typecheck/build/check:acpx/check:ui and team-service typecheck/build.

## 7. Wrong vs Correct

Wrong: after an activation timeout, read a newer head and issue a new activation command; interpret null reconciliation as proof the old command cannot commit.

Correct: retain the original operation, command UUID/body and expected revision, reconcile that exact intent and fence new admission while the outcome remains uncertain.
