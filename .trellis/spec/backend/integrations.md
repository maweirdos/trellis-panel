# External Integration Contracts (TPD-025)

## 1. Scope / Trigger

Read before modifying external provider adapters, credentials, project bindings, source identities, task references, notifications, or the integration directory. The built-ins are Jira, GitHub, GitLab, Gitee, DingTalk, and Feishu. Connectors are trusted modules shipped with the app; runtime connection enablement is not an executable-plugin sandbox or hot installer.

## 2. Signatures

- Shared boundary: `src/shared/integrations.ts`, `IntegrationApi`, `BindingRequest`, `ConnectionRequest`, and Zod request/connection/binding/receipt/reference schemas.
- IPC: `ipcInvoke.integration.*` centrally registers explicit `integration:action` channels. Preload exposes `api.integrations`; failures use `ipcFail` with machine-readable codes.
- Registry: `IntegrationRegistry.register(provider)` / `get(providerId)` / `catalog()`; declared capabilities must have corresponding task/repository/notification ports.
- Configuration: `saveConnection(input)`, `saveBinding(input)`, `resolveConnection(input)`, `resolveBinding(input)` in `services/integrations/service.ts`.
- Source: `jiraContext({expectedRoot})`, `jiraSearch({...BindingRequest,jql,requestId})`, `jiraTransitions`, `jiraTransition`, `jiraComment`. Local import extends existing `createTaskFromJira` with optional `integration: BindingRequest`.
- Local associations: `links({expectedRoot,taskDir})`, `attach({...BindingRequest,taskDir,object})`, `unlink({expectedRoot,taskDir,linkId})`.
- Manual notifications: `previewNotification({...BindingRequest,taskDir})`, `sendNotification({...BindingRequest,taskDir,requestId,preview})`.
- Configuration events: `ipcEvent.integrationsChanged` / `api.integrations.onChanged(callback)`; payload is empty, with no secrets. Refetch owner-scoped local data on changes.
- Jira read cancellation: `cancelRead(requestId)`; requests are keyed by sender ID plus UUID, with at most four active Jira reads per sender.

## 3. Contracts

### Credentials and persistence

`userData/integrations.json` has schema version 1, at most 100 connection records, 500 bindings, 100 delivery receipts, and a 2 MiB file limit. Mutations use atomic replacement; corrupt/future-version data is preserved and rejected, never silently initialized over. New secrets use main-process `safeStorage`; public connections include only non-secret `config` and `hasSecrets` indicators. Full webhook URLs are secrets. Secret patches are `keep`, `replace(value)`, or explicit `clear`.

Legacy Jira/GitLab entries read from their existing settings as a single compatibility source. Strict integration saves use `setSettings(patch, true)` with atomic persistence and cache rollback on failure; old callers retain the best-effort default. A legacy name is fixed. New account connections are independent records. Configuration revision changes invalidate verification and stale caller revisions.

### Browser authorization

Provider manifests declare `authentication` methods and method-specific fields;
`connectionFields` is shared by form rendering and main validation. Missing
`authMethod` retains pre-OAuth PAT semantics; new GitLab forms select OAuth explicitly.
Registry entries declaring OAuth must supply an `AuthorizationPort`.
Snapshots expose `authorizationProviders` from registered native ports. Both this
native capability and the preload methods are required before saving OAuth config
or starting login; a newly compiled shared manifest alone does not prove that the
loaded main process implements authorization.

`integration:authorize` accepts a connection revision and request UUID. Cancellation
is sender+UUID scoped, sender destruction aborts the flow, one authorization may run
at a time, and the complete flow expires in five minutes. New OAuth methods have a
feature-specific preload guard; adding them must not disable unrelated existing
integration features when the loaded main/preload is old.

GitLab uses oauth4webapi 3.8.8 via dynamic ESM import for state, PKCE S256, code
exchange and refresh. Open the system browser; listen only on
`127.0.0.1:17654/oauth/callback/gitlab`. Validate method, exact Host/path and one-time
state before consuming a callback. Reject unrelated/duplicate callbacks, apply
no-store/referrer/CSP headers, and close the listener on success, cancellation,
timeout or error. The server body never echoes callback parameters. Request only
`read_api read_user`, with a registered non-confidential client and no Client Secret.
The explicitly configured company HTTP intranet instance retains HTTP support;
transport must not follow credential-bearing redirects or disable TLS validation.

Store the access/refresh/expiry/issuer/client tuple as one protected `oauthTokens`
secret. Only redacted connection metadata crosses IPC. Save after checking the
captured connection revision/enabled state, then advance revision. Changing auth
method clears previous credentials; changing issuer/client invalidates OAuth tokens.
Refreshes share one promise per connection revision, replace the encrypted token
bundle atomically, and compare the previous encrypted bundle so a late refresh
cannot overwrite a newer login. Internal refresh does not advance configuration
revision. Refresh failure requires a visible login/retry action. PAT and legacy
password-grant credentials keep their existing transport-header semantics.

