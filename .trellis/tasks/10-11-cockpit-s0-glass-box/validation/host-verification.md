# AC3 宿主进程内验证报告（真实交互式 Codex TUI）

日期：2026-10-13 10:23–10:41（本地）。验证人：构建者本人（GLM 会话驱动 computer-use 操作真实桌面）。
结论先行：**AC3 宿主半边通过**——在真实交互式 Codex TUI 会话内原生派发 `trellis-research` 子代理，SubagentStart 钩子触发、上下文真实注入子代理、`context.assembled` + `context.emitted` 回执对落库（`producer.host=codex`、`session.parentId=真实 TUI 会话 id`）。

同时更正此前一轮结论：**"TUI 也不触发 SubagentStart"的判断是错的**——事件会触发；此前静默无注入的根因是活动任务指针缺失（下文 §3）。`codex exec` 不触发 SubagentStart 的结论（4478dc7）维持不变。

## 1. 环境

- 宿主：codex-cli **0.159.2**（真实 TUI，Windows Terminal 新标签页内交互运行，cwd=D:\my_demo\trellis-panel）。
- 项目钩子/代理：本仓库 `.codex/hooks.json` + `.codex/hooks/inject-subagent-context.py` + `.codex/agents/trellis-research.toml`，全部未改动。
- **模型后端替换（如实登记）**：用户日常后端（公司 CLIProxyAPI 192.168.1.203:8317，gpt-6.1-sol）当时不可达——本机在 192.168.126.x 网段，代理在 192.168.1.x，TCP 通但服务空回复；备用云网关 gw2.oops.asia 源站宕机（CF 530/1033）；智谱 coding 端点仅有 chat/completions（无 /responses）。因此在 127.0.0.1:4317 起本地 LiteLLM 网关（`zai/glm-5.2`，/v1/responses 桥接到 chat/completions，用用户 cc-switch 内自有的智谱 key，密钥全程文件传递未上屏），经临时 `CODEX_HOME` 指向。**被测对象（codex 宿主、钩子、子代理运行时、观测链）全部为真实件**；后端替换不影响 AC3 所验证的钩子触发/注入/回执语义。验证后临时 CODEX_HOME 与密钥文件已删除，LiteLLM 已停止。

## 2. 验证序列与证据

1. TUI 内执行 `python .trellis/scripts/task.py start 10-11-cockpit-s0-glass-box` → 输出"Session identity not available…degraded mode"（§3 缺口的现场证据）。
2. 启动 `codex`（真实 TUI）。钩子信任对话框出现，选择 "Trust all and continue"。
3. 输入派发指令，模型经原生 `spawn_agent`（namespace `multi_agent_v1`，`agent_type="trellis-research"`）派发子代理（rollout 留痕：`parent_thread_id` 指向主会话）。
4. **SubagentStart 钩子确实触发**：codex 内部日志（logs_2.sqlite，TRACE `hook/started`/`hook/completed`）与钩子侧 `TRELLIS_ARM_DEBUG` armed 记录（每次派生各一条）双重印证。
5. 前两次派生无注入（§3 根因）。写入正确键格式指针（`TRELLIS_CONTEXT_ID=codex_<主会话id>` 重跑 start）后，**全新派生（rollout 01a13322，10:41:14）钩子注入真实生效**：子代理 rollout 内出现 `<!-- trellis-hook-injected -->` 标记与 "# Trellis Native Research Subagent" 上下文（此前"看到标记"为指令文本误报，本轮已按消息级核验）。
6. **回执落库**（observations.sqlite，事件 seq 5/6）：
   - injectionId `0327c767-fdce-4d66-a05f-dcfca6a65eaa`（与基线 97e44301、直调复现 b2f3a5a1 均不同，宿主内新对）
   - kind：`context.assembled`（occurredAtMs 1791859275452）→ `context.emitted`（…456，stdout write+flush 后）
   - `producer = {host: "codex", hook: "inject-subagent-context", version: "0.6.17", capability: "subagent-context-v1"}`
   - `session.parentId = 01a13312-6639-7273-9756-abc31ddd2bf6`（真实 TUI 主会话）
   - taskRef `10-11-cockpit-s0-glass-box`；materials 1（research 动态段 inline:spec-tree）
7. 中间诊断发射（seq 3/4，injectionId b2f3a5a1）：同一钩子脚本在合成 stdin 载荷下的直调复现，用于定位根因——**如实标注为诊断，不冒充宿主证据**。

## 3. 新发现：TUI 内 `task.py start` 降级 → 钩子静默跳过注入（P1，已登记 known-issues）

根因链：codex 0.159.2 未向钩子/子进程导出会话身份环境变量（`CODEX_THREAD_ID` 等未下发）→ 在 TUI 的 shell 工具里跑 `task.py start` 时 `resolve_context_key()` 返回 None → 走降级路径（只翻 task.json 状态，不写会话指针）→ SubagentStart 钩子按父会话 id 查指针（键格式 `codex_<session-id>`）落空 → 按"native starts 绝不借用他窗任务"的设计静默早退（无注入、无回执、无 stderr——`allow_single_session_fallback=False` 是防串线的正确设计，缺口在指针没写进去）。

临时缓解（本轮实际采用）：外部以 `TRELLIS_CONTEXT_ID=codex_<TUI主会话id>` 重跑 `task.py start`。上游修复方向（AC9 PR 的具体内容素材）：codex 为钩子进程导出会话/线程身份环境变量；或 Trellis 侧提供 `task.py start --context-key` 显式参数。

## 4. 证据资产

`validation/host-verification-assets/`：
- `main-session-01a13312.jsonl`——真实 TUI 主会话 rollout（含 spawn_agent 调用、派发提示原文；已扫描无密钥）。
- `subagent-01a13322-with-injection.jsonl`——带钩子注入上下文的子代理 rollout。
- `arm-debug.log`——钩子 armed 诊断（3 条：两次 TUI 派生 + 一次合成复现）。

数据库证据留存于本机 `.trellis/.panel/runtime/observations.sqlite`（seq 1–6）。
