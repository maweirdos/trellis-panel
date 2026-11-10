# Backend Development Guidelines Index

Runtime provider/model changes must also follow [Provider source fidelity](./acp-provider-sources.md).
Native Pi SDK changes also follow [Native Pi execution](./pi-runtime.md).
ZCode setup and startup changes also follow [Managed ZCode startup](./zcode-managed-startup.md).

> **Tech Stack**: Electron Main Process + Drizzle ORM + SQLite (better-sqlite3)

## Related Guidelines

| Guideline                 | Location     | When to Read                 |
| ------------------------- | ------------ | ---------------------------- |
| **Shared Code Standards** | `../shared/` | Always - applies to all code |

---

## Documentation Files

| File                                               | Description                                       | When to Read                       |
| -------------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| [directory-structure.md](./directory-structure.md) | Project structure and domain organization         | Starting a new feature             |
| [api-module.md](./api-module.md)                   | API module pattern (types, procedures, lib)       | Creating/modifying service modules |
| [api-patterns.md](./api-patterns.md)               | Common patterns for API calls and data operations | Implementing CRUD, pagination      |
| [error-handling.md](./error-handling.md)           | Error handling strategies in procedures           | Handling errors in transactions    |
| [database.md](./database.md)                       | Drizzle ORM, schema, migrations                   | Database operations                |
| [environment.md](./environment.md)                 | Dev/prod isolation, userData separation           | Setting up environment, debugging  |
| [window-appearance.md](./window-appearance.md)     | Ordinary native frame/theme decoration, resize preservation | Changing main-window chrome or theme updates |
| [window-navigation.md](./window-navigation.md) | Trusted app documents, external links, redirects and popup routing | Adding windows or link navigation |
| [task-conversations.md](./task-conversations.md) | Native session metadata, durable task links, bounded editor navigation and equal-width homepage entries | Task conversation continuation |
| [private-conversations.md](./private-conversations.md) | Creator-private Work/Code drafts, native directory grants, exact runtime owners and explicit file delivery | Personal assistant entry and conversation context |
| [local-document-links.md](./local-document-links.md) | Narrow Markdown document opener, main-owned roots, safe paths and visible errors | Local HTML/PDF/Markdown/text links |
| [knowledge-document-reading.md](./knowledge-document-reading.md) | Saved-revision Modal, project-relative images and version-aware local opening | Product-document preview and assets |
| [document-watch.md](./document-watch.md)           | Opaque watch leases, project generations and exact release | Modern reader watch/IPC cleanup |
| [type-safety.md](./type-safety.md)                 | Zod schemas, discriminated unions, type patterns  | Type-related decisions             |
| [logging.md](./logging.md)                         | Logging and native module packaging               | Debugging, packaging               |
| [pagination.md](./pagination.md)                   | Cursor vs offset pagination guidelines            | Implementing list APIs             |
| [git-viewer.md](./git-viewer.md) | Bounded read-only history, commit files/diffs, request ownership and extracted algorithm provenance | Developer-tools Git viewer changes |
| [quality.md](./quality.md)                         | Import paths, Vite config, code quality           | Before committing                  |
| [macos-permissions.md](./macos-permissions.md)     | macOS system permissions (mic, accessibility)     | Features requiring permissions     |
| [text-input.md](./text-input.md)                   | Text insertion without clipboard pollution        | Voice-to-text, paste features      |
| [ipc-conventions.md](./ipc-conventions.md)         | IPC channel registry, error codes, event streams (TPD-001/002/003) | Adding or modifying any IPC channel |
| [app-runtime.md](./app-runtime.md) | Owned local application lifecycle, environment, exact launch approval, CLI and quit contracts | Application run-panel or Agent startup changes |
| [git-workspace.md](./git-workspace.md) | Main-only manual Git writes, reviewed index/HEAD fences, native confirmation and bounded recovery | Git stage/commit/branch/push changes |
| [integrations.md](./integrations.md) | Provider ports, protected connections, project bindings, source identity, SDK transport and manual notifications (TPD-025) | External app integration changes |
| [knowledge-access.md](./knowledge-access.md) | Project knowledge scope, evidence, native conversational document/publication/handoff actions, CAS and receipts | Knowledge / Agent / WeKnora changes |
| [acp-runtime.md](./acp-runtime.md)                 | Pinned runtime, exact approvals, full history archive/paging, explicit model recovery, cleanup and acceptance | ACP Agent, history, dependency or packaging changes |
| [runtime-handoff.md](./runtime-handoff.md) | Linked cross-Runtime continuation, checkpoint/context fences, delivery receipts and cancellation | Ordinary conversation Runtime continuation |
| [workflow-control.md](./workflow-control.md) | Durable commands, leases, outbox, process recovery and committed event cursors | Workflow control/admission/reconciliation |
| [workflow-runtime.md](./workflow-runtime.md) | Immutable input/output versions, native adapter, exact prompt receipts and stop finalization | Managed stages and ACP material composition |
| [workflow-reading.md](./workflow-reading.md) | Fixed source/version registry, independent native views, exact origin and comparison | Workflow output/native document reading |
| [workflow-application.md](./workflow-application.md) | Main-owned admission, source/execution fences, native session lineage and retained recovery protection | Workflow application/desktop API and quit |
| [team-platform.md](./team-platform.md) | Separate team authority, explicit publication, protected device pairing, scoped cursors and offline command reconciliation | Team service, supplemental Web and desktop synchronization |
| [team-task-execution.md](./team-task-execution.md) | Central task authority, fixed local execution bindings, bounded progress, Trellis projections and versioned rule context | Team task progress and native execution |
| [team-task-executions-v2.md](./team-task-executions-v2.md) | Platform task identity, single writer, historical receipts, transition revocation and typed desktop intents | V2 service execution commands and bridge |
| [team-trellis-import.md](./team-trellis-import.md) | Read-only source discovery, explicit mappings, immutable candidates and per-item import recovery | Trellis migration discovery and team import commands |
| [workflow-cutover.md](./workflow-cutover.md) | Whole-workcopy activation, native connector installation, original-command recovery and guarded rollback | Imported-workflow cutover and writer admission |
| [team-execution-inputs.md](./team-execution-inputs.md) | Portable definitions, immutable Agent/Skill and stage inputs, authorized resources and Pi/ACP packet composition | Fixed team execution context and definition sources |
| [team-execution-artifacts.md](./team-execution-artifacts.md) | Fixed artifacts, delivery manifests, carried references, checkpoint and actual code availability gates | Shared execution outputs and handoff transactions |
| [native-task-preparation.md](./native-task-preparation.md) | Trellis-independent engineering binding, fixed material mapping, authenticated native admission and retained owner discovery | Platform task preparation and directory/resource checks |
| [product-task-execution.md](./product-task-execution.md) | Current-node Pi/Codex/Claude product dispatch, actual native receipts, selected output submission and original cleanup | Product-start, report, permission, stop and reconciliation |
| [editor-task-mcp.md](./editor-task-mcp.md) | Loopback MCP tools for editor task claim, fixed context, progress and delivery | Codex/Claude editor task access |
| [jira-business-hooks.md](./jira-business-hooks.md) | Protected desktop identity for Jira-to-platform task effects and status events | Jira intake/status business Hook changes |
| [database-delivery.md](./database-delivery.md) | Imported database gate conversion, fixed SQL evidence and shared development delivery validation | Database delivery Hook changes |
| [access-protocol-security.md](./access-protocol-security.md) | TPAP 本地控制面安全约束（TPD-007/008） | Touching services/access or exposing new endpoints |

