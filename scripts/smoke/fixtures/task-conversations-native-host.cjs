/** Optional local read-only probe. No windows, native client launches or transcript output. */
const { app } = require('electron')
const { join, dirname } = require('node:path')
const bundle = process.argv[2]
const root = process.argv[3]
app.setPath('userData', join(dirname(bundle), 'local-probe-profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-networking')
app.whenReady().then(async () => {
  const { TaskConversationsService } = require(bundle)
  const service = new TaskConversationsService()
  try {
    if (process.env.TASK_CONVERSATIONS_PROTOCOL_DIAGNOSTIC === '1') {
      for (const source of ['codex', 'zcode']) {
        try { const info = await app.getApplicationInfoForProtocol(`${source}://`); console.log('TASK_CONVERSATIONS_NATIVE ' + JSON.stringify({ protocol: source, name: info.name, path: info.path })) }
        catch (error) { console.log('TASK_CONVERSATIONS_NATIVE ' + JSON.stringify({ protocol: source, error: String(error) })) }
      }
    }
    const started = performance.now()
    const result = await service.discover(root)
    const firstDiscoverMs = Math.round(performance.now() - started)
    console.log('TASK_CONVERSATIONS_NATIVE ' + JSON.stringify({
      sources: result.sources,
      counts: Object.fromEntries(result.sources.map(source => [source.source, result.items.filter(item => item.source === source.source).length])),
      capabilities: Object.fromEntries(result.sources.map(source => [source.source, [...new Set(result.items.filter(item => item.source === source.source).map(item => item.capability))]])),
      codexRoles: Object.fromEntries(['user', 'subagent', 'unknown'].map(role => [role, result.items.filter(item => item.source === 'codex' && (item.role ?? 'unknown') === role).length])),
      truncated: result.truncated,
      ...(process.argv[4] ? { expectedSessionPresent: result.items.some(item => item.sessionId === process.argv[4]) } : {})
    }))
    if (process.env.TASK_CONVERSATIONS_CACHE_DIAGNOSTIC === '1') {
      const repeated = performance.now()
      const next = await service.discover(root)
      console.log('TASK_CONVERSATIONS_NATIVE ' + JSON.stringify({ firstDiscoverMs, repeatDiscoverMs: Math.round(performance.now() - repeated),
        codexCapability: [...new Set(next.items.filter(item => item.source === 'codex').map(item => item.capability))] }))
    }
  } finally { service.close(); app.quit() }
}).catch(error => { console.error(String(error)); app.exit(1) })
