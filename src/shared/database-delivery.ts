import { z } from 'zod'
import { teamDigestSchema, teamIdSchema, teamRelativePathSchema } from './team-platform'
import { executionArtifactRefSchema, executionDocumentRefSchema, executionCodeSourceSchema } from './team-execution-artifacts'
import { workflowIdSchema } from './workflow/identity'
import { teamExecutionBundleRefSchema, teamTaskRefSchema } from './team-task-execution'

export const DATABASE_DELIVERY_LIMITS = Object.freeze({ sqlFiles: 12, fileBytes: 1024 * 1024, receiptWindow: 3 })
const count = z.number().int().nonnegative().safe()
/** Published required rule JSON is the explicit activation; importing a script alone activates nothing. */
export const databaseDeliveryDescriptorSchema = z.object({
  kind: z.literal('database-delivery'), version: z.literal(1),
  source: z.object({ namespaceId: teamIdSchema, importId: teamIdSchema, candidateId: teamIdSchema,
    itemKey: teamDigestSchema, sourceDigest: teamDigestSchema }).strict(),
  gate: z.object({ action: z.literal('submit_test'), from: z.literal('developing'), to: z.literal('testing') }).strict(),
  /** A missing canonical issue is rejected unless this original fallback was explicitly selected. */
  unlinkedTicket: z.enum(['reject', 'HONSKY-1111'])
}).strict()
export const databaseDeliveryRuleRefSchema = z.object({ packageId: teamIdSchema, versionId: teamIdSchema, bodyDigest: teamDigestSchema }).strict()
export const databaseDeliveryFileSchema = z.object({ path: teamRelativePathSchema.max(1024), ref: executionArtifactRefSchema }).strict()
export const databaseDeliveryEvidenceSchema = z.object({
  kind: z.literal('database-delivery-evidence'), version: z.literal(1), task: teamTaskRefSchema,
  rule: databaseDeliveryRuleRefSchema, inputBundle: teamExecutionBundleRefSchema,
  executionId: teamIdSchema, generation: count.min(1), nodeId: z.string().min(1).max(512), attempt: count.min(1),
  implementation: executionDocumentRefSchema,
  source: executionCodeSourceSchema,
  files: z.array(databaseDeliveryFileSchema).max(DATABASE_DELIVERY_LIMITS.sqlFiles),
  native: z.object({ verification: z.literal('device-reported'), deviceId: teamIdSchema, preparationId: z.string().uuid(),
    inputDigest: teamDigestSchema, sourceDigest: teamDigestSchema }).strict()
}).strict().superRefine((value, ctx) => {
  if (new Set(value.files.map(item => item.path)).size !== value.files.length) ctx.addIssue({ code: 'custom', message: 'Duplicate SQL path' })
  if (new Set(value.files.map(item => item.ref.versionId)).size !== value.files.length) ctx.addIssue({ code: 'custom', message: 'A fixed SQL artifact cannot name multiple paths' })
  if (value.source.kind !== 'selected-files' && value.source.kind !== 'none') ctx.addIssue({ code: 'custom', message: 'Database delivery v1 supports fixed selected SQL files only' })
})
/** Authenticated native taskPreparation RPC; the original runtime UUID also identifies the save-artifact command. */
export const databaseDeliveryCaptureRequestSchema = z.object({
  operation: z.literal('database-delivery'), preparationId: z.string().uuid(), commandId: z.string().uuid(), artifactId: z.string().uuid(),
  rule: databaseDeliveryRuleRefSchema, implementationSelectionId: workflowIdSchema,
  files: z.array(databaseDeliveryFileSchema).max(DATABASE_DELIVERY_LIMITS.sqlFiles), ticket: z.string().regex(/^HONSKY-\d+$/).nullable()
}).strict()
export type DatabaseDeliveryCaptureRequest = z.infer<typeof databaseDeliveryCaptureRequestSchema>
export type DatabaseDeliveryDescriptor = z.infer<typeof databaseDeliveryDescriptorSchema>
export type DatabaseDeliveryEvidence = z.infer<typeof databaseDeliveryEvidenceSchema>
export type DatabaseDeliveryFile = z.infer<typeof databaseDeliveryFileSchema>
export type DatabaseDeliveryRuleRef = z.infer<typeof databaseDeliveryRuleRefSchema>
export type DatabaseDeliveryProblem = { code: string; path: string | null; detail: string }
export type DatabaseDeliveryRegistration = { path: string; receiptId: string | null; problems: DatabaseDeliveryProblem[] }
export type DatabaseDeliveryReport = { status: 'passed' | 'skipped' | 'failed'; registrations: DatabaseDeliveryRegistration[]; problems: DatabaseDeliveryProblem[] }

