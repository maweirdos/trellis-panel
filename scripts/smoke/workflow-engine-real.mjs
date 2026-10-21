/** Opt-in distinct R1 real Codex path. Uses installed adapter metadata; never customer Jira or active repo. */
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync,readFileSync,writeFileSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareWorkflowEngineHarness } from './fixtures/workflow-engine-harness.mjs'
if(!process.argv.includes('--run'))throw new Error('Real model invocation requires explicit --run')
const installed=JSON.parse(readFileSync('.trellis/tasks/10-20-wf-capability-baselines/research/current/installed.json','utf8'))
const temporary=mkdtempSync(join(tmpdir(),'trellis-workflow-engine-real-'));let rig
const report={status:'pending',scope:'R1 actual facade/stage/material path with installed pinned Codex adapter',fixture:false,permissions:'existing native policy; no automatic approval',adapter:installed.agents.codex.adapter.version}
try{
 rig=await prepareWorkflowEngineHarness(temporary,{id:'workflow-real-codex',name:'Installed Codex R1 acceptance',command:'installed pinned Codex ACP',enabled:true,launchKind:'custom',executable:installed.nodeExecutable,args:[installed.agents.codex.adapter.entry]},{real:true})
 const ack=await rig.driver.dispatch(rig.request);report.dispatch=ack
 const result=await rig.driver.result(rig.request.operationId);report.result=result
 if(result?.status==='passed'){
  const outputs=await Promise.all(result.outputs.map(output=>rig.store.readVersion(rig.scope,output.ref)))
  assert.equal(outputs.length,2);assert.ok(outputs.every(o=>o.text.includes(rig.nonce)),'both actual files reference the exact supplied source nonce')
  assert.ok(outputs.some(o=>o.material.kind==='trellis-prd'));assert.ok(outputs.some(o=>o.material.kind==='design'))
  report.status='passed';report.outputEvidence=outputs.map(o=>({kind:o.material.kind,ref:o.ref,digest:o.bodyDigest,bytes:o.byteLength,sourceNonceMatched:true}));report.historyCommitted=result.historyCommitted
  const events=rig.core.events({scope:rig.scope,cursor:null,limit:200}).items.map(item=>item.event)
  const provenance=events.find(event=>event.type==='workflow.native-provenance');assert.ok(provenance,'actual admitted runtime provenance must be recorded')
  report.nativeProvenance=provenance.payload;report.nativeHooks='unobserved';report.manifestComplete=rig.context.manifest.complete
 }else{report.status='not_passed';report.pendingPermissions=(globalThis.__TPANEL_EVENTS__??[]).filter(x=>x.channel==='acp:permission').map(x=>({requestId:x.payload.requestId,kind:x.payload.toolCall?.kind}));process.exitCode=2}
}catch(error){report.status='failed';report.error=error instanceof Error?error.message:String(error);process.exitCode=1}
finally{
 if(rig){await rig.api.facade.shutdownAcp();await rig.api.facade.stopAcpHistory();rig.core.close();report.ownedShutdown='confirmed'}
 const pos=process.argv.indexOf('--report');if(pos>=0)writeFileSync(process.argv[pos+1],JSON.stringify(report,null,2)+'\n')
 assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));assert.ok(temporary.includes('trellis-workflow-engine-real-'));rmSync(temporary,{recursive:true,force:true})
 console.log(JSON.stringify({status:report.status,scope:report.scope,outputCount:report.outputEvidence?.length??0,ownedShutdown:report.ownedShutdown}))
}
