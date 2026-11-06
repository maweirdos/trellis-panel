import { z } from 'zod'

// Conservative v1 contract limits, not a claim that binary transfer is implemented.
// Team restore currently accepts non-empty blobs of at most 1 MiB.
export const CREATION_RESOURCE_MAX_BYTES = 1024 * 1024
export const CREATION_RESOURCE_MAX_COUNT = 64
// Structural maximum of logical references, not the team store's available quota.
export const CREATION_RESOURCE_MAX_TOTAL_BYTES = CREATION_RESOURCE_MAX_COUNT * CREATION_RESOURCE_MAX_BYTES
export const CREATION_RESOURCE_MAX_PATH_BYTES = 1024

const encoder = new TextEncoder()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const resourceId = z.string().uuid().refine((value) => value === value.toLowerCase(), 'Resource ID must be lowercase')
const reservedWindowsName = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i

/** A portable logical name, not a URL or an authorized filesystem path. */
export const creationResourcePathSchema = z.string().min(1).max(CREATION_RESOURCE_MAX_PATH_BYTES).refine((value) => {
  if (value !== value.normalize('NFC') || encoder.encode(value).length > CREATION_RESOURCE_MAX_PATH_BYTES) return false
  // Exclude URL escapes, Windows separators/devices, control characters and lone surrogates.
  if (/[\\%:?#<>"|*\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) return false
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'
    && !/[. ]$/.test(segment) && !reservedWindowsName.test(segment) && encoder.encode(segment).length <= 255)
}, 'Resource path must be a normalized portable relative path')

// Lowercase, parameter-free media type tokens; this does not assert content safety.
const mediaType = z.string().max(127).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)

export const creationResourceSchema = z.object({
  id: resourceId,
  path: creationResourcePathSchema,
  mediaType,
  byteLength: z.number().int().min(1).max(CREATION_RESOURCE_MAX_BYTES),
  sha256: digest
}).strict()

/** Metadata only. Equal digests may share a blob; equal digests must have equal lengths. */
export const creationResourceManifestSchema = z.object({
  version: z.literal(1),
  resources: z.array(creationResourceSchema).max(CREATION_RESOURCE_MAX_COUNT)
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>()
  const files = new Set<string>()
  const directories = new Map<string, string>()
  const lengths = new Map<string, number>()
  manifest.resources.forEach((resource, index) => {
    const issue = (message: string): void => context.addIssue({ code: 'custom', path: ['resources', index], message })
    if (ids.has(resource.id)) issue('Duplicate resource ID')
    ids.add(resource.id)
    const parts = resource.path.split('/')
    const folded = parts.map((part) => part.toLowerCase().normalize('NFC'))
    const file = folded.join('/')
    if (files.has(file) || directories.has(file)) issue('Resource path conflicts with another file or directory')
    files.add(file)
    for (let i = 1; i < parts.length; i += 1) {
      const key = folded.slice(0, i).join('/')
      const spelling = parts.slice(0, i).join('/')
      if (files.has(key) || (directories.has(key) && directories.get(key) !== spelling)) issue('Resource directory conflicts with another path')
      directories.set(key, spelling)
    }
    const previousLength = lengths.get(resource.sha256)
    if (previousLength !== undefined && previousLength !== resource.byteLength) issue('A digest cannot have different byte lengths')
    lengths.set(resource.sha256, resource.byteLength)
  })
})

export type CreationResource = z.infer<typeof creationResourceSchema>
export type CreationResourceManifest = z.infer<typeof creationResourceManifestSchema>
export type CreationResourceDigestPort = (utf8Text: string) => string | Promise<string>

/**
 * SHA-256 input is the UTF-8 encoding of this JSON array, with resources sorted by
 * lowercase UUID in code-unit order. Each tuple is [id, path, mediaType, byteLength,
 * sha256]. The domain tag and version prevent confusion with body/blob hashes.
 * bodyDigest is SHA-256 of the exact UTF-8 creation body, under its existing limit.
 */
export function creationResourceBindingPreimage(bodyDigest: unknown, rawManifest: unknown): string {
  const body = digest.parse(bodyDigest)
  const manifest = creationResourceManifestSchema.parse(rawManifest)
  const resources = [...manifest.resources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return JSON.stringify(['creation-resource-binding', 1, body, resources.map((resource) => [
    resource.id, resource.path, resource.mediaType, resource.byteLength, resource.sha256
  ])])
}

/** The adapter must hash the exact UTF-8 input using SHA-256 and return lowercase hex. */
export async function creationResourceBindingDigest(bodyDigest: unknown, rawManifest: unknown, sha256: CreationResourceDigestPort): Promise<string> {
  return digest.parse(await sha256(creationResourceBindingPreimage(bodyDigest, rawManifest)))
}

/*
 * Future publication must reauthorize the creation and every blob, verify actual
 * bytes, lengths and hashes, then atomically freeze the manifest and binding with
 * the fixed revision and task reference. A hash is not a read grant. Backup and
 * restore must retain that metadata and every referenced blob, check completeness,
 * lengths and hashes before admitting the restored revision, and retain existing
 * quota/GC guarantees. The team writer must check its actual shared blob quota
 * after deduplication; the structural maximum does not reserve capacity. None of
 * those integrations are implemented by this schema.
 * A future filesystem adapter must also prevent symlinks and filesystem-specific
 * aliases/collisions; logical path validation alone cannot prove containment.
 */
