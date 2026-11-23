# Runtime compatibility patches

`acpx@0.19.5` is retained only as the legacy-history reader. The live ACP path uses the project-owned v2 wire/runtime under `src/main/services/acp/v2`; it never imports `acpx/runtime` or `acpx/agent-registry`.

The checked-in compatibility patch must continue to match `patches/acpx-compat.json` and the pinned SDK override. Production install, dev, build, and dist commands verify the patch and pinned dependency state. Temporary protocol peers and validation artifacts belong in the OS TEMP directory, not in Git.

ACP v2 uses the generated schemas and protocol version from `@agentclientprotocol/sdk@1.9.0/experimental/v2`. `patches/acp-v2-sdk.json` records that experimental entry and protocol version. This manifest is a dependency guard, not a claim that a provider supports v2; every provider must pass strict initialize negotiation before becoming available.