---

## Quick Navigation

For independent daemon ownership, protected settings migration and provider workspace composition, read [Integration daemon contracts](./integration-daemon.md).
For development restart, bounded native shutdown and Windows installer handoff, read [Desktop lifecycle](./daemon-lifecycle.md).

### Service Module Structure

| Task                          | File                                               |
| ----------------------------- | -------------------------------------------------- |
| Project structure             | [directory-structure.md](./directory-structure.md) |
| Domain module pattern         | [api-module.md](./api-module.md)                   |
| Write types.ts                | [api-module.md](./api-module.md)                   |
| Write procedure               | [api-module.md](./api-module.md)                   |
| Write lib/ helpers            | [api-module.md](./api-module.md)                   |
| Common patterns               | [api-patterns.md](./api-patterns.md)               |
| Anti-patterns                 | [api-patterns.md](./api-patterns.md)               |
| Pagination (cursor vs offset) | [pagination.md](./pagination.md)                   |

### Type Safety

| Task                 | File                               |
| -------------------- | ---------------------------------- |
| Type safety patterns | [type-safety.md](./type-safety.md) |
| Discriminated unions | [type-safety.md](./type-safety.md) |
| Zod-first types      | [type-safety.md](./type-safety.md) |
| Zod error handling   | [type-safety.md](./type-safety.md) |

