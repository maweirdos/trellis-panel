# Runtime provider source fidelity

## 1. Scope / Trigger

Read before changing runtime discovery, model selection, account bootstrap or catalog refresh. A readable legacy file or reference application's behavior does not prove the current application's configuration source.

## 2. Signatures

- `resolveProviderEnvironment(env, {isolatedDir?})` returns `dataBaseDir`, `personalPath`, `source`, `verify()` and `assertCurrent()`.
- `createAccountContext({dataBaseDir,builtinPath,builtinActivePath?,env,settingsPath?})` provides acknowledged `sync(backend)`, session/workspace `bindSession`, scoped `handleRequest` and `dispose`.
- `ModelMetadataContext.capture(generation)`, `project(meta,refresh?)` and `selectionProblem(id)` enrich existing Claude/Codex session metadata without owning preferences.

## 3. Contracts

Session admission resolves only the requested Runtime from current definitions and launch checks. Full discovery, unrelated CLI version probes and npm latest-version requests belong to explicit catalog/settings refresh, not the critical path of new/resumed sessions. Preserve missing/disabled/custom-command validation, captured history launch snapshots, Node/SQLite requirements, actual native readiness, account entitlement and admission/cleanup fences. A faster launch is not permission to cache authorization or guess availability.

Deduplicate exact advertised provider/model refs in their original order. Custom or colliding model labels must identify their provider; retain native human labels and use the exact selector only as a last tie-breaker. Display formatting must never alter wire selectors, add candidates or change the acknowledged current model.

Native ZCode input IDs persist across adapter process restarts. Generate a fresh UUID for each admitted prompt; a process-local counter can collide after same-session load and cause the native server to suppress a new request as a duplicate. Reconnect tests must preserve the peer's input ledger across restarts.

ZCode precedence: explicit isolation, `ZCODE_DATA_BASE_DIR`, `ZCODE_HOME`, bootstrap `~/.zcode/v2/setting.json.dataBaseDir`, then home. Use the effective root's native schema-1 `provider_config.json` or intentional explicit primary path. Bound reads and validate source/schema. Never import legacy `config.json`, backups or another application's provider list as an automatic fallback.

Freeze source identity for the owned process. `verify()` fences discovery/spawn drift. Before later mutable requests, `assertCurrent()` rejects root/catalog changes with an explicit reconnect requirement, while unrelated bootstrap UI preferences do not invalidate the owner. Cancellation/shutdown remain usable. Never silently rebind a process, switch models or replay prompts.

ZCode app-server is a worker: subscription models also need host `provider/updateAccountConfig` and `interaction/requestProviderRuntimeHeaders`. The builtin revision must match the backend-selected file. BigModel individual entitlement comes from the native read-only subscription API, not cached-key presence. Reuse only current identity-bound native material; OAuth is not a model key. Fence headers to the admitted session, workspace, provider and account scope. Missing/expired/switched/unsupported accounts remain unavailable. Never log credentials, headers, config bodies or raw callback replies.

Unique categorized `configOptions` govern model controls. Preserve exact selectors, provider namespace, case, punctuation and `ccs-`. An unlisted current ID stays unlisted; never substitute item one. Retain full ZCode catalogs across intentionally current-only read/config snapshots. Native failure/limit outcomes must not become successful end-turns.

ZCode permission rejection may arrive as `permission.resolved` with `decision: deny`, rather than a separate `tool.updated` error. Resolve only the original open tool in the admitted turn/session to failed; an allow decision does not mean the tool completed. Ignore foreign, unmatched, duplicate or already-settled resolutions. Preserve sequence and turn gates. Verify live rejection independently of final assistant text: exact original decision, denied target absent and native rejection if inspected; a pending tool card is not a terminal denial projection.

CC Switch metadata is per app and process generation. Codex uses its referenced generated catalog, not an unrelated cache. Claude aliases stay intact. Per-app proxy/stack state may differ from old global switches. Unknown precedence/schema stays unknown; configured upstream is not proof of the answering upstream. Changes require honest freshness/reload status, not restarting shared daemons or silently changing effective selection.

## 4. Validation / Error Matrix

| Condition | Required behavior |
| --- | --- |
| Relocated active root plus old home MiMo config | Only active native models; no stale credential import |
| Invalid/relative/missing configured root or unsupported schema | Explicit failure; no legacy fallback |
| Root/catalog changes after connection | Reject later mutation with reconnect guidance; allow stop |
| Wrong/expired account, foreign session/workspace/provider | No authentication material; unavailable/deny |
| Removed or incompatible aggregate ID | Explicit recovery; no prefix stripping or similar-name substitution |
| Current model absent from candidates | Preserve actual ID/unknown state, never candidate one |
| Initialize success, provider failure, thought-only or cancellation | Not successful live inference |

## 5. Good / Base / Bad Cases

Good: bootstrap resolves the current primary registry, account synchronization enables its three GLM models, and configured custom providers remain distinct. Base: unavailable account with independent custom models still available. Bad: reporting stale home credentials' authentication failures as a failure of the user's current subscription.

## 6. Tests Required

- `acp-zcode-provider-source.mjs`: relocated source versus stale legacy; override/isolation precedence; schema bounds; source drift; unrelated UI changes; no credential copy.
- `acp-zcode-account.mjs`: fake encrypted store/owned local API; entitlement, acknowledgement, exact scope fences, expiry, malformed/oversized responses and redirects.
- Translation/protocol fixtures: complete tool outputs, failure semantics, exact permission IDs/orderings, sequence/identity fences, partial catalogs and same-session load.
- `acp-model-compat.mjs`: direct/routing/aggregate, exact IDs, duplicate names, unknown sources and generation fences.
- `acp-zcode-runtime.mjs --live`: real facade/public acpx/installed ZCode, fresh unseen file nonce in completed native tool output AND assistant text, multiple turns, cancel/reuse, same native identity after restore and owned cleanup. Report live permission coverage separately; do not invent approval success.
- Live acceptance requires the matching normal turn's terminal result to be completed, and the cancellation test's matching result to be cancelled. Ready state, a nonce emitted before cancellation, or a successfully sent cancel request do not establish those outcomes. Keep self-tests for both false-positive paths.

## 7. Wrong vs Correct

Wrong: `current = candidates.includes(nativeCurrent) ? nativeCurrent : candidates[0]`, or treating any home config as active. Correct: resolve/fence the actual source, negotiate exact candidates, preserve acknowledged native state and require explicit recovery on source/model changes.
