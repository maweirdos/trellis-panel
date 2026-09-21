# 前端 store 约定（zustand 切片）

> 决策依据：TPD-006。改动状态管理代码前必读。

## 结构

```
src/renderer/src/store/
  ├── types.ts          # AppState = 六个 Slice 的交集；AppSlice<T> 切片构造器类型
  ├── index.ts          # 组合根：create<AppState>()((set,get,store)=>({...6 slices}))
  │                     #   并统一导出 useApp / Page / ViewerTab / reconcileInbox 等
  ├── inbox-storage.ts  # inbox 本地持久化 + 对账（reconcileInbox）
  └── slices/           # session / ui / toast / viewer / todos / inbox 一域一文件
```

## 规则

1. **一域一切片**：新状态先问属于哪个既有域；都不属于才开新 slice 文件 + 在 types.ts
   声明接口 + 在 index.ts 组装。禁止把新状态堆进 `session.ts`（会退化回单体）。
2. **页面 import 不变**：页面一律 `import { useApp, type Page } from '../store'`；
   slice 内部文件不对外。跨域动作（如 setPage 顺带清 openTaskDir）直接在 slice 里
   `set({ 其他域字段 })` —— 组合后是同一 store，这是切片模式的预期用法。
3. **切片签名**：`export const xxxSlice: AppSlice<XxxSlice> = (set, get) => ({...})`；
   组合处在 index.ts 用具名参数 `(set, get, store)` 传参——**不要用 rest 参数**
   （会丢上下文类型，全站选择器退化 any）。
4. **⚠ 命名陷阱**：实现目录是 `store/`。历史上曾有同名 `store.ts` 与目录并存，
   `export from './store'` 解析到文件自身形成循环、类型静默变 any。**永远不要在
   `store/` 目录旁重建同名 .ts 文件**；同类问题对任何"目录 + index.ts"导出都成立。
5. **持久化**：localStorage 键统一 `tpanel.` 前缀；容量敏感数据写入前截断（参照
   inbox 的 newest-200 策略），读取 try/catch 给空默认。
