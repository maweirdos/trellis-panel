export type RuntimeContextResource = { uri: string; mimeType?: string; text: string }
/** Literal SDK attachment framing, shared with the actual Pi engine. */
export function runtimeContextText(context?: readonly RuntimeContextResource[]): string {
  return context?.map(item => `\n\n<attached_context uri=${JSON.stringify(item.uri)} mimeType=${JSON.stringify(item.mimeType ?? 'text/plain')}>\n${item.text}\n</attached_context>`).join('') ?? ''
}
/** Implicit resource envelopes only; user text, images and unrelated context have separate bounds. */
export function executionContextEnvelopeBytes(resource: RuntimeContextResource): { acp: number; pi: number } {
  return { acp: Buffer.byteLength(JSON.stringify({ context: [resource] }), 'utf8'),
    pi: Math.max(Buffer.byteLength(JSON.stringify({ text: '', context: [resource] }), 'utf8'), Buffer.byteLength(runtimeContextText([resource]), 'utf8')) }
}
