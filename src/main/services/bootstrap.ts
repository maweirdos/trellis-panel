import { app, nativeTheme } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import type { BootstrapMigration, BootstrapSnapshot } from '../../shared/bootstrap'
import { daemonFailure } from '../daemon/errors'
import { readBounded } from '../daemon/files'

const preferencesSchema = z.object({
  version: z.literal(1), revision: z.number().int().positive().safe(),
  theme: z.enum(['dark', 'light', 'system']).optional()
})

/** Read only the separate non-secret desktop file. Never initialize native
 * protection, merge legacy settings or write defaults to obtain a window theme. */
function desktopUiPreferences(): BootstrapSnapshot['ui'] {
  const file = join(app.getPath('userData'), 'daemon-v1', app.isPackaged ? 'production' : 'development', 'desktop-preferences.json')
  try {
    if (!existsSync(file)) return { theme: 'dark' }
    const prefs = preferencesSchema.parse(JSON.parse(readBounded(file, 256 * 1024)))
    return { theme: prefs.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : prefs.theme ?? 'dark' }
  } catch {
    return { theme: 'dark', warning: '桌面外观偏好暂不可读，已使用默认外观；原文件已保留。' }
  }
}

function safeMessage(message: string): string {
  return message
    .replace(/[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(?:authorization|bearer|basic|[\w-]*(?:token|secret|password|credential|api[_-]?key)[\w-]*)["']?\s*[:=]\s*[^\r\n]+/gi, '[redacted credential]')
    .replace(/\b(?:bearer|basic)\s+[^\s]+/gi, '[redacted credential]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 800)
}

type Ports = {
  prepare(onPreparing: () => void, onAuthenticated: () => void): Promise<void>
  migration(): BootstrapMigration | undefined
  installDesktop(): Promise<void>
  publish(state: BootstrapSnapshot): void
  takeover?(error: unknown): BootstrapSnapshot['takeover'] | undefined
}

export function takeoverDiagnostics(status: import('../../shared/daemon').DaemonStatus, buildCompatibility: NonNullable<BootstrapSnapshot['takeover']>['buildCompatibility'] = 'unknown', builds?: { ownerSha256?: string; currentSha256?: string }): NonNullable<BootstrapSnapshot['takeover']> {
  return {
    state: status.state,
    buildCompatibility,
    identities: {
      productVersion: status.identity.appVersion, protocolVersion: status.protocol,
      installationId: status.identity.installationId,
      ...(builds?.ownerSha256 ? { ownerBuildSha256: builds.ownerSha256 } : {}),
      ...(builds?.currentSha256 ? { currentBuildSha256: builds.currentSha256 } : {})
    },
    activeJobs: status.activeJobs,
    unknownJobs: status.unknownJobs,
    ...(status.stopCommandId ? { stopCommandId: status.stopCommandId } : {}),
    ...(status.blockers?.length ? { blockers: status.blockers.map(({ rootId, ownerGeneration, ...blocker }) => blocker).slice(0, 32) } : {})
  }
}

/** Native retry and one-shot desktop installation are different state machines.
 * Once handler installation begins, retry cannot re-register a partial IPC set. */
export function createGuiBootstrap(ports: Ports): {
  state(): BootstrapSnapshot
  start(): Promise<void>
  retry(): Promise<void>
  fail(error: unknown): void
  firstVisible(): void
  rendererReady(): void
  refreshAppearance(): BootstrapSnapshot['ui']['theme']
  firstPaint(startTimeMs: number): void
} {
  let state: BootstrapSnapshot = { revision: 0, phase: 'window-ready', ui: desktopUiPreferences(), marks: { processStartMs: performance.nodeTiming.nodeStart } }
  let pending: Promise<void> | undefined
  let desktopStarted = false
  let rendererCommitted = false
  const snapshot = (): BootstrapSnapshot => structuredClone(state)
  const publish = (): void => { state.revision += 1; ports.publish(snapshot()) }
  const fail = (error: unknown): void => {
    const failure = daemonFailure(error)
    const takeover = ports.takeover?.(error)
    state = { ...state, phase: failure.code === 'E_VERSION' ? 'incompatible' : 'error', failure: {
      code: failure.code, message: safeMessage(failure.error), outcome: failure.outcome,
      stage: desktopStarted ? 'desktop' : 'native', retryable: !desktopStarted,
      migration: ports.migration()
    }, ...(takeover ? { takeover } : {}) }
    publish()
  }
  const run = (): Promise<void> => {
    if (!rendererCommitted || state.marks.firstVisibleMs === undefined) return Promise.resolve()
    if (pending) return pending
    if (desktopStarted || state.phase === 'ready') return Promise.resolve()
    state = { ...state, phase: 'connecting', failure: undefined, ...(state.takeover ? { takeover: undefined } : {}) }; publish()
    pending = (async () => {
      try {
        await ports.prepare(() => { state.phase = 'preparing'; publish() }, () => {
          state.marks.authenticatedMs ??= performance.now()
          publish()
        })
        state.marks.nativeReadyMs ??= performance.now()
        state.phase = 'preparing'; publish()
        desktopStarted = true
        await ports.installDesktop()
        state.phase = 'ready'; state.marks.desktopReadyMs = performance.now(); publish()
      } catch (error) { fail(error) }
    })().finally(() => { pending = undefined })
    return pending
  }
  return {
    state: snapshot,
    start: () => state.phase === 'window-ready' ? run() : Promise.resolve(),
    retry: () => state.failure?.retryable ? run() : pending ?? Promise.resolve(),
    fail,
    rendererReady() { rendererCommitted = true },
    refreshAppearance() {
      const ui = desktopUiPreferences()
      if (ui.theme !== state.ui.theme || ui.warning !== state.ui.warning) { state.ui = ui; publish() }
      return ui.theme
    },
    firstVisible() { if (state.marks.firstVisibleMs === undefined) { state.marks.firstVisibleMs = performance.now(); publish() } },
    firstPaint(startTimeMs) {
      if (state.marks.rendererFirstPaintMs !== undefined) return
      state.marks.rendererFirstPaintMs = startTimeMs; state.marks.firstPaintReceivedMs = performance.now(); publish()
    }
  }
}
export type GuiBootstrap = ReturnType<typeof createGuiBootstrap>
