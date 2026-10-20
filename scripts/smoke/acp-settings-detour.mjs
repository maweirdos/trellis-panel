/** Real ReactDOM PageBody + ACP/reader mount in an isolated hidden Electron window. No providers/network. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from 'tailwindcss'
import tailwindConfig from '../../tailwind.config.js'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-settings-host-'))
const absolute = (file) => resolve(file).replace(/\\/g, '/')
const appFile = absolute('src/renderer/src/my/layout/MyApp.tsx')
const root = 'D:/settings-detour-fixture', relativePath = '.trellis/tasks/review/prd.md'
const emptyExports = ['YourWorkPage','AnalyticsPage','WorkItemsPage','KnowledgePage','SpecPage','ArchivePage','InboxPage','ChannelsPage','TeamPage','JiraPage','StudioPage','ArchitecturePage','ModelsPage','GatewayPage','ChatPage','DevToolsPage','TaskDetail','WorkspaceSidebar','CommandPalette','IssuePeek','CreateIssueModal']
const storeSource = `import { create } from '${absolute('node_modules/zustand/esm/index.mjs')}';
import { sessionSlice } from '${absolute('src/renderer/src/store/slices/session.ts')}';
import { readerSlice } from '${absolute('src/renderer/src/store/slices/reader.ts')}';
export const useApp = create((set,get,store) => ({...sessionSlice(set,get,store),...readerSlice(set,get,store), page:'acp',taskExpandOrigin:null,inbox:{},loadTodos:async()=>{},pushToast:()=>{},setPage:(page)=>set({page}),showTask:()=>{},openArtifact:()=>{}}));
globalThis.__app = useApp;`
const mySource = `import {create} from '${absolute('node_modules/zustand/esm/index.mjs')}'; export const useMy=create((set)=>({sidebarWidth:275,sidebarCollapsed:false,fontSize:'small',setSidebarWidth:(sidebarWidth)=>set({sidebarWidth}),toggleSidebar:()=>set(s=>({sidebarCollapsed:!s.sidebarCollapsed})),setFontSize:(fontSize)=>set({fontSize})}));`
const settingsSource = `import {useState} from 'react'; import {AppearancePreferences} from '${absolute('src/renderer/src/my/AppearancePreferences.tsx')}'; import {Dropdown,Modal,Button} from '${absolute('src/renderer/src/my/ui.tsx')}';
export function SettingsPage(){const[open,setOpen]=useState(false);return <section data-settings><AppearancePreferences/><input id="settings-focus" aria-label="Settings focus"/><Dropdown trigger={({toggle})=><Button onClick={toggle}>Settings menu</Button>}>{()=> <button>Settings menu item</button>}</Dropdown><Button onClick={()=>setOpen(true)}>Settings modal</Button><Modal open={open} onClose={()=>setOpen(false)}><div data-settings-modal>Settings modal body</div></Modal></section>}`
const entry = join(directory,'entry.tsx')
writeFileSync(entry, `import React from 'react';import{createRoot}from'react-dom/client';
import{PageBody}from'${appFile}';import{useApp}from'${absolute('src/renderer/src/store/index.ts')}';import{useMy}from'${absolute('src/renderer/src/my/store.ts')}';
import{DialogHost,confirmDialog}from'${absolute('src/renderer/src/components/Dialogs.tsx')}';
import{InteractionScope}from'${absolute('src/renderer/src/utils/interaction-scope.tsx')}';
import{receiveDocumentChanged,documentSessionCount}from'${absolute('src/renderer/src/reader/document-session-hub.ts')}';
import{dispatchEscKey,escLayerCount}from'${absolute('src/renderer/src/utils/esc-layer.ts')}';

const root=${JSON.stringify(root)}, path=${JSON.stringify(relativePath)};const unwatch=[];let watchCount=0;let revision='A';let reads=0;
const text=(letter)=>'# '+letter+'\\n\\n'+Array.from({length:80},(_,index)=>'Paragraph '+index+' '+letter+' retained source bytes.').join('\\n\\n');
const file={name:'prd.md',path:root+'/'+path,kind:'file',size:100,mtime:1,ext:'md'};
const snapshot=(projectRoot=root)=>({meta:{root:projectRoot,name:'Fixture'},tasks:[{dirName:'review',path:projectRoot+'/.trellis/tasks/review',record:{title:'Review',status:'planning'},phase:'planning',artifacts:[file]}],archived:[]});
const session={sessionId:'session',projectRoot:root,agentId:'codex',agentName:'Codex',status:'ready',startedAt:1,taskDir:'review',connectionGeneration:'connection',events:[{id:'user',source:'acp',kind:'message',projectRoot:root,sessionId:'session',text:'Meaningful fixture',payload:{role:'user'},ts:1}]};
const paragraphs=(prefix,count)=>Array.from({length:count},(_,index)=>prefix+' paragraph '+index+' has distinct original reading content and a stable visible line.').join('\\n\\n')+'\\n\\n';
const scrollSession={...session,sessionId:'scroll-session',taskDir:undefined,title:'Paged response',turnId:'scroll-turn',events:[]};
const scrollEvent=(id,ts,text)=>({id,ts,text,source:'acp',kind:'message',sessionId:'scroll-session',projectRoot:root,turnId:'scroll-turn',connectionGeneration:'connection',payload:{role:'assistant',messageId:'same-response'}});
const tail=scrollEvent('tail-fragment',2,paragraphs('Original',70));let releaseEarlier;const outputListeners=new Set();const stateListeners=new Set();
let releaseSearchA;const searchCalls=[];let brokenSearches=0;
const conversationPreferences=new Map();const managementCalls=[];let managementFailure='';let releaseManagement;
const summary=(record)=>({...record,...conversationPreferences.get(record.sessionId),eventCount:record.sessionId==='scroll-session'?80:1,lastActivityAt:2,hasConversation:true,historyCoverage:{state:'complete',capturedFrom:1},historyPersistence:{state:'saved',pendingCount:0,committedThroughEventId:'tail-fragment',committedThroughSeq:2},pendingPermissions:[],stateRevision:1});
const page=(record,events,earlier=false)=>({ok:true,version:1,session:summary(record),events,beforeCursor:earlier?'before-tail':null,afterCursor:null,hasEarlier:earlier,hasLater:false,startsMidTurn:earlier,oversized:false,coverage:{state:'complete',capturedFrom:1},historyPersistence:summary(record).historyPersistence});
let legacySessionCalls=0;const noop=()=>()=>{};window.trellis={acpAgents:async()=>({ok:true,agents:[{id:'codex',name:'Codex',runtimeId:'codex',available:true,enabled:true,command:'fixture'}]}),acpProfiles:async()=>({ok:true,profiles:[]}),acpSessions:async()=>{legacySessionCalls++;throw new Error('modern history must not call acpSessions')},
acpHistoryList:async(input={})=>{searchCalls.push(input);const result=(sessions,nextCursor=null)=>({ok:true,version:1,sessions,nextCursor,hasMore:!!nextCursor,snapshotId:'fixture',searchScope:'metadata',diagnostics:[]});if(input.query==='pending A')return new Promise(resolve=>{releaseSearchA=()=>resolve(result([{...summary(session),title:'过期搜索 A'}]))});if(input.query==='paged B')return input.cursor?result([{...summary(session),title:'搜索 B 第二页'}]):result([{...summary(scrollSession),title:'搜索 B 第一页'}],'B-page-2');if(input.query==='broken C'&&brokenSearches++===0)return{ok:false,error:'search fixture unavailable'};const records=[summary(session),summary(scrollSession)].filter(record=>input.archive==='all'||(input.archive==='archived'?!!record.archivedAt:!record.archivedAt)).filter(record=>!input.query?.startsWith('Renamed ')||record.title?.includes(input.query)).sort((a,b)=>(b.pinnedAt??0)-(a.pinnedAt??0));return result(records)},acpHistorySession:async(id)=>({ok:true,version:1,session:summary(id==='scroll-session'?scrollSession:session)}),acpHistoryEvents:async(id,input={})=>id==='scroll-session'?(input.before?new Promise(resolve=>{releaseEarlier=resolve}):page(scrollSession,[tail],true)):page(session,session.events),
acpHistoryUpdate:async(id,patch)=>{managementCalls.push({id,patch});if(releaseManagement===null)await new Promise(resolve=>{releaseManagement=resolve});if(managementFailure){const error=managementFailure;managementFailure='';return{ok:false,code:'E_IO',error}}const previous=conversationPreferences.get(id)??{};const next={...previous,...(patch.title!==undefined?{title:patch.title.trim(),customTitle:patch.title.trim()}:{}),...(patch.pinned!==undefined?{pinnedAt:patch.pinned?1234:undefined}:{}),...(patch.archived!==undefined?{archivedAt:patch.archived?1235:undefined}:{})};conversationPreferences.set(id,next);return{ok:true,version:1,session:summary(id==='scroll-session'?scrollSession:session)}},
onAcpOutput:(listener)=>{outputListeners.add(listener);return()=>outputListeners.delete(listener)},onAcpState:(listener)=>{stateListeners.add(listener);return()=>stateListeners.delete(listener)},onAcpDone:noop,onMaterialUpdated:noop,
documentRead:async(scope,input)=>{reads++;return{ok:true,requestId:input.requestId,revision,rawText:text(revision),diagnostics:[],parsed:null,source:{canonicalPath:root+'/'+path,relativePath:path,workspaceId:root,taskRef:'review',sizeBytes:100,mtimeMs:1}}},documentWatch:async()=>({ok:true,canonicalPath:root+'/'+path,watchId:'lease-'+(++watchCount)}),documentUnwatch:async(canonicalPath,watchId)=>{unwatch.push({canonicalPath,watchId})},documentDiff:async()=>({ok:false,error:'fixture no diff'}),openProject:async(projectRoot)=>({ok:true,snapshot:snapshot(projectRoot)}),getSettings:async()=>({theme:'light',recentProjects:[root],jira:{},ai:{},weknora:{}})};
useApp.setState({snapshot:snapshot(),page:'acp'});
function Fixture(){const size=useMy(s=>s.fontSize);const outerActive=useApp(s=>s.taskExpandOrigin===null);return <div className="my-root" data-my-theme="light" data-my-font-size={size}><button id="settings-opener" style={{position:'fixed',top:0,left:0,zIndex:100}} onClick={()=>useApp.getState().setPage('settings')}>Open Settings</button><div className="h-full" hidden={!outerActive} aria-hidden={!outerActive||undefined} ref={element=>{if(element)element.inert=!outerActive}}><InteractionScope active={outerActive}><PageBody/></InteractionScope></div>{!outerActive&&<button id="outer-focus">Task workspace focus</button>}<DialogHost/></div>}

const host=createRoot(document.getElementById('root'));host.render(<React.StrictMode><Fixture/></React.StrictMode>);
const wait=async(test,label)=>{for(let i=0;i<200;i++){if(test())return;await new Promise(r=>setTimeout(r,10))}throw new Error('timeout '+label+'; '+document.body.innerText.slice(0,700))};
const check=(name,value)=>{if(!value)throw new Error(name);console.log('PASS '+name)};
const click=(element)=>{if(!element)throw new Error('missing click');element.click()};
const byText=(label)=>[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===label);
const textarea=()=>document.querySelector('[aria-label="Agent 指令"]');
window.addEventListener('keydown',event=>{if(event.key==='Escape')dispatchEscKey()});
async function run(){
await wait(()=>document.querySelector('[data-acp-session="session"]'),'ACP mount');click(document.querySelector('[data-acp-session="session"]'));
await wait(()=>textarea(),'conversation');
check('modern metadata history avoids bulk legacy transcript hydration',legacySessionCalls===0);
// Search exercises shared Modal ownership and independently paged metadata.
const magnifier=document.querySelector('[aria-label="搜索全部会话"]');const originalSidebar=document.querySelector('.acp-navigation-scroll').textContent;
magnifier.focus();click(magnifier);
await wait(()=>document.querySelector('[role="dialog"][aria-label="搜索会话"] input')===document.activeElement,'search autofocus and dialog name');
// Hidden hosts can suspend CSS frames. Measure the real final modal layout.
document.querySelector('[role="dialog"][aria-label="搜索会话"]').getAnimations().forEach(animation=>animation.finish());
await wait(()=>{const rect=document.querySelector('[role="dialog"][aria-label="搜索会话"]').getBoundingClientRect();return Math.abs((rect.top+rect.bottom)/2-innerHeight/2)<1.1},'search vertically centered');
const searchRect=document.querySelector('[role="dialog"][aria-label="搜索会话"]').getBoundingClientRect();check('search palette is truly centered in the viewport '+JSON.stringify({centerY:(searchRect.top+searchRect.bottom)/2,viewportY:innerHeight/2}),Math.abs((searchRect.top+searchRect.bottom)/2-innerHeight/2)<1.1);
const searchInput=()=>document.querySelector('.acp-search-input input');const setSearch=value=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(searchInput(),value);searchInput().dispatchEvent(new Event('input',{bubbles:true}))};
setSearch('pending A');await wait(()=>releaseSearchA,'deferred search A');setSearch('paged B');
check('replacement search immediately removes old result actions during debounce',!document.querySelector('.acp-search-result'));
await wait(()=>document.querySelector('.acp-search-result')?.textContent.includes('搜索 B 第一页'),'search B result');releaseSearchA();await new Promise(r=>setTimeout(r,20));
check('late query A cannot replace query B or change the sidebar',!document.querySelector('.acp-search-palette').textContent.includes('过期搜索 A')&&document.querySelector('.acp-navigation-scroll').textContent===originalSidebar);
click([...document.querySelectorAll('.acp-search-palette button')].find(button=>button.textContent==='加载更多会话'));await wait(()=>document.querySelectorAll('.acp-search-result').length===2,'search B pagination');
check('new query pagination uses its own cursor after a stale pending request',searchCalls.some(call=>call.query==='paged B'&&call.cursor==='B-page-2'));
setSearch('broken C');await wait(()=>document.querySelector('.acp-search-error'),'search C error');
check('failed replacement query does not retain the previous cursor action',!document.querySelector('.acp-search-palette .acp-load-more'));
click(document.querySelector('.acp-search-error button'));await wait(()=>!document.querySelector('.acp-search-error')&&document.querySelector('.acp-search-result'),'search C retry');
check('search retry starts a fresh metadata snapshot rather than reusing the old page cursor',searchCalls.filter(call=>call.query==='broken C').length===2&&searchCalls.filter(call=>call.query==='broken C').every(call=>!call.cursor));
click(document.querySelector('[aria-label="清空会话搜索"]'));await wait(()=>searchInput()?.value===''&&document.activeElement===searchInput(),'clear search focus');
searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true}));
check('IME Enter and Escape do not select a result or close the search',!!document.querySelector('.acp-search-palette')&&document.querySelector('[data-acp-session="session"]').getAttribute('aria-current')==='page');
searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.acp-search-palette')&&document.activeElement===magnifier,'Escape search return focus');
click(magnifier);await wait(()=>searchInput()===document.activeElement,'search reopen');await wait(()=>!document.querySelector('.acp-search-empty[role="status"]'),'search recents');
searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await new Promise(r=>setTimeout(r,0));
check('Arrow selection updates the active option while keeping input focus',document.querySelectorAll('.acp-search-result')[1]?.getAttribute('aria-selected')==='true'&&document.activeElement===searchInput());
searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));await new Promise(r=>setTimeout(r,0));searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
await wait(()=>!document.querySelector('.acp-search-palette')&&document.querySelector('[data-acp-session="scroll-session"]').getAttribute('aria-current')==='page','explicit search selection');
click(magnifier);await wait(()=>searchInput(),'outside test open');document.querySelector('.my-modal-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));await wait(()=>!document.querySelector('.acp-search-palette')&&document.activeElement===magnifier,'outside close return focus');
releaseSearchA=undefined;click(magnifier);await wait(()=>searchInput(),'pending close open');setSearch('pending A');await wait(()=>releaseSearchA,'pending close request');const closeSearchResult=releaseSearchA;
searchInput().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(()=>!document.querySelector('.acp-search-palette')&&document.activeElement===magnifier,'close pending search');closeSearchResult();await new Promise(r=>setTimeout(r,20));
check('a delayed search result after close cannot reopen the palette or steal trigger focus',!document.querySelector('.acp-search-palette')&&document.activeElement===magnifier&&document.querySelector('.acp-navigation-scroll').textContent===originalSidebar);
releaseSearchA=undefined;click(magnifier);await wait(()=>searchInput(),'pending hidden open');setSearch('pending A');await wait(()=>releaseSearchA,'pending hidden request');const hiddenSearchResult=releaseSearchA;
useApp.getState().setPage('settings');await wait(()=>document.querySelector('#settings-focus'),'pending search Settings');document.querySelector('#settings-focus').focus();hiddenSearchResult();await new Promise(r=>setTimeout(r,20));
check('a delayed search result in hidden ACP cannot render a portal or focus Settings',!document.querySelector('.acp-search-palette')&&document.activeElement.id==='settings-focus');
useApp.getState().setPage('acp');await wait(()=>document.querySelector('[data-acp-source-owner]')?.hidden===false,'return after hidden search');
check('returning to ACP does not revive a suspended search query or result',!document.querySelector('.acp-search-palette')&&document.querySelector('.acp-navigation-scroll').textContent===originalSidebar);
click(document.querySelector('[data-acp-session="session"]'));await wait(()=>document.querySelector('.acp-artifact'),'return from search');
// Exercise the production history hook, Markdown compiler and DOM scroll owner.
// Native browser anchoring is disabled below so this proves explicit restoration.
click(document.querySelector('[data-acp-session="scroll-session"]'));
await wait(()=>document.querySelector('[data-acp-item="tail-fragment"]')&&byText('加载更早消息'),'paged response');
const snapshotTail=scrollEvent('snapshot-only-fragment',1.5,'CUT_COMPATIBILITY_SNAPSHOT');
for(const listener of stateListeners)listener({projectRoot:root,sessionId:scrollSession.sessionId,status:'ready',connectionGeneration:'connection',stateRevision:50,pendingPermissions:[],session:{...scrollSession,stateRevision:50,pendingPermissions:[],events:[snapshotTail]}});
await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
check('versioned history keeps bounded state/resume snapshot tails out of the transcript',!document.querySelector('[data-acp-item="snapshot-only-fragment"]')&&!document.body.textContent.includes('CUT_COMPATIBILITY_SNAPSHOT'));
for(const listener of outputListeners)listener(scrollEvent('live-after-snapshot',2.5,'\\n\\nFresh streamed content stays visible.\\n\\n'));
await wait(()=>document.body.textContent.includes('Fresh streamed content stays visible.'),'live output after snapshot');
check('fresh scoped live output remains visible after metadata-only snapshot updates',document.body.textContent.includes('Original paragraph 0 ')&&document.body.textContent.includes('Fresh streamed content stays visible.'));
const scroll=document.querySelector('.acp-transcript');
const scrollStyle=getComputedStyle(scroll),scrollbarStyle=getComputedStyle(scroll,'::-webkit-scrollbar');
check('transcript scrollbar is hidden without a gutter while vertical overflow remains scrollable',scrollStyle.scrollbarWidth==='none'&&scrollStyle.scrollbarGutter==='auto'&&scrollbarStyle.display==='none'&&scrollbarStyle.width==='0px'&&scrollbarStyle.height==='0px'&&scrollStyle.overflowY==='auto'&&scroll.scrollHeight>scroll.clientHeight);
const knowledgeDisclosures=scroll.querySelectorAll('.acp-transcript-content > details.acp-knowledge-context');
check('session switching keeps knowledge setup and material editors out of the transcript',knowledgeDisclosures.length===0&&!scroll.querySelector('[aria-label="会话知识与材料"]')&&!scroll.querySelector('[aria-label="产品需求说明与人工发布"]'));
const reading=()=>[...document.querySelectorAll('.acp-answer p')].find(p=>p.textContent.startsWith('Original paragraph 25 '));
const initialScrollTop=scroll.scrollTop;
scroll.scrollTop+=reading().getBoundingClientRect().top-scroll.getBoundingClientRect().top-42;
scroll.dispatchEvent(new Event('scroll',{bubbles:true}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
const programmaticTop=scroll.scrollTop;console.log('ACP_TRANSCRIPT_WHEEL');
await wait(()=>scroll.scrollTop>programmaticTop+20,'native transcript wheel scrolling');
check('hidden transcript scrollbar preserves programmatic and native wheel scrolling',Math.abs(programmaticTop-initialScrollTop)>20&&scroll.scrollTop>programmaticTop+20);
scroll.scrollTop=programmaticTop;
scroll.dispatchEvent(new Event('scroll',{bubbles:true}));await new Promise(r=>setTimeout(r,30));
const readingTop=reading().getBoundingClientRect().top,oldAnswer=document.querySelector('[data-acp-item="tail-fragment"]'),beforeHeight=scroll.scrollHeight;
click(byText('加载更早消息'));await wait(()=>releaseEarlier,'deferred earlier page');
const append=scrollEvent('concurrent-live-fragment',3,paragraphs('Concurrent append',55));
// The same task releases history and emits live text: both changes may commit
// together, so a total-scrollHeight difference would incorrectly count the tail.
releaseEarlier(page(scrollSession,[scrollEvent('earlier-fragment',1,paragraphs('Earlier prefix',45))]));
for(const listener of outputListeners)listener(append);
await wait(()=>document.querySelector('[data-acp-item="earlier-fragment"]')&&document.body.textContent.includes('Concurrent append paragraph 54 '),'merged prepend plus live append');
await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
check('earlier fragments remount the merged answer while preserving the exact reading position during concurrent same-response append '+JSON.stringify({before:readingTop,after:reading().getBoundingClientRect().top}),!oldAnswer.isConnected&&scroll.scrollHeight>beforeHeight+1000&&Math.abs(reading().getBoundingClientRect().top-readingTop)<1.1);
const restoredTop=scroll.scrollTop;
for(const listener of outputListeners)listener(scrollEvent('later-live-fragment',4,paragraphs('Later append',12)));
await wait(()=>document.body.textContent.includes('Later append paragraph 11 '),'later live append');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
check('history prepend retains follow=false and later output cannot pull the reader to the bottom',Math.abs(scroll.scrollTop-restoredTop)<1.1&&Math.abs(reading().getBoundingClientRect().top-readingTop)<1.1&&scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight>1000);
click(document.querySelector('[data-acp-session="session"]'));await wait(()=>document.querySelector('.acp-artifact')&&!document.body.textContent.includes('Original paragraph 25 '),'return original conversation');
const messageColumn=document.querySelector('.acp-transcript-content').getBoundingClientRect(),inputColumn=document.querySelector('.acp-composer-region').getBoundingClientRect();
check('transcript and composer share the exact conversation column '+JSON.stringify({messageLeft:messageColumn.left,inputLeft:inputColumn.left,messageWidth:messageColumn.width,inputWidth:inputColumn.width}),Math.abs(messageColumn.left-inputColumn.left)<1&&Math.abs(messageColumn.width-inputColumn.width)<1);
const inputSetter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
const setDraft=(value)=>{inputSetter.call(textarea(),value);textarea().dispatchEvent(new Event('input',{bubbles:true}))};
const sessionMenu=(id)=>document.querySelector('[data-acp-session="'+id+'"]')?.parentElement.querySelector('button[aria-label^="会话操作"]');
const openSessionMenu=async(id)=>{await wait(()=>sessionMenu(id)&&!sessionMenu(id).disabled,'enabled conversation action');click(sessionMenu(id));await wait(()=>byText('重命名'),'conversation management menu')};
const titleField=()=>document.querySelector('input[aria-label="会话标题"]');
const setTitle=(value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(titleField(),value);titleField().dispatchEvent(new Event('input',{bubbles:true}))};
setDraft('Management draft remains');await openSessionMenu('session');
check('row management uses sibling buttons without nested interactive controls',!!sessionMenu('session')&&!document.querySelector('.acp-navigation button button'));
click(byText('重命名'));await wait(titleField,'rename dialog');
const beforeInvalidRename=managementCalls.length;setTitle('   ');click(byText('保存'));await new Promise(r=>setTimeout(r,0));
check('empty conversation title cannot dispatch or close the editor',managementCalls.length===beforeInvalidRename&&!!titleField());
setTitle('  Renamed conversation  ');titleField().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
titleField().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));
check('IME Enter cannot submit a conversation title',managementCalls.length===beforeInvalidRename&&!!titleField());
titleField().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));managementFailure='Fixture rename write failed';click(byText('保存'));
await wait(()=>document.body.textContent.includes('Fixture rename write failed'),'rename failure');
check('failed rename preserves the edited title and effective conversation name',titleField().value.trim()==='Renamed conversation'&&!document.querySelector('.acp-header-identity').textContent.includes('Renamed conversation'));
click(byText('保存'));await wait(()=>!titleField()&&document.querySelector('.acp-header-identity')?.textContent.includes('Renamed conversation'),'rename acknowledgement');
check('acknowledged title reaches the sidebar and header while preserving the draft',document.querySelector('[data-acp-session="session"]').textContent.includes('Renamed conversation')&&textarea().value==='Management draft remains');
for(const listener of stateListeners)listener({projectRoot:root,sessionId:'session',status:'ready',connectionGeneration:'connection',stateRevision:100,pendingPermissions:[],session:{...session,title:'Old generated title',stateRevision:100,events:[]}});
await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
check('later native metadata cannot replace the acknowledged custom title',document.querySelector('.acp-header-identity').textContent.includes('Renamed conversation'));
await openSessionMenu('session');click(byText('置顶'));await wait(()=>conversationPreferences.get('session')?.pinnedAt,'pin acknowledgement');
await wait(()=>document.querySelector('[data-acp-session]')?.dataset.acpSession==='session','pinned order');
check('pinning promotes the conversation in the real navigation list',document.querySelector('[data-acp-session]').dataset.acpSession==='session');
await openSessionMenu('session');click(byText('取消置顶'));await wait(()=>!conversationPreferences.get('session')?.pinnedAt,'unpin acknowledgement');
await openSessionMenu('session');click(byText('归档'));await wait(()=>!document.querySelector('[data-acp-session="session"]'),'archived row removed');
check('archiving the active conversation selects another source without losing its draft',document.querySelector('[data-acp-session="scroll-session"]')?.getAttribute('aria-current')==='page');
click(document.querySelector('.acp-list-filter'));await wait(()=>byText('已归档'),'archive filter');click(byText('已归档'));
await wait(()=>document.querySelector('[data-acp-session="session"]')&&!document.querySelector('[data-acp-session="scroll-session"]'),'archived list');
check('archived view requests the server archive scope instead of filtering only loaded rows',searchCalls.some(call=>call.archive==='archived'));
await openSessionMenu('session');click(byText('取消归档'));await wait(()=>!conversationPreferences.get('session')?.archivedAt,'restore acknowledgement');
click(document.querySelector('.acp-list-filter'));await wait(()=>byText('全部对话'),'active filter');click(byText('全部对话'));
await wait(()=>document.querySelector('[data-acp-session="session"]'),'restored active list');click(document.querySelector('[data-acp-session="session"]'));
await wait(()=>document.querySelector('.acp-artifact')&&textarea().value==='Management draft remains','restored conversation draft');
await openSessionMenu('session');click(byText('重命名'));await wait(titleField,'hidden rename setup');
useApp.getState().setPage('settings');await wait(()=>document.querySelector('[data-settings]')&&!titleField(),'hidden source closes rename');document.querySelector('#settings-focus').focus();
check('switching to Settings releases the rename modal without stealing Settings focus',!titleField()&&document.activeElement.id==='settings-focus');
useApp.getState().setPage('acp');await wait(()=>textarea()&&!document.querySelector('[data-acp-source-owner]').hidden,'return after rename suspension');
await openSessionMenu('session');click(byText('重命名'));await wait(titleField,'pending rename setup');setTitle('Renamed after Settings');releaseManagement=null;click(byText('保存'));
await wait(()=>typeof releaseManagement==='function','pending rename request');const finishManagement=releaseManagement;
useApp.getState().setPage('settings');await wait(()=>document.querySelector('[data-settings]')&&!titleField(),'Settings during pending rename');document.querySelector('#settings-focus').focus();finishManagement();
await wait(()=>conversationPreferences.get('session')?.title==='Renamed after Settings','saved hidden rename');await new Promise(r=>setTimeout(r,20));
check('a rename completing in a hidden source cannot render a modal or steal Settings focus',!titleField()&&document.activeElement.id==='settings-focus');
useApp.getState().setPage('acp');await wait(()=>document.querySelector('.acp-header-identity')?.textContent.includes('Renamed after Settings'),'return reads the actual saved title');
check('fresh history replaces an older local title acknowledgement after returning from Settings',document.querySelector('[data-acp-session="session"]').textContent.includes('Renamed after Settings')&&textarea().value==='Management draft remains');
setDraft('');await wait(()=>textarea().value==='','clear management fixture draft');
const compactHeight=textarea().getBoundingClientRect().height;
setDraft(Array.from({length:20},(_,i)=>'Draft line '+i).join('\\n'));
await wait(()=>textarea().getBoundingClientRect().height>compactHeight,'composer growth');
check('composer grows to the global height limit with internal scrolling',textarea().getBoundingClientRect().height<=220&&textarea().scrollHeight>textarea().clientHeight);
setDraft('Short editable draft');await wait(()=>textarea().getBoundingClientRect().height===compactHeight,'composer shrink');
check('composer contracts without replacing its draft',textarea().value==='Short editable draft');
setDraft('');await wait(()=>textarea().value==='','empty composer');
click(document.querySelector('.acp-artifact'));
await wait(()=>Object.keys(useApp.getState().readingSessions).length===1&&watchCount===1,'reader A');
const readerKey=Object.keys(useApp.getState().readingSessions)[0];const originalReader=useApp.getState().readingSessions[readerKey];
click(byText('引用到草稿'));await wait(()=>textarea().value.length>0,'reference draft');
click(document.querySelector('[title="展开阅读"]'));await wait(()=>document.querySelector('.acp-inspector.is-expanded'),'expanded');
const source=document.querySelector('[data-acp-source-owner]'),owner=source.dataset.acpSourceOwner,readerElement=document.querySelector('.acp-document'),body=document.querySelector('.acp-document__body');body.scrollTop=220;
const draft=textarea().value,chip=document.querySelector('.acp-source-chip').textContent;const readCount=reads;
const selection=window.getSelection();const paragraph=body.querySelector('.md p');if(paragraph){const range=document.createRange();range.selectNodeContents(paragraph);selection.removeAllRanges();selection.addRange(range)}
useApp.setState({taskExpandOrigin:{taskDir:'review',fromPage:'acp',projectRoot:root}});await wait(()=>source.inert&&document.querySelector('#outer-focus')&&escLayerCount()===0,'nested outer suspension');document.querySelector('#outer-focus').focus();
check('an inactive outer task source suspends the nested ACP layers without releasing its reader',document.querySelector('.acp-document')===readerElement&&useApp.getState().readingSessions[readerKey].displayed.revision==='A'&&watchCount===1&&unwatch.length===0&&document.activeElement.id==='outer-focus');
useApp.setState({taskExpandOrigin:null});await wait(()=>!source.inert&&!document.querySelector('.acp-inspector').inert&&escLayerCount()>0,'outer source return');
const sourceControl=byText('目录');sourceControl.focus();if(document.activeElement!==sourceControl)throw new Error('source control must be focused before the detour');
// A hidden Electron window updates activeElement without OS focusin delivery.
// Deliver that source event explicitly; the connected native gear path is checked separately.
if(!document.hasFocus())sourceControl.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
// Schedule a real portaled tooltip immediately before navigation; it must never surface in Settings.
const row=document.querySelector('[data-acp-session="session"]');row.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
document.querySelector('#settings-opener').focus();click(document.querySelector('#settings-opener'));await wait(()=>document.querySelector('[data-settings]'),'Settings');
const settingsFocus=document.querySelector('#settings-focus');settingsFocus.focus();
click(document.querySelector('[aria-label="字号：大"]'));await wait(()=>document.querySelector('.my-root').dataset.myFontSize==='large','appearance');
await new Promise(r=>setTimeout(r,380));check('retained ACP is the same inert inaccessible owner and leaks no tooltip',document.querySelector('[data-acp-source-owner]')===source&&source.hidden&&source.inert&&source.getAttribute('aria-hidden')==='true'&&!document.querySelector('[role="tooltip"]'));
const refreshed=snapshot();refreshed.tasks=[{...refreshed.tasks[0],artifacts:[{...file,mtime:2}]}];useApp.setState({snapshot:refreshed});await new Promise(r=>setTimeout(r,0));
check('an ordinary same-root snapshot refresh does not replace retained source or reader ownership',document.querySelector('[data-acp-source-owner]')===source&&document.querySelector('.acp-document')===readerElement&&Object.keys(useApp.getState().readingSessions)[0]===readerKey&&watchCount===1&&reads===readCount&&unwatch.length===0);
revision='B';receiveDocumentChanged({canonicalPath:root+'/'+path,revision:'B',kind:'change'});await wait(()=>useApp.getState().readingSessions[readerKey]?.latest?.revision==='B','hidden candidate B');
check('a material update while Settings is active retains displayed A/base and original watch',useApp.getState().readingSessions[readerKey].displayed===originalReader.displayed&&useApp.getState().readingSessions[readerKey].base===originalReader.base&&useApp.getState().readingSessions[readerKey].displayed.revision==='A'&&useApp.getState().readingSessions[readerKey].base.revision==='A'&&watchCount===1&&unwatch.length===0&&document.activeElement===settingsFocus);
click(byText('Settings menu'));await wait(()=>document.querySelector('.my-pop'),'Settings dropdown');dispatchEscKey();await wait(()=>!document.querySelector('.my-pop'),'dropdown Escape');
click(byText('Settings modal'));await wait(()=>document.querySelector('[data-settings-modal]'),'Settings modal');dispatchEscKey();await wait(()=>!document.querySelector('[data-settings-modal]'),'modal Escape');check('Settings Escape closes its own layers while ACP inspector remains retained',document.querySelector('.acp-inspector.is-expanded')!==null&&escLayerCount()===0);
useApp.getState().setPage('acp');await wait(()=>!source.hidden,'back ACP');
check('actual mount Settings round-trip preserves reader identity A/pending B expansion viewport draft/reference',document.querySelector('.acp-document')===readerElement&&document.querySelector('[data-acp-source-owner]').dataset.acpSourceOwner===owner&&useApp.getState().readingSessions[readerKey].displayed.revision==='A'&&useApp.getState().readingSessions[readerKey].latest.revision==='B'&&document.querySelector('.acp-inspector.is-expanded')!==null&&body.scrollTop===220&&textarea().value===draft&&document.querySelector('.acp-source-chip').textContent===chip&&watchCount===1&&reads===readCount+1);
check('return restores the connected source control without a later inspector autofocus override',document.activeElement===sourceControl);
// ACP's real draft replacement dialog is source-scoped: navigating away aborts it, never confirms or steals focus.
click(document.querySelector('[title="返回会话布局"]'));await wait(()=>!document.querySelector('.acp-inspector.is-expanded'),'reduce for planning');const planningButton=byText('继续完善方案');click(planningButton);await wait(()=>document.querySelector('[role="dialog"]'),'ACP confirm');const ownDialog=confirmDialog({title:'Settings independent question'});
useApp.getState().setPage('settings');await wait(()=>document.querySelector('[data-settings]'),'Settings second');document.querySelector('#settings-focus').focus();await wait(()=>document.querySelector('[role="dialog"]')?.textContent.includes('Settings independent question'),'abort only source dialog and promote unrelated');
check('inactive source aborts only its pending imperative confirmation and late completion cannot focus Settings',document.activeElement.id==='settings-focus'&&textarea().value===draft&&!document.querySelector('[role="dialog"]').textContent.includes('切换为仅规划草稿'));
dispatchEscKey();check('unrelated global Settings dialog stays independent of suspended ACP',await ownDialog===false);
const queueHead=confirmDialog({title:'Unrelated queue head'});await wait(()=>document.querySelector('[role="dialog"]')?.textContent.includes('Unrelated queue head'),'global queue head');const queuedScope=new AbortController();const queuedOwned=confirmDialog({title:'Queued owned request'},queuedScope.signal);const queueTail=confirmDialog({title:'Unrelated queue tail'});queuedScope.abort();
check('aborting a queued scoped request preserves the unrelated current dialog',await queuedOwned===false&&document.querySelector('[role="dialog"]')?.textContent.includes('Unrelated queue head'));
dispatchEscKey();await wait(()=>document.querySelector('[role="dialog"]')?.textContent.includes('Unrelated queue tail'),'global queue tail');dispatchEscKey();
check('unrelated queued dialogs each settle once and are never skipped by owned abort cleanup',await queueHead===false&&await queueTail===false);
useApp.getState().setPage('acp');await wait(()=>!source.hidden,'ACP restored');useApp.getState().setPage('channels');await wait(()=>unwatch.length===1,'other module cleanup');check('another module releases the exact reader/watch once',unwatch[0].watchId==='lease-1'&&unwatch[0].canonicalPath===root+'/'+path&&documentSessionCount()===0&&Object.keys(useApp.getState().readingSessions).length===0);
useApp.setState({page:'acp'});await wait(()=>document.querySelector('[data-acp-session="session"]'),'fresh ACP');click(document.querySelector('[data-acp-session="session"]'));await wait(()=>document.querySelector('.acp-artifact'),'fresh artifact');click(document.querySelector('.acp-artifact'));await wait(()=>watchCount===2,'fresh watch');useApp.getState().setPage('settings');await wait(()=>document.querySelector('[data-settings]'),'root detour');
await useApp.getState().openProjectPath(root);await wait(()=>unwatch.length===2,'same-root reopen');check('real same-root explicit project open replaces source via dashboard lifecycle and exact lease cleanup',useApp.getState().page==='dashboard'&&!document.querySelector('[data-acp-source-owner]')&&unwatch[1].watchId==='lease-2');
useApp.getState().setPage('acp');await wait(()=>document.querySelector('[data-acp-session="session"]'),'root replacement setup');click(document.querySelector('[data-acp-session="session"]'));await wait(()=>document.querySelector('.acp-artifact'),'root replacement artifact');click(document.querySelector('.acp-artifact'));await wait(()=>watchCount===3,'third watch');
const replacedOwner=document.querySelector('[data-acp-source-owner]').dataset.acpSourceOwner;useApp.getState().setPage('settings');await wait(()=>document.querySelector('[data-settings]'),'batched root detour');
useApp.setState({snapshot:snapshot(root+'-other')});useApp.setState({snapshot:snapshot(root)});await wait(()=>unwatch.length===3,'batched root cleanup');
check('batched A-to-B-to-A root replacement invalidates retained owner and releases its exact watch',!document.querySelector('[data-acp-source-owner]')&&unwatch[2].watchId==='lease-3'&&Object.keys(useApp.getState().readingSessions).length===0);
useApp.getState().setPage('acp');await wait(()=>document.querySelector('[data-acp-source-owner]'),'new root owner');check('return after root replacement creates a fresh source without reviving the old reader',document.querySelector('[data-acp-source-owner]').dataset.acpSourceOwner!==replacedOwner&&!document.querySelector('.acp-document')&&watchCount===3);
await wait(()=>document.querySelector('.acp-artifact'),'active replacement artifact');click(document.querySelector('.acp-artifact'));await wait(()=>watchCount===4,'active replacement watch');click(byText('继续完善方案'));await wait(()=>document.querySelector('[role="dialog"]'),'active owner confirmation');const survivingGlobal=confirmDialog({title:'Independent after owner replacement'});const activeOwner=document.querySelector('[data-acp-source-owner]').dataset.acpSourceOwner;
useApp.setState({snapshot:snapshot(root+'-other')});useApp.setState({snapshot:snapshot(root)});await wait(()=>unwatch.length===4&&document.querySelector('[data-acp-source-owner]')?.dataset.acpSourceOwner!==activeOwner,'active owner replacement');await wait(()=>document.querySelector('[role="dialog"]')?.textContent.includes('Independent after owner replacement'),'active replacement cancels only old owner dialog');
check('an active root owner replacement cancels its old scoped confirmation without cancelling the queued global request',unwatch[3].watchId==='lease-4'&&!document.querySelector('.acp-document')&&document.querySelector('[role="dialog"]').textContent.includes('Independent after owner replacement'));dispatchEscKey();if(await survivingGlobal!==false)throw new Error('surviving global confirmation should remain independently cancellable');
host.unmount();await new Promise(r=>setTimeout(r,0));useApp.setState({page:'settings'});const directHost=createRoot(document.getElementById('root'));directHost.render(<React.StrictMode><Fixture/></React.StrictMode>);await wait(()=>document.querySelector('[data-settings]'),'direct Settings visit');
check('a direct Settings visit never mounts a speculative ACP owner or reader',!document.querySelector('[data-acp-source-owner]')&&watchCount===4&&Object.keys(useApp.getState().readingSessions).length===0);
let releaseAcp;window.__acpLoadingGate=new Promise(resolve=>{releaseAcp=()=>{window.__acpLoadingGate=null;resolve()}});useApp.getState().setPage('acp');const sourceLoader=()=>document.querySelector('div.flex.h-full.w-full.items-center.justify-center.text-my-tertiary');await wait(sourceLoader,'controlled pending ACP source');
useApp.getState().setPage('settings');await wait(()=>document.querySelector('[data-settings]'),'Settings while ACP is pending');
check('a pending retained ACP import cannot leak its full-height loading fallback into Settings',!sourceLoader()&&document.querySelector('[aria-label="字号：大"]'));
releaseAcp();await wait(()=>document.querySelector('[data-acp-source-owner]')?.hidden,'hidden ACP import resolves');directHost.unmount();await new Promise(r=>setTimeout(r,0));console.log('ACP_SETTINGS_DETOUR_PASSED');window.__done=true;
}
run().catch(error=>{console.error(error.stack);window.__failed=String(error.stack);window.__done=true});`)

try {
  await build({entryPoints:[entry],outfile:join(directory,'renderer.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},nodePaths:[absolute('node_modules')],plugins:[{name:'isolated-host',setup(builder){
    builder.onResolve({filter:/.*/},args=>{
      const path=absolute(resolve(dirname(args.importer||entry),args.path))
      if(path===absolute('src/renderer/src/api'))return{path:'fixture-api',namespace:'fixture'}
      if(path===absolute('src/renderer/src/store')||path===absolute('src/renderer/src/store/index.ts'))return{path:'fixture-store',namespace:'fixture'}
      if(path===absolute('src/renderer/src/my/store')||path===absolute('src/renderer/src/my/store.ts'))return{path:'fixture-my',namespace:'fixture'}
      if(absolute(args.importer)===appFile&&args.path.includes('AcpConsole'))return{path:'fixture-acp-load',namespace:'fixture'}
      if(absolute(args.importer)===appFile&&args.path.includes('Settings'))return{path:'fixture-settings',namespace:'fixture'}
      if(absolute(args.importer)===appFile&&!args.path.includes('AcpConsole')&&(/pages\//.test(args.path)||/WorkspaceSidebar|CommandPalette/.test(args.path)))return{path:'fixture-other',namespace:'fixture'}
      if(args.path.endsWith('.css')||args.path.startsWith('@fontsource'))return{path:'fixture-style',namespace:'fixture'}
    })
    builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'tsx',resolveDir:process.cwd(),contents:args.path==='fixture-api'?'export const hasIpc=true;export const api=new Proxy({},{get:(_target,key)=>(...args)=>window.trellis[key](...args)});':args.path==='fixture-store'?storeSource:args.path==='fixture-my'?mySource:args.path==='fixture-settings'?settingsSource:args.path==='fixture-acp-load'?`import {AcpConsolePage as ActualAcpPage} from '${absolute('src/renderer/src/pages/AcpConsole.tsx')}'; export function AcpConsolePage(){if(window.__acpLoadingGate)throw window.__acpLoadingGate;return <ActualAcpPage/>}`:args.path==='fixture-other'?emptyExports.map(name=>'export const '+name+'=()=>null;').join('\n'):''}))
  }}]})
  const css=(await postcss([tailwind(tailwindConfig)]).process(['my/my-tokens.css','my/my-components.css','my/my-shell.css','styles.css','acp/workspace.css'].map(file=>readFileSync('src/renderer/src/'+file,'utf8')).join('\n'),{from:undefined})).css
  writeFileSync(join(directory,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; font-src data:"><style>${css}\nhtml,body,#root,.my-root{height:100%;margin:0}[hidden]{display:none!important}.h-full{height:100%}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.min-h-0{min-height:0}.min-w-0{min-width:0}.overflow-auto{overflow:auto}.acp-transcript{overflow-anchor:none}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>`)
  mkdirSync(join(directory,'profile'))
  writeFileSync(join(directory,'main.cjs'),`const{app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(join(directory,'profile'))});app.disableHardwareAcceleration();app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{contextIsolation:false,nodeIntegration:false}});w.webContents.on('console-message',async event=>{
    if(event.message==='ACP_TRANSCRIPT_WHEEL'){
      const point=await w.webContents.executeJavaScript("(()=>{const r=document.querySelector('.acp-transcript').getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
      w.webContents.debugger.attach('1.3');
      await w.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:180});
    }
    if(event.message.includes('PASS')||event.message.startsWith('Error:')||event.message.startsWith('ACP_KNOWLEDGE_DISCLOSURES '))console.log(event.message)
  });w.webContents.on('did-finish-load',()=>{const timer=setInterval(async()=>{const state=await w.webContents.executeJavaScript('({done:window.__done,failed:window.__failed})');if(state.done){clearInterval(timer);app.exit(state.failed?1:0)}},30)});await w.loadFile(${JSON.stringify(join(directory,'index.html'))});});setTimeout(()=>{console.error('hidden host timed out');app.exit(1)},45000);`)
  const electron=createRequire(import.meta.url)('electron')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const result=await promisify(execFile)(electron,[join(directory,'main.cjs'),'--no-sandbox'],{env,windowsHide:true,timeout:55000,maxBuffer:2*1024*1024})
  process.stdout.write(result.stdout)
  assert.ok(result.stdout.includes('ACP_SETTINGS_DETOUR_PASSED'))
} catch(error) { if(error.stdout)process.stdout.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);throw error }
finally { rmSync(directory,{recursive:true,force:true}) }
