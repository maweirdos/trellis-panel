# 执行计划（已执行）

TaskInsightsModal v3 整体重写：状态带/问题清单（规则驱动）/下一步卡（优先级建议+动作）/交付物清单行（缺失后果+阅读回调 onReadArtifact）/上下文体检（判定 chip+逐条折叠）/会话与审阅频道关联（channelList 前缀匹配）。Tasks.tsx 传 onReadArtifact。

## 验证

typecheck 0 错（修两处：tone 联合类型、dead plain 比较）；build 693ms 通过。
