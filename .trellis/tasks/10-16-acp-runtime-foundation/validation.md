# Product acceptance record

Status (2026-10-17): implementation, adversarial checks and both vendors' core
functional acceptance pass. Final desktop/IME acceptance is still in progress. Do not archive this task or
replace its failed stock-package research evidence with product passes.

## Versions and test boundary

- Application 0.1.0, Electron 44.4.3 / embedded Node 24.21.0; external Node 24.12.0.
- acpx 0.19.5, compatibility revision 1; actual scoped ACP SDK 1.8.0.
- Managed Codex adapter 2.2.2 / codex-cli 0.160.1 and Claude adapter 0.91.0 /
  Agent SDK 0.3.300 / wrapped Claude Code 2.1.300, installed explicitly
  through the product's Setup IPC into its isolated userData cache.
- Codex reported `gpt-6.1-sol`. User explicitly selected `glm-5.3-flash` for Claude
  acceptance. The adapter's current advertised `sonnet` choice has that display
  name; earlier observed alias maps differ. IDs alone do not prove the underlying
  third-party model identity. The assistant changed only the authorized session
  selection, not global provider/credential settings. See `final-versions.json`.
- All model operations target the owned `fixture project`, containing a generated
  README token, harmless AGENTS instructions and a single sample Trellis task.
  No model operation targets the dirty application checkout.

External evidence root:
`C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/acp-native-qa/`.
Requests use the actual built renderer's public `window.trellis` preload methods,
real registered IPC handlers and application services. A bounded acceptance
controller records results; it does not substitute a direct CLI for product
sessions. Native input/observation uses the Computer Use skill.

The QA package is built by electron-builder from the real production output and
dependencies. Its test bootstrap isolates userData, disables protocol/login-item
and shortcut registration, and sets PATH to Windows/System32 + Windows **before**
loading the unchanged packaged main. It loads the renderer from app.asar, with no
development server. File hashes in `package-inspection.json` verify main, preload,
renderer entry, patched acpx and its SDK schema match the current workspace build.
This is instrumented packaged acceptance, not an installer/signing/OS integration
test. The ordinary production package manifest is not changed to use the helper.

## Executed product matrix

| Scenario | Codex | Claude | Evidence / limits |
| --- | --- | --- | --- |
| Clean missing adapter diagnostics + explicit setup | Passed | Passed | `runtime-before-setup`, `setup-codex`, `setup-claude`; no start/discovery install |
| Two coherent turns in desktop product | Passed | Passed | `codex-first-result`, `codex-recall-result`; `claude-greet-result`, `claude-recall-result` |
| Native-tools profile in restricted-PATH package | Passed | Passed startup/chat | `packaged-runtime-refresh`; Claude `packaged-claude-initial` reports real identity/modes/models, no dev Mock |
| Same remote conversation after app shutdown/restart | Passed | Passed | Codex keeps wire ID and recalls original marker; Claude `glm-persistence-read` / `glm-resume-memory` keep its wire ID, read a fresh nonce and recall `GLM_AFTER_CANCEL_OK` after full restart |
| README nonce using actual tools | Passed | Passed with selected GLM | Final `final-codex-read` / `glm-persistence-read` observations include real tool calls and the current random token |
| Controlled write and tool details | Passed | Passed | `final-codex-write-settled` includes actual diff path/old/new text and two separately approved operations; `glm-write-allowed` changes the physical file after exact allow-once |
| Actual offered rejection | Passed | Passed | Native Codex reject_once leaves target absent; `glm-write-rejected` returns failed tool/no retry and preserves the prior file bytes |
| Cancel while awaiting permission | Passed | Passed | `final-codex-cancelled` / `glm-cancelled` settle once with cancelled result, no live approval and unchanged file |
| Subsequent usable turn after cancellation | Passed | Passed | `CODEX_FINAL_CANCEL_OK` / `GLM_AFTER_CANCEL_OK`; a send during cancelling is rejected without queuing |
| Task/material association | Passed | Passed | Both capture `.trellis/tasks/acceptance/prd.md` provenance without task/Jira transition |
| Light desktop + dark 960px layout | Observed | History observed | Side list yields; Recent picker and transcript/input remain usable |
| Drafting while busy, no automatic send | Passed | Shared UI fixture | Chinese draft stays editable, Send disabled while busy, draft remains after deny/cancel |
| Scroll-up during live turn | Observed | Shared UI fixture | Prior content remains visible as permission arrives; Return to Latest appears |
| Real system IME composition | Pending native | Pending native | Hook regression is not a system IME test |
| Profile creation/edit and persistence | API passed; native pending | API passed; native pending | `final-profile-save-confirmed` / `final-profile-after-restart`; root-scoped service/UI regressions pass |
| Exact model/mode acknowledgement | Passed | Passed | Final effective Codex read-only; explicit GLM selection and Claude plan→default both acknowledged; categorized projection correction passes integration tests |
| Foreign current-root action | Passed main IPC | Shared service boundary | `final-foreign-prompt` returns E_DENIED after switching fixture roots |
| Unresolved tools / directory occupancy | Passed | Passed | Claude cancellation omits terminal tool update; app retains visible reason, rejects competing Codex restore, and releases after explicit End |
| Owned process tree on app quit | Passed | Passed | `final-owned-tree` / `final-owned-cleanup`: all16 captured owned processes exit; separately confirmed none of those PIDs remains |

