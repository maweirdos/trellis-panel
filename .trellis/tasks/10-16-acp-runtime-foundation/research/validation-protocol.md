# Research: Published acpx runtime protocol validation

Clean-room note (TPD-009): Original strict-peer and harness code were authored for this experiment. No upstream implementation/documentation/patch was copied or changed. The installed package was read-only and used only through its exported runtime and registry entrypoints. No vendor/model call, credential access or product/dependency edit was performed.

- Query: Does exact published acpx 0.19.5 satisfy our strict protocol, permissions, controls and native-session restoration contracts through its supported public runtime API?
- Scope: Local isolated research experiment; actual Node stdio peer processes, public in-process runtime, original protocol fixtures and owned stores/logs.
- Date: 2026-10-16

## Findings

**Verdict: useful reuse surface demonstrated; strict protocol adoption gate failed.** Real public APIs handled multiple turns, correct outbound session IDs, Unicode framing, tool updates, configuration acknowledgement, ordinary permission choices/cancellation and same-session restore. However, an unrelated session notification was projected into the active turn, malformed/incompatible initialize versions were accepted, and a missing new-session ID returned an unusable handle. Duplicate-kind permission choice remains a separate public-interface limitation. These failures must not be converted into a blanket pass because real Codex operation succeeds in the coordinator's separate vendor experiment.

### Exact environment and isolation

- Package: `acpx@0.19.5`, read-only external installation at `C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/acpx-validation/node_modules/acpx`.
- Host: Node **v24.12.0**, Windows. Imported package `dist/runtime.js` and `dist/agent-registry.js`, corresponding to public package exports `acpx/runtime` and `acpx/agent-registry`. No private module import, package monkey patch or constructor test seam was used.
- Registry: a unique research alias resolves to an explicit argv array containing the selected Node executable, the owned peer script, its owned run directory and scenario. Launch admission rejects any executable other than that Node or arguments without that peer; no npx/package download path exists in this harness.
- Each run has a unique directory beneath `research/validation/protocol/runs/`; peer cwd, file store, home/appdata/temp locations and evidence logs remain there. The harness process environment is reduced to ordinary OS launch variables and owned home/temp paths before dynamic imports. It does not inspect vendor auth variables or change the parent shell's environment.
- Every operation has a bounded research deadline; the suite has a 120-second watchdog and `finally` shutdown. Only recorded fixture PIDs are eligible for its narrow emergency stop. No broad process kill was used; the observed shutdowns matched all recorded fixture launches to exits.

### Files and evidence

| File | Responsibility |
| --- | --- |
| `research/validation/protocol/strict-peer.mjs` | Independent newline JSON-RPC peer with strict remote session identity checks, controlled permission requests, configuration responses and persisted mock-provider state. |
| `research/validation/protocol/run-protocol.mjs` | Public-runtime assertions, explicit registry/store setup, bounded execution, lifecycle observations and result writing. |
| `research/validation/protocol/public-api-review.json` | Independent public-surface review and SHA-256 hashes of the installed declaration files; no copied declaration text. |
| `research/validation/protocol/runs/2026-10-16T09-57-26-735Z/results.json` | First full run: happy paths, permissions, restore, auth propagation and initial negative findings. Exit code 1. |
| `research/validation/protocol/runs/2026-10-16T09-59-24-171Z/results.json` | Focused negative rerun: foreign update, malformed initialize version, unsupported version and missing new-session ID. All four strict gates failed; exit code 1. |
| Each run's scenario `peer-wire.jsonl` | Controlled peer's received/sent protocol messages and permission responses. Authentication request contents, if any, are deliberately not recorded. |
| Each run's scenario `peer-state.json` and `runtime-store/` | Provider continuity/action counters and the runtime's own durable records; no actual application project or vendor state. |

The second run did not repeat already passing feature assertions. It strengthened negative evidence capture and the missing-ID stage assertion. The first run's looser missing-ID assertion counted “no prompt sent” as passing; the final verdict correctly treats returning an unusable ensured handle as a failed strict session-creation gate.

### Results against the original contracts

