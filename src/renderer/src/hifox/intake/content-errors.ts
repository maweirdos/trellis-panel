const messages = new Map<string, string>([
  ['CONTENT_NOT_CONFIGURED', '团队AI尚未配置，请管理员接入模型；素材已保留。'],
  ['CONTENT_CAPABILITY_DISABLED', '团队尚未开放需求整理，请管理员启用。'],
  ['CONTENT_PROTECTION_UNAVAILABLE', '团队模型凭据目前不可用，请服务管理员检查；不要重复填写或发送。'],
  ['CONTENT_INPUT_LIMIT', '资料超过团队设置的单次输入额度。请减少资料，或由管理员调整额度。'],
  ['CONTENT_INPUT_TOO_LARGE', '本轮资料过长，请减少附件或精简正文后再整理。'],
  ['CONTENT_TOKEN_BUDGET', '团队或个人的当日Token额度不足，请管理员核对用量。'],
  ['CONTENT_REQUEST_BUDGET', '已达到当日请求额度，请管理员核对后再继续。'],
  ['CONTENT_CONCURRENCY_LIMIT', '正在处理的请求已达上限，请等原请求结束后再试。'],
  ['CONTENT_CONFIG_CHANGED', '模型配置已变化，本次请求未继续，请核对新配置后再整理。'],
  ['CONTENT_TASK_CHANGED', '原任务内容已变化，请先核对原任务，素材仍保留。'],
  ['CONTENT_UPSTREAM_HTTP', '模型服务拒绝了请求，请管理员检查服务地址、模型和Key。'],
  ['CONTENT_RESPONSE_INVALID', '模型返回的内容暂不可用，原素材和上一版候选已保留。'],
  ['CONTENT_RESPONSE_TOO_LARGE', '模型返回内容超过读取上限，请缩小本轮范围。'],
  ['TASK_INPUT_RULE_CONFLICT', '适用的必需团队规范存在冲突，请规则负责人处理后再生成。'],
  ['GOVERNANCE_WITHDRAWN', '本轮引用的规范版本已撤回，请核对可用版本；旧候选不能直接采用。']
])

export function contentErrorMessage(code: string | null | undefined, fallback = '内容整理未完成，请核对原请求。'): string {
  return code ? messages.get(code) ?? fallback : fallback
}
