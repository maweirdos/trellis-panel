import { validateExecutionContextResource } from '../acp/execution-context'

type Resource = { uri: string; mimeType?: string; text: string }
/** Used at the real Pi prompt boundary; embedded fixed bytes are preserved exactly. */
export function composePiPromptPacket(input: { text: string; context?: readonly Resource[]; attachments?: readonly { mediaType: string; data: string }[] }): {
  text: string; context: Resource[] | undefined; images: Array<{ mimeType: string; data: string }> | undefined
} {
  let fixedCount = 0
  const context = input.context?.map(resource => {
    if (resource.uri.startsWith('trellis://execution-input/')) {
      if (++fixedCount > 1) throw new Error('A Pi prompt accepts one fixed stage context baseline')
      validateExecutionContextResource(resource)
    }
    return { ...resource }
  })
  return { text: input.text, context, images: input.attachments?.map(image => ({ mimeType: image.mediaType, data: image.data })) }
}
