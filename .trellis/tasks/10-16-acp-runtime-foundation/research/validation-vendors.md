# Real-vendor validation during runtime selection

Date: 2026-10-16. Original isolated research harnesses using published dependencies. This is not product/native-UI acceptance. No application source, project dependency manifest, global package installation, authentication credential or user configuration was changed.

## Exact installed research dependencies

Pinned external scratch installation: `acpx@0.19.5`, `@agentclientprotocol/codex-acp@2.2.2`, `@agentclientprotocol/claude-agent-acp@0.91.0`, Node v24.12.0. All installs used an isolated `--prefix`, exact requested package versions and `--ignore-scripts`; the generated lockfile preserves resolved transitives. The current project package.json/lockfile were not changed. Runtime registration uses absolute Node + exact installed adapter entrypoint arrays; no npx acquisition occurs during discovery/start.

Scripts are under `research/validation/vendors/`. All real sessions use newly created sample directories under this chat's external `acpx-validation/vendor-results/`, containing only a generated README and random evidence token. They never target the dirty application checkout. Reports exclude credentials and full environment values. Runtime process hooks record only owned launch/exit IDs/PIDs/times.

Identity note: the harness's initial `hasAgentSessionId: false` log concerns the optional **native vendor** ID, not the required ACP wire identity. Public acpx handles use `backendSessionId` for the returned ACP session ID. The strict fixture validates that mapping; a missing optional native ID must not be misreported as a failed session creation.

## Codex result

Run `vendor-results/codex/2026-10-16T09-56-03.551Z/result.json`:

- First greeting prompt completed and returned its exact expected marker.
- Second prompt correctly recalled that marker from the preceding turn.
- Third prompt read the sample README using tools and returned its unique evidence token; seven tool events were observed.
- Runtime shutdown resolved and the adapter launch PID had a corresponding exit event.

This establishes a real adapter/session/multi-turn/tool-read path for this configuration. It does **not** establish GUI approvals, native resume, packaged app integration, grandchild cleanup or the strict negative protocol gates; the latter failed independently in `validation-protocol.md`.

## Claude: configuration isolation is distinct from authentication absence

The initial acpx route launched and accepted a prompt, then returned `AUTH_REQUIRED`. Choosing the already working local Claude executable and explicitly selecting the configured model alias did not change this result. These were diagnostic runs, not successful acceptance rows.

Controls:

- Both the existing global Claude 2.1.296 and the adapter-wrapped Claude 2.1.300 reported logged-in state through the public `auth status` command. Only logged-in/method/provider metadata was retained; no identity/token payload was printed.
- The existing CLI completed a constrained print probe using its normal configuration.
- Direct official Claude Agent SDK calls with the existing CLI and `settingSources: ['user','project','local']` completed the greeting, including the control with an explicit inherited process environment.
- A direct official ACP client to the same official Claude adapter, without acpx, also created a session and completed the greeting. No ACP auth methods were required in this successful initialized configuration.

The isolated cause of the initial greeting failure is acpx's default exclusion of **user-level Claude settings**. The installed package's own skill documents `ACPX_CLAUDE_INCLUDE_USER_SETTINGS=1`. The runtime reads this host-process setting while constructing session metadata. Enabling it in the research host restored successful greeting and coherent follow-up through acpx. The user's existing custom service configuration resides in user settings; no secret values were extracted/copied to implement this control.

This flag is a deliberate configuration behavior, not proof of an acpx protocol bug or expired user credentials. A product integration must explicitly choose and explain inherited settings scope; a CLI probe alone cannot establish it. Host-process configuration and child-only `agentProcessEnv` have different effects here.

## Claude: tool-read acceptance is still open

- With user settings enabled and default acpx client fs/terminal capabilities, two conversation turns passed, but the file-read turn returned no evidence token and no tool events. The model reported that the expected file tools were unavailable. This is a failed tool-read acceptance, not success because the turn ended normally.
- With user settings enabled and client filesystem/terminal callbacks disabled to exercise native tool behavior, two conversation turns again passed. The file turn emitted eight tool events but did not return the evidence token; it reported no visible tool result. This is also failed acceptance. Tool events alone do not prove the file was read or result returned.
- A direct SDK sample-read control with only the Read tool did not return the evidence token: one bounded run hit its maximum turns; a diagnostic rerun ended without a Read call. This means the observed sample-read failure is not established as exclusively an acpx defect. The currently configured third-party model/provider, tool catalog, SDK and adapter behavior require further controlled evidence; no root cause is claimed.

Every acpx Claude attempt recorded successful runtime shutdown with matching adapter exit. Relevant isolated run paths:

- `claude/2026-10-16T09-56-03.556Z/`: original default settings, AUTH_REQUIRED.
- `claude/2026-10-16T10-02-17.923Z/`: existing CLI override, AUTH_REQUIRED.
- `claude/2026-10-16T10-04-57.512Z/`: existing CLI + model alias, AUTH_REQUIRED.
- `claude/2026-10-16T10-06-29.576Z/`: native client-tool capability control without user-setting inheritance, AUTH_REQUIRED.
- `claude/2026-10-16T10-08-03.657Z/`: user settings inherited, two turns passed; sample-read failed with no tool events.
- `claude/2026-10-16T10-09-07.936Z/`: inheritance + native-tool control, two turns passed; sample-read failed despite tool events.

External report root: `C:/Users/Maweirdos/.codex/visualizations/2026/10/16/01a143cf-354c-7ce0-a351-45db825fc514/acpx-validation/`.

## Harness corrections and limits

The CLI probe initially attempted to execute the installed native `.exe` through Node; this harness mistake was corrected to spawn native executables directly before the successful CLI control. A shell report-formatting error also prevented capture of an earlier CLI attempt; that attempt is not used as evidence. Direct SDK probes distinguish ordinary completion from actual expected-token evidence and record permission/tool observations rather than inferring success.

No installed package was patched to pass these tests. No user auth/config file was edited, no credentials were printed or persisted in task artifacts, and no external messages/Jira/Git actions were sent. These are selection experiments; real Codex success, partial Claude success and strict protocol failures must remain separate in the adoption decision.