### Identity and scope

Provider ID, configured connection ID, remote instance namespace, project binding ID, and stable taskRef are separate. Main compares `expectedRoot` against the current canonical root before project actions. An accepted operation captures its root and connection revision instead of resolving a different project after an await.

Jira Server 8.1 uses the existing REST v2 adapter, not a newer Cloud/DC SDK. Keep `jiraInstanceIdFor` stable. Resolve numeric issue IDs within their source namespace before relying on display keys, including after a key changes. Key-only historical references do not identify an instance: match explicit instance metadata first, then an unambiguous source URL; otherwise return ambiguity. Different-source identical-key imports gain a source-derived slug suffix to avoid directory collisions. Never overwrite edited local PRDs during source refresh.

A project with no explicit Jira bindings can use the visibly labeled global legacy path. Once Jira bindings exist, disabling/deleting them stops that project source; do not silently fall back to the global connection. Legacy callers without integration context retain their existing API path.

Repository references use `(instanceId, repository, kind, remoteId)` and stable task aliases in existing `source_links`, with `sourceKind='integration.pull_request'`. List/upsert/unlink are workspace/task scoped. A task's association list is capped at 100. Disabling/removing a connection preserves source evidence. Links show status as an association-time snapshot; they do not claim live status.

### Transport and delivery

Use the app's same-instance `proxiedFetch`, a 15-second request timeout, a 2 MiB response cap, and no credential-bearing redirects. SDK requests remain behind adapters. Octokit loads through a native dynamic import; Gitbeaker uses a custom requester based on its public options formatter. Read one 30-item repository/PR page per request, not an unbounded SDK collection.

DingTalk and Feishu accept only their documented HTTPS group-bot hosts/paths. Optional signatures follow each vendor's distinct timestamp/HMAC convention. HTTP success and vendor business-code success are separate. Connection inspection sends no message. Notification sends use exact title/body/task/destination preview comparison, UUID receipts persisted before transport, and no automatic retry. Timeouts/invalid responses/uncertain results remain uncertain. A retained UUID cannot be resubmitted blindly; receipt history is bounded and does not promise remote exactly-once semantics. Stored receipts omit message bodies and secret URLs.

## 4. Validation / Error Matrix

| Condition | Result |
| --- | --- |
| Invalid payload or missing required connection field | `E_INVALID_ARG`; no side effects |
| Project, connection revision, or binding revision changed | `E_CONFLICT`; reload/review current owner |
| Disabled connection/binding or unavailable protected credentials | `E_DENIED` or conflict; no outgoing operation |
| Corrupt/future-version config, encryption/persistence failure | Visible failure; preserve prior data |
| Unexpected remote list/PR shape | Upstream error, not a fabricated empty success |
| Anonymous/public Jira version response | Version metadata only, not authenticated business acceptance |
| Notification network interruption or unreadable response | `uncertain` receipt; no automatic resend |
| Vendor business result code is nonzero | Failed receipt; show sanitized code, not raw response/secret URL |
| Work item or destination changed since preview | Conflict before creating a send receipt or invoking transport |

## 5. Good / Base / Bad Cases

- Desktop runtime skew is distinct from browser preview: a base `window.trellis` without complete `integrations` methods means the loaded preload is outdated. Missing `integration:*` handlers mean the loaded main process is outdated. Classify these separately and give a full application restart instruction; a renderer-only refresh cannot load new main handlers. Config forms remain inspectable, but saving still requires the real bridge. Never simulate persistence or store draft credentials in browser storage.

- Good: two Jira instances have `PROJ-1`; namespace matching and directory suffixes keep their imports separate.
- Base: a global legacy Jira connection is shown explicitly when the project has never bound its own source.
- Bad: a legacy key has neither namespace nor source URL; require an explicit repair instead of selecting an arbitrary task.
- Good: disable a connection while retaining the work item's remote source link and cached association metadata.
- Bad: a 200 response with a nonzero Feishu/DingTalk code cannot become a delivered receipt.
- Good: switching projects discards old UI reads; Jira page cleanup cancels its outstanding sender-scoped read.

## 6. Required Verification Points

For the 2026-10-18 implementation, the user explicitly prohibited tests, lint/typecheck, builds, packaging, and synthetic live-provider actions. Only static source/diff review was performed. Do not record executable gates as passed. If executable validation is authorized later, cover the cases above, CJS/ESM SDK loading, actual proxy/cancellation behavior, strict persistence failures, source namespace ambiguity, reference upsert/unlink identity, credential patch semantics, and real vendor result envelopes.

## 7. Wrong vs Correct

Wrong: identify a Jira source by issue key, pass saved credentials back to renderer, call a global SDK from a component, or retry an unknown POST.

Correct: resolve captured project/binding/revision in main, delegate to a capability adapter, return redacted DTOs and truthful partial/uncertain results, and preserve explicit user intent for writes.
