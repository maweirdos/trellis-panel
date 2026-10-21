import { parseTeamConfig, teamConfigFromEnvironment } from './config'
import { TeamStore } from './store-client'
import { restoreTeamBackup } from './restore'
const [mode, destination, restoreSource] = process.argv.slice(2)
if (mode === 'restore' && destination && restoreSource) console.log(JSON.stringify(restoreTeamBackup(restoreSource, destination)))
else if (mode === 'create' && destination) {
  const config = parseTeamConfig(teamConfigFromEnvironment())
  const store = await TeamStore.open({ dataDir: config.dataDir, issuer: config.oidc.issuer, bootstrapSubject: config.bootstrapSubject, sessionTtlMs: config.sessionTtlMs, pairingTtlMs: config.pairingTtlMs, onlineTtlMs: config.onlineTtlMs })
  try { console.log(JSON.stringify(await store.backup(destination))) } finally { await store.close() }
} else throw new Error('Usage: npm run backup -- create <new-backup-dir> OR npm run backup -- restore <new-data-dir> <backup-dir>; stop the service before CLI backup/restore')
