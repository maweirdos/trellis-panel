/** Actual facade + patched public runtime + owned protocol process. Not real vendor/model acceptance. */
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareWorkflowEngineHarness } from './fixtures/workflow-engine-harness.mjs'
const temporary=mkdtempSync(join(tmpdir(),'trellis-workflow-engine-facade-'));let rig;let timer
try{
 const denied=process.argv.includes('--deny')
 const instructionPrefix=process.argv.includes('--native-command')?'/workflow-owned-command ':process.argv.includes('--whitespace')?'  ':''
 rig=await prepareWorkflowEngineHarness(temporary,{id:'workflow-owned-peer',name:'Owned workflow peer',command:'owned fixture',enabled:true,launchKind:'custom',executable:process.execPath,args:[resolve('scripts/smoke/fixtures/workflow-engine-peer.mjs')]},{instructionPrefix})
 const responded=new Set();timer=setInterval(()=>{
  for(const item of globalThis.__TPANEL_EVENTS__??[]){
   if(item.channel!=='acp:permission')continue;const p=item.payload;if(responded.has(p.requestId))continue;responded.add(p.requestId)
   assert.equal(p.toolCall.title,'Write owned fixture PRD/design');assert.equal(p.projectRoot,rig.root)
   const option=p.options.find(o=>denied?o.optionId==='reject-owned-once'&&o.kind==='reject_once':o.optionId==='allow-owned-once'&&o.kind==='allow_once');assert.ok(option)
   assert.equal(rig.api.facade.respondAcpPermission(rig.root,p.requestId,option.optionId).ok,true)
  }
 },10)
 const ack=await rig.driver.dispatch(rig.request);assert.equal(ack.status,'accepted',JSON.stringify(ack))
 const result=await rig.driver.result(rig.request.operationId)
 assert.equal(result.status,denied?'cancelled':'passed',JSON.stringify(result))
 if(denied){assert.equal(result.outputs.length,0);assert.equal(responded.size,1,'A native denial is not repaired/re-prompted');assert.equal(existsSync(join(rig.root,'.trellis/tasks/task-a/design.md')),false);assert.ok(readFileSync(join(rig.root,'.trellis/tasks/task-a/prd.md'),'utf8').includes('MUTABLE_REQUIREMENT_B'))}
 else{assert.equal(result.outputs.length,2);assert.equal(result.historyCommitted,true)}
 const sessions=rig.api.facade.listAcpSessions(rig.root).sessions;const session=sessions.find(s=>s.sessionId===result.sessionId);assert.ok(session)
 assert.ok(session.materialSnapshot.files.includes('.trellis/tasks/task-a/product.md'));assert.ok(!session.materialSnapshot.files.includes('.trellis/tasks/task-a/prd.md'))
 const input=session.events.find(e=>e.kind==='message'&&e.payload?.role==='user');assert.ok(input);assert.ok(!input.text.includes('<workflow_materials'))
 const response=session.events.filter(e=>e.kind==='message'&&e.payload?.role!=='user').map(e=>{try{return JSON.parse(e.text)}catch{return null}}).find(e=>e?.promptDigest)
 assert.ok(response);assert.equal(response.promptDigest,rig.context.promptDigest,'Actual peer received the exact admitted workflow instruction/material bytes')
 const events=rig.core.events({scope:rig.scope,cursor:null,limit:200}).items.map(x=>x.event)
 assert.ok(events.some(e=>e.type==='workflow.context-emitted-to-host'));assert.equal(events.some(e=>e.type==='workflow.output-verified'),!denied)
 assert.ok(events.every(e=>e.payload?.nativeStatus!=='agent_invented'))
 const report={status:'passed',scope:'Actual application ACP facade/public acpx with owned stdio peer; no real vendor/model',mode:denied?'native-denial':process.argv.includes('--native-command')?'managed-native-command':process.argv.includes('--whitespace')?'managed-whitespace':'ordinary-managed',dispatch:ack,result,permissionOption:denied?'reject-owned-once':'allow-owned-once',permissionRequests:responded.size,checks:['pinned A sent without mutable B','actual received prompt SHA-256 matches admitted packet','visible user instruction excludes source packet','original permission option mediated',...(denied?['denial cancels without output writes or another prompt']:['actual two output files captured','exact terminal history sequence committed']),'workflow/native event references correlated'],realVendor:'not_run'}
 const pos=process.argv.indexOf('--report');if(pos>=0)writeFileSync(process.argv[pos+1],JSON.stringify(report,null,2)+'\n')
 console.log('workflow-engine-facade: '+report.mode+' pinned materials, native permissions and exact prompt bytes passed')
}finally{if(timer)clearInterval(timer);if(rig){await rig.api.facade.shutdownAcp();await rig.api.facade.stopAcpHistory();rig.core.close()}assert.equal(dirname(resolve(temporary)),resolve(tmpdir()));assert.ok(temporary.includes('trellis-workflow-engine-facade-'));rmSync(temporary,{recursive:true,force:true})}
