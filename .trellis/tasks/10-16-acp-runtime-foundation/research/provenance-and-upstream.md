# ACP provenance and current upstream baseline

Investigated 2026-10-16. Planning evidence only; no adapter installation, credential changes, live model request, or product-code edit was performed by the coordinating session.

## What the earlier task actually adopted

The parent `10-09-acp-agent-console/prd.md` names OpenHands' ACP control-center architecture as its reference. `task.json` also explicitly says it borrows that architecture. The parent selected the Zed Codex ACP adapter and a configurable Gemini entry, while `design.md` chose a locally handwritten NDJSON JSON-RPC client. This establishes architectural reference plus adapter interoperability; it does **not** establish that OpenHands' runtime, process supervision, authentication, or session implementation was embedded.

Git attributes the initial implementation to `cffeebd` (`feat(acp): add Trellis-aware agent console`, commit date 2026-10-11). The directory's 10-09 name and historical research date do not establish a separate implementation date. The parent explicitly leaves real-vendor E2E unchecked and reports mock/service coverage instead.

`trellis mem` initially exhausted the Node heap while searching all platforms. A bounded Codex-only query succeeded and recovered session `01a12623-f65d-7c20-983c-d9c9aac03bed`: it discussed OpenHands as a candidate execution layer, not a confirmed embedded dependency. Some inter-agent payloads are encrypted and unavailable. Bounded searches for `codex-acp` returned no historical dialogue; the parent task and Git remain the primary evidence for the original implementation decision. Do not invent a recovered user approval or treat old assistant recommendations as user decisions.

## Current primary-source facts

| Source | Verified fact | Consequence |
| --- | --- | --- |
| [Official ACP TypeScript library](https://agentclientprotocol.com/libraries/typescript) | Official SDK implements both protocol sides; new integrations use the fluent `client()`/`agent()` API. Connection classes remain compatibility wrappers. | Parent claim that no official TypeScript client SDK exists is no longer valid. Evaluate replacement of handwritten framing/routing/validation with the maintained SDK. |
| [Old Zed Codex adapter](https://github.com/zed-industries/codex-acp) | Repository is archived and directs new installs to `@agentclientprotocol/codex-acp`. | The old repository cannot be the maintenance baseline for a new supported preset. Preserve user commands explicitly during migration. |
| [Maintained Codex adapter](https://github.com/agentclientprotocol/codex-acp) | Stdio ACP adapter launches Codex App Server and maps sessions, authentication, configuration, tool events and permission requests. | Reuse upstream vendor integration instead of writing another Codex runtime. Inspect the published release, not just `main`, before pinning behavior. |
| [Claude adapter](https://github.com/agentclientprotocol/claude-agent-acp) | ACP implementation uses the Claude Agent SDK and supports tool/permission events and client MCP configuration. | Claude needs an ACP adapter; finding the ordinary `claude` CLI does not establish ACP availability. |
| [OpenHands repository](https://github.com/OpenHands/OpenHands) | Agent Canvas UI/orchestration and the canonical Python SDK/Agent Server are distinct repositories/layers. | OpenHands provides a useful lifecycle/profile reference. Embedding its complete server is a separate deployment architecture decision. |
| [HiFox Agent documentation](https://help.hifox.com/docs/agent-and-computer/agents) | Agent identity/instructions, machine, Runtime and per-run task are separate; model controls derive from Runtime capability. | Reference profile/detail, diagnostics and truthful runtime controls. Retain the project's current navigation and manual execution behavior. |
| [OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server) | Codex App Server exposes thread/turn lifecycle and approvals for product integrations. | Supports upstream adapter's role; using the adapter avoids implementing a second vendor-specific client alongside ACP. |

## Live package metadata, not search-cache versions

Read-only `npm view` on this date returned:

- `@agentclientprotocol/sdk`: **1.8.0**; stable root export plus separately marked experimental v2/node/server transports.
- `@agentclientprotocol/codex-acp`: **2.2.2**.
- `@agentclientprotocol/claude-agent-acp`: **0.91.0**, Node `>=22`.
- Local Node: **v24.12.0**.

These are research snapshots, not dependencies installed into this project. Before implementation, inspect published artifacts and choose exact compatible versions. Stay on stable ACP v1 unless a separately approved feature requires an extension. Existence of an extension in `main` is not proof the chosen published adapter supports it.

## Protocol facts relevant to verified failures

- [Initialization](https://agentclientprotocol.com/protocol/v1/initialization): exchange protocol version, client capabilities and agent capabilities/authentication methods. Do not discard the response or advertise unimplemented client methods.
- [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup): retain the session ID returned by the agent. Native history loading is a negotiated capability; displaying local transcripts is a different operation.
- [Prompt turns](https://agentclientprotocol.com/protocol/v1/prompt-turn): prompts and cancellation identify the agent's session. Tool lifecycle includes `tool_call_update`, not only `tool_call`.
- [Tool calls/permissions](https://agentclientprotocol.com/protocol/v1/tool-calls): preserve `allow_once`, `allow_always`, `reject_once` and `reject_always`; respond using the supplied option ID. Cancelled turns settle pending requests with a cancelled outcome. Reclassifying a reject option as allow is incorrect.

## Architectural recommendation under planning

Prefer a maintained TypeScript ACP client SDK plus maintained external adapters. Trellis owns profiles, explicit task/material association, local launch supervision, scoped history and UI; upstream Runtime owns the coding loop, model behavior and its native tools. This retains the existing Electron deployment and avoids another complete server stack.

This is a proposal, not an approved dependency change. Even with the SDK, process cleanup, directory ownership, authentication UX, timeout policy, persistence and project isolation remain application responsibilities and need explicit contracts/tests. If actual adapter testing establishes a mandatory client filesystem or terminal callback, implement that callback with verified scope and truthful capability negotiation; do not retain the old blanket omission merely because the mock tolerated it.

## Local environment evidence and limits

`Get-Command` resolved ordinary Codex, Claude and OpenCode npm shims; Gemini, `codex-acp` and `claude-agent-acp` were not resolved in this shell. This shows available PATH entries only. It does not prove authentication, adapter installation elsewhere, GUI-inherited PATH, or model access. User credentials were not read or printed. No automatic install or live prompt was used as an availability probe.

User-supplied HiFox screenshots show an Agent list, profile detail aside, startup milestones, collapsible thought content and a runtime/model composer. They are interaction references, not authority to add cloud machines, IM integration, automatic dispatch or invented token statistics.