| Contract | Observed result | Verdict |
| --- | --- | --- |
| Correct remote identity and two coherent turns | Two prompt requests used `opaque-agent-session:normal:729`, distinct from local record `research-conversation`; both completed. Peer rejects any other outbound session ID. | Passed. |
| Streaming Unicode | Peer split the bytes inside the first Chinese character across separate stdout writes. Runtime text remained `你好，协议✅` without replacement characters. | Passed. |
| Tool patch/content correlation | Initial pending tool and subsequent `tool_call_update` retained `fixed-tool`, completed status, structured raw output and content array. | Passed for correlation/content. |
| Effective model/mode/config | Mode changed to edit, model to large, quality to careful; peer state and runtime status/acknowledgement agreed. Invalid quality choice rejected and careful remained effective. | Passed. |
| Four permission kinds and supplied IDs | GUI-style async callback saw all four original labels/kinds/opaque option IDs. Each outcome selected the matching upstream ID. Reject outcomes did not increment the peer's controlled action counter. | Passed when one option exists per kind. |
| Distinct options sharing one kind | Peer supplied two allow_once choices. Callback selected the semantic kind while the intended GUI choice was `opaque-second-once`; wire response selected `opaque-first-once`. | Public-interface limitation; arbitrary original-optionId contract is not satisfied. |
| Cancel while approval pending | Callback AbortSignal fired, request settled with `{outcome:{outcome:'cancelled'}}`, prompt ended cancelled, and a later turn remained usable. | Passed. |
| Foreign inbound session/update | Notification for `foreign-unowned-session` produced `WRONG-SESSION-MARKER` inside the active turn's text stream. | **Failed strict identity gate.** |
| Restart using stored native session | After runtime shutdown/new runtime instance, session/load targeted the same remote ID. Provider newCount remained 1 and turnCount advanced by one. Prior configuration remained effective. | Passed. |
| Failed native restore | Peer rejected the stored session. Result was failed with `detailCode: SESSION_RESUME_REQUIRED`; no replacement session was created and no prompt replay occurred. | Passed. |
| Auth-required failure | Peer advertised a mock login method then rejected session/new as auth-required. Error propagated with code -32000 and no prompt was transmitted. Public runtime has no authenticate method. | Error propagation passed; real login/configuration behavior remains outside this test. |
| Malformed initialize | Response contained `protocolVersion: 'one'`; runtime proceeded through session/new and accepted/completed a prompt. | **Failed schema/version gate.** |
| Unsupported negotiated version | Response contained `protocolVersion: 999`; runtime proceeded through session/new and accepted/completed a prompt. | **Failed negotiation gate.** |
| Missing session/new identity | Response omitted sessionId. ensureSession returned a local handle lacking backendSessionId; sending then failed with NO_SESSION. No prompt reached the peer. | **Failed session-creation/readiness gate**, while preventing the later prompt is useful. |

The full run recorded seven fixture launches and seven matching exits. The focused negative run recorded four launches and four matching exits. This is cleanup evidence for these peers, not proof of grandchild/process-tree behavior or app quit; the sibling lifecycle experiment owns those cases.

### Minimal failed scenarios and exact public boundary

**Foreign update:** A normal session is created, then a turn receives one standards-shaped text update whose envelope sessionId differs from the owned remote session. Its marker is delivered in `startTurn(...).events` as ordinary `text_delta`. The later valid text is also present, so this is not a failed parser or an unrelated test process's output.

Public declaration review found no supported raw incoming session/update interceptor or host-supplied transport in `AcpRuntimeOptions` (installed `runtime.d.ts:406-453`). Its normalized text/tool event types do not carry the envelope sessionId (`runtime.d.ts:217-278`). Process lifecycle callbacks concern launch/exit, and `assertActive` checks host authority around outbound prompt/control admission. Neither can validate a future incoming notification. The in-process `AcpxRuntime` class does not expose a live raw-envelope watcher; optional shared-runtime watching belongs to a different ownership topology and is not a missing local filter to turn on.

