// Optional diagnostic preload for the owned, isolated startup benchmark only.
// Preserve every native fs/stdout argument, return value and exception.
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const crypto = require('node:crypto')

const target = process.env.TRELLIS_ZCODE_STARTUP_FS_FILE
const entry = process.env.TRELLIS_ZCODE_STARTUP_FS_BIN
if (target && entry && process.argv[2] === 'app-server' && path.resolve(process.argv[1]) === path.resolve(entry)) {
  const resourceRoot = path.dirname(path.dirname(path.resolve(entry))) + path.sep
  const packageRoot = path.dirname(path.resolve(entry)) + path.sep + 'packages' + path.sep
  const originalWrite = fs.writeFileSync
  const counters = { version: 1, sourceReadCalls: 0, sourceReadBytes: 0, sourceReadMs: 0,
    sourceReaddirCalls: 0, sourceReaddirMs: 0, sourceStatCalls: 0, sourceStatMs: 0,
    seedMetadataChecks: 0, seedMetadataReads: 0, seedMetadataWrites: 0,
    seedCopyWriteCalls: 0, seedCopyWriteBytes: 0, seedCopyWriteMs: 0,
    fileHashCalls: 0, fileHashBytes: 0, fileHashMs: 0,
    manifestHashCalls: 0, manifestHashBytes: 0, manifestHashMs: 0,
    seedVerificationHashCalls: 0, seedVerificationHashBytes: 0, seedVerificationHashMs: 0 }
  let firstSeedCheck
  const source = value => typeof value === 'string' && value.startsWith(resourceRoot) &&
    (value.startsWith(packageRoot) || value.slice(resourceRoot.length).split(path.sep)[0] !== path.basename(path.dirname(entry)))
  const seed = value => typeof value === 'string' && path.basename(value) === '.zcode-plugin-seed.json'
  const isolatedRoot = path.resolve(process.env.ZCODE_DATA_BASE_DIR || path.dirname(target)) + path.sep
  const seedCopy = value => typeof value === 'string' && value.startsWith(isolatedRoot) &&
    value.includes(`${path.sep}plugins${path.sep}cache${path.sep}`) && value.includes(`.tmp-${process.pid}-`)
  const byteLength = (value, encoding) => typeof value === 'string' ? Buffer.byteLength(value, encoding) : value?.byteLength ?? 0
  const originalCreateHash = crypto.createHash
  crypto.createHash = function (...args) {
    const hash = Reflect.apply(originalCreateHash, this, args)
    if (args[0] !== 'sha256') return hash
    // Installed bundle retains these diagnostic function names. Count only the
    // native plugin scanner, aggregate manifest, and seed copy verification.
    // Stack inspection adds overhead; wall latency from this probe is labelled
    // instrumented. No stack, path, input bytes or digest is retained.
    const stack = new Error().stack || ''
    const field = stack.includes('collectFilesystemPluginFiles') ? 'fileHash' :
      stack.includes('hashSeedFiles') ? 'manifestHash' : stack.includes('seedBundledOfficialPlugins') ? 'seedVerificationHash' : undefined
    if (!field) return hash
    const update = hash.update
    const digest = hash.digest
    hash.update = function (...values) {
      const began = performance.now()
      try {
        const result = Reflect.apply(update, this, values)
        counters[`${field}Bytes`] += byteLength(values[0], values[1])
        return result
      } finally { counters[`${field}Ms`] += performance.now() - began }
    }
    hash.digest = function (...values) {
      const began = performance.now()
      try { return Reflect.apply(digest, this, values) }
      finally { counters[`${field}Calls`]++; counters[`${field}Ms`] += performance.now() - began }
    }
    return hash
  }
  const originalExists = fs.existsSync
  fs.existsSync = function (...args) {
    if (seed(args[0])) {
      counters.seedMetadataChecks++
      firstSeedCheck ??= { sourceReadCalls: counters.sourceReadCalls, sourceReadBytes: counters.sourceReadBytes,
        sourceReaddirCalls: counters.sourceReaddirCalls, sourceReadMs: Math.round(counters.sourceReadMs),
        sourceReaddirMs: Math.round(counters.sourceReaddirMs), sourceStatMs: Math.round(counters.sourceStatMs) }
    }
    return Reflect.apply(originalExists, this, args)
  }
  for (const [method, field] of [['readFileSync', 'Read'], ['readdirSync', 'Readdir'], ['statSync', 'Stat']]) {
    const original = fs[method]
    fs[method] = function (...args) {
      if (method === 'readFileSync' && seed(args[0])) {
        counters.seedMetadataReads++
      }
      if (!source(args[0])) return Reflect.apply(original, this, args)
      const began = performance.now()
      try {
        const result = Reflect.apply(original, this, args)
        if (method === 'readFileSync') counters.sourceReadBytes += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength
        return result
      } finally {
        counters[`source${field}Calls`]++
        counters[`source${field}Ms`] += performance.now() - began
      }
    }
  }
  fs.writeFileSync = function (...args) {
    const copying = seedCopy(args[0])
    const began = performance.now()
    try {
      const result = Reflect.apply(originalWrite, this, args)
      if (seed(args[0])) counters.seedMetadataWrites++
      if (copying) { counters.seedCopyWriteCalls++; counters.seedCopyWriteBytes += byteLength(args[1], typeof args[2] === 'string' ? args[2] : args[2]?.encoding) }
      return result
    } finally { if (copying) counters.seedCopyWriteMs += performance.now() - began }
  }
  const flush = () => {
    const value = { ...counters, ...(firstSeedCheck ? { firstSeedCheck } : {}) }
    for (const key of Object.keys(value)) if (key.endsWith('Ms')) value[key] = Math.round(value[key])
    Reflect.apply(originalWrite, fs, [target, JSON.stringify(value), { mode: 0o600 }])
  }
  const originalOutput = process.stdout.write
  process.stdout.write = function (...args) {
    // Native NDJSON writes one complete response per call. Do not inspect or
    // retain any payload other than recognizing a session snapshot response.
    try {
      const chunk = args[0]
      if (typeof chunk === 'string' && chunk.length <= 1024 * 1024) {
        const frame = JSON.parse(chunk)
        if (frame.result?.session?.sessionId || frame.result?.eventSeq !== undefined) flush()
      }
    } catch { /* Observation failure cannot change the native transport. */ }
    return Reflect.apply(originalOutput, this, args)
  }
}
