/** Only absolute, well-formed web URLs may be handed to the operating system. */
export function externalHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\\s]/i.test(value)) return null
  // Reject characters that URL parsers would silently strip or reinterpret.
  if (/[\\\u0000-\u0020\u007f]/.test(value) || /%(?![\da-f]{2})/i.test(value)) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}
