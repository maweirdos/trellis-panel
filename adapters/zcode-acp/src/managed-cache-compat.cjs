'use strict'

const { createHash } = require('node:crypto')

const CLI_SHA256 = '97490d0f06a7a225d54d47817acf4b4859cdb268b59f2490caaeda982bef063a'
const PREPARE_STATUS = Object.freeze({ ready: 0, degraded: 1, unsupported: 2 })
const MOC = 'function Moc(e,t){let n=[],o=new Set([...Ioc,...t.runtimeTopLevelPaths??[]]);for(let i of aoi(e,o)){let a=uoi(i.slice(e.length+1));if(!Woc(a,o))continue;let c=(0,D0.readFileSync)(i);n.push({mode:yFn(a,(0,D0.statSync)(i).mode),path:a,sha256:vFn(c),sourcePath:i})}return n.sort((i,a)=>i.path.localeCompare(a.path))}'
const DFN = 'function dFn(e,t,n){if(e.kind==="filesystem"&&n.sourcePath)return(0,D0.readFileSync)(n.sourcePath);'
const ENTRY = 'bQe();mSc();async function mSc'
const CREATE = 'async function zhc(e,t,n,o){'
const SNAPSHOT = 'i.importedHistory&&(await Uhc({context:e,record:h,sessionId:c,createParams:i}),await h.app.resume(),h.stateRevision++);let O=Date.now(),U=await o(h),j=U.value;'
const HOOK_COMMAND = 'function ebo(e,t,n,o,i,a){switch(n.type){case"command":return async(c,u)=>{let f=await Oxn(c);try{let h=await e.executionPort.run({command:{mode:"shell",command:xbe(n.command,n.plugin,c,e.getWorkingDirectory()),shell:n.shell}'
const HOOK_RESOLVER = 'function hoe(e){let t=Cks(e.override);return t||(e.platform==="win32"?Aks(e):Pks(e))}'
const SHELL_STRING = 'function txs(e,t,n){return typeof e=="string"?e:n==="win32"?I4r(t,"ComSpec","win32")??"cmd.exe":!0}'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function hasUniqueAnchor(source, anchor) {
  const index = source.indexOf(anchor)
  return index >= 0 && source.indexOf(anchor, index + anchor.length) < 0
}

// This is deliberately a closed allowlist. No environment variable can enable
// an unreviewed artifact; fixtures exercise the transform separately.
function inspectCompatibility(bytes) {
  const hash = sha256(bytes)
  const source = bytes.toString('utf8')
  return { hash, supported: hash === CLI_SHA256 && [CREATE, SNAPSHOT, HOOK_COMMAND, HOOK_RESOLVER, SHELL_STRING].every(anchor => hasUniqueAnchor(source, anchor)),
    cacheSupported: hash === CLI_SHA256 && [MOC, DFN, ENTRY].every(anchor => hasUniqueAnchor(source, anchor)) }
}

function transformVerifiedSource(source, prepare = false, { cache = true } = {}) {
  const compatibility = inspectCompatibility(Buffer.from(source))
  if (!compatibility.supported) return undefined
  if (prepare) return cache && compatibility.cacheSupported ? transformAnchoredSource(source, true) : undefined
  const corrected = transformWindowsHookShellSource(transformEmptyPersistenceSource(source))
  return cache && compatibility.cacheSupported ? transformAnchoredSource(corrected) : corrected
}

// Keep native generic-shell execution: posix-bash would also enable costly shell
// snapshots. Resolve only SessionStart sync/context and UserPromptSubmit nudge
// without replacing their command, environment, port, or an explicit shell.
function transformWindowsHookShellSource(source) {
  if (!hasUniqueAnchor(source, HOOK_COMMAND)) return undefined
  const resolver = String.raw`function __trellisWindowsHookShell(t,n){if(process.platform==="win32"&&n.shell===void 0&&(t===Tl.SessionStart&&/^bash\s+(["'])\$HOME\/\.zcode\/hooks\/codegraph-(sync|context)\.sh\1$(?![\s\S])/.test(n.command)||t===Tl.UserPromptSubmit&&/^bash\s+(["'])\$HOME\/\.zcode\/hooks\/codegraph-nudge\.sh\1$(?![\s\S])/.test(n.command)))try{let e=hoe({env:process.env,platform:process.platform}).provider;if(e?.dialect==="git-bash"&&typeof e.file==="string"&&e.file.length>0)return e.file}catch{}return n.shell}`
  return source.replace(HOOK_COMMAND, resolver + HOOK_COMMAND.replace('shell:n.shell}', 'shell:__trellisWindowsHookShell(t,n)}'))
}

// Called only after the closed artifact check in production. Kept separate so
// fixtures can execute the same insertion without admitting another CLI hash.
function transformEmptyPersistenceSource(source) {
  if (![CREATE, SNAPSHOT].every(anchor => hasUniqueAnchor(source, anchor))) return undefined
  // Native persistence is idempotent for imported/already-persisted sessions.
  // Missing stores and failed writes must reach zhc's existing cleanup/rethrow;
  // neither may produce a successful creation snapshot.
  const persist = 'if(h.persistence==="immediate"){if(!h.app.runtime.sessionStore)throw new Error("Immediate session persistence requires a session store");await h.app.runtime.ensureSessionPersistedForExternalActivity("",{traceContext:h.traceContext});if(!h.app.runtime.sessionPersisted)throw new Error("Immediate session persistence did not complete")}'
  return source.replace(SNAPSHOT, SNAPSHOT.replace(';let O=', ';' + persist + 'let O='))
}

function transformAnchoredSource(source, prepare = false) {
  if (![MOC, DFN, ENTRY].every(anchor => hasUniqueAnchor(source, anchor))) return undefined
  // Inventory calls native traversal, filtering, mode normalization and sorting.
  // Coc and its per-copy SHA, locking and atomic replacement are untouched.
  const wrapper = 'var __trellisCache=module.__trellisManagedCache;function Moc(e,t){return __trellisCache.catalogue(e,t,()=>__trellisNativeMoc(e,t),()=>{let o=new Set([...Ioc,...t.runtimeTopLevelPaths??[]]),n=[];for(let i of aoi(e,o)){let a=uoi(i.slice(e.length+1));if(Woc(a,o))n.push({mode:yFn(a,(0,D0.statSync)(i).mode),path:a,sourcePath:i})}return n.sort((i,a)=>i.path.localeCompare(a.path))})}'
  let transformed = source.replace(MOC, wrapper + MOC.replace('function Moc(', 'function __trellisNativeMoc('))
    .replace(DFN, 'function dFn(e,t,n){return __trellisCache.readAsset(e,t,n)??__trellisNativeDFn(e,t,n)}' + DFN.replace('function dFn(', 'function __trellisNativeDFn('))
  if (prepare) {
    transformed = transformed.replace(ENTRY, 'bQe();hEt();{let s=module.__trellisManagedCache.prepareReport(Roc());process.stdout.write(JSON.stringify(s)+"\\n");process.exitCode=s.status==="prepared"?0:1}async function mSc')
  }
  return transformed
}

module.exports = { CLI_SHA256, PREPARE_STATUS, inspectCompatibility, transformVerifiedSource, transformAnchoredSource, transformEmptyPersistenceSource, transformWindowsHookShellSource, sha256 }
