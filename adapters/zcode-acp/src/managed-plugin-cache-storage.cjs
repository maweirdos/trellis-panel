'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { sha256 } = require('./managed-cache-compat.cjs')

const STAT_FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink']
const ENTRY_NAME = /^[a-f0-9]{64}$/

function inside(parent, child) {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}

function metadata(filename) {
  return statMetadata(fs.lstatSync(filename, { bigint: true }))
}

function statMetadata(stat) {
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('unsupported-entry')
  return [stat.isDirectory() ? 'd' : 'f', ...STAT_FIELDS.map(key => String(stat[key]))]
}

function physical(filename) {
  // Callers supply realpathSync.native paths, including Windows short-name and
  // case expansion. For a new path, normalize its nearest existing ancestor
  // before appending the missing suffix. Reject redirects before any mkdir.
  const resolved = path.resolve(filename)
  if (fs.realpathSync.native(resolved) !== resolved) throw new Error('redirected-path')
  metadata(resolved)
  return resolved
}

function snapshot(root, resources, limits) {
  const entries = []
  let totalBytes = 0
  function append(filename, relative, depth) {
    if (entries.length >= limits.maxEntries || depth > limits.maxDepth) throw new Error('inventory-limit')
    const stat = metadata(filename)
    entries.push([relative, ...stat])
    if (stat[0] === 'f') {
      totalBytes += Number(stat[3])
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxSourceBytes) throw new Error('source-limit')
    } else {
      for (const name of fs.readdirSync(filename).sort()) append(path.join(filename, name), relative ? relative + '/' + name : name, depth + 1)
    }
  }
  // Also fence each ancestor; a junction above the plugin cannot redirect a hit.
  let ancestor = root
  while (ancestor !== resources) {
    physical(ancestor)
    ancestor = path.dirname(ancestor)
    if (!inside(resources, ancestor) && ancestor !== resources) throw new Error('outside-resources')
  }
  physical(resources)
  append(root, '', 0)
  return entries
}

function boundedRead(filename, maxBytes) {
  physical(filename)
  const before = metadata(filename)
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile() || stat.size > BigInt(maxBytes)) throw new Error('read-limit')
    const unchanged = current => current.every((value, index) => value === before[index])
    if (!unchanged(statMetadata(stat))) throw new Error('changed-read')
    const bytes = Buffer.alloc(Number(stat.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error('truncated-read')
      offset += count
    }
    if (!unchanged(statMetadata(fs.fstatSync(fd, { bigint: true })))) throw new Error('changed-read')
    physical(filename)
    if (!unchanged(metadata(filename))) throw new Error('changed-read')
    return bytes
  } finally {
    fs.closeSync(fd)
  }
}

function readEntry(directory, key, limits) {
  physical(directory)
  const entry = path.join(directory, key)
  physical(entry)
  const manifest = JSON.parse(boundedRead(path.join(entry, 'manifest.json'), limits.maxManifestBytes).toString('utf8'))
  const pack = boundedRead(path.join(entry, 'assets.bin'), Math.min(limits.maxPackBytes, limits.maxMemoryBytes))
  if (manifest.packHash !== sha256(pack)) throw new Error('pack-integrity')
  return { manifest, pack }
}

function cacheDirectory(cacheDir, resources) {
  if (!cacheDir || !path.isAbsolute(cacheDir)) throw new Error('cache-dir-required')
  // Never create a cache in the native installation.
  const install = path.dirname(resources)
  if (path.resolve(cacheDir) === install || inside(install, path.resolve(cacheDir))) throw new Error('cache-in-installation')
  let ancestor = path.resolve(cacheDir)
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
  physical(ancestor)
  fs.mkdirSync(cacheDir, { recursive: true })
  physical(cacheDir)
  const directory = path.join(cacheDir, 'managed-plugin-cache-v1')
  fs.mkdirSync(directory, { recursive: true })
  return physical(directory)
}

function writeReadyMarker(cacheDir, report) {
  physical(cacheDir)
  const marker = path.join(cacheDir, 'managed-zcode-ready.json')
  const stage = path.join(cacheDir, '.managed-zcode-ready-' + randomUUID() + '.tmp')
  try {
    fs.writeFileSync(stage, JSON.stringify(report) + '\n', { flag: 'wx', mode: 0o600 })
    fs.renameSync(stage, marker)
  } finally {
    fs.rmSync(stage, { force: true })
  }
}

// A global, non-waiting publication lock bounds all generations together. Readers
// see only complete renamed directories. Contention simply uses native scanning.
function publish(directory, key, manifest, pack, limits) {
  physical(directory)
  if (limits.maxDiskEntries < 1) throw new Error('disk-entry-limit')
  const encoded = Buffer.from(JSON.stringify(manifest))
  if (encoded.length > limits.maxManifestBytes || encoded.length + pack.length > limits.maxDiskBytes) throw new Error('disk-limit')
  const lock = path.join(directory, '.publish-lock')
  try {
    fs.mkdirSync(lock)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    physical(lock)
    // A crashed writer leaves no published half entry. Reclaim only expired locks.
    if (Date.now() - fs.lstatSync(lock).mtimeMs <= 300_000) throw new Error('publication-busy')
    fs.rmdirSync(lock)
    fs.mkdirSync(lock)
  }
  const stage = path.join(directory, '.' + key + '.' + randomUUID() + '.tmp')
  try {
    const entries = []
    let bytes = 0
    for (const name of fs.readdirSync(directory)) {
      if (name === '.publish-lock') continue
      if (!ENTRY_NAME.test(name) && !/^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/.test(name)) throw new Error('foreign-cache-entry')
      const target = physical(path.join(directory, name))
      let size = 0
      for (const file of fs.readdirSync(target)) {
        if (!['manifest.json', 'assets.bin'].includes(file)) throw new Error('foreign-cache-file')
        const stat = metadata(path.join(target, file))
        if (stat[0] !== 'f') throw new Error('foreign-cache-file')
        size += Number(stat[3])
      }
      entries.push({ name, target, size, time: fs.statSync(target).mtimeMs })
      bytes += size
      if (entries.length > limits.maxDiskEntries) throw new Error('disk-entry-limit')
    }
    // Temporary bytes count against the limit, including the replaced generation.
    let remainingEntries = entries.length
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (bytes + encoded.length + pack.length <= limits.maxDiskBytes && remainingEntries < limits.maxDiskEntries) break
      fs.rmSync(entry.target, { recursive: true, force: true })
      bytes -= entry.size
      remainingEntries--
    }
    if (bytes + encoded.length + pack.length > limits.maxDiskBytes) throw new Error('disk-limit')
    fs.mkdirSync(stage)
    fs.writeFileSync(path.join(stage, 'assets.bin'), pack, { flag: 'wx', mode: 0o600 })
    fs.writeFileSync(path.join(stage, 'manifest.json'), encoded, { flag: 'wx', mode: 0o600 })
    const target = path.join(directory, key)
    if (fs.existsSync(target)) fs.rmSync(physical(target), { recursive: true, force: true })
    fs.renameSync(stage, target)
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
    fs.rmdirSync(lock)
  }
}

module.exports = { inside, metadata, physical, snapshot, boundedRead, readEntry, cacheDirectory, publish, writeReadyMarker }