### Database (Drizzle + SQLite)

| Task                 | File                         |
| -------------------- | ---------------------------- |
| Setup Drizzle client | [database.md](./database.md) |
| Define schema        | [database.md](./database.md) |
| Timestamp precision  | [database.md](./database.md) |
| Batch queries        | [database.md](./database.md) |
| Database migrations  | [database.md](./database.md) |

### Error Handling

| Task                    | File                                     |
| ----------------------- | ---------------------------------------- |
| Error categories        | [error-handling.md](./error-handling.md) |
| Transaction errors      | [error-handling.md](./error-handling.md) |
| Input validation errors | [error-handling.md](./error-handling.md) |

### Configuration & Logging

| Task                     | File                               |
| ------------------------ | ---------------------------------- |
| Environment isolation    | [environment.md](./environment.md) |
| Logging                  | [logging.md](./logging.md)         |
| Scoped logger            | [logging.md](./logging.md)         |
| Packaging native modules | [logging.md](./logging.md)         |

### Import Paths & Quality

| Task                       | File                       |
| -------------------------- | -------------------------- |
| Main process imports       | [quality.md](./quality.md) |
| Renderer imports (@shared) | [quality.md](./quality.md) |
| Code quality               | [quality.md](./quality.md) |

---

## Core Rules Summary

| Rule                                                           | Reference                                      |
| -------------------------------------------------------------- | ---------------------------------------------- |
| **Isolate dev/prod userData directories**                      | [environment.md](./environment.md)             |
| **Import env-setup first** (before electron-store)             | [environment.md](./environment.md)             |
| **Main process: use relative paths** for `src/shared/` imports | [quality.md](./quality.md)                     |
| **Renderer: use `@shared` alias** for shared types             | [quality.md](./quality.md)                     |
| **Service modules follow domain layout**                       | [api-module.md](./api-module.md)               |
| **IPC handlers are thin wrappers** calling procedures          | [api-module.md](./api-module.md)               |
| **Transaction helpers must throw**, not silent return          | [error-handling.md](./error-handling.md)       |
| **Data integrity errors must throw** in transactions           | [error-handling.md](./error-handling.md)       |
| **All types from Zod schemas**                                 | [type-safety.md](./type-safety.md)             |
| **No non-null assertions `!`**                                 | [type-safety.md](./type-safety.md)             |
| **Use cursor pagination** for user-facing lists                | [pagination.md](./pagination.md)               |
| **Use `timestamp_ms` mode** for millisecond precision          | [database.md](./database.md)                   |
| **Use `logger.scope()`** for module loggers                    | [logging.md](./logging.md)                     |
| **Check permissions before use** on macOS                      | [macos-permissions.md](./macos-permissions.md) |
| **Use direct text insertion** instead of clipboard             | [text-input.md](./text-input.md)               |

---

## Reference Files

| Feature            | Typical Location                   |
| ------------------ | ---------------------------------- |
| Drizzle Client     | `src/main/db/client.ts`            |
| Schema Definition  | `src/main/db/schema.ts`            |
| IPC Channels       | `src/shared/constants/channels.ts` |
| Shared Types (Zod) | `src/shared/types/`                |
| Service Module     | `src/main/services/{domain}/`      |

---

**Language**: All documentation must be written in **English**.
