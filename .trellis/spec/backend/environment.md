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
