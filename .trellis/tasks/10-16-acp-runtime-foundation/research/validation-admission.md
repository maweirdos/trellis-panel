# Research: Supported public admission guards around acpx

Clean-room note (TPD-009): This independently authored experiment uses only the published runtime/registry exports and public custom-store contract. The earlier original strict peer is reused read-only. No prior protocol evidence, product source, dependency, task status, plan or upstream package was modified; no proxy/fork, credential access or vendor call was introduced.

- Query: Can small public session-store/handle guards close the failed admission cases, and can the custom store validate inbound session identity before normalized delivery?
- Scope: Local bounded public-API experiment using exact acpx 0.19.5, Node v24.12.0 and original local peers on Windows.
- Date: 2026-10-16

## Findings

**Verdict: supported small guards can enforce application readiness for the tested invalid-version/missing-ID cases, but cannot supply a complete raw protocol boundary.** A version-rejecting store prevented prompts and cleaned children, although session/new had already happened. A missing-ID handle check plus public close prevented prompts and cleaned that child. Public projected records did not expose the foreign notification's envelope identity and were saved after its normalized text had already been delivered. The original stock-package failures remain valid and unchanged.

### Artifacts and method

- Original harness: `research/validation/admission/run-admission.mjs`.
- Evidence: `research/validation/admission/runs/2026-10-16T10-06-49-071Z/results.json`, per-scenario `result.json`, `peer-wire.jsonl`, owned provider state and runtime store.
- Pointer: `research/validation/admission/latest-run.json`.
- Strict peer reused read-only from `research/validation/protocol/strict-peer.mjs`; it writes only into each new admission run's owned cwd.
- Package: the same prepared external read-only acpx 0.19.5 installation used in `validation-protocol.md`. Only `acpx/runtime` and `acpx/agent-registry` public entrypoints were imported; no private imports or package test seams.
- Explicit registry argv launches only the selected Node and owned peer. Environment is reduced to OS launch variables and owned home/appdata/temp directories before dynamic import. Every case has bounded operations/finally shutdown and the harness has a 100-second emergency watchdog for only recorded fixture PIDs.

The wrapper delegates to `createFileSessionStore` through its public `load/save` methods. **The public record field is camelCase `protocolVersion`; `protocol_version` is the file-store serialization field.** Checking only the latter property on a public record would be the wrong contract. Observations explicitly record the actual value and whether a snake-case property exists.

For the foreign-update case only, the store rejects a controlled marker after it appears in projected messages. This is an ordering probe, **not** a proposed identity/security policy: matching text cannot establish the remote envelope owner. The probe also scans the entire public record for the exact controlled foreign session ID.

### Observed results

| Case | Public adaptation | Wire/admission result | Owned-child cleanup |
| --- | --- | --- | --- |
| Valid version 1 control | Same strict version store wrapper | ensure admitted, session/new and one prompt completed | Child alive while ready, then public shutdown resolved and child exited. |
| Malformed initialize version `"one"` | Reject save when public record.protocolVersion is not exactly 1 | ensure rejected with host version-admission error; **no prompt**, but **session/new already sent** | Child already exited before caller cleanup; final shutdown resolved. |
| Unsupported initialize version 999 | Same wrapper | ensure rejected with host version-admission error; **no prompt**, but **session/new already sent** | Child already exited before caller cleanup; final shutdown resolved. |
| session/new omits sessionId | Reject returned handle without a nonempty backendSessionId | ensure returned an unusable handle, façade refused admission, **no prompt** | Child initially still alive. Supported `runtime.close({handle, reason})` resolved and exited it; final shutdown resolved. |
| Foreign session/update | Reject later projected record containing the controlled marker | Foreign marker **already delivered** at normalized event sequence 43; first save containing it was sequence 46. No public saved record contained `foreign-unowned-session`. Turn eventually failed from the injected store error. | Child had exited. Shutdown reported failure because the deliberately rejecting store also rejected terminal persistence; this does **not** establish a stock cleanup leak. |

All five recorded peer processes were gone by the final per-case checks. No emergency or broad process kill was used. The harness exits 1 because the intentional foreign-content persistence rejection yields a shutdown error; that error and its cause are preserved rather than converted into success.

### Responsibility matrix

