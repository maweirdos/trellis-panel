# Electron + React Frontend Development Guidelines

> Universal frontend development guidelines for Electron applications with React + Vite + TypeScript.

## Tech Stack

- **Framework**: Electron + React 18+
- **Build Tool**: Vite
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS + CSS Modules (optional)
- **State**: React Context + React Query (optional)

---

## Documentation Files

| File                                                                           | Description                                     | Priority      |
| ------------------------------------------------------------------------------ | ----------------------------------------------- | ------------- |
| [ipc-electron.md](./ipc-electron.md)                                           | IPC patterns, context isolation, title bar      | **Must Read** |
| [daemon-bootstrap.md](./daemon-bootstrap.md)                                 | Restricted first-window shell, readiness, recovery, lazy App and authenticated attachment | Desktop startup / daemon changes |
| [Integration contracts](../backend/integrations.md)                           | Shared directory, owner-scoped requests, redacted fields and explicit notification preview | Integration UI |
| [Knowledge contracts](../backend/knowledge-access.md)                         | Project defaults, temporary scope, provenance, material CAS/handoff and explicit publication | Knowledge / Agent / intake UI |
| [store-conventions.md](./store-conventions.md)                                 | Zustand store slicing rules (TPD-006)           | **Must Read** |
| [electron-browser-api-restrictions.md](./electron-browser-api-restrictions.md) | Browser APIs that don't work in Electron        | **Must Read** |
| [react-pitfalls.md](./react-pitfalls.md)                                       | Critical React patterns and common mistakes     | **Must Read** |
| [state-management.md](./state-management.md)                                   | Auth context, layout, navigation patterns       | Reference     |
| [components.md](./components.md)                                               | Semantic HTML, empty states, scrollbar patterns | Reference     |
| [Task conversation contracts](../backend/task-conversations.md)              | Equal entry geometry, native identity, destination labels and retained request ownership | Homepage session continuation |
| [Git viewer contracts](../backend/git-viewer.md)                              | Auxiliary history graph, unified diff, stale-result ownership and source attribution | Git viewer UI |
| [hooks.md](./hooks.md)                                                         | Query and mutation hook patterns                | Reference     |
| [type-safety.md](./type-safety.md)                                             | Types, import paths, module constants           | Reference     |
| [directory-structure.md](./directory-structure.md)                             | Project structure conventions                   | Reference     |
| [css-design.md](./css-design.md)                                               | CSS organization and design tokens              | Reference     |
| [applications.md](./applications.md)                                          | Shared compact application panel, project scope, state and execution UI | Application run-panel changes |
| [developer-tools-workbench.md](./developer-tools-workbench.md)                  | Header Git/run controls, retained source, measured dock geometry and grouped config drafts | Developer-tool shell interactions |
| [quality.md](./quality.md)                                                     | Code quality and performance standards          | Reference     |
| [my-ui-module.md](./my-ui-module.md)                                     | Shell module tokens & conventions               | Module-scoped |
| [conversation-workspace.md](./conversation-workspace.md)                   | ACP history/paging/recovery, turn layout, inspector/appearance and source ownership | Conversation / reader / Settings |
| [workflow-conversation.md](./workflow-conversation.md)                     | Actual node/receipt provenance, frozen revisions, retained commands and sessionless recovery | Managed workflow / revision / source history |
| [team-collaboration.md](./team-collaboration.md)                           | Fixed published reading, offline original intents, authority changes and selected-source publication | Desktop team sharing and native publish entries |
| [retained-source-interactions.md](./retained-source-interactions.md)       | Bounded Settings detours, reader continuity and hidden interaction ownership | Retained source pages |

---

## Quick Navigation by Task

### Before Starting Development

| Task                         | Document                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Understand IPC patterns      | [ipc-electron.md](./ipc-electron.md)                                           |
| Know browser API limitations | [electron-browser-api-restrictions.md](./electron-browser-api-restrictions.md) |
| Avoid common React mistakes  | [react-pitfalls.md](./react-pitfalls.md)                                       |

### During Development

| Task                     | Document                                     |
| ------------------------ | -------------------------------------------- |
| Create custom hooks      | [hooks.md](./hooks.md)                       |
| Manage application state | [state-management.md](./state-management.md) |
| Build UI components      | [components.md](./components.md)             |
| Ensure type safety       | [type-safety.md](./type-safety.md)           |

### Before Committing

| Task                    | Document                         |
| ----------------------- | -------------------------------- |
| Check code quality      | [quality.md](./quality.md)       |
| Verify CSS organization | [css-design.md](./css-design.md) |

---

## Core Rules Summary

| Rule                                                         | Reference                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **Native APIs require IPC**                                  | [ipc-electron.md](./ipc-electron.md)                                           |
| **NEVER use prompt/alert/confirm**                           | [electron-browser-api-restrictions.md](./electron-browser-api-restrictions.md) |
| **Wrap functions with `() =>`** when storing in useState     | [react-pitfalls.md](./react-pitfalls.md)                                       |
| **Use `useMemo`** for objects/Date passed to hooks           | [react-pitfalls.md](./react-pitfalls.md)                                       |
| **Distinguish initial load vs refetch**                      | [react-pitfalls.md](./react-pitfalls.md)                                       |
| **No non-null assertions `!`**                               | [quality.md](./quality.md)                                                     |
| **Use `scrollbar-gutter: stable`** for scrollable containers | [components.md](./components.md)                                               |

---

## Architecture Overview

```
+----------------------------------------------------------+
|                    Main Process                           |
|  +--------------+  +--------------+  +-----------------+  |
|  |   IPC        |  |   Native     |  |   Database      |  |
|  |   Handlers   |  |   APIs       |  |   (SQLite)      |  |
|  +------+-------+  +--------------+  +-----------------+  |
+---------|-------------------------------------------------+
          | ipcMain.handle / ipcRenderer.invoke
          |
+---------|-------------------------------------------------+
|         |              Preload Script                     |
|  +------+-------+                                         |
|  | contextBridge.exposeInMainWorld('api', {...})         |
|  +------+-------+                                         |
+---------|-------------------------------------------------+
          | window.api
          |
+---------|-------------------------------------------------+
|         v              Renderer Process                   |
|  +--------------+  +--------------+  +-----------------+  |
|  |   React      |  |   Context    |  |   Components    |  |
|  |   App        |  |   Providers  |  |   & Hooks       |  |
|  +--------------+  +--------------+  +-----------------+  |
+----------------------------------------------------------+
```

---

## Getting Started

1. **Read the Must-Read documents** - Especially IPC patterns and browser API restrictions
2. **Set up your project structure** - Follow [directory-structure.md](./directory-structure.md)
3. **Configure TypeScript paths** - See [type-safety.md](./type-safety.md)
4. **Implement IPC layer** - Use patterns from [ipc-electron.md](./ipc-electron.md)
5. **Build components** - Follow [components.md](./components.md) and [react-pitfalls.md](./react-pitfalls.md)

---

**Language**: All documentation is written in **English**.
