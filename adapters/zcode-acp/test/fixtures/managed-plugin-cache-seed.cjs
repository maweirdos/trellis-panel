'use strict'

// Runs only native bundled-plugin seeding into this test's owned storage root.
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { transformVerifiedSource, CLI_SHA256, sha256 } = require('../../src/managed-cache-compat.cjs')
const { createManagedPluginCache } = require('../../src/managed-plugin-cache.cjs')
const { loadMain } = require('../../src/managed-zcode-launch.cjs')
const originalCli = fs.realpathSync.native(process.env.MANAGED_CACHE_TEST_CLI)
const source = fs.readFileSync(originalCli, 'utf8')
assert.equal(sha256(source), CLI_SHA256)
const transformed = transformVerifiedSource(source).replace('bQe();mSc();async function mSc',
  'bQe();hEt();{let d=Coc({storageRoot:process.env.MANAGED_CACHE_TEST_SEED_DIR});process.stdout.write(JSON.stringify({missing:d.length,stats:module.__trellisManagedCache.stats})+"\\n")}async function mSc')
assert.ok(!transformed.includes('bQe();mSc();async function mSc'))
const cache = createManagedPluginCache({ originalCli, cliHash: CLI_SHA256, cacheDir: process.env.TRELLIS_ZCODE_STARTUP_CACHE_DIR })
process.argv = [process.argv[0], originalCli]
loadMain(originalCli, transformed, cache)
