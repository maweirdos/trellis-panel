# Implement — 参考 UI 克隆模块

## 执行顺序

1. **基础（主线自行完成）**
   - [ ] 拷贝 my-tokens.css → `my/my.css`，补字体/滚动条/模块样式
   - [ ] `types.ts` 领域类型；`data.ts` 演示数据；`store.ts`；`icons.tsx`；`ui.tsx` 基础件
   - [ ] tailwind.config.js 扩展 `p.*` 色板/阴影/字号；package.json 加 Inter 依赖并安装
   - [ ] layout/：参考App 壳 + WorkspaceSidebar + ProjectSidebar + 内容路由骨架
2. **子代理并行（每代理只写自己的 pages/ 文件，禁改基础契约）**
   - [ ] A：WorkItemsPage（5 布局/工具栏/筛选/显示/创建）+ IssuePeek
   - [ ] B：CyclesPage + ModulesPage + ViewsPage + IntakePage
   - [ ] C：YourWorkPage + AnalyticsPage + ProjectsPage + PagesPage + InboxPage
   - [ ] D：SettingsPage（项目/工作区/外观）+ CommandPalette
3. **集成（主线）**
   - [ ] store/types.ts Page 加 `'my'`；Sidebar 入口；App.tsx lazy 路由
4. **验证**
   - [ ] `npm run typecheck`；`npm run build`
   - [ ] `npm run dev` + Electron 截图：深/浅主题外壳、工作项列表/看板、peek、命令面板
   - [ ] AC1–AC8 逐条核对
5. **收尾**
   - [ ] spec 更新评估（trellis-update-spec，如有沉淀）；commit

## 验证命令

```bash
npm run typecheck
npm run build
npm run dev   # 手动/截图验证
```

## 回滚点

- 步骤 1–2 全部在新目录 `my/`，任意时刻可整目录删除。
- 步骤 3 集成三处单点 revert。
