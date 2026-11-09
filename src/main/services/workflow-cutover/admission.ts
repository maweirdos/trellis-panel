import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import { processOwnerSchema, workspaceGrantSchema } from '../../../shared/daemon/identity'
import { nativeWorkflowCutoverPreviewRequestSchema } from '../../../shared/native-workflow-cutover'
import { cutoverCommandSchema, cutoverReceiptSchema, cutoverRecordSchema, type CutoverAdmission } from '../../../shared/team-cutover'
import { importAssetSchema, importTaskSourceSchema } from '../../../shared/team-import'
import { teamTaskIdentity, type TeamTaskRef, type TeamExecutionCommand } from '../../../shared/team-task-execution'
import { DesktopTeamError } from '../team-platform/types'
import { assertDirectories, boundedEntries, captureDirectory, captureDirectoryTree, captureParents, fileDigest, fileStat, publishPrivate, readPrivate, readRegular, targetPath, within } from './files'
import { cutoverDigest, CutoverTransport } from './transport'
import { WorkflowCutoverInstaller, cutoverManifestDigest } from './installer'

const physical = z.object({ path: z.string(), device: z.string(), inode: z.string(), birthtime: z.string() }).strict()
const preview = nativeWorkflowCutoverPreviewRequestSchema
export const cutoverJournalSchema = z.object({ version: z.literal(1), sequence: z.number().int().nonnegative(), previousDigest: z.string().nullable(),
  request: preview, root: z.string(), directories: z.array(physical), owner: processOwnerSchema, grant: workspaceGrantSchema,
  inventory: z.object({ assets: z.array(importAssetSchema), tasks: z.array(importTaskSourceSchema) }).strict(),
  previewDigest: z.string(), blockers: z.array(z.string()), target: z.enum(['activate', 'suspend', 'rollback']),
  local: z.enum(['uninstalled', 'installed', 'rolled-back']),
  steps: z.array(z.object({ command: cutoverCommandSchema, state: z.enum(['prepared', 'dispatched', 'unknown', 'rejected', 'committed']), receipt: cutoverReceiptSchema.nullable() }).strict()),
  server: cutoverRecordSchema.nullable()
}).strict()
export type CutoverJournal = z.infer<typeof cutoverJournalSchema>
export function cutoverFailure(code: string, message: string): never { throw new DesktopTeamError(code, message) }
/** Immutable snapshots live beside the installer journal, never in the engineering tree. */
export class CutoverJournalStore {
  private readonly directory: string
  constructor(private readonly dataDir: string) { this.directory = join(dataDir, 'cutovers', 'coordinator') }
  private check(root?: string): void {
    captureDirectoryTree(this.dataDir)
    if (root && (within(root, this.directory) || within(this.directory, root))) cutoverFailure('CUTOVER_STORAGE_CONFLICT', 'Private cutover storage must be outside the entire workcopy')
    for (const directory of [join(this.dataDir, 'cutovers'), this.directory]) if (fileStat(directory)) captureDirectoryTree(directory)
  }
  assertStorage(root: string): void { this.check(root) }
  read(operationId: string): CutoverJournal | null {
    z.string().uuid().parse(operationId); this.check()
    const directory = join(this.directory, operationId)
    if (!fileStat(directory)) return null
    captureDirectoryTree(directory)
    const files = boundedEntries(directory).filter(name => /^journal-\d{6}\.json$/.test(name)).sort()
    if (!files.length || files.length > 512) cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original cutover journal is missing or exceeds its bound')
    let previous: CutoverJournal | null = null, digest: string | null = null
    for (const [index, name] of files.entries()) {
      if (name !== 'journal-' + String(index).padStart(6, '0') + '.json') cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original cutover milestone is missing')
      const bytes = readPrivate(captureDirectory(directory), name, 24 * 1024 * 1024).bytes
      if (!bytes) cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original journal disappeared')
      const record = cutoverJournalSchema.parse(JSON.parse(bytes.toString('utf8')))
      if (record.sequence !== index || record.previousDigest !== digest || record.request.command.operationId !== operationId
        || previous && (cutoverDigest(record.request) !== cutoverDigest(previous.request) || cutoverDigest(record.owner) !== cutoverDigest(previous.owner) || cutoverDigest(record.grant) !== cutoverDigest(previous.grant) || record.root !== previous.root || record.previewDigest !== previous.previewDigest
          || cutoverDigest(record.inventory) !== cutoverDigest(previous.inventory) || cutoverDigest(record.directories) !== cutoverDigest(previous.directories)
          || record.steps.length < previous.steps.length || previous.steps.some((step, position) => cutoverDigest(step.command) !== cutoverDigest(record.steps[position].command) || step.state === 'committed' && (record.steps[position].state !== 'committed' || cutoverDigest(step.receipt) !== cutoverDigest(record.steps[position].receipt))))) cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original cutover identity or milestone chain changed')
      previous = record; digest = fileDigest(bytes)
    }
    if (!previous) cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original cutover journal is unavailable')
    this.check(previous.root); return previous
  }
  save(raw: CutoverJournal): CutoverJournal {
    const record = cutoverJournalSchema.parse(raw); this.check(record.root)
    const operationId = record.request.command.operationId, old = this.read(operationId)
    const directory = join(this.directory, operationId)
    for (const selected of [join(this.dataDir, 'cutovers'), this.directory, directory]) {
      captureDirectoryTree(dirname(selected))
      if (!fileStat(selected)) mkdirSync(selected, { mode: 0o700 })
      captureDirectoryTree(selected)
    }
    const sequence = old ? old.sequence + 1 : 0
    if (sequence >= 512) cutoverFailure('CUTOVER_LIMIT', 'Retained cutover milestone limit reached')
    const previousDigest = old ? fileDigest(readPrivate(captureDirectory(directory), 'journal-' + String(old.sequence).padStart(6, '0') + '.json', 24 * 1024 * 1024).bytes ?? cutoverFailure('CUTOVER_JOURNAL_INVALID', 'Original journal disappeared')) : null
    const next = cutoverJournalSchema.parse({ ...record, sequence, previousDigest })
    publishPrivate(captureDirectory(directory), 'journal-' + String(sequence).padStart(6, '0') + '.json', Buffer.from(JSON.stringify(next)))
    return next
  }
}
/** Verify the original install-created identities, as well as the reviewed bytes and scope. */
export async function verifyCutoverInstallation(dataDir: string, record: CutoverJournal, guard: () => void = () => {}): Promise<void> {
  const operationId = record.request.command.operationId
  const verify = (): void => { guard(); assertDirectories(record.directories) }
  verify()
  const files = record.request.command.manifest.files.map(file => {
    const parents = captureParents(record.root, file.targetPath); assertDirectories(parents)
    const bytes = readRegular(targetPath(record.root, file.targetPath)).bytes
    if ((bytes === null ? null : fileDigest(bytes)) !== file.afterDigest) cutoverFailure('CUTOVER_DRIFT', 'Installed platform instructions or connectors changed: ' + file.targetPath)
    return { relativePath: file.targetPath, expectedBeforeDigest: file.beforeDigest, afterDigest: file.afterDigest, afterBytes: bytes }
  })
  const expectedDigest = cutoverManifestDigest(files)
  const installer = new WorkflowCutoverInstaller({ privateDirectory: join(dataDir, 'cutovers'), validateAdmission: async request => {
    verify()
    if (request.action !== 'inspect' || request.operationId !== operationId || request.rootDirectory !== record.root || request.manifestDigest !== expectedDigest) cutoverFailure('CUTOVER_LOCAL_PROOF_MISSING', 'Original installer scope differs from the retained activation')
  } })
  const status = await installer.inspect(operationId)
  verify()
  if (!status.localVerified || status.phase !== 'installed' || status.manifestDigest !== expectedDigest
    || cutoverDigest(status.files.map(file => ({ relativePath: file.relativePath, expectedBeforeDigest: file.expectedBeforeDigest, afterDigest: file.afterDigest }))) !== cutoverDigest(files.map(({ afterBytes: _bytes, ...file }) => file).sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))) cutoverFailure('CUTOVER_DRIFT', 'Original installed file or directory identities no longer match')
}
export async function verifiedCutoverAdmission(dataDir: string, task: TeamTaskRef, actorId: string, deviceId: string, transport: CutoverTransport, options: { root?: string; productClaim?: boolean } = {}): Promise<CutoverAdmission | null> {
  const active = await transport.task(task)
  if (!active) return null
  if (active.state !== 'active') cutoverFailure('CUTOVER_NOT_ACTIVE', 'Imported task writers are fenced until the original workcopy activation is active')
  const record = new CutoverJournalStore(dataDir).read(active.operationId)
  if (!record || options.root && options.root !== record.root) {
    if (!options.productClaim && !options.root) cutoverFailure('CUTOVER_LOCAL_PROOF_MISSING', 'Independent editors require the original verified local installation')
    if (options.root && await hasRetainedDispatch(options.root)) cutoverFailure('CUTOVER_LOCAL_PROOF_MISSING', 'A directory with retained dispatch surfaces requires its original installation journal')
    const current = await transport.task(task)
    if (!current || cutoverDigest(current) !== cutoverDigest(active)) cutoverFailure('CUTOVER_CHANGED', 'Original activation changed during admission')
    return { operationId: active.operationId, manifestDigest: active.manifestDigest }
  }
  if (record.request.pin.deviceId !== deviceId) cutoverFailure('CUTOVER_DEVICE_MISMATCH', 'Converted workcopy installation belongs to its original local device')
  if (record.local !== 'installed' || !record.server || record.server.state !== 'active'
    || record.server.revision !== active.revision || cutoverDigest(record.server) !== cutoverDigest(active)
    || cutoverDigest(record.request.command.manifest) !== active.manifestDigest || record.request.pin.deviceId !== deviceId
    || !actorId || record.request.pin.epoch !== active.epoch
    || !record.request.command.manifest.tasks.some(t => teamTaskIdentity(t.task) === teamTaskIdentity(task))) cutoverFailure('CUTOVER_LOCAL_PROOF_MISSING', 'Original private installation and activation receipts must be reconciled on this device')
  await verifyCutoverInstallation(dataDir, record)
  const current = await transport.task(task)
  await verifyCutoverInstallation(dataDir, record)
  if (!current || cutoverDigest(current) !== cutoverDigest(active)) cutoverFailure('CUTOVER_CHANGED', 'Original activation changed during local verification')
  return { operationId: active.operationId, manifestDigest: active.manifestDigest }
}
/** Retry comparison may omit only the locally injected proof; every other byte is semantic intent. */
export function originalExecutionCommand(incoming: TeamExecutionCommand, stored: TeamExecutionCommand): TeamExecutionCommand {
  const withoutProof = (command: TeamExecutionCommand): unknown => { if (command.kind !== 'claim') return command; const { cutoverAdmission: _proof, ...rest } = command; return rest }
  if (cutoverDigest(withoutProof(incoming)) !== cutoverDigest(withoutProof(stored)) || incoming.kind === 'claim' && incoming.cutoverAdmission !== undefined
    && (stored.kind !== 'claim' || cutoverDigest(incoming.cutoverAdmission) !== cutoverDigest(stored.cutoverAdmission))) cutoverFailure('COMMAND_PAYLOAD_CONFLICT', 'Original execution UUID belongs to a different semantic intent')
  return stored
}

