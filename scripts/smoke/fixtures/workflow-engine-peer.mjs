/** Owned ACP protocol peer: controlled file writes/permissions, never a real-vendor substitute. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
let buffer='';let cwd;let sessionId;let active;let requestId=1000
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\n')
const reply=(id,result)=>send({jsonrpc:'2.0',id,result})
const notify=(update)=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}})
function complete(allowed){
 if(!active)return;const current=active;active=undefined
 if(allowed){
  const dir=join(cwd,'.trellis','tasks',current.task);mkdirSync(dir,{recursive:true})
  writeFileSync(join(dir,'prd.md'),'# PRD\nSource: PINNED_REQUIREMENT_A\nScenario: controlled export\n')
  writeFileSync(join(dir,'design.md'),'# Design\nImplementation: fixture owned file write\n')
 }
 notify({sessionUpdate:'tool_call_update',toolCallId:current.tool,status:allowed?'completed':'failed',rawOutput:{written:allowed}})
 notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({ok:allowed,pinned:current.text.includes('PINNED_REQUIREMENT_A'),mutable:current.text.includes('MUTABLE_REQUIREMENT_B'),promptDigest:createHash('sha256').update(current.text).digest('hex')})}})
 reply(current.id,{stopReason:allowed?'end_turn':'cancelled'})
}
function handle(message){
 const {id,method,params}=message
 if(!method&&active&&id===active.permission){complete(message.result?.outcome?.outcome==='selected'&&message.result.outcome.optionId==='allow-owned-once');return}
 if(method==='initialize'){reply(id,{protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:'workflow-owned-peer',version:'1'},authMethods:[]});return}
 if(method==='session/new'){cwd=params.cwd;sessionId='workflow-wire-'+randomUUID();notify({sessionUpdate:'available_commands_update',availableCommands:[{name:'workflow-owned-command',description:'Owned native command boundary regression',input:{hint:'optional'}}]});reply(id,{sessionId});return}
 if(method==='session/load'){cwd=params.cwd;sessionId=params.sessionId;reply(id,{});return}
 if(method==='session/cancel'){complete(false);return}
 if(method==='session/prompt'){
  const text=(params.prompt??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');const task=/WORKFLOW_PEER_TASK=(task-[ab])/.exec(text)?.[1]
  if(!task){send({jsonrpc:'2.0',id,error:{code:-32602,message:'Owned peer requires an explicit fixture task'}});return}
  const tool='workflow-write-'+randomUUID();notify({sessionUpdate:'tool_call',toolCallId:tool,title:'Write owned fixture PRD/design',kind:'edit',status:'pending'})
  const permission=++requestId;active={id,text,task,tool,permission}
  send({jsonrpc:'2.0',id:permission,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:tool,title:'Write owned fixture PRD/design',kind:'edit'},options:[{optionId:'allow-owned-once',name:'Allow once',kind:'allow_once'},{optionId:'reject-owned-once',name:'Reject',kind:'reject_once'}]}});return
 }
 if(id!==undefined)reply(id,{})
}
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(line)handle(JSON.parse(line))}})
process.stdin.resume()
