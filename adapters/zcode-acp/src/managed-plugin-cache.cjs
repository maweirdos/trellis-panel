'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { sha256, PREPARE_STATUS } = require('./managed-cache-compat.cjs')
const storage = require('./managed-plugin-cache-storage.cjs')
const trust = require('./managed-plugin-cache-trust.cjs')

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 30_000, maxDepth: 64, maxFiles: 15_000, maxAssetBytes: 64 * 1024 * 1024,
  maxSourceBytes: 256 * 1024 * 1024, maxPackBytes: 128 * 1024 * 1024,
  maxMemoryBytes: 256 * 1024 * 1024, maxManifestBytes: 16 * 1024 * 1024,
  maxDiskBytes: 512 * 1024 * 1024, maxDiskEntries: 128, maxMemoryEntries: 32
})

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function fingerprint(definition) { return sha256(JSON.stringify(definition)) }

function createManagedPluginCache({ originalCli, cliHash, cacheDir, limits: requestedLimits = {}, trustedAssets, eager = false }) {
  // Overrides may reduce resource usage, never raise hard bounds.
  const limits = Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([key, value]) => [key,
    Number.isSafeInteger(requestedLimits[key]) && requestedLimits[key] >= 0 ? Math.min(value, requestedLimits[key]) : value]))
  const original = fs.realpathSync.native(originalCli)
  const resources = path.dirname(path.dirname(original))
  const install = path.dirname(resources)
  const memory = new Map()
  const registrations = new WeakMap()
  const stats = { hits: 0, prepared: 0, fallbacks: 0, failures: 0, memoryBytes: 0 }
  let trusted
  try { trusted = trust.compileTrustedAssets(trustedAssets === undefined ? trust.loadBundledTrustedAssets() : trustedAssets, cliHash) }
  catch { /* An absent or invalid program asset disables the optional cache. */ }
  let directory

  function baseline(id, definition) {
    const relative = path.relative(resources, id.root).split(path.sep).join('/')
    const files = trusted?.get(trust.pluginKey(definition.name, definition.version, relative))
    if (!files) throw new Error('untrusted-plugin')
    return files
  }

  function identity(root, definition) {
    if (path.basename(resources).toLowerCase() !== 'resources' || !path.isAbsolute(root)) throw new Error('unofficial-root')
    const canonicalRoot = storage.physical(root)
    if (!storage.inside(resources, canonicalRoot) || !Array.isArray(definition.rootCandidates) ||
      !definition.rootCandidates.some(candidate => path.resolve(path.dirname(original), candidate) === canonicalRoot)) throw new Error('unofficial-root')
    return { version: 1, install, originalCli: original, cliHash, root: canonicalRoot, definitionHash: fingerprint(definition) }
  }

  function drop(key) {
    const previous = memory.get(key)
    if (previous) stats.memoryBytes -= previous.memoryBytes
    memory.delete(key)
  }

  function remember(key, record) {
    drop(key)
    const bytes = (record.pack?.length ?? record.sliceBytes ?? 0) + record.manifestBytes
    if (bytes > limits.maxMemoryBytes || limits.maxMemoryEntries === 0) throw new Error('memory-limit')
    while (memory.size >= limits.maxMemoryEntries || stats.memoryBytes + bytes > limits.maxMemoryBytes) drop(memory.keys().next().value)
    memory.set(key, record)
    record.memoryBytes = bytes
    record.slices ??= new Map()
    record.token ??= {}
    record.treeMap = new Map(record.manifest.tree.map(([relative, ...stat]) => [relative, stat]))
    stats.memoryBytes += bytes
  }

  function reserve(bytes, protectedKey) {
    if (bytes > limits.maxMemoryBytes) throw new Error('memory-limit')
    while (stats.memoryBytes + bytes > limits.maxMemoryBytes) {
      const key = [...memory.keys()].find(candidate => candidate !== protectedKey)
      if (key === undefined) throw new Error('memory-limit')
      drop(key)
    }
  }

  function validate(record, id, tree, inventory, expected) {
    const { manifest, pack, packSize } = record
    if (!same(manifest.identity, id) || !same(manifest.tree, tree) || !Array.isArray(manifest.files) ||
      manifest.files.length !== inventory.length || manifest.files.length > limits.maxFiles || !Number.isSafeInteger(packSize) ||
      packSize < 0 || packSize > limits.maxPackBytes || !/^[a-f0-9]{64}$/.test(manifest.packHash) ||
      (pack && (pack.length !== packSize || manifest.packHash !== sha256(pack)))) throw new Error('stale-manifest')
    if (record.packFile) storage.checkPack(record)
    let offset = 0
    for (let index = 0; index < inventory.length; index++) {
      const file = manifest.files[index]
      const item = inventory[index]
      const pinned = expected.get(item.path)
      if (file.path !== item.path || file.mode !== item.mode || file.offset !== offset || !Number.isSafeInteger(file.size) ||
        file.size < 0 || file.size > limits.maxAssetBytes || file.size > packSize - offset ||
        !pinned || file.sha256 !== pinned.sha256 || file.size !== pinned.size || file.mode !== pinned.mode ||
        (pack && pinned.sha256 !== sha256(pack.subarray(offset, offset + file.size)))) throw new Error('asset-integrity')
      offset += file.size
    }
    if (offset !== packSize) throw new Error('pack-size')
    record.expected = expected
  }

  function validateInventory(root, tree, inventory, expected) {
    if (!Array.isArray(inventory) || inventory.length > limits.maxFiles) throw new Error('file-limit')
    if (inventory.length !== expected.size) throw new Error('unpinned-assets')
    const entries = new Map(tree.map(([relative, ...stat]) => [relative, stat]))
    const seen = new Set()
    let total = 0
    for (const file of inventory) {
      const stat = entries.get(file.path)
      const pinned = expected.get(file.path)
      if (seen.has(file.path) || !stat || stat[0] !== 'f' || file.sourcePath !== path.join(root, ...file.path.split('/')) ||
        !storage.inside(root, file.sourcePath) || !Number.isSafeInteger(file.mode)) throw new Error('invalid-inventory')
      seen.add(file.path)
      const size = Number(stat[3])
      if (!pinned || pinned.size !== size || pinned.mode !== file.mode) throw new Error('unpinned-assets')
      if (size > limits.maxAssetBytes) throw new Error('asset-limit')
      total += size
      if (total > Math.min(limits.maxPackBytes, limits.maxMemoryBytes)) throw new Error('pack-limit')
    }
    return total
  }

  function expose(key, record) {
    return record.manifest.files.map((file, index) => {
      const result = { mode: file.mode, path: file.path, sha256: record.expected.get(file.path).sha256, sourcePath: path.join(record.manifest.identity.root, ...file.path.split('/')) }
      registrations.set(result, { key, index, token: record.token })
      return result
    })
  }

  function catalogue(root, definition, originalScan, nativeInventory) {
    let id, key, tree, inventory, total, expected
    try {
      if (!trusted) throw new Error('trusted-assets-unavailable')
      id = identity(root, definition)
      expected = baseline(id, definition)
      key = sha256(JSON.stringify(id))
      tree = storage.snapshot(root, resources, limits)
      inventory = nativeInventory()
      total = validateInventory(root, tree, inventory, expected)
      directory ??= storage.cacheDirectory(cacheDir, resources)
      let record = memory.get(key)
      if (!record) {
        try {
          reserve((eager ? total : 0) + Math.min(limits.maxManifestBytes, limits.maxMemoryBytes))
          record = storage.readEntry(directory, key, { ...limits, maxPackBytes: total }, eager)
        } catch { stats.failures++ }
      }
      if (record) {
        try {
          validate(record, id, tree, inventory, expected)
          if (!same(tree, storage.snapshot(root, resources, limits))) throw new Error('source-race')
          remember(key, record)
          stats.hits++
          return expose(key, record)
        } catch { drop(key); stats.failures++ }
      }
    } catch {
      if (key) drop(key)
      stats.fallbacks++
      return originalScan()
    }

    // Native scan errors must propagate, and must never trigger a second scan.
    const files = originalScan()
    try {
      if (files.length !== inventory.length) throw new Error('changed-scan')
      const largestAsset = tree.reduce((largest, [, kind, , , size]) => kind === 'f' ? Math.max(largest, Number(size)) : largest, 0)
      reserve(total + largestAsset + limits.maxManifestBytes)
      const pack = Buffer.alloc(total)
      const packedFiles = []
      let offset = 0
      for (let index = 0; index < files.length; index++) {
        const file = files[index], item = inventory[index]
        const pinned = expected.get(item.path)
        if (file.path !== item.path || file.mode !== item.mode || file.sourcePath !== item.sourcePath) throw new Error('changed-scan')
        if (file.sha256 !== pinned.sha256) throw new Error('unpinned-assets')
        const bytes = storage.boundedRead(file.sourcePath, limits.maxAssetBytes)
        if (bytes.length > pack.length - offset || bytes.length !== pinned.size || sha256(bytes) !== pinned.sha256) throw new Error('changed-asset')
        bytes.copy(pack, offset)
        packedFiles.push({ mode: file.mode, path: file.path, sha256: file.sha256, offset, size: bytes.length })
        offset += bytes.length
      }
      if (offset !== total || !same(tree, storage.snapshot(root, resources, limits))) throw new Error('source-race')
      const manifest = { identity: id, tree, files: packedFiles, packHash: sha256(pack) }
      const manifestBytes = Buffer.byteLength(JSON.stringify(manifest))
      if (manifestBytes > limits.maxManifestBytes || manifestBytes + pack.length > limits.maxMemoryBytes) throw new Error('memory-limit')
      storage.publish(directory, key, manifest, pack, limits)
      const record = { manifest, pack, packSize: pack.length, manifestBytes, expected }
      remember(key, record)
      stats.prepared++
      return expose(key, record)
    } catch {
      drop(key)
      stats.failures++
      stats.fallbacks++
      return files
    }
  }

  function readAsset(source, plugin, file) {
    if (source?.kind !== 'filesystem' || !file || typeof file !== 'object') return undefined
    const registration = registrations.get(file)
    const record = registration && memory.get(registration.key)
    if (!record || registration.token !== record.token) return undefined
    try {
      const id = identity(plugin.rootPath, plugin.definition)
      if (!same(id, record.manifest.identity)) return undefined
      const packed = record.manifest.files[registration.index]
      const pinned = record.expected.get(packed.path)
      const filename = path.join(id.root, ...packed.path.split('/'))
      if (!pinned || file.sourcePath !== filename || file.path !== packed.path || file.mode !== pinned.mode || file.sha256 !== pinned.sha256) return undefined
      function checkSource() {
        let relative = packed.path
        while (true) {
          const target = relative ? path.join(id.root, ...relative.split('/')) : id.root
          storage.physical(target)
          if (!same(storage.metadata(target), record.treeMap.get(relative))) throw new Error('stale-asset')
          if (!relative) break
          const slash = relative.lastIndexOf('/')
          relative = slash < 0 ? '' : relative.slice(0, slash)
        }
      }
      checkSource()
      let bytes = record.pack?.subarray(packed.offset, packed.offset + packed.size) ?? record.slices.get(registration.index)
      reserve(packed.size * (bytes ? 1 : 2), registration.key)
      if (!bytes) {
        bytes = storage.readSlice(record, packed.offset, packed.size, limits.maxAssetBytes)
        // Neither manifest.packHash nor its own file digests authorize bytes.
        if (bytes.length !== pinned.size || sha256(bytes) !== pinned.sha256) throw new Error('asset-integrity')
      }
      if (record.packFile) storage.checkPack(record)
      checkSource()
      if (!record.pack && !record.slices.has(registration.index)) {
        record.slices.set(registration.index, bytes)
        record.sliceBytes = (record.sliceBytes ?? 0) + bytes.length
        record.memoryBytes += bytes.length
        stats.memoryBytes += bytes.length
      }
      return Buffer.from(bytes)
    } catch {
      drop(registration.key)
      stats.failures++
      return undefined
    }
  }

  function prepareStatus(source) {
    if (source?.kind !== 'filesystem' || !source.plugins?.length) return PREPARE_STATUS.degraded
    return source.plugins.every(plugin => {
      if (plugin.missingSeedPaths?.length) return false
      try { return !!memory.get(sha256(JSON.stringify(identity(plugin.rootPath, plugin.definition))))?.pack } catch { return false }
    }) ? PREPARE_STATUS.ready : PREPARE_STATUS.degraded
  }

  function prepareReport(source) {
    const status = prepareStatus(source) === PREPARE_STATUS.ready ? 'prepared' : 'degraded'
    const records = [...memory.values()]
    const report = { version: 1, status, nativeSha256: cliHash, originalCli: original,
      counts: { roots: records.length, files: records.reduce((sum, record) => sum + record.manifest.files.length, 0),
        bytes: records.reduce((sum, record) => sum + record.packSize, 0) } }
    if (status !== 'prepared') return { ...report, reason: trusted ? 'cache-unavailable' : 'trusted-assets-unavailable' }
    try {
      storage.writeReadyMarker(cacheDir, report)
      return report
    } catch {
      return { ...report, status: 'degraded', reason: 'marker-unavailable' }
    }
  }

  return { catalogue, readAsset, prepareStatus, prepareReport, stats, limits, trustedAssetsAvailable: !!trusted }
}

module.exports = { createManagedPluginCache, DEFAULT_LIMITS }
