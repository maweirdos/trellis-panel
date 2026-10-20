import { transformWithOxc, type Plugin } from 'vite'
import { realpathSync } from 'node:fs'

/** Vite 8 otherwise skips refresh signatures for .ts files without JSX. */
export function reactHookRefresh(sourceRoot: string): Plugin {
  const normalize = (path: string): string => {
    const value = path.replace(/\\/g, '/')
    return process.platform === 'win32' ? value.toLowerCase() : value
  }
  const root = `${normalize(realpathSync.native(sourceRoot)).replace(/\/$/, '')}/`
  return {
    name: 'tpanel:react-hook-refresh',
    apply: 'serve',
    enforce: 'pre',
    async transform(code, id) {
      const file = id.split('?')[0].replace(/\\/g, '/')
      if (!normalize(file).startsWith(root) || !file.endsWith('.ts') || !/\buse[A-Z]\w*\s*(?:<|\()/.test(code)) return null
      const result = await transformWithOxc(code, file, { jsx: { runtime: 'automatic', refresh: true }, sourcemap: true })
      // Hook-only modules aren't component refresh boundaries. Bind their Oxc
      // signatures to the actual runtime, then let Vite invalidate importers.
      // The global preamble's $RefreshSig$ would otherwise be a no-op here.
      const map = typeof result.map === 'string' ? JSON.parse(result.map) : result.map
      return { code: `import {createSignatureFunctionForTransform as __tpanelHookSignature} from '/@react-refresh';\n${result.code.replaceAll('$RefreshSig$()', '__tpanelHookSignature()')}`,
        map: map ? { ...map, mappings: `;${map.mappings}` } : null }
    }
  }
}
