# Implement — 全量迁移执行计划

> 前置:design.md 的映射表是唯一对照标准;子代理只改分派清单内文件。

## 执行顺序

### 步骤 1 — 主线:地基(已完成)

- [x] 1.1 删除孤儿组件 6 个:FocusTimer、TaskInsightsModal、HandoffModal、
      DispatchModal、PlannerModal、旧 CommandPalette(components/);
      DiffModal/Select/MermaidBlock/AsciiDiagramBlock 经查实在用,保留并迁移
- [x] 1.2 styles.css:`.md` 排版块令牌化、`.arch-*` 深色选择器改
      `[data-my-theme='dark']`、删除死 CSS `.ascii-diagram`
- [x] 1.3 共享组件迁移:MarkdownView、MermaidBlock、AsciiDiagramBlock、Dialogs、
      badges、Select;my.css 新增 `.my-chip` 徽标基类;my/ui.tsx Button 增 autoFocus
- [x] 1.4 App.tsx:CapsuleView/QuickTodoView 分支根节点补 `my-root` + `data-my-theme`
- [x] 1.5 `npm run typecheck` 通过

### 步骤 2 — 子代理并行(文件互斥,见 design.md §4 修订版)

- [ ] A:TaskDetail + DiffModal(最重:60 处旧色 + `.chip`/`.card`/`.btn*`/`.field` + badges/DiffModal 消费)
- [ ] B:Chat + Channels + AcpConsole(mist/ink 重户 + MarkdownView/Dialogs 消费)
- [ ] C:Jira + PlanningModal + Team + Archive + Inbox(彩色 chip + badges/Select 消费)
- [ ] D:Knowledge + Spec + Studio + FlowStudio(FlowStudio 99 处旧色,最重组件)
- [ ] E:Models + Gateway + Architecture + Settings(硬编码彩色图标 + .arch 消费)
- [ ] F1:Toasts + Onboarding + IntakeModal + ArtifactViewer + ErrorBoundary +
      CapsuleView + QuickTodoView
- [ ] F2:reader 七件 + observation 两件(ArtifactReader/JsonTree/CodeView/
      ReaderVersionBar/DocumentDiffPanel/ContextManifestView/DocumentReader +
      ObservationPanel/EvidenceBadge)

每个子代理交付标准:映射表全应用;无写死字号/圆角;控件对齐 my/ui.tsx 视觉;
功能逻辑零改动(diff 只应出现 className/样式结构/组件替换)。

### 步骤 3 — 主线:集成与门禁

- [ ] 3.1 styles.css 删除 `.card/.btn*/.field/.chip`(确认最后消费者已迁)
- [ ] 3.2 grep 门禁(AC2):`grep -rnE 'mist-[0-9]|ink-[0-9]|bg-leaf|text-leaf|leaf-soft|leaf-dim|rounded-br-p-md' src/renderer/src/{pages,components,reader,observation,chat,my}` 应为空;
      `grep -rnE 'text-\[[0-9]+(\.[0-9]+)?px\]' src/renderer/src` 应为空(注释除外)
- [ ] 3.3 `npm run typecheck` + `npm run build`
- [ ] 3.4 视觉验证:`npm run dev` + `?my=1` 预览逐页截图,深/浅两态(AC3/AC5);
      快捷键抽查(C、/、Ctrl+K、Ctrl+B、?)
- [ ] 3.5 trellis-check 全量质检

### 步骤 4 — 收尾

- [ ] 4.1 spec 更新评估(迁移映射表若沉淀价值,入 my-ui-module.md 或新 spec;
      trellis-update-spec)
- [ ] 4.2 提交。**注意工作区已有 18 个未提交脏文件(docs 相关,与本任务无关)**:
      只 stage 本任务触碰的文件;App.tsx 若与本任务改动重叠,提交前向用户说明混合情况

## 验证命令

```bash
npm run typecheck
npm run build
npm run dev   # ?my=1 浏览器预览逐页截图
```

## 回滚点

- 步骤 1 各子项独立可 revert;孤儿删除是纯删除,单命令恢复。
- 步骤 2 文件互斥 ⇒ 任意页面/代理子集 `git checkout -- <files>` 回滚,不影响他人。
- 步骤 3.1 删旧组件类放在最后,此前旧类仍在(冗余但无害),随时可中断。
