/** Shared preparation for actual facade/driver acceptance; all persistence stays in the owned temporary directory. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { prepareAcpHistoryWorker } from '../prepare-acp-history-worker.mjs'
export const workflowDigest=(v)=>createHash('sha256').update(v).digest('hex')
export const workflowAsset=(id)=>({assetId:id,version:'v1',digest:workflowDigest(id)})

export async function prepareWorkflowEngineHarness(temporary,agent,{real=false,instructionPrefix=''}={}) {
  process.env.TPAP_SMOKE_DIR=temporary
  await prepareAcpHistoryWorker(temporary)
  const source=(p)=>resolve(p).replace(/\\/g,'/')
  const bundle=join(temporary,'facade-driver.mjs')
  await build({stdin:{contents:`export * from '${source('src/main/services/workflow-runtime/index.ts')}';
    export * from '${source('src/shared/workflow/index.ts')}';
    export {WorkflowControlCore} from '${source('src/main/services/workflow-control/core.ts')}';
    export {setSettings} from '${source('src/main/services/store.ts')}';
    export * as facade from '${source('src/main/services/acp.ts')}';`,loader:'ts',resolveDir:process.cwd()},bundle:true,format:'esm',platform:'node',
    alias:{electron:resolve('scripts/smoke/mock-electron.mjs')},banner:{js:"import {createRequire as smokeRequire} from 'node:module';const require=smokeRequire(import.meta.url);"},outfile:bundle,logLevel:'silent'})
  const api=await import(pathToFileURL(bundle).href)
  api.setSettings({acp:{nodePath:process.execPath,agents:[agent]}})
  const root=join(temporary,'owned repository');const task='task-a';const taskPath=join(root,'.trellis','tasks',task)
  mkdirSync(taskPath,{recursive:true})
  writeFileSync(join(taskPath,'task.json'),JSON.stringify({id:'task-a',title:'Owned workflow acceptance',status:'planning'}))
  const nonce=randomUUID()
  const requirement=`# Confirmed source\nPINNED_REQUIREMENT_A ${nonce}\nOrdinary employees must not export customer_phone.\n`
  writeFileSync(join(taskPath,'product.md'),requirement)
  writeFileSync(join(taskPath,'prd.md'),'MUTABLE_REQUIREMENT_B: unrelated current draft; this must not enter the pinned source packet.\n')
  const scope={projectId:'acceptance-project',repositoryId:'acceptance-repository',workspaceId:'acceptance-workspace',taskRef:'task:task-a'}
  const store=new api.WorkflowMaterialStore({directory:join(temporary,'material-cache')})
  const captured=await store.captureFile({projectRoot:root,owner:scope,relativePath:'.trellis/tasks/task-a/product.md',kind:'product-requirement'})
  const instruction=instructionPrefix+(real
    ? `This is an authorized isolated workflow integration test. Work only inside this current temporary repository. Read the explicitly supplied pinned product requirement. Create .trellis/tasks/task-a/prd.md and .trellis/tasks/task-a/design.md with a short meaningful requirement/acceptance and technical design for the customer_phone export restriction. Include the exact source nonce ${nonce} in both files. Do not access network or change anything outside this repository. Do not commit. Finish with a concise completion message.`
    : 'WORKFLOW_PEER_TASK=task-a Generate the declared PRD/design files from the pinned source and return the result object.')
  const context=await api.prepareWorkflowContext(store,{scope,instruction,inputs:{sourceNonce:nonce},selections:[{owner:scope,ref:captured.ref,purpose:'baseline',reason:'Confirmed exact product source'}],engineeringBaseline:workflowAsset('baseline'),outputContract:workflowAsset('prd-design'),budgetBytes:32000})
  const executor={bindingId:'acceptance-engine',engineId:agent.id,engineVersion:real?'unknown':'owned-peer-1',adapterVersion:real?'2.2.2':'owned-peer-1',configuration:{assetId:'runtime:'+agent.id,version:'captured',digest:workflowDigest(api.canonicalWorkflowJson(agent))},capabilities:real?{engineExecutableVersion:{status:'unknown',reason:'The installed adapter version does not establish its actual native executable version'}}:{}}
  const definition={contractVersion:1,ref:{definitionId:'acceptance-flow',revision:1},flow:{version:1,id:'acceptance-flow',name:'Produce PRD/design',description:'Owned acceptance',inputs:[],phases:[{id:'plan',name:'Planning',steps:[{id:'documents',name:'Produce documents',kind:'agent',instruction}]}]},defaultExecutor:executor,nodeBindings:[],trellisPhases:{plan:'plan'}}
  const compiled=await api.compileWorkflowDefinition(definition,context.manifest,workflowDigest)
  const run={runId:'acceptance-run',revision:1};const operationId='acceptance-operation';const payload={purpose:'owned-stage-acceptance'}
  const command={contractVersion:1,commandId:'acceptance-command',scope,runId:run.runId,expectedRevision:1,kind:'start',payload,payloadDigest:workflowDigest(api.canonicalWorkflowJson(payload)),requestedAt:Date.now()}
  const manifest={contractVersion:1,scope,run,definition:definition.ref,roles:[],executors:[executor],extensions:[],context:context.manifest,inputFingerprint:compiled.inputFingerprint,recordedAt:Date.now()}
  const core=new api.WorkflowControlCore(join(temporary,'control'));core.open()
  const claimed=core.claimWorkspace({scope,ownerId:'acceptance-owner',ttlMs:300000});assert.equal(claimed.status,'acquired');const owner=claimed.lease.owner
  const committed=await core.commitWithManifests({journal:{command,owner,expectedCurrent:null,runChanges:[{contractVersion:1,scope,run,definition:definition.ref,state:'queued',predecessor:null,createdAt:Date.now()}],events:[],outbox:[{operationId,commandId:command.commandId,scope,run,state:'pending',ownerId:owner.ownerId,fencingToken:owner.fencingToken,result:null}]},manifests:[manifest]});assert.equal(committed.status,'committed')
  const control={getOperation:async(...a)=>core.getOperation(...a),claimOperation:async(...a)=>core.claimOperation(...a),settleOperation:async(...a)=>core.settleOperation(...a),reconcileOperation:async(...a)=>core.reconcileOperation(...a),append:async(...a)=>core.append(...a),recordStep:async(...a)=>core.recordStep(...a),renewWorkspace:async(s,o,ttl)=>core.renewWorkspace({scope:s,ownerId:o.ownerId,ttlMs:ttl},o)}
  const plan={projectRoot:root,taskDir:task,context,executor:{agentId:agent.id,verified:executor},output:{contract:workflowAsset('prd-design'),files:[{relativePath:'.trellis/tasks/task-a/prd.md',kind:'trellis-prd',required:true},{relativePath:'.trellis/tasks/task-a/design.md',kind:'design',required:true}],maxRepairTurns:real?0:1,...(real?{validateMaterial:material=>({ok:material.text.includes(nonce),reason:'Actual output must reference the exact selected source nonce'})}:{validateText:text=>{try{const result=JSON.parse(text);return{ok:result.ok===true&&result.pinned===true&&result.mutable===false}}catch{return{ok:false}}}})},assertCurrent:()=>{}}
  const port=api.createFacadeWorkflowAcpPort()
  const driver=new api.AcpxWorkflowDriver({acp:port,control,materials:store,resolve:async()=>plan,startupTimeoutMs:35000,turnTimeoutMs:real?180000:20000})
  const request={operationId,owner,manifest,step:{...run,nodeId:compiled.plan.nodes[0].nodeId,attempt:1},node:compiled.plan.nodes[0],executorBindingId:executor.bindingId}
  return{api,core,root,task,scope,owner,store,captured,context,driver,request,nonce,port}
}
