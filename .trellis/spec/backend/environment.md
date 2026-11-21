# Environment Configuration

> Guidelines for separating development and production environments.

---

## Dev/Prod Data Isolation

### The Problem

By default, Electron's `userData` is the same for dev and prod:

- Dev and prod share the same data
- Testing can corrupt data
- Can't run both simultaneously

### The Solution

```typescript
// src/main/env-setup.ts
import { app } from 'electron';

if (!app.isPackaged) {
  const devUserData = app.getPath('userData') + '-dev';
  app.setPath('userData', devUserData);
}

export {};
```

**Import order matters:**

```typescript
// src/main/index.ts
import { app } from 'electron';
import './env-setup'; // MUST be first after electron import

// Now safe to import modules that use electron-store
import Store from 'electron-store';
```

---

## Why a Separate Module?

ESM hoists imports, so this won't work:

```typescript
// WRONG
import { app } from "electron";
if (!app.isPackaged) {
  app.setPath("userData", ...); // Runs AFTER all imports
}
import Store from "electron-store"; // Already initialized!
```

With a separate module:

```typescript
// CORRECT
import { app } from 'electron';
import './env-setup'; // Side effect runs during import
import Store from 'electron-store'; // Now uses correct path
```

---

## Detection Methods

| Method                 | Use Case                                       |
| ---------------------- | ---------------------------------------------- |
| `app.isPackaged`       | Recommended - true when running from .app/.exe |
| `process.env.NODE_ENV` | Alternative - depends on build config          |

---

## What Gets Isolated

| Data Type      | Dev Path         | Prod Path    |
| -------------- | ---------------- | ------------ |
| electron-store | `App-dev/*.json` | `App/*.json` |
| Cookies        | `App-dev/`       | `App/`       |
| Logs           | `App-dev/logs/`  | `App/logs/`  |

---

## Database Path Exception

Keep database in project for easy inspection during dev:

```typescript
const getDbPath = () => {
  if (process.env.NODE_ENV === 'development') {
    return './app-dev.db'; // Project directory
  }
  return path.join(app.getPath('userData'), 'app.db');
};
```

---

## Summary

| Rule                        | Reason                     |
| --------------------------- | -------------------------- |
| Isolate dev/prod userData   | Prevent data corruption    |
| Use `app.isPackaged`        | Most reliable detection    |
| Set path in separate module | ESM hoisting               |
| Import env-setup first      | Before any userData access |


---

## Worker 产物打包（asarUnpack + 路径重写）

> 来源：cockpit-s0 G1-B 打包验证（2026-10-12）。**worker_threads 无法从 asar 归档内加载文件**——邻位 worker 产物（out/main/*-worker.js）默认会被收进 app.asar，打包版 new Worker() 必挂。

**约定**：
1. `electron-builder.yml` 声明 `asarUnpack: ["out/main/*-worker.js"]`；
2. 加载侧统一走 `src/main/services/worker-path.ts` 的 `neighborWorkerFile(file, envKey)`——把邻位路径中的 `app.asar` 段重写为 `app.asar.unpacked`（开发环境原样返回；env 覆盖优先）；
3. 新增 worker 时：electron.vite.config 的 esbuild closeBundle 打包 + electron-builder asarUnpack + neighborWorkerFile 三处齐全，并用随包二进制（ELECTRON_RUN_AS_NODE）探针验证（临时探针脚本与输出放在 OS TEMP）。

**Wrong**: `new Worker(join(__dirname, 'x-worker.js'))` 直接使用（asar 内路径）。
**Correct**: `new Worker(neighborWorkerFile('x-worker.js', 'X_WORKER_FILE_ENV'))`。

## Isolated build verification

`electron.vite.config.ts` writes native role/worker bundles to
`resolve(__dirname, 'out/main', filename)` and the Pi engine to
`resolve(__dirname, 'out/pi-engine/engine.mjs')`. These custom outputs do not
follow the electron-vite `--outDir` override. Running the repository's config
with a TEMP output argument can still replace the daily application's bundles.

- Run verification builds from a physical OS TEMP source copy containing its
  own copied `electron.vite.config.ts`. Resolve the build configuration from that
  copy; do not import, link or pass the original repository configuration.
  Dependency reuse must not redirect configuration or output paths into the
  original workspace.
- Before building, resolve every custom output root and require it to remain
  under the TEMP copy. Keep the daily profile, processes and build outputs
  outside the verification write set.
- Record relative paths and SHA-256 values for the daily output baseline and the
  isolated build separately. After a verification build, require the daily
  baseline to remain unchanged.
- If an output escaped isolation, stop further builds and preserve the changed
  bytes. Restore only from verified original snapshots or a coherent historical
  build with matching original entry/role evidence. A previous test build is not
  the daily baseline. Distinguish exact original-hash restoration from recovery
  of corresponding dependencies without an original per-file hash.
- Verify restored entrypoints and their role/worker/renderer dependencies;
  restoring an entrypoint alone does not establish a usable build. Do not
  mirror-delete extra files or restart daily processes to test restoration.

Wrong: build from the original checkout with only `--outDir <TEMP>`.
Correct: build using the copied configuration inside the physical TEMP source
tree, then verify that the original output manifest did not change.

An independent Windows acceptance app must use the current user's normal
Windows environment, not inherit another coding host's private launch markers,
session identifiers or tool pipes. Obtain that environment from Windows for the
same user; retain the app's explicit profile, selected engine and provider
configuration. Never change global environment settings or weaken the engine's
sandbox/approval policy to repair a launcher mismatch. A small read-only native
command through the selected engine must succeed before a paid implementation
run; a version probe outside the engine's command executor is insufficient.
