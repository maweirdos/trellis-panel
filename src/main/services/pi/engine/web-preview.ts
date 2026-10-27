import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { piWebPreviewArtifactSchema } from '../../../../shared/pi-web-preview'
import { readPiWebPreviewEntry } from './web-preview-entry'

export function webPreviewExtension(root: string): ExtensionFactory {
  return pi => pi.registerTool(defineTool({
    name: 'preview_web',
    label: 'Web preview',
    description: 'Prepare an in-app preview of an existing static HTML entry in the project (at most 8 MiB). path is relative to the project root, even when cwd is a subdirectory. Reads and hashes the entry only; does not write files, install dependencies, run commands, or verify browser rendering or interactions.',
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 8192, description: 'Project-relative .html or .htm entry; all preview resources must be inside its directory.' }),
      title: Type.String({ minLength: 1, maxLength: 160, description: 'Short human-readable title for the preview.' })
    }, { additionalProperties: false }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async execute(_id, params, signal) {
      signal?.throwIfAborted()
      if (!params.title.trim()) throw new Error('preview_web requires a nonempty title')
      const artifact = piWebPreviewArtifactSchema.parse({ ...readPiWebPreviewEntry(root, params.path), title: params.title })
      signal?.throwIfAborted()
      return {
        content: [{ type: 'text', text: `In-app web preview prepared: ${artifact.path}. Only the saved HTML entry was validated and hashed. Browser rendering and interactions have not been verified.` }],
        details: { piWebPreview: artifact }
      }
    }
  }))
}