/** Shared evidence check for retained Trellis/native entrypoint references. */
export function hasRetainedDispatchText(text: string): boolean {
  const retained = /(?:\.trellis(?:[\/\\]|\b)|\.crux[\/\\]workflow|TRELLIS:(?:START|END)|CRUX:.*(?:START|END)|crux-native-workflow|trellis[:/]|team_cutover_check)/i
  return retained.test(text)
}
/** Ordinary T05 roots may have their own instructions, but no retained Trellis/native dispatch. */
export function hasRetainedDispatch(root: string): boolean {
  const directories = captureDirectoryTree(root)
  let entries = 0, bytesRead = 0
  const inspect = (path: string, depth = 0): boolean => {
    if (++entries > 12000 || depth > 32) cutoverFailure('CUTOVER_LIMIT', 'Native dispatch verification exceeds its inventory bound')
    captureParents(root, path)
    const target = targetPath(root, path), stat = fileStat(target)
    if (!stat) return false
    if (stat.isDirectory()) {
      const identity = captureDirectoryTree(target)
      const found = boundedEntries(target).some(name => inspect(path + '/' + name, depth + 1))
      assertDirectories(identity); return found
    }
    const bytes = readRegular(target).bytes
    if (!bytes || (bytesRead += bytes.length) > 8 * 1024 * 1024) cutoverFailure('CUTOVER_LIMIT', 'Native instruction verification is unavailable or exceeds its byte bound')
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes) || hasRetainedDispatchText(text)) return true
    if (['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json'].includes(path)) {
      try {
        const config: unknown = JSON.parse(text)
        if (!config || typeof config !== 'object' || Array.isArray(config)) return true
        const hooks = (config as Record<string, unknown>).hooks
        if (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Object.keys(hooks).length > 0)) return true
      } catch { return true }
    }
    return false
  }
  for (const path of ['.trellis', '.crux/workflow']) { captureParents(root, path); if (fileStat(targetPath(root, path))) return true }
  const paths = ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.codex/config.toml', '.codex/hooks.json', '.claude/settings.json', '.claude/settings.local.json',
    ...['.agents', '.claude', '.codex'].flatMap(base => ['skills', 'commands', 'agents', 'hooks'].map(kind => base + '/' + kind))]
  const found = paths.some(path => inspect(path))
  assertDirectories(directories)
  return found
}
