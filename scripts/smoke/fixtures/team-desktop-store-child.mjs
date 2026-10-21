/** Owned crash probe: actual store/worker admission; deliberately no remote POST. */
const [bundle, directory, worker, commandId] = process.argv.slice(2)
const { DesktopTeamStore } = await import(bundle)
const store = await DesktopTeamStore.open({ dataDir: directory, workerFile: worker })
await store.call({ op: 'claim', input: { commandId, retryUnknown: false } })
process.stdout.write('OWNED_DESKTOP_CLAIM_COMMITTED\n', () => process.exit(0))
