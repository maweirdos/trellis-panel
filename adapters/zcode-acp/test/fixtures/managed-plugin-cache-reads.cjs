'use strict'

const fs = require('node:fs')
const path = require('node:path')
const native = { open: fs.openSync, read: fs.readSync, close: fs.closeSync, readFile: fs.readFileSync, writeFile: fs.writeFileSync }
const originalCli = fs.realpathSync.native(process.env.MANAGED_CACHE_TEST_CLI)
const resources = path.dirname(path.dirname(originalCli)) + path.sep
const counts = { sourceReadCalls: 0, sourceReadBytes: 0, packReadCalls: 0, packReadBytes: 0 }
const descriptors = new Map()
let readingFile = 0
function category(filename) {
  if (typeof filename !== 'string') return undefined
  if (filename.startsWith(resources) && filename !== originalCli) return 'source'
  if (filename.endsWith(path.sep + 'assets.bin')) return 'pack'
}
function count(kind, bytes) {
  if (!kind) return
  counts[kind + 'ReadCalls']++
  counts[kind + 'ReadBytes'] += bytes
}
fs.openSync = function (filename, ...args) {
  const fd = native.open.call(this, filename, ...args)
  const kind = category(filename)
  if (kind) descriptors.set(fd, kind)
  return fd
}
fs.readSync = function (fd, ...args) {
  const bytes = native.read.call(this, fd, ...args)
  if (!readingFile) count(descriptors.get(fd), bytes)
  return bytes
}
fs.closeSync = function (fd, ...args) { descriptors.delete(fd); return native.close.call(this, fd, ...args) }
fs.readFileSync = function (filename, ...args) {
  readingFile++
  try {
    const bytes = native.readFile.call(this, filename, ...args)
    count(category(filename), Buffer.byteLength(bytes))
    return bytes
  } finally { readingFile-- }
}
const flush = () => native.writeFile(process.env.MANAGED_CACHE_TEST_COUNTS, JSON.stringify(counts))
process.on('exit', flush)
const originalOutput = process.stdout.write
process.stdout.write = function (...args) {
  try {
    const chunk = args[0]
    if (typeof chunk === 'string' && chunk.length <= 1024 * 1024) {
      const frame = JSON.parse(chunk)
      if (frame.result?.session?.sessionId || frame.result?.eventSeq !== undefined) flush()
    }
  } catch { /* Observation cannot change any native frame or stream result. */ }
  return Reflect.apply(originalOutput, this, args)
}
