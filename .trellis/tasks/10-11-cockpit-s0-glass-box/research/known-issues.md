# 已知问题与登记项（滚动更新）

## 环境类

- **chat.mjs 冒烟超时**（2026-10-11，G2 二片检查时发现）：`等待超时： 流式增量`，两次复现；依赖真实模型端点流式响应，与本任务改动无关（chat 域文件未动）。不在 implement.md §8 检查清单内。待单独排查（疑似端点/网络环境变化）。

## 登记不阻塞（P3，来源：G2 二片 trellis-check）

1. `git-baseline.ts:141`：项目根为 repo 子目录时判 no-repo（文案中性但不够准确）；`git show commit:path` 的 path 语义相对 repo 根。S0 只开 repo 根不触发；放开子目录/worktree 时（G3）必须重审。
2. `git-baseline.ts:120`：`validRepoRelative` 不拒 `:`，理论上 pathspec magic 可影响 not-in-commit/untracked 的分类（两者均为中性降级，无越界风险）。Windows 文件名天然无冒号。
3. asar 打包环境 diff-worker 加载未验证——G1-B 既有待办，不新增。
4. `readingSessions` 无条目上限：下一片页面接线时必须保证文档关闭调用 `readerCloseSession`（store 契约已写明）。
5. diff"最大编辑量可配置"（maxEditLength）未实现：2MiB/侧 + 1s 超时已覆盖失控场景；需要时再加。

## 已处置

- G2 二片 check 的 5 个 P3 中：`\r` 剥离、present 措辞"存在"、useMemo 常量三处已当场修复（随本片提交）；其余见上。
