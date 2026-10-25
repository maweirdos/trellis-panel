'use strict'

// Child-only fault injection; no installed file or bundled asset is changed.
const trust = require('../../src/managed-plugin-cache-trust.cjs')
trust.loadBundledTrustedAssets = () => { throw new Error('test-assets-unavailable') }
