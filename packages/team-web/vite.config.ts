import { defineConfig, normalizePath, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
// @ts-expect-error The canonical theme is authored as a JavaScript Tailwind config.
import rendererTailwind from '../../tailwind.config.js'
import type { Plugin as PostcssPlugin } from 'postcss'

const root = resolve(import.meta.dirname, '../..')
const rendererApi = normalizePath(resolve(root, 'src/renderer/src/api.ts'))
const browserApi = normalizePath(resolve(import.meta.dirname, 'src/hifox-browser-api.ts'))
const browserBoundary: Plugin = {
  name: 'hifox-browser-api', enforce: 'pre',
  async resolveId(source, importer) {
    if (!importer || source.includes('hifox-browser-api')) return null
    const resolved = await this.resolve(source, importer, { skipSelf: true })
    return resolved && normalizePath(resolved.id.split('?')[0]) === rendererApi ? browserApi : null
  }
}
// Scope the canonical renderer CSS and Tailwind reset/utilities to the browser host.
const scopedHifox: PostcssPlugin = {
  postcssPlugin: 'hifox-host-css',
  OnceExit(css) {
    css.walkRules((rule) => {
      const source = normalizePath(rule.source?.input.file ?? '')
      if (!source.includes('/src/renderer/src/') && !source.endsWith('/src/hifox-workspace.css')) return
      if (source.endsWith('/my-tokens.css')) return
      let parent: { type: string; name?: string; parent?: typeof parent } | undefined = rule.parent
      while (parent) { if (parent.type === 'atrule' && /keyframes$/i.test(parent.name ?? '')) return; parent = parent.parent }
      // Preflight must beat shell element styles without overriding canonical controls.
      const layer = (rule.raws.tailwind as { layer?: string } | undefined)?.layer
      const scope = layer === 'base' ? '.hifox-host' : '.hifox-host.hifox-host'
      rule.selectors = rule.selectors.map((selector) => {
        if (/^(:root|html|body)(?=$|[\s:.#[])/.test(selector)) return selector.replace(/^(:root|html|body)/, scope)
        if (selector.includes('.my-root')) return selector.replaceAll('.my-root', scope)
        return `${scope} ${selector}`
      })
    })
  }
}

export default defineConfig({
  plugins: [browserBoundary, react()],
  resolve: { alias: { '@shared': resolve(root, 'src/shared') }, dedupe: ['react', 'react-dom', 'zod', 'zustand', 'clsx'] },
  css: { postcss: { plugins: [tailwindcss({ ...rendererTailwind, content: [resolve(root, 'src/renderer/src/**/*.{ts,tsx}'), resolve(import.meta.dirname, 'src/**/*.{ts,tsx}')]}), autoprefixer(), scopedHifox] } },
  server: {
    port: 5442, strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, '../..')] },
    proxy: Object.fromEntries(['/api', '/auth', '/health', '/ready'].map((path) => [path, {
      target: process.env.TEAM_API_UPSTREAM ?? 'http://127.0.0.1:5441',
      changeOrigin: false
    }]))
  },
  build: { outDir: 'dist', emptyOutDir: true }
})
