# 统一代理设置（roadmap #10）

## Goal
settings 全局 proxy 覆盖面板三条出网路径：应用内 AI（openai/anthropic/ollama/request 四形态 +
模型探测 + models.dev 拉取）、WeKnora（Chromium net.fetch）、以及未来扩展的统一入口。

## Requirements
- R1 `settings.proxy = { enabled, url }`（http/https/socks5），默认关闭。
- R2 Node 侧 fetch（aiChat/aiChatStream/fetchModelsFromProvider/testSingleModel/models.dev）统一经
  `services/proxy.ts` 的 withProxy 注入 undici ProxyAgent dispatcher；未启用/禁用时零行为变化。
- R3 Chromium 侧（weknora net.fetch）经 `session.defaultSession.setProxy` 应用；boot 与 settings:set
  后重新应用。
- R4 Settings 页新增"网络代理"节：开关 + URL 输入（支持 http(s)://、socks5://）。
- R5 冒烟 scripts/smoke/proxy.mjs：本地转发代理 + 目标服务，断言 ①启用时请求经代理且业务成功
  ②禁用时直连（代理无请求）。

## Acceptance Criteria
- [ ] AC1 代理启用时 aiChatStream 请求经代理转发且流式完成（冒烟）。
- [ ] AC2 代理禁用时目标服务直接收到请求、代理零请求（冒烟）。
- [ ] AC3 模型探测路径同样经代理（冒烟）。
- [ ] AC4 typecheck 全绿 + 既有三套冒烟回归全过。