Therefore **a normal post-normalization UI filter cannot close this identity failure**. A supported upstream fix/raw hook, a separately maintained fork, or an explicit external stdio validation boundary would be required. An external validator is architecturally possible through the public launch registry, but no proxy/fork was built, and it would add custom protocol responsibility rather than be a free configuration change.

**Initialize versions:** The focused wire evidence contains the string/999 initialize result followed by session/new and session/prompt. Both prompts finished completed. A successful real adapter using version 1 does not exercise this guard.

There are smaller supported adaptation seams for some failures: an ordinary façade can reject a returned handle without backendSessionId before showing ready; a custom public session store receives records with protocolVersion and could potentially reject invalid negotiated state before admission. Persisted records retained the malformed/wrong values. The timing and cleanup correctness of a save-time guard were **not tested**, so it is a possible follow-up, not a passed repair. This does not address the raw inbound identity issue.

**Duplicate-kind choices:** Public `AcpPermissionDecision` (`session-options-CkcvthCv.d.ts:6-24`) chooses a kind or cancel rather than an arbitrary optionId. The normal four-kind test proves the runtime maps back to original IDs; it does not prove the UI can select every supplied choice. Do not discard duplicate choices or silently change the original-ID acceptance criterion to make the package pass. Seek a supported upstream exact-selection API or evaluate another candidate boundary.

### Additional observations and limits

- A partial tool update without title is normalized with generic title `tool call`. Correlation/status/content were preserved, but a UI reducer must not blindly overwrite a meaningful initial title. Whether a richer supported event surface can preserve absence is not established here.
- No real Codex or Claude prompt was run by this researcher. The coordinator's vendor report is separate: real Codex success and real Claude authentication failure must remain distinct from these adversarial protocol results.
- The mock auth case proves propagation of a controlled failure, not discovery/classification of every vendor's login method, GUI auth behavior or access to actual accounts.
- Filesystem and terminal client capabilities were explicitly disabled for these protocol cases. Callback/resource/process-tree coverage belongs to the lifecycle or later vendor work, and cannot be inferred from this pass.
- The peer uses its own JSON provider state, not a vendor transcript. Native load continuity is proven against this exact strict peer, not against every adapter.
- No package modification was attempted to turn the failures green. The result is evidence for selection/integration refinement, not authorization to relax accepted contracts or start product implementation.

### Rerun commands

From `D:/my_demo/trellis-panel` using the already prepared read-only package:

```powershell
node .trellis/tasks/10-16-acp-runtime-foundation/research/validation/protocol/run-protocol.mjs
node .trellis/tasks/10-16-acp-runtime-foundation/research/validation/protocol/run-protocol.mjs '--only=foreign session update filtering,malformed-init,wrong-version,missing-new-id'
```

An alternate exact acpx 0.19.5 package directory may be passed as the first argument. The harness asserts version 0.19.5, never installs it, creates a fresh owned run directory, writes results and intentionally exits 1 when strict gates fail. `latest-run.json` points to the latest artifact; older runs remain intact.

### Related specs and references

- `.trellis/spec/guides/decisions.md`, TPD-009: independent fixture/prose and read-only dependency use.
- `.trellis/spec/backend/ipc-conventions.md`: scoped identities and truthful typed failure/readiness integration.
- `.trellis/spec/backend/environment.md`: independent native/packaged environment validation.
- Task `research/reuse-acpx-aionui.md`: initial public API/reuse assessment, now qualified by executed failures.
- Exact public contract provenance: [published runtime declarations](https://unpkg.com/acpx@0.19.5/dist/runtime.d.ts), [published permission types](https://unpkg.com/acpx@0.19.5/dist/session-options-CkcvthCv.d.ts), [published registry declarations](https://unpkg.com/acpx@0.19.5/dist/agent-registry.d.ts). Installed declaration hashes are retained in `public-api-review.json`.

## Caveats / Not Found

No public pre-normalization session-update gate was found in the reviewed published interfaces. This is a bounded API review, not proof no future upstream release can supply one. Testing remains limited to the exact installed package/Node/Windows environment and original peer. Product code, dependencies, planning documents and task status were left unchanged.
