import { ipcInvoke } from '../../shared/ipc-channels'
import { startHttpApi, stopHttpApi, httpApiStatus } from '../services/httpapi'
import { accessServer } from '../services/access/server'
import { getAccessToken, rotateAccessToken } from '../services/access/token'
import { getSettings, setSettings } from '../services/store'
import { getSnapshot } from '../state'
import { handle } from './registry'

export function registerHttpApiIpc(): void {
  /* 只读 Web 看板（独立于 TPAP 接入协议：看板无鉴权、可选局域网，TPAP 恒环回 + token） */
  handle(ipcInvoke.mcp.info, () => {
    const st = httpApiStatus()
    return {
      running: st.running,
      port: st.port,
      webBoardUrl: st.running && getSettings().httpApi.webBoard ? `http://127.0.0.1:${st.port}/` : null
    }
  })

  handle(ipcInvoke.mcp.toggle, (_e, onOff: boolean) => {
    setSettings({ httpApi: { ...getSettings().httpApi, enabled: onOff } })
    if (onOff) {
      const s = getSettings()
      void startHttpApi(s.httpApi.port, s.httpApi.lanAccess, () => getSnapshot())
    } else {
      stopHttpApi()
    }
    return { ok: httpApiStatus().running === onOff, error: httpApiStatus().running === onOff ? undefined : '启动失败（端口占用？）' }
  })

  /* TPAP 本地接入协议 */
  handle(ipcInvoke.access.status, () => {
    const st = accessServer.status()
    return {
      ...st,
      endpoint: st.running && st.port ? `http://127.0.0.1:${st.port}/tpap/v1` : null,
      token: getAccessToken()
    }
  })

  handle(ipcInvoke.access.rotateToken, () => {
    const token = rotateAccessToken()
    return { ok: true, token }
  })
}
