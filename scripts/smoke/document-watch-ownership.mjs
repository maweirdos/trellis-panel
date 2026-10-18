/** Actual document IPC/bridge opaque-lease ownership regression; isolated files only. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const temporary = mkdtempSync(join(tmpdir(), 'trellis-document-leases-'))
process.env.TRELLIS_READER_SETTLE_MS = '20'
const roots = ['a', 'b'].map((name) => join(temporary, name))
for (const root of roots) { mkdirSync(root); writeFileSync(join(root, 'prd.md'), '# first') }
const handlers = new Map()
const events = []
globalThis.__DOCUMENT_LEASE_TEST__ = { root: roots[0], generation: 1, handlers, events }
const state = globalThis.__DOCUMENT_LEASE_TEST__
const mocked = {
  '../state': 'export const getProjectRoot=()=>globalThis.__DOCUMENT_LEASE_TEST__.root; export const getProjectGeneration=()=>globalThis.__DOCUMENT_LEASE_TEST__.generation;',
  './registry': 'export const handle=(channel,fn)=>globalThis.__DOCUMENT_LEASE_TEST__.handlers.set(channel,fn);',
  '../services/bridge': 'export const broadcastToWindows=(channel,payload)=>globalThis.__DOCUMENT_LEASE_TEST__.events.push({channel,payload});'
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate, label) => { for (let step=0;step<100;step++) { if (predicate()) return; await pause(10) } throw new Error(`Timeout: ${label}`) }
let bridge
try {
  await build({ stdin: { contents: `export {registerDocumentsIpc} from './src/main/ipc/documents'; export {clearReaderDocuments,routeReaderDocumentChange} from './src/main/services/documents/change-bridge';`, loader: 'ts', resolveDir: process.cwd() },
    bundle: true, format: 'esm', platform: 'node', outfile: join(temporary, 'leases.mjs'),
    plugins: [{ name: 'owned-ipc-context', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(mocked,args.path) ? {path:args.path,namespace:'lease-mock'} : undefined)
      builder.onLoad({filter:/.*/,namespace:'lease-mock'},(args)=>({contents:mocked[args.path],loader:'js'}))
    } }] })
  bridge = await import(pathToFileURL(join(temporary, 'leases.mjs')).href)
  bridge.registerDocumentsIpc()
  const ownerA = Object.assign(new EventEmitter(), { id: 1 })
  const ownerB = Object.assign(new EventEmitter(), { id: 2 })
  const invokeWatch = (sender=ownerA, scope={workspaceId:'namespace-only'}) => handlers.get('document:watch')({sender},scope,{relativePath:'prd.md',knownRevision:null})
  const release = (watch, sender=ownerA, watchId=watch.watchId) => handlers.get('document:unwatch')({sender},watch.canonicalPath,watchId)
  const notify = async (label) => {
    const before=events.length
    writeFileSync(join(roots[0],'prd.md'),`# ${label}`)
    bridge.routeReaderDocumentChange(join(roots[0],'prd.md'))
    await until(()=>events.length>before,label)
  }
  const oldA = invokeWatch()
  assert.equal(oldA.ok,true); assert.equal(typeof oldA.watchId,'string')
  bridge.clearReaderDocuments(); state.root=roots[1]; state.generation=2
  const interimB = invokeWatch(ownerB,{workspaceId:roots[0]})
  assert.equal(interimB.canonicalPath,join(roots[1],'prd.md'),'Wire scope is a namespace; main current root owns the lease')
  bridge.clearReaderDocuments(); state.root=roots[0]; state.generation=3
  const currentA=invokeWatch()
  const siblingA=invokeWatch(ownerB)
  assert.notEqual(currentA.watchId,oldA.watchId)
  release(oldA); release(oldA)
  handlers.get('document:unwatch')({sender:ownerA},oldA.canonicalPath)
  await notify('new A survives delayed old A acknowledgement and path-only cleanup')
  release(currentA); release(currentA)
  await notify('sibling survives repeated exact release of another lease')
  release(siblingA,ownerA)
  await notify('sender mismatch cannot release sibling lease')
  state.generation=99; release(siblingA,ownerB); state.generation=3
  await notify('project-generation mismatch cannot release current lease')
  state.root=roots[1]; release(siblingA,ownerB); state.root=roots[0]
  await notify('current-root mismatch cannot release current lease')
  handlers.get('document:unwatch')({sender:ownerB},interimB.canonicalPath,siblingA.watchId)
  await notify('path mismatch cannot consume live token')
  console.log('PASS actual IPC clear A-B-A, stale/duplicate/path-only/foreign owner-root-generation cleanup preserve live lease')

  const legacy=invokeWatch(ownerA)
  handlers.get('document:unwatch')({sender:ownerA},legacy.canonicalPath)
  release(siblingA,ownerB)
  await notify('legacy path-only reader remains safe until authoritative owner cleanup')
  const survivor=invokeWatch(ownerB)
  ownerA.emit('destroyed')
  await notify('another window lease survives destroyed legacy owner')
  release(survivor,ownerB)
  const beforeDestroyed=events.length
  bridge.routeReaderDocumentChange(join(roots[0],'prd.md'))
  await pause(60)
  assert.equal(events.length,beforeDestroyed,'Window destruction reclaims its legacy registrations')
  console.log('PASS window destruction reclaims legacy registrations without affecting unrelated owners')

  const beforeTimerWatch=invokeWatch(ownerB)
  const nativeTimeout=globalThis.setTimeout
  let oldTimerCallback
  globalThis.setTimeout=(callback,delay,...args)=>{if(delay===20)oldTimerCallback=callback;return nativeTimeout(callback,delay,...args)}
  try { bridge.routeReaderDocumentChange(beforeTimerWatch.canonicalPath) } finally { globalThis.setTimeout=nativeTimeout }
  assert.equal(typeof oldTimerCallback,'function')
  bridge.clearReaderDocuments(); state.generation=4
  const afterClear=invokeWatch(ownerB)
  const beforeStaleTimer=events.length
  oldTimerCallback()
  assert.equal(events.length,beforeStaleTimer,'A cleared entry timer cannot signal its replacement')
  await notify('new lease receives real change after stale timer')
  release(afterClear,ownerB); release(afterClear,ownerB)
  const beforeFinal=events.length
  bridge.routeReaderDocumentChange(afterClear.canonicalPath)
  await pause(60)
  assert.equal(events.length,beforeFinal)
  assert.equal(ownerB.listenerCount('destroyed'),1,'One cleanup listener per live sender')
  console.log('PASS stale timer entry identity, current registration updates and final duplicate release are safe')
} finally {
  bridge?.clearReaderDocuments()
  delete globalThis.__DOCUMENT_LEASE_TEST__
  rmSync(temporary,{recursive:true,force:true})
}
