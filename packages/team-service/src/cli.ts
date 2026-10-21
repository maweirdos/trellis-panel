import { createTeamService, teamConfigFromEnvironment } from './index'
const port = Number(process.env.TEAM_PORT ?? 5441)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TEAM_PORT must be between 1 and 65535')
const service = await createTeamService(teamConfigFromEnvironment())
await service.app.listen({ port, host: process.env.TEAM_HOST ?? '127.0.0.1' })
const stop = async (): Promise<void> => { await service.close() }
process.once('SIGINT', () => { void stop().catch(() => { process.exitCode = 1 }) })
process.once('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1 }) })