/** Only a top-level exact discriminator activates the bounded converter; prose references are inert. */
export function readDatabaseDeliveryDescriptor(text: string): DatabaseDeliveryDescriptor | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'database-delivery') return null
  return databaseDeliveryDescriptorSchema.parse(value)
}

/** Parse only the explicitly selected implement.md bytes. Other documents never reach this function. */
export function inspectDatabaseDeliveryRegistrations(implementation: string, ticket: string): DatabaseDeliveryReport {
  const problems: DatabaseDeliveryProblem[] = [], registrations: DatabaseDeliveryRegistration[] = []
  const problem = (code: string, path: string | null, detail: string): DatabaseDeliveryProblem => ({ code, path, detail })
  if (implementation.length > DATABASE_DELIVERY_LIMITS.fileBytes) problems.push(problem('capacity', null, 'Implementation text exceeds one MiB'))
  if (!/^HONSKY-\d+$/.test(ticket)) problems.push(problem('ticket', null, 'A canonical HONSKY issue or explicit original fallback is required'))
  const lines = implementation.split(/\r\n|\n|\r/), occurrences = new Map<string, number[]>()
  for (const [index, line] of lines.entries()) {
    // Match malformed depth/traversal as candidates too, so it cannot escape validation by being malformed.
    for (const match of line.matchAll(/[^\s'"<>[\]()））、；;`]*sql[\\/]+oceanbase[\\/]+[^\s'"<>[\]()））、；;`]+\.sql[^\s'"<>[\]()））、；;`]*/gi)) {
      const indexes = occurrences.get(match[0]) ?? []
      indexes.push(index); occurrences.set(match[0], indexes)
      if (occurrences.size > DATABASE_DELIVERY_LIMITS.sqlFiles) return { status: 'failed', registrations: [], problems: [problem('capacity', null, 'Too many registered SQL files')] }
    }
  }
  for (const [path, indexes] of occurrences) {
    const issues: DatabaseDeliveryProblem[] = [], parts = path.split('/'), filename = parts.at(-1) ?? ''
    if (!teamRelativePathSchema.safeParse(path).success || parts.length !== 5 || parts[0] !== 'sql' || parts[1] !== 'oceanbase' || parts.some(part => !part || part === '.' || part === '..'
      || /[\\:%?#\u0000-\u001f\u007f]/.test(part) || /[. ]$/.test(part))) issues.push(problem('path', path, 'Expected sql/oceanbase/<release>/<schema>/<filename>.sql without aliases or traversal'))
    const named = /^(\d{8})_(.+)_(HONSKY-\d+)\.sql$/.exec(filename)
    if (!named) issues.push(problem('filename', path, 'Expected YYYYMMDD_<description>_HONSKY-N.sql'))
    else if (named[3] !== ticket) issues.push(problem('ticket', path, `SQL issue ${named[3]} differs from canonical ${ticket}`))
    const receipts = new Set<string>()
    for (const index of indexes) {
      const receiptIds = (text: string): string[] => [...text.matchAll(/(?<![A-Za-z])(?:ID|id)(?![A-Za-z])\s*["：:]*\s*(\d+)(?![\dA-Za-z_.-])/g)].map(match => match[1])
      const ownLine = receiptIds(lines[index])
      const nearby = ownLine.length ? ownLine : receiptIds(lines.slice(Math.max(0, index - DATABASE_DELIVERY_LIMITS.receiptWindow), index + DATABASE_DELIVERY_LIMITS.receiptWindow + 1).join('\n'))
      for (const receipt of nearby) receipts.add(receipt)
    }
    const receiptId = receipts.size === 1 ? [...receipts][0] : null
    if (receiptId === null || receiptId.length > 32) issues.push(problem('receipt', path, 'An unambiguous numeric ID/id receipt is required within three lines of this registration'))
    registrations.push({ path, receiptId, problems: issues })
  }
  problems.push(...registrations.flatMap(item => item.problems))
  return { status: problems.length ? 'failed' : registrations.length ? 'passed' : 'skipped', registrations, problems }
}
