import { isNativeBaselineFileChange } from './connectors'
import { convertNativeProviderSettings } from './provider-hooks'
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, renameSync, rmdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { assertBytes, assertDirectories, assertDirectory, assertParents, boundedEntries, captureDirectory, captureDirectoryTree, captureParents, fileDigest, fileStat, pathFailure, publishPrivate, readPrivate, readRegular, removeOwned, sameIdentity, syncDirectory, targetPath, validateRelativePath, within, writeExclusive } from './files'
import { CUTOVER_FILE_LIMITS, CUTOVER_INSTALLER_VERSION, CutoverInstallerError, type CutoverAdmissionRequest, type CutoverFileChange, type CutoverFileIntent, type CutoverFileObservation, type CutoverFilePhase, type CutoverInstallationAction, type CutoverInstallationStatus, type CutoverInstallerOptions, type CutoverJournalState, type CutoverPhysicalIdentity, type CutoverStageRequest, type CutoverStoredFile, type CutoverStoredPlan, type CutoverStoredProgress } from './types'

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const identitySchema = z.object({ path: z.string().min(1).max(4096), device: z.string().regex(/^\d+$/), inode: z.string().regex(/^-?\d+$/), birthtime: z.string().regex(/^\d+$/) }).strict()
const storedFileSchema = z.object({ relativePath: z.string(), expectedBeforeDigest: digestSchema.nullable(), afterDigest: digestSchema.nullable(), afterBase64: z.string().nullable(), beforeBase64: z.string().nullable(), beforeIdentity: identitySchema.nullable(), beforeMode: z.number().int().min(0).max(511).nullable() }).strict()
const planSchema = z.object({ version: z.literal(CUTOVER_INSTALLER_VERSION), operationId: z.string().uuid(), rootDirectory: z.string(), manifestDigest: digestSchema, directories: z.array(identitySchema).max(4096), files: z.array(storedFileSchema).min(1).max(CUTOVER_FILE_LIMITS.files) }).strict()
const intentSchema = z.object({ direction: z.enum(['install', 'rollback']), scratch: z.string(), scratchIdentity: identitySchema, preparedIdentity: identitySchema.nullable(), sourceIdentity: identitySchema.nullable() }).strict()
const progressSchema = z.object({ phase: z.enum(['staged', 'install-intent', 'installed', 'rollback-intent', 'rolled-back', 'conflict', 'unknown']), message: z.string().max(2048).nullable(), intent: intentSchema.nullable(), ownedIdentity: identitySchema.nullable() }).strict()
const stateSchema = z.object({ sequence: z.number().int().nonnegative().max(CUTOVER_FILE_LIMITS.events), previousDigest: digestSchema.nullable(), directories: z.array(identitySchema).max(4096), files: z.array(progressSchema).max(CUTOVER_FILE_LIMITS.files) }).strict()
const activeOperations = new Set<string>()
const sortPaths = (a: { relativePath: string }, b: { relativePath: string }): number => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
function progress(phase: CutoverFilePhase, intent: CutoverFileIntent | null = null, ownedIdentity: CutoverPhysicalIdentity | null = null, message: string | null = null): CutoverStoredProgress { return { phase, intent, ownedIdentity, message } }
function currentDigest(observation: CutoverFileObservation): string | null { return observation.bytes === null ? null : fileDigest(observation.bytes) }
function validStoredBytes(encoded: string | null, digest: string | null): Buffer | null {
  if (encoded === null) { if (digest !== null) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Absent bytes have a digest'); return null }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > CUTOVER_FILE_LIMITS.fileBytes || bytes.toString('base64') !== encoded || fileDigest(bytes) !== digest) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Private original or planned bytes failed digest verification')
  return bytes
}
const providerSettingsPaths = new Set(['.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json'])
function assertProviderConversion(file: CutoverFileChange, before: Buffer | null): void {
  if (!providerSettingsPaths.has(file.relativePath)) return
  const converted = before && convertNativeProviderSettings(file.relativePath, before)
  if (!converted || !file.afterBytes || !converted.equals(Buffer.from(file.afterBytes))) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Provider settings may only replace the exact reviewed standard Hook registration, preserving other settings')
}
function validateSurface(file: CutoverFileChange): void {
  const path = file.relativePath
  validateRelativePath(path)
  if (isNativeBaselineFileChange(file) || providerSettingsPaths.has(path)) return
  const normalized = path.toLowerCase()
  if (normalized === 'agents.md' || normalized === 'claude.md' || normalized.startsWith('.crux/workflow/') || /^\.(claude|codex)\/(commands|agents|skills|hooks)\//.test(normalized) || normalized.startsWith('.agents/skills/')) return
  throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Only reviewed root instructions and native connector dispatch surfaces may be changed')
}
function normalizedFiles(input: readonly CutoverFileChange[]): CutoverFileChange[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > CUTOVER_FILE_LIMITS.files) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Cutover file count is outside its bounded limit')
  const seen = new Set<string>(), files: CutoverFileChange[] = []
  let total = 0
  for (const file of input) {
    validateSurface(file)
    const key = file.relativePath.toLowerCase()
    if (seen.has(key)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Duplicate or case-aliased cutover paths')
    seen.add(key)
    digestSchema.nullable().parse(file.expectedBeforeDigest); digestSchema.nullable().parse(file.afterDigest)
    const bytes = file.afterBytes === null ? null : Buffer.from(file.afterBytes)
    if (bytes && bytes.length > CUTOVER_FILE_LIMITS.fileBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Planned file is too large')
    if ((bytes === null ? null : fileDigest(bytes)) !== file.afterDigest || file.expectedBeforeDigest === file.afterDigest) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Planned bytes must match their digest and change the original bytes')
    total += bytes?.length ?? 0
    if (total > CUTOVER_FILE_LIMITS.totalBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Planned bytes exceed the total budget')
    files.push({ relativePath: file.relativePath, expectedBeforeDigest: file.expectedBeforeDigest, afterDigest: file.afterDigest, afterBytes: bytes })
  }
  files.sort(sortPaths)
  for (let i = 0; i < files.length; i++) for (const other of files.slice(i + 1)) if (other.relativePath.toLowerCase().startsWith(files[i].relativePath.toLowerCase() + '/')) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'File and directory paths overlap')
  return files
}
/** Stable local manifest digest; root identity is retained separately and is never portable authority. */
export function cutoverManifestDigest(files: readonly CutoverFileChange[]): string {
  return fileDigest(JSON.stringify({ version: CUTOVER_INSTALLER_VERSION, scope: 'whole-workcopy', files: normalizedFiles(files).map(file => ({ relativePath: file.relativePath, expectedBeforeDigest: file.expectedBeforeDigest, afterDigest: file.afterDigest, afterBytes: file.afterBytes?.length ?? null })) }))
}

/** Main-only, whole-workcopy engine. Its injected coordinator must retain quiescence through settlement. */
export class WorkflowCutoverInstaller {
  private readonly privateIdentities: CutoverPhysicalIdentity[]
  private readonly privateIdentity: CutoverPhysicalIdentity
  private readonly validateAdmission: CutoverInstallerOptions['validateAdmission']
  constructor(options: CutoverInstallerOptions) {
    this.privateIdentities = captureDirectoryTree(options.privateDirectory)
    const identity = this.privateIdentities.at(-1)
    if (!identity || typeof options.validateAdmission !== 'function') throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'A protected private directory and trusted admission validator are required')
    this.privateIdentity = identity
    this.validateAdmission = options.validateAdmission
  }
  async stage(request: CutoverStageRequest): Promise<CutoverInstallationStatus> {
    const operationId = z.string().uuid().parse(request.operationId), rootDirectory = request.rootDirectory
    const files = normalizedFiles(request.files), manifestDigest = cutoverManifestDigest(files)
    const directories = captureDirectoryTree(rootDirectory)
    if (within(rootDirectory, this.privateIdentity.path) || within(this.privateIdentity.path, rootDirectory)) throw new CutoverInstallerError('CUTOVER_INVALID_PLAN', 'Private recovery storage must be outside and separate from the affected workcopy')
    const key = this.operationPath(operationId)
    return this.exclusive(key, async () => {
      const admission: CutoverAdmissionRequest = { operationId: operationId, rootDirectory: rootDirectory, manifestDigest, action: 'stage', relativePath: null }
      await this.validateAdmission(Object.freeze(admission))
      assertDirectories(this.privateIdentities); assertDirectories(directories)
      if (fileStat(key)) {
        const loaded = this.load(operationId)
        if (loaded.plan.manifestDigest !== manifestDigest || loaded.plan.rootDirectory !== rootDirectory) throw new CutoverInstallerError('CUTOVER_OPERATION_CONFLICT', 'The original operation already has a different immutable plan')
        return this.status(loaded.plan, loaded.state)
      }
      const originals: CutoverStoredFile[] = []
      let total = 0
      for (const file of files) {
        await this.validateAdmission(Object.freeze({ ...admission, relativePath: file.relativePath }))
        assertDirectories(this.privateIdentities); assertDirectories(directories)
        const parents = captureParents(rootDirectory, file.relativePath)
        for (const parent of parents) if (!directories.some(item => item.path === parent.path)) directories.push(parent)
        assertDirectories(directories)
        const original = readRegular(targetPath(rootDirectory, file.relativePath))
        assertDirectories(directories)
        assertBytes(original, file.expectedBeforeDigest)
        assertProviderConversion(file, original.bytes)
        total += original.bytes?.length ?? 0
        if (total > CUTOVER_FILE_LIMITS.totalBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Original backup bytes exceed the total budget')
        originals.push({ relativePath: file.relativePath, expectedBeforeDigest: file.expectedBeforeDigest, afterDigest: file.afterDigest, afterBase64: file.afterBytes === null ? null : Buffer.from(file.afterBytes).toString('base64'), beforeBase64: original.bytes?.toString('base64') ?? null, beforeIdentity: original.identity, beforeMode: original.mode })
      }
      const plan: CutoverStoredPlan = { version: CUTOVER_INSTALLER_VERSION, operationId: operationId, rootDirectory: rootDirectory, manifestDigest, directories, files: originals }
      await this.validateAdmission(Object.freeze(admission))
      assertDirectories(this.privateIdentities); assertDirectories(directories)
      // Publish the whole staged directory with its plan already fsynced; a competing UUID cannot be adopted.
      const temporary = join(this.privateIdentity.path, '.stage-' + randomUUID())
      mkdirSync(temporary, { mode: 0o700 })
      const stagedIdentity = captureDirectory(temporary)
      const bytes = Buffer.from(JSON.stringify(plan))
      if (bytes.length > CUTOVER_FILE_LIMITS.planBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Private cutover plan exceeds its metadata budget')
      publishPrivate(stagedIdentity, 'plan.json', bytes)
      assertDirectories(this.privateIdentities); assertDirectory(stagedIdentity)
      // An existing nonempty operation directory makes rename fail; check it again before publication.
      if (fileStat(key)) throw new CutoverInstallerError('CUTOVER_OPERATION_CONFLICT', 'Operation directory appeared during staging')
      renameSync(temporary, key)
      assertDirectories(this.privateIdentities); syncDirectory(this.privateIdentity.path)
      const loaded = this.load(operationId)
      return this.status(loaded.plan, loaded.state)
    }, rootDirectory)
  }
  /** Synchronous read-only proof from original private plan/milestones; callers retain their admission guard. */
  verifyInstalled(operationId: string): CutoverInstallationStatus {
    const loaded = this.load(operationId)
    this.assertScope(loaded.plan, loaded.state)
    const status = this.status(loaded.plan, loaded.state)
    if (!status.localVerified) throw new CutoverInstallerError('CUTOVER_FILE_CONFLICT', 'Original installation is incomplete or its retained physical files changed')
    this.assertScope(loaded.plan, loaded.state)
    return status
  }
  inspect(operationId: string): Promise<CutoverInstallationStatus> { return this.run(operationId, 'inspect') }
  recover(operationId: string): Promise<CutoverInstallationStatus> { return this.run(operationId, 'recover') }
  install(operationId: string): Promise<CutoverInstallationStatus> { return this.run(operationId, 'install') }
  rollback(operationId: string): Promise<CutoverInstallationStatus> { return this.run(operationId, 'rollback') }

  private operationPath(operationId: string): string { z.string().uuid().parse(operationId); return join(this.privateIdentity.path, operationId) }
  private async exclusive<T>(key: string, operation: () => Promise<T>, rootDirectory: string): Promise<T> {
    const rootKey = 'whole-workcopy:' + rootDirectory.toLowerCase()
    if (activeOperations.has(key) || activeOperations.has(rootKey)) throw new CutoverInstallerError('CUTOVER_BUSY', 'The original installation operation is already being inspected or changed')
    activeOperations.add(key); activeOperations.add(rootKey)
    try { return await operation() } finally { activeOperations.delete(key); activeOperations.delete(rootKey) }
  }
  private load(operationId: string): { plan: CutoverStoredPlan; state: CutoverJournalState; directory: CutoverPhysicalIdentity; digest: string | null; journalBytes: number } {
    assertDirectories(this.privateIdentities)
    const directory = captureDirectory(this.operationPath(operationId))
    const rawPlan = readPrivate(directory, 'plan.json', CUTOVER_FILE_LIMITS.planBytes)
    if (!rawPlan.bytes) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Original immutable installation plan is missing')
    const plan = planSchema.parse(JSON.parse(rawPlan.bytes.toString('utf8')))
    if (plan.operationId !== operationId || within(plan.rootDirectory, directory.path) || within(directory.path, plan.rootDirectory)) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Private plan identity or boundary differs')
    const changes = plan.files.map(file => ({ relativePath: file.relativePath, expectedBeforeDigest: file.expectedBeforeDigest, afterDigest: file.afterDigest, afterBytes: validStoredBytes(file.afterBase64, file.afterDigest) }))
    if (cutoverManifestDigest(changes) !== plan.manifestDigest) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Immutable plan manifest failed verification')
    for (const file of plan.files) {
      const before = validStoredBytes(file.beforeBase64, file.expectedBeforeDigest)
      assertProviderConversion({ ...file, afterBytes: validStoredBytes(file.afterBase64, file.afterDigest) }, before)
      if ((file.beforeIdentity === null) !== (file.beforeBase64 === null)) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Original absence and physical identity differ')
    }
    let state: CutoverJournalState = { sequence: 0, previousDigest: null, directories: [], files: plan.files.map(() => progress('staged')) }, digest: string | null = null
    const entries = boundedEntries(directory.path).filter(name => /^event-\d{4}\.json$/.test(name)).sort()
    if (entries.length > CUTOVER_FILE_LIMITS.events) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Installation journal event budget exceeded')
    let journalBytes = 0
    for (const [index, name] of entries.entries()) {
      if (name !== this.eventName(index + 1)) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Installation journal sequence has a gap')
      const observation = readPrivate(directory, name, CUTOVER_FILE_LIMITS.eventBytes)
      if (!observation.bytes) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'An installation milestone is missing')
      journalBytes += observation.bytes.length
      if (journalBytes > CUTOVER_FILE_LIMITS.journalBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Installation journal byte budget exceeded')
      const next = stateSchema.parse(JSON.parse(observation.bytes.toString('utf8')))
      if (next.sequence !== index + 1 || next.previousDigest !== digest || next.files.length !== plan.files.length) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Installation milestone does not extend its original command')
      state = next; digest = fileDigest(observation.bytes)
    }
    const scopeDirectories = [...plan.directories, ...state.directories]
    if (!plan.directories.some(identity => identity.path === plan.rootDirectory) || new Set(scopeDirectories.map(identity => identity.path)).size !== scopeDirectories.length) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Directory evidence is absent or ambiguous')
    for (const identity of scopeDirectories) if (!within(identity.path, plan.rootDirectory) && !within(plan.rootDirectory, identity.path)) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Directory evidence escaped the retained root chain')
    for (const [index, file] of state.files.entries()) if (file.intent) {
      const target = targetPath(plan.rootDirectory, plan.files[index].relativePath)
      if (dirname(file.intent.scratch) !== dirname(target) || !new RegExp(`^\\.crux-cutover-${operationId}-${index}-[0-9a-f-]{36}$`).test(file.intent.scratch.slice(dirname(target).length + 1)) || file.intent.scratchIdentity.path !== file.intent.scratch || (file.intent.preparedIdentity && file.intent.preparedIdentity.path !== join(file.intent.scratch, 'prepared'))) throw new CutoverInstallerError('CUTOVER_JOURNAL_INVALID', 'Intent paths differ from the original file command')
    }
    assertDirectories(this.privateIdentities); assertDirectory(directory)
    return { plan, state, directory, digest, journalBytes }
  }
  private eventName(sequence: number): string { return `event-${String(sequence).padStart(4, '0')}.json` }
  private save(operationId: string, next: CutoverJournalState): CutoverJournalState {
    const loaded = this.load(operationId)
    if (loaded.state.sequence !== next.sequence) throw new CutoverInstallerError('CUTOVER_BUSY', 'Original operation milestone changed concurrently')
    if (next.sequence >= CUTOVER_FILE_LIMITS.events) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Installation journal event budget exceeded')
    const state: CutoverJournalState = { ...next, sequence: next.sequence + 1, previousDigest: loaded.digest }
    const bytes = Buffer.from(JSON.stringify(state))
    if (bytes.length > CUTOVER_FILE_LIMITS.eventBytes || loaded.journalBytes + bytes.length > CUTOVER_FILE_LIMITS.journalBytes) throw new CutoverInstallerError('CUTOVER_LIMIT', 'Installation milestone byte budget exceeded')
    publishPrivate(loaded.directory, this.eventName(state.sequence), bytes)
    return state
  }
  private async admit(plan: CutoverStoredPlan, state: CutoverJournalState, action: CutoverInstallationAction, relativePath: string | null): Promise<void> {
    await this.validateAdmission(Object.freeze({ operationId: plan.operationId, rootDirectory: plan.rootDirectory, manifestDigest: plan.manifestDigest, action, relativePath }))
    assertDirectories(this.privateIdentities); this.assertScope(plan, state)
  }
  private assertScope(plan: CutoverStoredPlan, state: CutoverJournalState): void {
    assertDirectories([...plan.directories, ...state.directories])
    for (const file of plan.files) assertParents(plan.rootDirectory, file.relativePath, [...plan.directories, ...state.directories])
  }
  private observe(plan: CutoverStoredPlan, state: CutoverJournalState, index: number): CutoverFileObservation {
    this.assertScope(plan, state)
    const observation = readRegular(targetPath(plan.rootDirectory, plan.files[index].relativePath), CUTOVER_FILE_LIMITS.fileBytes, state.files[index].intent ? 2n : 1n)
    this.assertScope(plan, state)
    const intent = state.files[index].intent
    if (observation.bytes !== null && intent) {
      const stat = fileStat(targetPath(plan.rootDirectory, plan.files[index].relativePath))
      if (stat?.nlink === 2n) {
        assertDirectory(intent.scratchIdentity)
        const aliases = ['prepared', 'displaced'].filter(name => {
          const alias = join(intent.scratch, name), retained = fileStat(alias)
          if (!retained || !observation.identity || !sameIdentity(observation.identity, retained)) return false
          const other = readRegular(alias, CUTOVER_FILE_LIMITS.fileBytes, 2n)
          if (!other.bytes || !observation.bytes || !other.bytes.equals(observation.bytes)) pathFailure('An owned hardlink alias changed during observation')
          return true
        })
        this.assertScope(plan, state); assertDirectory(intent.scratchIdentity)
        if (aliases.length !== 1) pathFailure('A file has an unowned hardlink alias')
      }
    }
    return observation
  }
  private status(plan: CutoverStoredPlan, state: CutoverJournalState): CutoverInstallationStatus {
    const files = plan.files.map((file, index) => {
      const saved = state.files[index]
      let phase = saved.phase, message = saved.message, observedDigest: string | null = null
      try {
        const observation = this.observe(plan, state, index)
        observedDigest = currentDigest(observation)
        const expected = phase === 'installed' ? file.afterDigest : phase === 'staged' || phase === 'rolled-back' ? file.expectedBeforeDigest : undefined
        if (expected !== undefined) {
          assertBytes(observation, expected)
          const expectedIdentity = phase === 'installed' || phase === 'rolled-back' ? saved.ownedIdentity ?? file.beforeIdentity : file.beforeIdentity
          if (observation.identity && expectedIdentity && (observation.identity.device !== expectedIdentity.device || observation.identity.inode !== expectedIdentity.inode || observation.identity.birthtime !== expectedIdentity.birthtime)) pathFailure('File with matching bytes was physically replaced')
        }
      } catch (error) { phase = 'conflict'; message = error instanceof Error ? error.message.slice(0, 2048) : 'Filesystem observation is unavailable' }
      return { relativePath: file.relativePath, expectedBeforeDigest: file.expectedBeforeDigest, afterDigest: file.afterDigest, observedDigest, phase, message }
    })
    const phases = files.map(file => file.phase)
    const phase = phases.some(item => item === 'conflict' || item === 'unknown') ? 'blocked' : phases.every(item => item === 'installed') ? 'installed' : phases.every(item => item === 'rolled-back') ? 'rolled-back' : phases.some(item => item === 'rollback-intent' || item === 'rolled-back') ? 'rolling-back' : phases.some(item => item === 'install-intent' || item === 'installed') ? 'installing' : 'staged'
    return { version: CUTOVER_INSTALLER_VERSION, operationId: plan.operationId, rootDirectory: plan.rootDirectory, manifestDigest: plan.manifestDigest, scope: 'whole-workcopy', phase, files, localVerified: phase === 'installed' && files.every((file, index) => !state.files[index].intent && file.phase === 'installed') }
  }
  private replaceProgress(state: CutoverJournalState, index: number, file: CutoverStoredProgress): CutoverJournalState { return { ...state, files: state.files.map((entry, position) => position === index ? file : entry) } }
  private async run(operationId: string, action: Exclude<CutoverInstallationAction, 'stage'>): Promise<CutoverInstallationStatus> {
    const key = this.operationPath(operationId), rootDirectory = this.load(operationId).plan.rootDirectory
    return this.exclusive(key, async () => {
      const loaded = this.load(operationId), plan = loaded.plan
      let state = loaded.state
      await this.validateAdmission(Object.freeze({ operationId, rootDirectory: plan.rootDirectory, manifestDigest: plan.manifestDigest, action, relativePath: null }))
      assertDirectories(this.privateIdentities)
      if (action === 'inspect') return this.status(plan, state)
      if (action === 'install' && state.files.some(file => file.phase === 'rollback-intent' || file.phase === 'rolled-back')) throw new CutoverInstallerError('CUTOVER_OPERATION_CONFLICT', 'Rollback has begun; the original command cannot become another installation')
      const indices = plan.files.map((_, index) => index)
      if (action === 'rollback') indices.reverse()
      for (const index of indices) {
        const file = plan.files[index]
        try {
          await this.admit(plan, state, action, file.relativePath)
          if (state.files[index].intent) state = this.reconcileIntent(plan, state, index)
          if (action === 'recover') {
            const saved = state.files[index]
            if ((saved.phase === 'conflict' || saved.phase === 'unknown') && !saved.intent) {
              const observation = this.observe(plan, state, index)
              if (currentDigest(observation) === file.expectedBeforeDigest) {
                this.assertFileIdentity(observation, file.beforeIdentity)
                state = this.save(operationId, this.replaceProgress(state, index, progress('staged')))
              } else if (currentDigest(observation) === file.afterDigest && saved.ownedIdentity) {
                this.assertFileIdentity(observation, saved.ownedIdentity)
                state = this.save(operationId, this.replaceProgress(state, index, progress('installed', null, saved.ownedIdentity)))
              }
            }
            continue
          }
          const saved = state.files[index]
          if (saved.phase === 'conflict' || saved.phase === 'unknown') continue
          if (action === 'install') {
            if (saved.phase === 'installed') { this.assertCurrent(plan, state, index, file.afterDigest, saved.ownedIdentity); continue }
            // Recheck every remaining source before any next install, including shared root files.
            for (let other = 0; other < plan.files.length; other++) {
              const item = plan.files[other], recorded = state.files[other]
              if (recorded.phase === 'staged') this.assertCurrent(plan, state, other, item.expectedBeforeDigest, item.beforeIdentity)
              else if (recorded.phase === 'installed') this.assertCurrent(plan, state, other, item.afterDigest, recorded.ownedIdentity)
              else throw new CutoverInstallerError('CUTOVER_FILE_CONFLICT', 'Another file in this whole-workcopy command is unresolved')
            }
            state = this.ensureParents(plan, state, file.relativePath)
            state = this.mutateFile(plan, state, index, 'install')
          } else {
            if (saved.phase === 'rolled-back') { this.assertCurrent(plan, state, index, file.expectedBeforeDigest, saved.ownedIdentity ?? file.beforeIdentity); continue }
            if (saved.phase === 'staged') {
              const original = this.assertCurrent(plan, state, index, file.expectedBeforeDigest, file.beforeIdentity)
              state = this.save(operationId, this.replaceProgress(state, index, progress('rolled-back', null, original.identity)))
            } else state = this.mutateFile(plan, state, index, 'rollback')
          }
        } catch (error) {
          if (!(error instanceof CutoverInstallerError) && !(error instanceof Error && 'code' in error)) throw error
          state = this.load(operationId).state
          const recorded = state.files[index]
          state = this.save(operationId, this.replaceProgress(state, index, { ...recorded, phase: recorded.intent ? 'unknown' : 'conflict', message: error instanceof Error ? error.message.slice(0, 2048) : 'Installation could not be observed' }))
          if (action === 'install') break
        }
      }
      await this.validateAdmission(Object.freeze({ operationId, rootDirectory: plan.rootDirectory, manifestDigest: plan.manifestDigest, action, relativePath: null }))
      assertDirectories(this.privateIdentities)
      return this.status(plan, state)
    }, rootDirectory)
  }
  private assertFileIdentity(observation: CutoverFileObservation, expected: CutoverPhysicalIdentity | null): void {
    if (!observation.identity && !expected) return
    if (!observation.identity || !expected || observation.identity.device !== expected.device || observation.identity.inode !== expected.inode || observation.identity.birthtime !== expected.birthtime) pathFailure('Matching bytes belong to a replaced physical file')
  }
  private assertCurrent(plan: CutoverStoredPlan, state: CutoverJournalState, index: number, expectedDigest: string | null, expectedIdentity: CutoverPhysicalIdentity | null): CutoverFileObservation {
    const observation = this.observe(plan, state, index)
    assertBytes(observation, expectedDigest); this.assertFileIdentity(observation, expectedIdentity)
    return observation
  }
  private ensureParents(plan: CutoverStoredPlan, state: CutoverJournalState, relativePath: string): CutoverJournalState {
    let current = plan.rootDirectory
    for (const part of relativePath.split('/').slice(0, -1)) {
      current = join(current, part)
      const identity = [...plan.directories, ...state.directories].find(item => item.path === current)
      if (identity) { assertDirectory(identity); continue }
      this.assertScope(plan, state)
      if (fileStat(current)) pathFailure('An unrecorded parent directory appeared')
      // A crash between mkdir and recording its identity fails closed on the unrecorded directory.
      mkdirSync(current, { mode: 0o700 })
      const created = captureDirectory(current)
      state = this.save(plan.operationId, { ...state, directories: [...state.directories, created] })
      this.assertScope(plan, state); syncDirectory(dirname(current))
    }
    return state
  }
  private mutateFile(plan: CutoverStoredPlan, state: CutoverJournalState, index: number, direction: 'install' | 'rollback'): CutoverJournalState {
    const file = plan.files[index], saved = state.files[index], target = targetPath(plan.rootDirectory, file.relativePath)
    const fromDigest = direction === 'install' ? file.expectedBeforeDigest : file.afterDigest
    const toDigest = direction === 'install' ? file.afterDigest : file.expectedBeforeDigest
    const fromIdentity = direction === 'install' ? file.beforeIdentity : saved.ownedIdentity
    const desired = validStoredBytes(direction === 'install' ? file.afterBase64 : file.beforeBase64, toDigest)
    this.assertCurrent(plan, state, index, fromDigest, fromIdentity)
    const scratch = join(dirname(target), `.crux-cutover-${plan.operationId}-${index}-${randomUUID()}`)
    this.assertScope(plan, state)
    mkdirSync(scratch, { mode: 0o700 })
    const scratchIdentity = captureDirectory(scratch)
    let preparedIdentity: CutoverPhysicalIdentity | null = null
    if (desired !== null) {
      const temporary = join(scratch, 'temporary'), prepared = join(scratch, 'prepared')
      writeExclusive(temporary, desired, file.beforeMode ?? 0o600)
      this.assertScope(plan, state); assertDirectory(scratchIdentity)
      renameSync(temporary, prepared)
      this.assertScope(plan, state); assertDirectory(scratchIdentity)
      const observation = readRegular(prepared)
      assertBytes(observation, toDigest); preparedIdentity = observation.identity
    }
    const intent: CutoverFileIntent = { direction, scratch, scratchIdentity, preparedIdentity, sourceIdentity: fromIdentity }
    state = this.save(plan.operationId, this.replaceProgress(state, index, progress(direction === 'install' ? 'install-intent' : 'rollback-intent', intent, saved.ownedIdentity)))
    this.assertCurrent(plan, state, index, fromDigest, fromIdentity)
    assertDirectory(scratchIdentity)
    if (fromDigest !== null) {
      const displaced = join(scratch, 'displaced')
      if (fileStat(displaced)) pathFailure('An unowned displaced file appeared')
      renameSync(target, displaced)
      this.assertScope(plan, state); assertDirectory(scratchIdentity)
      const moved = readRegular(displaced)
      assertBytes(moved, fromDigest); this.assertFileIdentity(moved, fromIdentity)
    }
    if (preparedIdentity) {
      this.assertScope(plan, state); assertDirectory(scratchIdentity)
      const prepared = readRegular(preparedIdentity.path)
      assertBytes(prepared, toDigest); this.assertFileIdentity(prepared, preparedIdentity)
      // link is exclusive: never rename over a destination that may have appeared concurrently.
      linkSync(preparedIdentity.path, target)
      this.assertScope(plan, state); assertDirectory(scratchIdentity)
    }
    syncDirectory(dirname(target))
    const installed = this.observe(plan, state, index)
    assertBytes(installed, toDigest); this.assertFileIdentity(installed, preparedIdentity)
    const finalPhase = direction === 'install' ? 'installed' : 'rolled-back'
    state = this.save(plan.operationId, this.replaceProgress(state, index, progress(finalPhase, intent, installed.identity)))
    return this.cleanupIntent(plan, state, index)
  }
  private reconcileIntent(plan: CutoverStoredPlan, state: CutoverJournalState, index: number): CutoverJournalState {
    const file = plan.files[index], saved = state.files[index], intent = saved.intent
    if (!intent) return state
    const fromDigest = intent.direction === 'install' ? file.expectedBeforeDigest : file.afterDigest
    const toDigest = intent.direction === 'install' ? file.afterDigest : file.expectedBeforeDigest
    const fromIdentity = intent.sourceIdentity
    let observed = this.observe(plan, state, index)
    const digest = currentDigest(observed)
    if (digest === toDigest) {
      this.assertFileIdentity(observed, intent.preparedIdentity)
      state = this.save(plan.operationId, this.replaceProgress(state, index, progress(intent.direction === 'install' ? 'installed' : 'rolled-back', intent, observed.identity)))
      return this.cleanupIntent(plan, state, index)
    }
    if (fileStat(intent.scratch)) assertDirectory(intent.scratchIdentity)
    if (digest === null && fromDigest !== null) {
      const displaced = readRegular(join(intent.scratch, 'displaced'))
      assertBytes(displaced, fromDigest); this.assertFileIdentity(displaced, fromIdentity)
      this.assertScope(plan, state); assertDirectory(intent.scratchIdentity)
      linkSync(join(intent.scratch, 'displaced'), targetPath(plan.rootDirectory, file.relativePath))
      this.assertScope(plan, state); assertDirectory(intent.scratchIdentity)
      observed = this.observe(plan, state, index)
    }
    assertBytes(observed, fromDigest); this.assertFileIdentity(observed, fromIdentity)
    state = this.save(plan.operationId, this.replaceProgress(state, index, progress(intent.direction === 'install' ? 'staged' : 'installed', intent, intent.direction === 'install' ? null : observed.identity)))
    return this.cleanupIntent(plan, state, index)
  }
  private cleanupIntent(plan: CutoverStoredPlan, state: CutoverJournalState, index: number): CutoverJournalState {
    const file = plan.files[index], saved = state.files[index], intent = saved.intent
    if (!intent) return state
    this.assertScope(plan, state)
    if (fileStat(intent.scratch)) {
      assertDirectory(intent.scratchIdentity)
      const preparedDigest = intent.direction === 'install' ? file.afterDigest : file.expectedBeforeDigest
      if (intent.preparedIdentity && preparedDigest !== null) {
        removeOwned(join(intent.scratch, 'prepared'), intent.preparedIdentity, preparedDigest, 2n)
        this.assertScope(plan, state); assertDirectory(intent.scratchIdentity)
      }
      const displacedPath = join(intent.scratch, 'displaced'), displaced = readRegular(displacedPath, CUTOVER_FILE_LIMITS.fileBytes, 2n)
      if (displaced.bytes !== null) {
        const expectedDigest = intent.direction === 'install' ? file.expectedBeforeDigest : file.afterDigest
        const expectedIdentity = intent.sourceIdentity
        assertBytes(displaced, expectedDigest)
        this.assertFileIdentity(displaced, expectedIdentity)
        if (!displaced.identity || expectedDigest === null) pathFailure('Displaced original evidence is missing')
        removeOwned(displacedPath, displaced.identity, expectedDigest, 2n)
        this.assertScope(plan, state); assertDirectory(intent.scratchIdentity)
      }
      if (boundedEntries(intent.scratch).length) pathFailure('Unknown files in the installer scratch directory were preserved')
      rmdirSync(intent.scratch); this.assertScope(plan, state); syncDirectory(dirname(intent.scratch))
    }
    state = this.save(plan.operationId, this.replaceProgress(state, index, { ...saved, intent: null }))
    return state
  }
}
