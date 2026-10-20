import { build } from 'esbuild'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'

export async function createRuntimeHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'tpanel-app-runtime-'))
  const project = join(directory, 'project with spaces')
  mkdirSync(project)
  const mock = join(directory, 'electron.mjs')
  writeFileSync(mock, `import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
const key=createHash('sha256').update('fixture-only-key').digest();
export const app={isPackaged:false,getPath:()=>${JSON.stringify(directory)}};
export const safeStorage={isEncryptionAvailable:()=>process.env.APP_RUNTIME_TEST_ENCRYPTION!=='off',encryptString(value){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body])},decryptString(value){const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8')}};`)
  const entry = join(directory, 'entry.ts')
  const source = (path) => JSON.stringify(resolve(path))
  writeFileSync(entry, `export * from ${source('src/main/services/app-runtime/index.ts')};
export * from ${source('src/main/services/app-runtime/lib/env.ts')};
export * from ${source('src/main/services/app-runtime/lib/output.ts')};
export * from ${source('src/main/services/app-runtime/lib/ports.ts')};
export * from ${source('src/main/services/app-runtime/lib/process-tree.ts')};
export * from ${source('src/main/services/app-runtime/lib/persistence.ts')};
export * from ${source('src/shared/app-runtime.ts')};`)
  const bundle = join(directory, 'runtime.mjs')
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', alias: { electron: mock }, banner: { js: "import { createRequire } from 'node:module';const require=createRequire(import.meta.url);" }, logLevel: 'silent' })
  const api = await import(pathToFileURL(bundle).href)
  const runtime = new api.ApplicationRuntime()
  return { directory, project, api, runtime, async close() { await runtime.shutdown(); const absolute = resolve(directory); if (!absolute.startsWith(resolve(tmpdir()) + '\\') && !absolute.startsWith(resolve(tmpdir()) + '/')) throw new Error('Fixture cleanup fence failed'); rmSync(directory, { recursive: true, force: true }) } }
}
export async function freePort() { const server = createServer(); await new Promise((accept) => server.listen(0, '127.0.0.1', accept)); const port = server.address().port; await new Promise((accept) => server.close(accept)); return port }
export async function until(fn, timeout = 15000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await fn()) return; await new Promise((accept) => setTimeout(accept, 80)) } throw new Error('Timed out waiting for fixture state') }
export function createService(project) {
  const file = join(project, 'service.mjs')
  writeFileSync(file, `import {createServer} from 'node:http';import {spawn} from 'node:child_process';
if(process.env.RUNTIME_CHILD==='enabled'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.on('SIGTERM',()=>{});child.on('error',()=>process.exit(9));}
const server=createServer((req,res)=>{res.end(JSON.stringify({value:process.env.FIXTURE_VALUE,override:process.env.FIXTURE_OVERRIDE,pid:process.pid}))});
setTimeout(()=>server.listen(Number(process.env.RUNTIME_PORT),'127.0.0.1',()=>{console.log('fixture service listening'); if(process.env.RUNTIME_OUTPUT==='flood') process.stdout.write('x'.repeat(400000));}),Number(process.env.RUNTIME_DELAY||0));
setInterval(()=>{},1000);`)
  return file
}
