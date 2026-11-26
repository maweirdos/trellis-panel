export interface TeamAuthFeedback {
  message: string
  offerLogin?: boolean
}

export function teamAuthFailure(code: string, register: boolean, uncertain: boolean): TeamAuthFeedback | null {
  if (register && uncertain) return { message: '暂时无法确认注册结果。请用刚才的用户名和密码登录核对。', offerLogin: true }
  switch (code) {
    case 'REGISTRATION_UNAVAILABLE':
      return { message: '这个用户名已被占用。已有账号可以直接登录，也可以换一个用户名注册。', offerLogin: true }
    case 'REGISTRATION_DISABLED':
      return { message: '此服务未开放自主注册。已有账号可以登录，新用户请联系管理员。', offerLogin: true }
    case 'INVALID_CREDENTIALS':
      return { message: '用户名或密码不正确，请重新输入。' }
    case 'UNAUTHORIZED':
    case 'ACCOUNT_SESSION_UNAVAILABLE':
      return { message: '登录状态已过期，请重新输入密码验证。', offerLogin: true }
    case 'NETWORK_UNAVAILABLE':
      return { message: '无法连接团队服务，请检查服务地址或确认服务已启动。' }
    case 'AUTHENTICATION_BUSY':
    case 'RATE_LIMITED':
    case 'FST_ERR_RATE_LIMIT':
      return { message: '请求过于频繁，请稍后再试。' }
    default:
      return null
  }
}
