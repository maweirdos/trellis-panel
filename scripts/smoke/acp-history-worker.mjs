/** Electron's Node runtime + production worker + actual asar unpack layout. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const request = createRequire(import.meta.url)
const { createPackageWithOptions } = request('@electron/asar')
const temporary = mkdtempSync(join(tmpdir(), 'trellis-history-worker-'))
try {
  const staging = join(temporary, 'staging')
  const main = join(staging, 'out', 'main')
  mkdirSync(main, { recursive: true })
  copyFileSync(resolve('out/main/history-worker.js'), join(main, 'history-worker.js'))
  const archive = join(temporary, 'resources', 'app.asar')
  mkdirSync(dirname(archive), { recursive: true })
  await createPackageWithOptions(staging, archive, { unpack: '*-worker.js' })
  assert.ok(existsSync(join(`${archive}.unpacked`, 'out', 'main', 'history-worker.js')), 'asar actually unpacked the production worker')
  // Simulate the bundled locator's __filename within app.asar; worker must resolve outside it.
  await build({ stdin: { contents: `export {neighborWorkerFile} from './src/main/services/worker-path'`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: join(temporary, 'locator.cjs'), bundle: true, platform: 'node', format: 'cjs',
    define: { __filename: JSON.stringify(join(archive, 'out', 'main', 'index.js')) }, logLevel: 'silent' })
  const probe = join(temporary, 'probe.cjs')
  writeFileSync(probe, `
    const assert=require('node:assert/strict');const {Worker}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');
    const {neighborWorkerFile}=require(${JSON.stringify(join(temporary, 'locator.cjs'))});
    const path=neighborWorkerFile('history-worker.js','HISTORY_PROBE_UNUSED');
    assert.ok(path.includes('app.asar.unpacked'));const db=new DatabaseSync(':memory:');db.close();
    const worker=new Worker(path);let seq=0;const pending=new Map();
    worker.on('message',m=>{const q=pending.get(m.requestId);if(q){clearTimeout(q.timer);pending.delete(m.requestId);m.ok?q.resolve(m.result):q.reject(new Error(m.error));}});
    worker.on('error',error=>{for(const q of pending.values())q.reject(error);});
    function call(op){return new Promise((resolve,reject)=>{const requestId=++seq;const timer=setTimeout(()=>reject(new Error('probe timeout')),5000);pending.set(requestId,{resolve,reject,timer});worker.postMessage({...op,requestId});})}
    (async()=>{const root=${JSON.stringify(join(temporary, 'project'))};
      await call({op:'init',directory:${JSON.stringify(join(temporary, 'data'))},sourceDirectory:${JSON.stringify(join(temporary, 'no-source'))}});
      await call({op:'append',items:[{root,record:{sessionId:'packaged-worker',projectRoot:root,startedAt:1,schemaVersion:2,status:'closed',events:[]},events:[{id:'first',ts:1,source:'acp',projectRoot:root,kind:'message',text:'exact worker bytes',payload:{role:'assistant'}}]}]});
      const page=await call({op:'events',root,sessionId:'packaged-worker',input:{}});assert.equal(page.events[0].text,'exact worker bytes');
      await call({op:'close'});await worker.terminate();console.log('PASS Electron node:sqlite and production history worker in real app.asar.unpacked layout');
    })().catch(async error=>{console.error(error);await worker.terminate();process.exitCode=1;});
  `)
  const result = spawnSync(request('electron'), [probe], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000, windowsHide: true })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()))
  assert.ok(basename(temporary).startsWith('trellis-history-worker-'))
  rmSync(temporary, { recursive: true, force: true })
}
