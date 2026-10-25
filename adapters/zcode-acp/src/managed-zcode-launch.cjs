#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { inspectCompatibility, transformVerifiedSource, PREPARE_STATUS } = require('./managed-cache-compat.cjs')

const MAX_CLI_BYTES = 32 * 1024 * 1024

function loadMain(filename, source, cache) {
  const main = new Module(filename, null)
  main.id = '.'
  main.filename = filename
  main.paths = Module._nodeModulePaths(path.dirname(filename))
  if (cache) Object.defineProperty(main, '__trellisManagedCache', { value: cache })
  require.main = main
  process.mainModule = main
  Module._cache[filename] = main
  try {
    main._compile(source, filename)
    main.loaded = true
    return main.exports
  } catch (error) {
    delete Module._cache[filename]
    throw error
  }
}

function launch(argv = process.argv.slice(2)) {
  const prepare = argv[0] === '--prepare'
  const input = argv[prepare ? 1 : 0]
  if (!input || (prepare && argv.length !== 2)) {
    process.stderr.write('Usage: node managed-zcode-launch.cjs [--prepare] <originalCli> [native args...]\n')
    process.exitCode = 1
    return
  }
  const inputPath = path.resolve(input)
  let filename
  try { filename = fs.realpathSync.native(inputPath) } catch (error) {
    if (!prepare) throw error
    process.stdout.write(JSON.stringify({ version: 1, status: 'degraded', originalCli: inputPath, reason: 'cli-unavailable' }) + '\n')
    process.exitCode = 1
    return
  }
  process.argv = [process.argv[0], inputPath, ...argv.slice(prepare ? 2 : 1)]
  let bytes, compatibility, transformed, cache, cacheReason = 'cache-dir-required'
  try {
    if (fs.statSync(filename).size <= MAX_CLI_BYTES) {
      bytes = fs.readFileSync(filename)
      compatibility = inspectCompatibility(bytes)
      if (compatibility.supported) {
        if (process.env.TRELLIS_ZCODE_STARTUP_CACHE_DIR) {
          try {
            const { createManagedPluginCache } = require('./managed-plugin-cache.cjs')
            cache = createManagedPluginCache({ originalCli: filename, cliHash: compatibility.hash, cacheDir: process.env.TRELLIS_ZCODE_STARTUP_CACHE_DIR, eager: prepare })
            if (cache.trustedAssetsAvailable) {
              transformed = transformVerifiedSource(bytes.toString('utf8'), prepare)
            } else cacheReason = 'trusted-assets-unavailable'
          } catch {
            cache = undefined
            cacheReason = 'cache-unavailable'
          }
        }
        // Correctness does not depend on optional cache code, paths or assets.
        if (!prepare && !transformed) transformed = transformVerifiedSource(bytes.toString('utf8'), false, { cache: false })
      }
    }
  } catch {
    // The optional optimization never replaces official launch errors or output.
    transformed = undefined
  }
  if (prepare && !transformed) {
    const status = compatibility?.supported ? PREPARE_STATUS.degraded : PREPARE_STATUS.unsupported
    process.stdout.write(JSON.stringify({ version: 1, status: status === PREPARE_STATUS.unsupported ? 'unsupported' : 'degraded', originalCli: filename,
      ...(compatibility ? { nativeSha256: compatibility.hash } : {}), reason: status === PREPARE_STATUS.unsupported ? 'unsupported-artifact' : cacheReason }) + '\n')
    process.exitCode = status
    return
  }
  if (!transformed) return Module._load(filename, null, true)
  if (!prepare) return loadMain(filename, transformed, cache)
  try {
    return loadMain(filename, transformed, cache)
  } catch {
    process.stdout.write(JSON.stringify({ version: 1, status: 'degraded', originalCli: filename, nativeSha256: compatibility.hash, reason: 'prepare-failed' }) + '\n')
    process.exitCode = 1
  }
}

if (require.main === module) launch()
module.exports = { launch, loadMain }