## Claude tool-result investigation

The initial user-settings inheritance issue is resolved by the stable host policy
`ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1`. Real conversations pass with the existing
configuration. A successful CLI login or greeting is not coding acceptance.

Before the native-profile correction, a real Terminal tool returned the fixture
nonce in completed rawOutput, but the model retried and claimed no output.
After unadvertising optional ACP filesystem/terminal callbacks, a **fresh** Claude
session in the packaged app completed two coherent turns; its native Read tool
returned the same nonce, and its final assistant response again claimed no content.
The direct official Agent SDK control separately captured a correct Read result
while the model repeated tool calls and failed to consume it. This does not
establish an app-only/acpx defect; the inherited provider/model compatibility is
a historical failed acceptance boundary. User was asked for an existing known-good
model/config name, without requesting secrets or changing global settings.

The user supplied **glm-5.3-flash**. Explicit session selection then produced a
real Read and the correct file token. The latest adapter mapping labels `sonnet`
as GLM Flash (earlier mappings differed). Real GLM tests passed deny, allow-once,
physical write, cancel, late stale response rejection, subsequent conversation,
mode acknowledgements and same-session continuation after full app restart.
The persisted public record retains `session_options.model`; no duplicate model
preference layer or global configuration rewrite was needed.

One intermediate post-resume trial returned the old token without calling a tool.
That is retained as a failed behavioral trial, not relabeled a transport success
or a proven model-persistence defect. A subsequent prompt explicitly identifying
the changed file invoked Read and returned a new random token, including after
another complete app restart. The final functional pass depends on actual tools
and filesystem evidence, not a repeated token already present in conversation.

## Quality gates

- Patched public runtime: **23/23**, owned process exits verified.
  `Temp/trellis-acpx-runtime-Z5k8r4/results.json`.
- Preparation: **7/7**, including skipped-script rejection, exact SDK drift,
  idempotent preparation and actual clean production npm postinstall.
  `Temp/trellis-acpx-preparation-83Z77W/results.json`.
- Focused unknown diagnostics and credential-clean captured stdio passed:
  `Temp/trellis-acpx-runtime-MKi5Qs/results.json`.
- Full application batch passes typecheck/build, service/scope/foundation/UI,
  ordinary Chat, IPC registry, navigation, UIUX and render contract. Final counts
  and post-native corrections are recorded in `research/implementation-check.md`.
- Final product evidence summary: **14/14** assertions in `research/final-functional-results.json`, with package hashes/versions and both cleanup summaries copied alongside it. Final app exit also cleared all9 observed Claude/app processes.
- No configured lint script; no lint pass is claimed.
- Initial QA packaging helper failures (missing entry / outside app root) were
  test configuration failures, corrected without production code changes. Native
  GUI acceptance uses the successful packaged artifact, not those failed builds.

## Remaining work

Core vendor criteria now pass on the final restricted-PATH package; package hashes
match the released source build. Finish the native system-IME/profile/draft-switch
walkthrough and final visual recheck of long labels/last layout changes when desktop
automation or manual review is available. Desktop automation was stopped twice by
the user's physical Escape; subsequent tests used only the purpose-built product
API controller in the isolated hidden QA app, without keyboard/mouse automation.
Keep the task in_progress while these native requirements remain unresolved;
preserve unrelated dirty files. User supplied the required single commit-plan
confirmation (“继续”) on2026-10-17. Feature commit: `f265a1db29db9fd4ed72ce5605c01a480f18a2a5`;
the second approved work commit records these artifacts. Acceptance runs did not
transition task/Jira states or write user project code. No remote publication or
task archive is included.
