# Feishu workspace integration

## Scope

Organization application credentials, a personal Feishu account, space task assistants, general Agent messaging, and existing outgoing group Webhooks have distinct identities. Only the first four use the Feishu workspace API. The group Webhook adapter retains explicit preview/send and existing connection IDs.

## Signatures

- `src/shared/feishu-integration.ts`: version 1 `FeishuApi`; narrow `feishu:*` channels and authenticated `feishu.workspace.*` daemon methods. All requests carry a nullable `expectedRoot`. A bot target also needs the current paired Crux `scopeKey`, `spaceId`, and, for a general Agent, `agentId`.
- `src/main/daemon/feishu.ts`: `beginRegistration`, `registrationStatus`, and `cancelRegistration` share one bounded in-memory attempt, tied to its original target and workspace. `configure`, `chats`, `retry`, and `disconnect` use the original connection ID and revision. `reconcile` reads the original team command; it does not resend.
- `feishu-workspace-v1.protected.json` stores the app credential, bot identity, original grant, account identity, unresolved registration IDs, and bounded event receipts in a native encrypted envelope. No message body, member binding code, OAuth access token, or QR link is persisted there.
- `src/shared/feishu-member.ts` defines the team-service contract. A browser session issues a five-minute code for its own space membership. The protected paired device exchanges a code received in the bot's private chat for a binding of project, space, device, app, tenant, sender, and Crux member. The browser can list and revoke its own bindings.

## Contracts

- The main frame supplies configuration through the authenticated native GUI. The leased daemon owns provider state and networking. Registration uses the official SDK's app device flow; personal identity uses the organization app's device authorization. Require app support and validate the official authorization origin. A saved credential or completed scan does not indicate a working long connection.
- The preload and renderer configure Zod with `jitless` before loading schemas. Both run with CSP string code generation disabled. Exercise the real Electron bridge when changing validation.
- The profile snapshot reads organization and account state without a team lookup. A team snapshot, a saved bot or a registration attempt requires the original paired team. When a code directory was selected for binding, its grant also applies. Without a directory, use the original paired device, team and space. Revalidate the target after Feishu returns credentials.
- A task assistant selects an enabled Pi SDK Runtime. Model setup can follow QR authorization. A general Agent binds by space and Agent ID alone. Resolve the authorized Agent's current `runtimeKind` on each message. Ignore saved or incoming bot-model overrides for general Agents.
- Send `Accept-Encoding: identity` for Feishu JSON requests. In the desktop daemon the registration endpoint returned bytes that the bounded transport could not parse as JSON with default content negotiation. Validate QR rendering from the real window, where the official SDK, the daemon HTTP transport and the preload run together.
- A task assistant accepts a direct @ in an explicitly allowed group only from a bound Crux space member. The registration scan grants no task authority. A general Agent also accepts private text messages from a bound member. Both accept `绑定 <code>` in private chat. Never send binding code messages to a model or use another application's `open_id`, a display name, or an email as identity evidence.
- Keep the binding ID pinned from admission through snapshot, command, and receipt. Team-service resolves the actor from that binding, checks the original native device and both current space memberships, and commits only the allowed command in that space. Revoking or replacing the binding invalidates a pending command. A transferred group membership is not a Crux grant.
- Verify current actor/space access before reading history or invoking the model. Use the message's own thread or current group; bound context to 30 messages and 16,000 characters, with a 30-minute window for ordinary groups. Text is input data. The model cannot issue a write through tools.
- Task create/update/transition goes through existing team-service commands with the original authorization and revision. A task persists an optional `feishuSource` containing `chatId`, `messageId` and optional `threadId`. Replies to group queries expose only the approved task reference and minimal status metadata. Access to the linked task is checked by Crux.
- Key intake by tenant, app, and message ID; persist before acknowledging admission. Derive stable, distinct business and reply IDs. Retain command identity and provider reply outcome after restart; reconcile uncertainty via the original receipt. Never infer task creation from reply success, or delivery from a completed business command.
- The general Agent's text channel has no task-write, filesystem, shell or MCP capability. Claude Code uses its managed runtime in text-only mode. Codex reads the managed CLI's effective configuration and calls the selected Responses provider with tools disabled. This path needs a compatible API authentication configuration. A `custom` reference has no executable identity in the Agent schema. Report an unavailable route to the sender without switching providers.
- Persist a registration marker before exposing a QR code. Reuse a live attempt for the same target and grant; closing its dialog does not cancel it. An inactive `pending` or legacy QR-only marker has no recorded credential result and can be cleared after validating the selected team and matching any stored workspace identity. A legacy marker without an owner is cleared only for the selected target. Clearing a waiting marker does not prove that Feishu created no application. A `committing` or `unknown` marker retains the original attempt for explicit review. A newly admitted grant for the same workspace ID and root may recover that review after validating the original team and target; abort the old attempt and revalidate the team, target and current grant immediately before an explicit reset. A result marker without a stored workspace identity cannot transfer recovery authority. Do not expose the old QR or credentials to a replacement grant, another team or another workspace. A definitive provider rejection or protected credential save clears the marker. If Feishu has returned credentials and bot verification still requires publishing or approval, keep the credentials and retry verification for that application.

## Validation and errors

| Condition | Result |
| --- | --- |
| Old bridge, missing pairing, disabled model or revoked grant | Show the unavailable state; do not bind an unrelated owner or read message history |
| QR expired, declined, cancelled or provider result uncertain | Preserve the observed terminal state; a local cancellation does not assert that Feishu removed the application |
| Unapproved group, sender, or missing @ for a group request | Do not read history, call the model or mutate a task |
| No unique task or an ambiguous write intent | Reply for clarification; no task mutation |
| Lost team reply or uncertain Feishu send | Preserve original identities, no replay; only a proved business receipt settles the business result |

## Good, base, and bad cases

- Good: a bound member @s the assistant after a multi-message discussion. One task is created as that member in the configured space and carries the original message reference.
- Base: a valid application has no approved group. It accepts private pairing and waits for a group to be configured.
- Bad: a group join, display-name match, or team device token by itself is treated as the sender's identity.

## Verification

Cover the credential envelope, auth attempt lifecycle, allowlist and sender checks, bounded history, duplicate delivery across restart, exact-source creation, authorization/revision conflicts, and reply failure recovery. Verify GUI partner versions and light/dark density support separately. A controlled response or localhost test is not live tenant registration, event-scope approval, or actual Feishu delivery.

## Wrong vs correct

Wrong: run the generic model output or Feishu message as an instruction with access to the current desktop workspace.

Correct: capture the explicitly configured space, authorize the original sender, validate a finite task operation, and submit it through the existing Crux authority.
