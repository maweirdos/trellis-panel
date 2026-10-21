/** Actual immutable material/driver/control code. Native messages in the fast cases are explicit fixtures. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { prepareAcpHistoryWorker } from './prepare-acp-history-worker.mjs'

const temporary = mkdtempSync(join(tmpdir(), 'trellis-workflow-engine-'))
const results = []; const cores = []; let facade
const digest = (value) => createHash('sha256').update(value).digest('hex')
const asset = (id) => ({ assetId: id, version: 'v1', digest: digest(id) })
const source = (name) => resolve(name).replace(/\\/g, '/')
const check = async (name, work) => { await work(); results.push({ name, status: 'passed' }) }
process.env.TPAP_SMOKE_DIR = temporary
await prepareAcpHistoryWorker(temporary)
const bundle = join(temporary, 'engine.mjs')
await build({ stdin: { contents: `export * from '${source('src/main/services/workflow-runtime/index.ts')}';
  export * from '${source('src/shared/workflow/index.ts')}';
  export {WorkflowControlCore} from '${source('src/main/services/workflow-control/core.ts')}';
  export {readDocument,computeRevision} from '${source('src/main/services/documents/controller.ts')}';
  export * as facade from '${source('src/main/services/acp.ts')}';`, loader: 'ts', resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', alias: { electron: resolve('scripts/smoke/mock-electron.mjs') },
  banner: { js: "import {createRequire as smokeRequire} from 'node:module';const require=smokeRequire(import.meta.url);" }, outfile: bundle, logLevel: 'silent' })
const api = await import(pathToFileURL(bundle).href); facade = api.facade
const root = join(temporary, 'workspace')
for (const task of ['task-a','task-b']) {
  mkdirSync(join(root,'.trellis','tasks',task),{recursive:true})
  writeFileSync(join(root,'.trellis','tasks',task,'task.json'),JSON.stringify({id:task,status:'planning'}))
}
const scope = { projectId:'project-a',repositoryId:'repo-a',workspaceId:'workspace-a',taskRef:'task:task-a' }
const projectOwner = {...scope,taskRef:null}
const store = new api.WorkflowMaterialStore({directory:join(temporary,'materials')})
const path = '.trellis/tasks/task-a/prd.md'
writeFileSync(join(root,path),'\uFEFF# Requirement A\r\n客户字段🙂\r\n')
let savedA

function fakeAcp(scenario='pass') {
  const sessions=new Map();let sequence=0;let prompts=0;let creates=0;let cancellations=0;let shutdowns=0
  let releaseCreate;let creationEntered
  const creationStarted=new Promise(resolve=>{creationEntered=resolve})
  const creationGate=new Promise(resolve=>{releaseCreate=resolve})
  const records=[]
  const emit=(session,kind,text,payload)=>{
    const event={id:'fixture-'+randomUUID(),ts:Date.now(),source:'acp',sessionId:session.sessionId,projectRoot:root,taskDir:session.taskDir,connectionGeneration:session.connectionGeneration,turnId:session.turnId,kind,text,payload}
    records.push({...event,historySeq:++sequence});api.publishWorkflowAcpEvent(event);return event
  }
  const port={
    create:async(_root,input)=>{creates++;const id='fixture-session-'+creates;sessions.set(id,{sessionId:id,agentId:input.agentId,agentName:'owned fixture',taskDir:input.taskDir,projectRoot:root,status:'ready',startedAt:Date.now(),connectionGeneration:'generation-'+creates});creationEntered();if(scenario.startsWith('deferred-create'))await creationGate;return{ok:true,sessionId:id}},
    list:()=>({ok:true,sessions:[...sessions.values()].map(s=>({...s,events:[]}))}),
    get:async(_root,id)=>sessions.has(id)?{ok:true,session:sessions.get(id)}:{ok:false,code:'E_NOT_FOUND',error:'missing fixture session'},
    prompt:async(_root,id,text,options,prepared)=>{
      const session=sessions.get(id);assert.ok(session);prepared.assertActive();prompts++;session.status='busy';session.turnId='fixture-turn-'+prompts
      const identity={sessionId:id,turnId:session.turnId,connectionGeneration:session.connectionGeneration}
      prepared.onAdmitted?.(identity);prepared.onPromptWritten?.(identity)
      session.lastPacket=prepared.materials.text
      setTimeout(()=>{
        if(scenario==='failed-side-effect')writeFileSync(join(root,'fixture-side-effect.txt'),'effect occurred')
        const textResult=scenario==='repair'&&prompts===1?'bad-json':'{"ok":true}'
        if(scenario!=='repair'||prompts>1){writeFileSync(join(root,'.trellis','tasks',session.taskDir,'design.md'),'# Fixture design\nVerified output\n')}
        emit(session,'message',textResult,{messageId:'answer-'+prompts})
        session.status='ready'
        if(scenario==='background')session.directoryLeaseReason='Owned fixture reported unfinished background tool'
        emit(session,'turn-done','fixture completed',{result:{status:scenario==='failed-side-effect'?'failed':'completed',stopReason:'end_turn'}})
      },15)
      return{ok:true,turnId:session.turnId}
    },
    cancel:async()=>{cancellations++;return{ok:true}},end:async(_root,id)=>{shutdowns++;if(scenario==='deferred-create-unknown'||scenario==='shutdown-unknown')return{ok:false,code:'E_FIXTURE_STOP',error:'Owned shutdown not confirmed'};const s=sessions.get(id);if(s)s.status='closed';return{ok:true}},resume:async(_root,id)=>({ok:true,sessionId:id}),
    observe:api.observeWorkflowAcp,flushHistory:async()=>{},persistence:()=>({state:scenario==='history-degraded'?'degraded':'saved',pendingCount:0,committedThroughEventId:records.at(-1)?.id??null,committedThroughSeq:sequence}),
    historyEvents:async()=>({ok:true,events:records,historyPersistence:port.persistence()})
  }
  return{port,sessions,creationStarted,releaseCreate,get prompts(){return prompts},get creates(){return creates},get cancellations(){return cancellations},get shutdowns(){return shutdowns}}
}
async function harness({scenario='pass',task='task-a',maxRepairTurns=0,shared}={}) {
  const localScope={...scope,taskRef:'task:'+task}
  const runtime=join(temporary,'control-'+randomUUID());const core=shared?.core??new api.WorkflowControlCore(runtime);if(!shared){core.open();cores.push(core)}
  const claimed=core.claimWorkspace({scope:localScope,ownerId:'test-owner',ttlMs:300000});assert.equal(claimed.status,'acquired');const owner=claimed.lease.owner
  const context=await api.prepareWorkflowContext(store,{scope:localScope,instruction:'Generate the declared design output for this isolated fixture.',inputs:{},selections:[],engineeringBaseline:asset('baseline'),outputContract:asset('output'),budgetBytes:16000})
  const executor={bindingId:'fixture-binding',engineId:'fixture',engineVersion:'1',adapterVersion:'1',configuration:asset('engine-config'),capabilities:{}}
  const definition={contractVersion:1,ref:{definitionId:'flow-a',revision:1},flow:{version:1,id:'flow-a',name:'Fixture',description:'',inputs:[],phases:[{id:'plan',name:'Plan',steps:[{id:'generate',name:'Generate design',kind:'agent',instruction:context.instruction}]}]},defaultExecutor:executor,nodeBindings:[],trellisPhases:{plan:'plan'}}
  const compiled=await api.compileWorkflowDefinition(definition,context.manifest,digest)
  const run={runId:'run-'+randomUUID(),revision:1};const operationId='operation-'+randomUUID()
  const manifest={contractVersion:1,scope:localScope,run,definition:definition.ref,roles:[],executors:[executor],extensions:[],context:context.manifest,inputFingerprint:compiled.inputFingerprint,recordedAt:Date.now()}
  const payload={purpose:'owned stage fixture'}
  const command={contractVersion:1,commandId:'command-'+randomUUID(),scope:localScope,runId:run.runId,expectedRevision:1,kind:'start',payload,payloadDigest:digest(api.canonicalWorkflowJson(payload)),requestedAt:Date.now()}
  const admission=await core.commitWithManifests({journal:{command,owner,expectedCurrent:null,runChanges:[{contractVersion:1,scope:localScope,run,definition:definition.ref,state:'queued',predecessor:null,createdAt:Date.now()}],events:[],outbox:[{operationId,commandId:command.commandId,scope:localScope,run,state:'pending',ownerId:owner.ownerId,fencingToken:owner.fencingToken,result:null}]},manifests:[manifest]})
  assert.equal(admission.status,'committed',JSON.stringify(admission));assert.ok(core.getOperation(localScope,operationId),'fixture outbox was actually persisted')
  const control={getOperation:async(...a)=>core.getOperation(...a),claimOperation:async(...a)=>core.claimOperation(...a),settleOperation:async(...a)=>core.settleOperation(...a),reconcileOperation:async(...a)=>core.reconcileOperation(...a),append:async(...a)=>core.append(...a),recordStep:async(...a)=>core.recordStep(...a),renewWorkspace:async(s,o,ttl)=>core.renewWorkspace({scope:s,ownerId:o.ownerId,ttlMs:ttl},o)}
  const fake=shared?.fake??fakeAcp(scenario)
  const plan={projectRoot:root,taskDir:task,context,executor:{agentId:'fixture',verified:executor},output:{contract:asset('output'),files:[{relativePath:`.trellis/tasks/${task}/design.md`,kind:'design',required:true}],maxRepairTurns,validateText:(text)=>{try{return{ok:JSON.parse(text).ok===true}}catch{return{ok:false,reason:'Expected JSON result'}}}},assertCurrent:()=>{}}
  const request={operationId,owner,manifest,step:{...run,nodeId:compiled.plan.nodes[0].nodeId,attempt:1},node:compiled.plan.nodes[0],executorBindingId:executor.bindingId}
  const plans=shared?.plans??new Map();plans.set(operationId,plan)
  const driver=shared?.driver??new api.AcpxWorkflowDriver({acp:fake.port,control,materials:store,resolve:async(request)=>plans.get(request.operationId),startupTimeoutMs:2000,turnTimeoutMs:5000})
  return{driver,request,core,fake,plan,control,plans}
}

try {
  await check('Main-owned successful read pins original A after disk changes to B, including BOM/CRLF',async()=>{
    const read=await api.readDocument(root,{workspaceId:scope.workspaceId},{relativePath:path,requestId:'read-A'})
    assert.equal(read.ok,true,JSON.stringify(read));const original=readFileSync(join(root,path));writeFileSync(join(root,path),'# Disk B')
    savedA=await store.captureDocumentRead({projectRoot:root,owner:projectOwner,read,kind:'trellis-prd'})
    assert.equal(savedA.bodyDigest,digest(original));assert.equal(savedA.text,original.toString('utf8'))
    assert.equal((await store.readVersion(projectOwner,savedA.ref)).text,original.toString('utf8'))
  })
  await check('Project-only materials do not invent task refs and foreign scopes cannot read snapshots',async()=>{
    assert.equal(savedA.owner.taskRef,null)
    await assert.rejects(store.readVersion({...projectOwner,projectId:'foreign'},savedA.ref),e=>e.code==='SCOPE_CHANGED')
    await assert.rejects(store.captureFile({projectRoot:root,owner:scope,relativePath:path,kind:'trellis-prd',expectedRevision:'0'.repeat(16)}),e=>e.code==='MATERIAL_CHANGED')
  })
  await check('Immutable source/version refuses changed bytes and preserves first record',async()=>{
    const input={owner:scope,source:{kind:'published',publicationId:'confirmed-doc'},kind:'product-requirement',text:'Version A',version:'v1'}
    const first=await store.captureText(input)
    await assert.rejects(store.captureText({...input,text:'Version B'}),e=>e.code==='MATERIAL_CHANGED')
    assert.equal((await store.readVersion(scope,first.ref)).text,'Version A')
    await assert.rejects(store.captureText({...input,text:'bad\uD800',version:'v2'}),e=>e.code==='INVALID_INPUT')
  })
  await check('Missing/corrupted snapshots and root-escaping links fail without replacing old records',async()=>{
    const material=await store.captureText({owner:scope,source:{kind:'published',publicationId:'corrupt-only'},kind:'other',text:'original tamper fixture'})
    writeFileSync(join(temporary,'materials','blobs',material.bodyDigest+'.blob'),'tampered')
    await assert.rejects(store.readVersion(scope,material.ref),e=>e.code==='STORE_CORRUPTED')
    await assert.rejects(store.captureText({owner:scope,source:{kind:'published',publicationId:'corrupt-only'},kind:'other',text:'original tamper fixture'}),e=>e.code==='STORE_CORRUPTED')
    const outside=join(temporary,'outside');mkdirSync(outside);writeFileSync(join(outside,'secret.md'),'outside root')
    symlinkSync(outside,join(root,'escape'),process.platform==='win32'?'junction':'dir')
    await assert.rejects(store.captureFile({projectRoot:root,owner:projectOwner,relativePath:'escape/secret.md',kind:'other'}),e=>e.code==='MATERIAL_UNAVAILABLE')
  })
  await check('Context deduplicates selected versions and rejects foreign task or feedback without baseline',async()=>{
    const selection={owner:projectOwner,ref:savedA.ref,purpose:'baseline',reason:'effective requirement'}
    const input={scope,instruction:'Inspect current requirement.',inputs:{},selections:[selection,selection],engineeringBaseline:asset('baseline'),outputContract:asset('output'),budgetBytes:8000}
    const prepared=await api.prepareWorkflowContext(store,input)
    assert.equal(prepared.manifest.materials.length,1);assert.equal(prepared.manifest.complete,false);assert.equal(prepared.additionalInputs,'unobserved')
    await assert.rejects(api.prepareWorkflowContext(store,{...input,selections:[{...selection,purpose:'delta'}]}),e=>e.code==='MISSING_BASELINE')
    await assert.rejects(api.prepareWorkflowContext(store,{...input,selections:[{...selection,owner:{...scope,taskRef:'foreign'}}]}),e=>e.code==='SCOPE_CHANGED')
  })
  await check('Serialized UTF-8 context budget includes escaping and never cuts Unicode codepoints',async()=>{
    const material=await store.captureText({owner:scope,source:{kind:'published',publicationId:'long-doc'},kind:'product-requirement',text:'🙂"\\\n'.repeat(4000)})
    const prepared=await api.prepareWorkflowContext(store,{scope,instruction:'Read a bounded excerpt.',inputs:{},selections:[{owner:scope,ref:material.ref,purpose:'baseline',reason:'budget fixture'}],engineeringBaseline:null,outputContract:asset('out'),budgetBytes:3000})
    assert.ok(prepared.promptBytes<=3000);assert.equal(prepared.manifest.materials[0].inclusion,'truncated');assert.ok(!prepared.materials.text.includes('\uFFFD'))
    assert.equal(prepared.manifest.materials[0].includedDigest,digest(JSON.parse(prepared.materials.text.split('\n')[3]).entries[0].text))
  })
  await check('Dedup retains required content and baseline semantics regardless of selection order',async()=>{
    const material=await store.captureText({owner:scope,source:{kind:'published',publicationId:'dedup-stronger-required'},kind:'spec',text:'Important source'.repeat(300)})
    const input={scope,instruction:'x'.repeat(500),inputs:{},selections:[
      {owner:scope,ref:material.ref,purpose:'spec',reason:'Optional first',required:false},
      {owner:scope,ref:material.ref,purpose:'other',reason:'Required later',required:true}
    ],engineeringBaseline:null,outputContract:asset('out'),budgetBytes:1024}
    await assert.rejects(api.prepareWorkflowContext(store,input),e=>e.code==='CAPACITY_EXCEEDED')
    await assert.rejects(api.prepareWorkflowContext(store,{...input,selections:[...input.selections].reverse()}),e=>e.code==='CAPACITY_EXCEEDED')
    const prepared=await api.prepareWorkflowContext(store,{...input,instruction:'Apply relevant feedback to the effective baseline.',budgetBytes:16000,selections:[
      {...input.selections[0],required:true},{...input.selections[1],purpose:'baseline'},
      {...input.selections[1],purpose:'delta'}
    ]})
    assert.equal(prepared.manifest.materials.length,1);assert.equal(prepared.packetRefs.length,1)
    assert.equal(prepared.manifest.materials[0].inclusion,'full')
  })
  await check('Observer root/session/generation, clone and callback failures never mutate the source event',async()=>{
    const original={id:'event',ts:1,source:'acp',sessionId:'owned',projectRoot:root,connectionGeneration:'current',kind:'diagnostic',text:'source'};let count=0
    const observer={scope:{projectRoot:root,sessionId:'owned',connectionGeneration:'current'},event:(e)=>{count++;e.text='mutated';throw new Error('fixture callback')}}
    const stop=api.observeWorkflowAcp(observer);observer.scope.projectRoot=null
    assert.equal(api.publishWorkflowAcpEvent({...original,connectionGeneration:'old'}).length,0);assert.equal(count,0)
    assert.equal(api.publishWorkflowAcpEvent(original).length,1);assert.equal(original.text,'source')
    assert.equal(api.publishWorkflowAcpEvent({...original,payload:{notCloneable:()=>{}}}).length,1);assert.equal(count,1);stop()
  })
  await check('Official native session pointer binding preserves planning status and foreign pointers',async()=>{
    const scripts=join(root,'.trellis','scripts');assert.ok(resolve(scripts).startsWith(resolve(temporary)+sep))
    cpSync(resolve('.trellis/scripts'),scripts,{recursive:true})
    const before=readFileSync(join(root,'.trellis/tasks/task-a/task.json'),'utf8')
    const bound=await api.bindNativeTrellisTask({projectRoot:root,taskDir:'task-a',platform:'codex',nativeSessionId:'actual-fixture-native-id',allowBinding:true})
    assert.equal(bound.status,'bound');assert.equal(bound.hookInjection,'unobserved')
    assert.equal(readFileSync(join(root,'.trellis/tasks/task-a/task.json'),'utf8'),before)
    assert.equal((await api.bindNativeTrellisTask({projectRoot:root,taskDir:'task-b',platform:'codex',nativeSessionId:'actual-fixture-native-id',allowBinding:true})).status,'conflict')
    assert.equal((await api.bindNativeTrellisTask({projectRoot:root,taskDir:'task-a',platform:'codex',allowBinding:true})).status,'unavailable')
  })
  await check('Actual file control intent precedes native dispatch; output snapshot and exact history link are recorded',async()=>{
    const h=await harness();const ack=await h.driver.dispatch(h.request);assert.equal(ack.status,'accepted');const result=await h.driver.result(h.request.operationId)
    assert.equal(result.status,'passed');assert.equal(result.outputs.length,1);assert.equal(result.historyCommitted,true)
    assert.equal(h.core.getOperation(scope,h.request.operationId).operation.state,'confirmed')
    const events=h.core.events({scope,cursor:null,limit:200}).items.map(x=>x.event)
    assert.ok(events.some(x=>x.type==='workflow.context-assembled')||h.request.manifest.context.materials.length===0)
    assert.ok(events.some(x=>x.type==='workflow.native-event'));assert.ok(events.every(x=>!JSON.stringify(x.payload).includes('{"ok":true}')),'no assistant transcript copied into control events')
  })
  await check('Concurrent duplicate dispatch calls create one native session and prompt',async()=>{
    const h=await harness();await Promise.all([h.driver.dispatch(h.request),h.driver.dispatch(h.request)]);assert.equal((await h.driver.result(h.request.operationId)).status,'passed');assert.equal(h.fake.prompts,1);assert.equal(h.fake.creates,1)
  })
  await check('Stop during in-flight creation stays unconfirmed until late native identity is canonically shut down',async()=>{
    const h=await harness({scenario:'deferred-create'});const dispatch=h.driver.dispatch(h.request)
    await h.fake.creationStarted
    const stop=await h.driver.requestStop({operationId:h.request.operationId,scope:h.request.manifest.scope,run:h.request.manifest.run,owner:h.request.owner})
    assert.equal(stop.status,'unconfirmed');assert.equal(h.fake.sessions.get('fixture-session-1').status,'ready')
    assert.equal(h.core.getOperation(scope,h.request.operationId).operation.state,'dispatched','ownership stays live until actual creation resolves')
    h.fake.releaseCreate();await dispatch;const result=await h.driver.result(h.request.operationId)
    assert.equal(result.status,'cancelled');assert.equal(result.sessionId,'fixture-session-1');assert.equal(h.fake.sessions.get(result.sessionId).status,'closed');assert.equal(h.fake.prompts,0)
    assert.equal(h.core.getOperation(scope,h.request.operationId).operation.state,'confirmed')
  })
  await check('A truly pre-creation stop prevents native admission',async()=>{
    const h=await harness();const dispatch=h.driver.dispatch(h.request)
    assert.equal((await h.driver.requestStop({operationId:h.request.operationId,scope:h.request.manifest.scope,run:h.request.manifest.run,owner:h.request.owner})).status,'stopped')
    await dispatch;assert.equal((await h.driver.result(h.request.operationId)).status,'cancelled');assert.equal(h.fake.creates,0);assert.equal(h.fake.prompts,0)
  })
  await check('Failed shutdown after late creation remains unknown and never sends a prompt',async()=>{
    const h=await harness({scenario:'deferred-create-unknown'});const dispatch=h.driver.dispatch(h.request);await h.fake.creationStarted
    assert.equal((await h.driver.requestStop({operationId:h.request.operationId,scope:h.request.manifest.scope,run:h.request.manifest.run,owner:h.request.owner})).status,'unconfirmed')
    h.fake.releaseCreate();await dispatch;const result=await h.driver.result(h.request.operationId)
    assert.equal(result.status,'outcome-unknown');assert.equal(h.fake.sessions.get(result.sessionId).status,'ready');assert.equal(h.fake.prompts,0)
    assert.equal(h.core.getOperation(scope,h.request.operationId).operation.state,'outcome-unknown')
    assert.equal(h.fake.shutdowns,1,'Late-create, stop and error paths join the same canonical shutdown')
  })
  await check('Stop accepted during actual output capture wins and concurrent requests share canonical cleanup',async()=>{
    for(const scenario of ['pass','shutdown-unknown']){
      const h=await harness({scenario});const original=store.captureFile.bind(store);let entered;let release
      const started=new Promise(resolve=>{entered=resolve});const gate=new Promise(resolve=>{release=resolve})
      store.captureFile=async input=>{if(input.kind==='design'){entered();await gate}return original(input)}
      try{
        await h.driver.dispatch(h.request);await started
        const stopRequest={operationId:h.request.operationId,scope,run:h.request.manifest.run,owner:h.request.owner}
        assert.equal((await h.driver.requestStop({...stopRequest,owner:{...h.request.owner,fencingToken:h.request.owner.fencingToken+1}})).status,'rejected')
        assert.equal(h.fake.shutdowns,0,'A foreign fence cannot stop the live owned stage')
        const stops=await Promise.all([h.driver.requestStop(stopRequest),h.driver.requestStop(stopRequest)])
        assert.ok(stops.every(s=>s.status===(scenario==='pass'?'stopped':'unconfirmed')))
        release();const result=await h.driver.result(h.request.operationId)
        assert.equal(result.status,scenario==='pass'?'cancelled':'outcome-unknown')
        assert.equal(result.outputs.length,1,'Already observed output remains readable evidence')
        assert.equal(h.core.steps(scope,h.request.manifest.run)[0].state,result.status)
        assert.equal(h.core.getOperation(scope,h.request.operationId).operation.state,scenario==='pass'?'confirmed':'outcome-unknown')
        assert.equal(h.fake.cancellations,1);assert.equal(h.fake.shutdowns,1);assert.equal(h.fake.prompts,1)
      }finally{release?.();store.captureFile=original}
    }
  })
  await check('Stop after synchronous finalization boundary rejects before awaited durable final writes',async()=>{
    const h=await harness();const original=h.control.append;let entered;let release
    const started=new Promise(resolve=>{entered=resolve});const gate=new Promise(resolve=>{release=resolve})
    h.control.append=async report=>{if(report.event.type==='workflow.driver-result'){entered();await gate}return original(report)}
    try{
      await h.driver.dispatch(h.request);await started
      assert.equal(h.core.getOperation(scope,h.request.operationId).operation.state,'dispatched','Final writes have not been acknowledged yet')
      const stop=await h.driver.requestStop({operationId:h.request.operationId,scope,run:h.request.manifest.run,owner:h.request.owner})
      assert.equal(stop.status,'rejected');assert.deepEqual(stop.evidenceRefs,['already-settling'])
      assert.equal(h.fake.cancellations,0);assert.equal(h.fake.shutdowns,0)
      release();assert.equal((await h.driver.result(h.request.operationId)).status,'passed')
    }finally{release?.();h.control.append=original}
  })
  await check('Failure after final result freeze remains unknown without competing final writes or native replay',async()=>{
    const h=await harness();h.control.recordStep=async()=>{throw new Error('Owned final-step acknowledgement outage')}
    await h.driver.dispatch(h.request);const result=await h.driver.result(h.request.operationId)
    assert.equal(result.status,'outcome-unknown');assert.equal(h.fake.prompts,1);assert.equal(h.fake.shutdowns,0)
    const reports=h.core.events({scope,cursor:null,limit:200}).items.filter(x=>x.event.type==='workflow.driver-result')
    assert.equal(reports.length,1,'The frozen final result is not rewritten as a second guessed result')
    assert.equal(h.core.getOperation(scope,h.request.operationId).operation.state,'dispatched','Reconciliation owns missing durable acknowledgement')
    assert.deepEqual((await h.driver.requestStop({operationId:h.request.operationId,scope,run:h.request.manifest.run,owner:h.request.owner})).evidenceRefs,['already-settling'])
  })
  await check('One role serving two tasks keeps distinct native sessions and source histories',async()=>{
    const first=await harness();await first.driver.dispatch(first.request);const resultA=await first.driver.result(first.request.operationId);assert.equal(resultA.status,'passed')
    const run=(await first.core.head(scope)).run;const payload={reason:'The sole fixture stage passed; coordinator closes this fixture run'}
    const command={contractVersion:1,commandId:'finish-'+randomUUID(),scope,runId:run.run.runId,expectedRevision:run.run.revision,kind:'reconcile',payload,payloadDigest:digest(api.canonicalWorkflowJson(payload)),requestedAt:Date.now()}
    assert.equal((await first.core.commit({command,owner:first.request.owner,expectedCurrent:run.run,runChanges:[{...run,state:'verified'}],events:[],outbox:[]})).status,'committed')
    first.core.releaseWorkspace(first.request.manifest.scope,first.request.owner)
    const second=await harness({task:'task-b',shared:first});await second.driver.dispatch(second.request);const resultB=await second.driver.result(second.request.operationId)
    assert.equal(resultB.status,'passed');assert.notEqual(resultA.sessionId,resultB.sessionId);assert.equal(first.fake.creates,2)
    assert.equal(first.fake.sessions.get(resultA.sessionId).taskDir,'task-a');assert.equal(first.fake.sessions.get(resultB.sessionId).taskDir,'task-b')
  })
  await check('Malformed output has a bounded repair turn using the same task session',async()=>{
    const h=await harness({scenario:'repair',maxRepairTurns:1});await h.driver.dispatch(h.request);assert.equal((await h.driver.result(h.request.operationId)).status,'passed');assert.equal(h.fake.prompts,2);assert.equal(h.fake.creates,1)
  })
  await check('Same-task executor reuse keeps one owned idle session with distinct native turns',async()=>{
    const first=await harness();await first.driver.dispatch(first.request);const a=await first.driver.result(first.request.operationId)
    const run=(await first.core.head(scope)).run;const payload={reason:'Coordinator closes the checked first run before a new one'}
    const command={contractVersion:1,commandId:'reuse-finish-'+randomUUID(),scope,runId:run.run.runId,expectedRevision:run.run.revision,kind:'reconcile',payload,payloadDigest:digest(api.canonicalWorkflowJson(payload)),requestedAt:Date.now()}
    assert.equal((await first.core.commit({command,owner:first.request.owner,expectedCurrent:run.run,runChanges:[{...run,state:'verified'}],events:[],outbox:[]})).status,'committed')
    first.core.releaseWorkspace(scope,first.request.owner)
    const second=await harness({shared:first});await second.driver.dispatch(second.request);const b=await second.driver.result(second.request.operationId)
    assert.equal(b.status,'passed');assert.equal(a.sessionId,b.sessionId);assert.notEqual(a.turnId,b.turnId)
    assert.equal(first.fake.creates,1);assert.equal(first.fake.prompts,2)
    assert.equal(second.plan.context.manifest.complete,false,'Native prior memory is still unobserved')
  })
  await check('Output byte validation cannot be replaced by a successful assistant response',async()=>{
    const h=await harness();h.plan.output.validateMaterial=()=>({ok:false,reason:'Required business field missing from actual file'})
    await h.driver.dispatch(h.request);const result=await h.driver.result(h.request.operationId)
    assert.equal(result.status,'failed');assert.equal(result.outputs.length,1,'rejected actual output version remains referenced');assert.equal(h.fake.prompts,1)
  })
  await check('Validator exceptions are unknown and cannot automatically repeat model side effects',async()=>{
    const h=await harness({maxRepairTurns:2});h.plan.output.validateMaterial=()=>{throw new Error('Actual validator service unavailable')}
    await h.driver.dispatch(h.request);const result=await h.driver.result(h.request.operationId)
    assert.equal(result.status,'outcome-unknown');assert.equal(result.outputs.length,1);assert.equal(h.fake.prompts,1)
    assert.equal(h.core.getOperation(scope,h.request.operationId).operation.state,'outcome-unknown')
  })
  await check('Output storage failures stay unknown for required and optional files without another prompt',async()=>{
    const original=store.captureFile.bind(store)
    try{
      for(const required of [true,false]){
        const h=await harness({maxRepairTurns:2});h.plan.output.files[0].required=required
        store.captureFile=async()=>{throw new api.WorkflowRuntimeError('STORE_UNAVAILABLE','Owned storage outage fixture')}
        await h.driver.dispatch(h.request);const result=await h.driver.result(h.request.operationId)
        assert.equal(result.status,'outcome-unknown');assert.equal(h.fake.prompts,1)
      }
    }finally{store.captureFile=original}
  })
  await check('A rejected empty actual output retains its immutable version reference',async()=>{
    const h=await harness();const original=store.captureFile.bind(store)
    store.captureFile=async input=>{writeFileSync(join(root,input.relativePath),' \n\t');return original(input)}
    try{
      await h.driver.dispatch(h.request);const result=await h.driver.result(h.request.operationId)
      assert.equal(result.status,'failed');assert.equal(result.outputs.length,1);assert.equal(h.fake.prompts,1)
      assert.equal((await store.readVersion(scope,result.outputs[0].ref)).text,' \n\t')
    }finally{store.captureFile=original}
  })
  await check('Provider failure after side effect is unknown and never automatically re-prompted',async()=>{
    const h=await harness({scenario:'failed-side-effect',maxRepairTurns:2});await h.driver.dispatch(h.request);assert.equal((await h.driver.result(h.request.operationId)).status,'outcome-unknown');assert.equal(h.fake.prompts,1);assert.equal(readFileSync(join(root,'fixture-side-effect.txt'),'utf8'),'effect occurred')
  })
  await check('Native background work cannot become a verified stage just because the turn ended',async()=>{
    const h=await harness({scenario:'background'});await h.driver.dispatch(h.request);assert.equal((await h.driver.result(h.request.operationId)).status,'outcome-unknown')
  })
  await check('History degraded acknowledgement never becomes a committed transcript link',async()=>{
    const h=await harness({scenario:'history-degraded'});await h.driver.dispatch(h.request);const result=await h.driver.result(h.request.operationId);assert.equal(result.status,'passed');assert.equal(result.historyCommitted,false);assert.equal(result.historySeq,null)
  })
  await check('A restarted driver reconciles prior dispatch instead of starting it again',async()=>{
    const h=await harness();h.core.claimOperation({scope:h.request.manifest.scope,owner:h.request.owner,operationId:h.request.operationId});const ack=await h.driver.dispatch(h.request);assert.equal(ack.status,'outcome-unknown');assert.equal(h.fake.creates,0)
  })
  const report={status:'passed',scenarios:results.length,scope:'Actual exported material/context/driver/control code; fast native messages are deterministic fixtures',results,realVendor:'not_run',actualFacade:'separate workflow-engine-facade.mjs gate'}
  const reportIndex=process.argv.indexOf('--report');if(reportIndex>=0)writeFileSync(process.argv[reportIndex+1],JSON.stringify(report,null,2)+'\n')
  console.log(`workflow-engine: ${results.length} scenarios passed; real file SQLite and SHA-256; native fixture boundary retained`)
} finally {
  await facade.shutdownAcp();await facade.stopAcpHistory()
  for(const core of cores)core.close()
  assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));assert.ok(temporary.includes('trellis-workflow-engine-'));rmSync(temporary,{recursive:true,force:true})
}
