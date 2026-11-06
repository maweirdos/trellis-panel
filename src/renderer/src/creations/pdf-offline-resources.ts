const cmaps = import.meta.glob('../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, query: '?url&no-inline', import: 'default' }) as Record<string, string>
const fonts = import.meta.glob('../../../../node_modules/pdfjs-dist/standard_fonts/*.{ttf,pfb}', { eager: true, query: '?url&no-inline', import: 'default' }) as Record<string, string>

const index = (values: Record<string, string>): Map<string, string> => new Map(Object.entries(values).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]))
const resources = { cMapUrl: index(cmaps), standardFontDataUrl: index(fonts) }

/** Only URLs emitted by the bundler can be requested; document paths are never used as URLs. */
export function offlinePdfResources(signal: AbortSignal) {
  return class OfflinePdfResources {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      if (!/^[A-Za-z0-9_.-]+$/.test(filename) || (kind !== 'cMapUrl' && kind !== 'standardFontDataUrl')) throw new Error('Unsupported PDF resource')
      const url = resources[kind].get(filename)
      if (!url) throw new Error('PDF resource unavailable')
      const target = new URL(url, window.location.href)
      if (target.protocol !== 'file:' && target.origin !== window.location.origin) throw new Error('Invalid PDF resource origin')
      const response = await fetch(target, { signal, redirect: 'error' })
      if (!response.ok) throw new Error('PDF resource unavailable')
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > 1024 * 1024) throw new Error('PDF resource exceeds limit')
      return new Uint8Array(bytes)
    }
  }
}
