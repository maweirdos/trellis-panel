/**
 * TPAP / 对话冒烟测试的 electron 桩：仅为让主进程服务（state / store / gateway /
 * chat）能在纯 node 下完成模块加载并运行。事件经 getAllWindows → webContents.send
 * 落入 globalThis.__TPANEL_EVENTS__ 供断言。
 */
const dataDir = process.env.TPAP_SMOKE_DIR

const chainable = {
  on() { return this },
  once() { return this },
  setToolTip() { return this },
  setContextMenu() { return this },
  setAlwaysOnTop() { return this },
  setMinimumSize() { return this },
  setMaximumSize() { return this },
  setBounds() { return this },
  setSize() { return this },
  show() { return this },
  hide() { return this },
  focus() { return this },
  close() { return this },
  restore() { return this },
  minimize() { return this },
  isMinimized() { return false },
  isMaximized() { return false },
  isVisible() { return false },
  isDestroyed() { return false },
  loadURL() { return Promise.resolve() },
  loadFile() { return Promise.resolve() },
  getBounds() { return { x: 0, y: 0, width: 400, height: 100 } },
  webContents: { send() {}, isLoading() { return false } }
}

export const app = {
  getPath: () => dataDir,
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-smoke',
  quit() {},
  isPackaged: false,
  requestSingleInstanceLock: () => true,
  setAsDefaultProtocolClient() {},
  setLoginItemSettings() {},
  commandLine: { appendSwitch() {} },
  whenReady: () => Promise.resolve()
}

/** 事件捕获：broadcastToWindows → webContents.send 落入全局数组。
 *  注意：每个 smoke bundle 都内联一份 mock，必须幂等初始化，否则后加载的 bundle 会重置数组。 */
if (!globalThis.__TPANEL_EVENTS__) globalThis.__TPANEL_EVENTS__ = []
const capturedWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel, payload) => globalThis.__TPANEL_EVENTS__.push({ channel, payload, ts: Date.now() })
  }
}

export const BrowserWindow = class BrowserWindowStub {
  constructor() {
    Object.assign(this, chainable)
  }
  static getAllWindows() {
    return [capturedWindow]
  }
  static getFocusedWindow() {
    return null
  }
}

export const Notification = { isSupported: () => false }

/** ipcMain 桩记录注册的通道，供 ipc-registry 冒烟做双向断言 */
globalThis.__TPANEL_IPC__ = { handle: [], on: [] }
export const ipcMain = {
  handle: (ch) => globalThis.__TPANEL_IPC__.handle.push(ch),
  on: (ch) => globalThis.__TPANEL_IPC__.on.push(ch)
}

export const Menu = { buildFromTemplate: () => ({ setContextMenu() {} }), setApplicationMenu() {} }
export const Tray = class TrayStub {
  constructor() { Object.assign(this, chainable) }
}
export const globalShortcut = { register() {}, unregisterAll() {} }
export const nativeImage = { createFromDataURL: () => ({}) }
export const shell = { openExternal() {}, showItemInFolder() {}, openPath() {} }
export const clipboard = { writeText() {} }
export const screen = { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }
export const dialog = { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) }

/** electron net 的最小桩：weknora 服务仅在被调用时才发请求，冒烟不触达 */
export const net = { fetch: () => Promise.reject(new Error('smoke stub')) }

/** session 桩：代理应用冒烟不触达 Chromium，仅记录 setProxy 调用 */
globalThis.__TPANEL_SETPROXY__ = []
export const session = {
  defaultSession: {
    setProxy: async (cfg) => {
      globalThis.__TPANEL_SETPROXY__.push(cfg)
    }
  }
}

/** safeStorage 桩：冒烟路径下密钥明文回落（isEncryptionAvailable false 分支） */
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s)),
  decryptString: (b) => Buffer.from(b).toString('utf-8')
}

export default { app, BrowserWindow, Notification, ipcMain, Menu, Tray, globalShortcut, nativeImage, shell, clipboard, screen, dialog, net, safeStorage }
