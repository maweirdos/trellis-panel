# 技术设计（TPD-015）

- `services/proxy.ts`：getDispatcher()（按 url 缓存 ProxyAgent，未启用返回 undefined）、
  withProxy(init)（合并 dispatcher，TS 侧以 Record 承载）、applyChromiumProxy()
  （http(s)→host:port、socks5://→socks5:host:port 的 rules 转换）。
- ai.ts 全部 fetch 调用点改为 fetch(url, withProxy(init))；调用方无感知。
- settings:set → applyChromiumProxy()；boot 时同样调用。
- Settings 页"网络代理"节；normalizeSettings 补默认值。