| Responsibility | Supported public seam established | Honest remaining boundary |
| --- | --- | --- |
| Refuse an ensured handle with no remote ACP identity | Ordinary façade validates `handle.backendSessionId`, then invokes public close for that handle. Tested to block prompt and clean child. | The stock ensure result remains malformed; wrapper must not show ready before this validation or omit close. This is a small adapter guard, not a new supervisor. |
| Prevent a prompt after invalid negotiated version | Public custom-store save can reject `record.protocolVersion !== 1`. Tested to reject ensure and clean its owned child. | Validation occurs **after session/new**, so it closes app readiness/prompt admission, not strict initialize negotiation before any session operation. Other malformed capability/schema fields were not tested by this guard. |
| Reject incompatible initialize before session/new | No tested public initialization-result interception seam. | Requires a supported upstream check/hook or an explicit raw stdio/fork boundary. Do not claim the save guard moves backwards in the wire sequence. |
| Validate inbound session/update ownership | Public normalized events omit envelope sessionId; saved projection did not expose it, and save ran after stream delivery. | **Cannot be closed by the tested store or a post-normalization UI filter.** Needs upstream validation/raw hook, a separately maintained fork, or an explicit external stdio boundary. No proxy was built. |
| Preserve a user's exact selection among duplicate-kind permission choices | Ordinary single-option-per-kind callback behavior passed in the prior protocol experiment. | Public callback selects a kind, not an arbitrary original optionId. A store/handle guard cannot add a missing choice API; supported upstream API/another integration boundary is required. |
| Resource cleanup for a rejected valid public handle | Public close/shutdown were sufficient in these cases. | Do not invent manual PID ownership/termination as the primary product mechanism. These peers had no grandchildren; full lifecycle/platform gates remain separately owned. |
| History/task/project authority and UI readiness | App-owned record/handle validation and scoped façade remain appropriate integration responsibilities. | This does not justify rebuilding the delegated protocol/session/process stack or silently accepting its failed gates. |

### Interpretation for candidate selection

The experiment narrows the necessary application work: nonempty returned identity validation and app-readiness version checks can be ordinary supported façade/store integration. They do not require private imports or patching acpx. Their cleanup behavior is now observed rather than assumed.

The strict inbound identity failure is materially different. Its information has been dropped before the application receives the normalized event. A save hook cannot recover a source envelope from projected text, and rejecting a checkpoint after UI delivery is too late. Keeping the original acceptance criterion therefore requires an upstream fix/raw hook, a maintained fork or an explicitly reviewed stdio boundary. A proxy would be new protocol responsibility, so it should be compared against another maintained runtime boundary before being selected; this report does not approve one.

The coordinator's actual-vendor experiments remain separate. Codex multi-turn/tool success does not exercise these adversarial gates. The coordinator also reports that existing Claude CLI and official Claude SDK can succeed while the selected ACP adapter still returns auth-required; it would be inaccurate to treat every adapter auth failure as proof that the user's account is missing. No actual-vendor claim is independently established by this mock-only experiment.

### Rerun

From the repository root, using the already prepared read-only package:

```powershell
node .trellis/tasks/10-16-acp-runtime-foundation/research/validation/admission/run-admission.mjs
```

An alternate exact acpx 0.19.5 package directory may be passed as the first argument. Each run retains fresh evidence under the owned admission directory and does not overwrite stock protocol-run artifacts. Exit 1 is currently expected for the recorded foreign-store timing probe's rejected shutdown persistence; inspect the per-case outcomes instead of treating this as a uniform library failure.

### Related specs and public contracts

- `.trellis/spec/guides/decisions.md`, TPD-009: original fixtures/notes, read-only package/API reuse.
- `.trellis/spec/backend/ipc-conventions.md`: truthful ready/error state and explicit scope validation.
- `.trellis/spec/backend/environment.md`: owned local runtime paths and separate packaged/native evidence.
- `research/validation-protocol.md`: unchanged stock-package failures and successful ordinary protocol cases.
- Public contract references: [runtime declarations](https://unpkg.com/acpx@0.19.5/dist/runtime.d.ts) and [record/permission declarations](https://unpkg.com/acpx@0.19.5/dist/session-options-CkcvthCv.d.ts). No upstream source was changed to satisfy the tests.

## Caveats / Not Found

- Five bounded mock cases establish only the tested adaptation/ordering/cleanup facts. They are not vendor or production acceptance.
- No public raw-notification option was newly discovered. This does not rule out a future upstream release or accepted API contribution.
- Content-marker rejection is intentionally artificial and cannot authorize or classify real agent messages. Its shutdown error is an injected persistence failure, while the foreign notification delivery itself is the previously reproduced stock behavior.
- True pre-session protocol validation, arbitrary exact-option selection, broader schemas, grandfathered history and cross-project policy remain outside the passing adaptation claims.
- No product implementation, fork, proxy, task transition or dependency modification was performed.
