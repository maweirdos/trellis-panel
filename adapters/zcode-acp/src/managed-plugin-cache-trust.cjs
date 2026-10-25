'use strict'

const path = require('node:path')
const storage = require('./managed-plugin-cache-storage.cjs')

const HASH = /^[a-f0-9]{64}$/
const MAX_TABLE_BYTES = 16 * 1024 * 1024
const MAX_TABLE_FILES = 30_000
const MAX_ASSET_BYTES = 64 * 1024 * 1024

function relativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\\:\0]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..')
}

function pluginKey(name, version, rootRelative) { return JSON.stringify([name, version, rootRelative]) }

function compileTrustedAssets(input, cliHash) {
  if (!input || input.version !== 1 || !HASH.test(input.cliSha256) || input.cliSha256 !== cliHash ||
    !Array.isArray(input.plugins) || !input.plugins.length || input.plugins.length > 128) throw new Error('trusted-assets-invalid')
  const plugins = new Map()
  let count = 0
  for (const plugin of input.plugins) {
    if (!plugin || ![plugin.name, plugin.version].every(value => typeof value === 'string' && value.length > 0 && value.length <= 128) ||
      !relativePath(plugin.rootRelative) || !Array.isArray(plugin.files) || plugin.files.length > 15_000) throw new Error('trusted-assets-invalid')
    const key = pluginKey(plugin.name, plugin.version, plugin.rootRelative)
    if (plugins.has(key)) throw new Error('trusted-assets-invalid')
    const files = new Map()
    for (const file of plugin.files) {
      if (++count > MAX_TABLE_FILES || !file || !relativePath(file.path) || files.has(file.path) ||
        ![0o644, 0o755].includes(file.mode) || typeof file.sha256 !== 'string' || !HASH.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ASSET_BYTES) throw new Error('trusted-assets-invalid')
      // Copy scalar metadata so later mutation of a test injection cannot change trust.
      files.set(file.path, Object.freeze({ path: file.path, mode: file.mode, sha256: file.sha256, size: file.size }))
    }
    plugins.set(key, files)
  }
  return plugins
}

function loadBundledTrustedAssets() {
  // Never resolve a table from the cache, installation, environment or CLI args.
  return JSON.parse(storage.boundedRead(path.join(__dirname, 'managed-plugin-assets.json'), MAX_TABLE_BYTES).toString('utf8'))
}

module.exports = { compileTrustedAssets, loadBundledTrustedAssets, pluginKey }
