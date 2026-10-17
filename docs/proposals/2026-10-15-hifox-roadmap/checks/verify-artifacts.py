"""Read-only v0.5.1 artifact/contract consistency checks; not product execution tests."""
from pathlib import Path
import json,re,xml.etree.ElementTree as ET,struct,csv,hashlib,sys,datetime
P=Path(__file__).resolve().parent.parent
checks=[]
def ck(n,v,detail=''): checks.append(dict(name=n,passed=bool(v),detail=detail))
def read(n):return (P/n).read_text(encoding='utf-8')
req=json.loads(read('requirements.json'));cases=json.loads(read('test-cases.json'));contract=json.loads(read('model-contracts.json'));states=json.loads(read('state-transitions.json'))
ck('48 stable FR IDs',[r['id'] for r in req]==[f'FR-{i:03}' for i in range(1,49)])
ck('64 original capabilities mapped',{c for r in req for c in r['capabilities']}=={f'C{i:02}' for i in range(1,65)})
ids={t['id'] for t in cases};ck('test IDs unique',len(ids)==len(cases))
ck('all product test statuses honest',all(t['status']=='not_run' for t in cases))
for r in req:
    ck(r['id']+' obligation/test mapping',len(r['obligations'])==4 and all(o['test_ids'] and set(o['test_ids'])<=ids for o in r['obligations']) and set(r['test_ids'])<=ids)
    ck(r['id']+' ownership and cases resolve',all(next(t for t in cases if t['id']==i)['requirement']==r['id'] for o in r['obligations'] for i in o['test_ids']))
    ck(r['id']+' cases have input outcome method',all(t['given_when'] and t['expected'] and t['method'] for t in cases if t['requirement']==r['id']))
catalog=read('13-test-catalog.md');trace=read('10-acceptance-and-traceability.md');prd=read('07-product-requirements.md');model=read('09-data-and-control-model.md');plan=read('11-phased-delivery-plan.md')
ck('every case in detailed catalog',all('| '+i+' |' in catalog for i in ids))
ck('every FR has concrete trace',all(r['id'] in trace and all(i in trace for o in r['obligations'] for i in o['test_ids']) for r in req))
ck('CSV and JSON agree',list(csv.DictReader((P/'test-cases.csv').open(encoding='utf-8-sig',newline='')))==cases)
ck('owner exception and hard gates',contract['owner']['nullable_in']==['draft','unassigned_intake'] and set(contract['owner']['required_for'])=={'formal_requirement_review','plan_approval','implementation','agent_execution'} and '草稿/未分配接入项允许ownerId=null' in prd)
ck('approval unit not mutable document',contract['approval']['unit']=='RequirementRevision' and contract['approval']['changed_revision_inherits'] is False)
ck('unchanged reuse has explicit guard',all(s in contract['approval']['unchanged_reuse'] for s in ['same revision','effective approval','unaffected','unchanged scope']))
ck('AP partial concurrent withdraw covered',all(f'AP{i:02}' in ids for i in range(1,9)) and all(s in model for s in ['RequirementDependency','ImpactAssessment','expectedManifestRevision','Withdrawal','undecided','partial']))
er=read('diagrams/05-core-entities.mmd')+read('diagrams/05b-approval-testing.mmd')
for snippet in ['WorkItem o|--o{ Session','Session ||--o{ Run','Run o|--o{ Evidence','Acceptance ||--o{ AcceptanceEvidence','Evidence ||--o{ AcceptanceEvidence','WorkItem ||--o{ SourceRef','RequirementRevision ||--o{ RequirementTestCoverage','TestCaseRevision ||--o{ RequirementTestCoverage','AuthorizationGrant }o--o{ AuthorizationDecision','Run o|--o{ AuthorizationDecision']:
    ck('ER '+snippet,snippet in er)
ck('canonical source list and derived run scope','sourceRefs:ref[]' in model and 'Run.workItemId == Session.workItemId'==contract['run_task_invariant'].split(';')[0])
ck('evidence does not own single acceptance',any(x.get('join')=='AcceptanceEvidence' and x.get('forbidden_field')=='Evidence.acceptanceId' for x in contract['cardinalities']))
ck('ST01-ST21 complete',[x['id'] for x in states]==[f'ST{i:02}' for i in range(1,22)])
for s in states:
    ck(s['id']+' table and test synchronized',all(s[k] in model for k in ['transition','event_actor','guard','effects_lease_recovery']) and next(t for t in cases if t['id']==s['id'])['expected']==s['effects_lease_recovery'])
normal=read('diagrams/06-run-state.mmd');recovery=read('diagrams/06b-run-recovery.mmd')
for state in ['preflight','queued','starting','waiting']:
    ck('cancel path '+state,bool(re.search(r'\b'+state+r' --> (cancelled|stopping)',normal)))
ck('unknown exits shown','unknown --> active' in recovery and 'unknown --> terminal' in recovery)
ck('hold pause fallback guarded',all(s in model for s in ['controlHold','不支持','executionIntent=resume_existing','ST21','resultDeliveryState=pending/failed']))
ck('v041 changed input waits stop confirmation','paused --> stopping: ST15' in recovery and 'paused --> stopped' not in recovery and all(x in next(s for s in states if s['id']=='ST15')['effects_lease_recovery'] for x in ['停止确认前保留旧lease','不执行关联新run','ST19','ST18','unknown']))
ck('v041 hold disconnect and lost pause ack','hold_requested→unknown' in next(s for s in states if s['id']=='ST16')['transition'] and 'hold_requested --> unknown' in recovery and all(x in next(s for s in states if s['id']=='ST16')['effects_lease_recovery'] for x in ['requestedControl','保留controlHold和旧lease','证实paused','回hold_requested','保持unknown']))
ck('v041 stop timeout keeps lease',all(x in next(s for s in states if s['id']=='ST19')['effects_lease_recovery'] for x in ['停止超时','ST16','保留controlHold和旧lease','禁止直接stopped']))
ck('v041 recovery has no implied resume',all(x in next(s for s in states if s['id']=='ST17')['effects_lease_recovery'] for x in ['无hold','hold_requested','保留旧lease','不启动关联新run']))
road=read('diagrams/07-roadmap-dependencies.mmd')
ck('developer branch optional no R4 prerequisite','-. 可独立启用 .-> Dev' in road and not re.search(r'\bDev\s*[-.=]+>',road) and not contract['delivery']['developer_tools_required_for_R4'])
ck('R1 manual and R4 increment explicit',all(x in plan for x in ['R1必须具备的手工能力','R4新增能力','可以完全不写外部系统' if '可以完全不写外部系统' in plan else '可完全不写外部系统','recoveryOwner','另一设备']))
ck('22 work packages and decision deadlines',all(f'W{i:02}' in plan for i in range(22)) and '最晚门槛' in plan and 'M/C/O' in plan)
ck('NFR gates explicit',all(f'NF{i:02}' in ids for i in range(1,16)) and '非功能门槛' in plan and 'R1' in plan and 'R4' in plan)
ck('conditional auth and offline boundary',all(s in model for s in ['ApplicableChecks','不要求机器','离线不能新增','已下载','无法由本产品保证远程收回']))
dfd=read('diagrams/03-layered-dfd.mmd')+read('diagrams/03b-execution-dfd.mmd');context=read('diagrams/02-context-dfd.mmd')
for ext in ['真人','本地Trellis与Git源','共享身份与材料服务','Jira等任务来源','Git CI 构建平台','成员电脑与Runtime','模型服务']:
    ck('DFD external coverage '+ext,ext in context and ext in dfd)
for flow in ['显式发布内容与决定','权限 版本 决定响应','读取与受控写入','固定输入与本次指令','事件 结果 权限请求','授权上下文与模型请求','模型输出与用量','授权查询与逐字段动作','需求 身份 基线 回执','授权查询与关联','提交 构建 发布事实']:
    ck('DFD balanced '+flow,flow in dfd and (flow in context or flow=='读取与受控写入'))
ck('DFD decomposition port balanced',dfd.count('端口A')>=2 and 'A -->|可核实运行与外部事实| P5' in dfd)
business=read('diagrams/01-business-flow.mmd')
ck('business failures correctly routed',all(s in business for s in ['J -- 实现失败 --> H','J -- 方案缺陷 --> F','J -- 需求变化 --> K','J -- 环境阻塞或未运行 --> L','N -- 不需要 --> Z']))
idx=json.loads(read('diagrams/index.json'))
for d in idx:
    file=P/d['svg']
    try:valid=ET.parse(file).getroot().tag.endswith('svg') and 'Syntax error' not in file.read_text(encoding='utf-8')
    except Exception:valid=False
    ck(d['id']+' SVG parseable',valid)
    ck(d['id']+' editable source',(P/d['source']).exists())
    try:
        b=file.with_suffix('.png').read_bytes();w,h=struct.unpack('>II',b[16:24]);v=b[:8]==b'\x89PNG\r\n\x1a\n' and w>300 and h>100
    except Exception:v=False
    ck(d['id']+' PNG valid',v)
for n in ['06-research-and-evidence.md','07-product-requirements.md','08-journeys-and-ux.md','09-data-and-control-model.md','10-acceptance-and-traceability.md','11-phased-delivery-plan.md','12-decisions-and-research-gaps.md','13-test-catalog.md','14-review-resolution.md']:
    s=read(n);ck(n+' UTF8','\ufffd' not in s)
    ck(n+' links resolve',all(x.startswith(('http://','https://','#')) or (P/x.split('#')[0]).exists() for x in re.findall(r'\]\(([^)]+)\)',s)))
ck('PH47 source trace retained',all(f'PH{i:02}' in trace for i in range(1,48)))
research=read('06-research-and-evidence.md')
ck('UI coverage remains bounded','19张' in research and '原生' in research and all(f'U{i:02}' in research for i in range(1,23)))
ck('wireframes concepts explicit','布局概念' in read('diagrams/W01-task-workspace.svg') and '布局概念' in read('diagrams/W02-review.svg'))
report=read('Trellis-Requirements.html')
ck('HTML diagrams and all cases',report.count('<svg')==len(idx) and all(i in report for i in ids))
ck('HTML standalone','<script src=' not in report and 'v0.5' in report)
ck('parent original retained',hashlib.sha256((P/'research/parent-official-research.md').read_bytes()).hexdigest()=='7732a92652ae8ee461b2f47ee664320bb2b44919fcc9ec434961da5044cfcec3')

ui=json.loads(read('evidence/ui-evidence.json'));coverage=json.loads(read('evidence/ui-coverage.json'));ux=json.loads(read('ux-acceptance.json'))
uiids={x['id'] for x in ui};uxids={x['id'] for x in ux};frids={r['id'] for r in req}
ck('UI counts bounded',len(ui)==25 and sum(bool(x.get('accepted')) for x in ui)==19)
ck('Coverage 22 partial rows',[c['id'] for c in coverage]==[f'U{i:02}' for i in range(1,23)] and all(c['status'] in ['observed_partial','structure_only','not_observed'] and c['verified_boundary'] for c in coverage))
ck('Coverage evidence resolves',all(set(c['evidence'])<=uiids for c in coverage))
for x in ui:
    if x.get('accepted'):
        f=P/x['file'];b=f.read_bytes()
        ck(x['id']+' accepted image and fingerprint',f.exists() and b[:2]==b'\xff\xd8' and hashlib.sha256(b).hexdigest()==x['sha256'])
    else:ck(x['id']+' honest structure-only',x['file'] is None and x['observation_level']=='structure_only')
    ck(x['id']+' classification and limitation',bool(x['limits'] and x['privacy'] and x['maps']))
ck('No private captures packaged',not any('private' in f.relative_to(P).parts or f.name.startswith('rejected-') for f in P.rglob('*') if f.is_file()))
ck('UX acceptance 12 stable IDs',[u['id'] for u in ux]==[f'UXAC{i:02}' for i in range(1,13)] and all(u['status']=='not_run' for u in ux))
ck('UX trace complete',all(set(u['evidence'])<=uiids and set(u['requirements'])<=frids and u['given_when'] and u['expected'] and u['method'] for u in ux))
ck('FR UI and UX refs resolve',all(set(r['ui_evidence'])<=uiids and set(r['ux_acceptance_ids'])<=uxids for r in req))
audit=read('15-hifox-uiux-audit.md');design=read('16-ui-derived-design-contracts.md')
ck('Each UI record narrated',all(x['id'] in audit for x in ui))
ck('Each UX case and D10-12 narrated',all(u['id'] in design for u in ux) and all(f'D{i}' in design for i in range(10,13)))
for n in ['15-hifox-uiux-audit.md','16-ui-derived-design-contracts.md']:
    v=read(n);ck(n+' UTF8','\ufffd' not in v)
    ck(n+' local links resolve',all(x.startswith(('http://','https://','#')) or (P/x.split('#')[0]).exists() for x in re.findall(r'\]\(([^)]+)\)',v)))
ck('Standalone embeds all actual UI screenshots',all(x['id'] in report for x in ui) and report.count('data:image/jpeg;base64,')==19)
ck('Core v041 contracts unchanged',hashlib.sha256((P/'model-contracts.json').read_bytes()).hexdigest()=='6d7d2a1426d742c5cb5cc93b40eee9c80f8b21f9c3227ea8729db71beed894cd' and hashlib.sha256((P/'state-transitions.json').read_bytes()).hexdigest()=='65f02eb7ade03396635cbbda27aff8dcacc2d996b307422e21f34dbdc1743341')

# v0.5.1: viewport metadata must not be inferred by PNG offsets on JPEG data.
def jpeg_size(b):
    if b[:2]!=b'\xff\xd8':raise ValueError('not JPEG')
    p=2
    while p<len(b):
        while p<len(b) and b[p]!=255:p+=1
        while p<len(b) and b[p]==255:p+=1
        if p>=len(b):break
        marker=b[p];p+=1
        if marker in (0xd8,0x01) or 0xd0<=marker<=0xd7:continue
        if marker in (0xd9,0xda):break
        size=int.from_bytes(b[p:p+2],'big');p+=2
        if size<2:raise ValueError('invalid segment')
        if marker in (0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf):
            return int.from_bytes(b[p+3:p+5],'big'),int.from_bytes(b[p+1:p+3],'big')
        p+=size-2
    raise ValueError('JPEG dimensions missing')

for e in ui:
    if e.get('accepted'):
        w,h=jpeg_size((P/e['file']).read_bytes());vp=e['viewport'];im=e['image_size']
        ck(e['id']+' reasonable CSS viewport',all(isinstance(vp[k],int) and 200<=vp[k]<=16384 for k in ['width','height']))
        ck(e['id']+' image dimensions match JPEG',im==dict(width=w,height=h) and 1<=w<=16384 and 1<=h<=16384)
        ck(e['id']+' explicit viewport versus crop',e['capture_kind']==('viewport' if (w,h)==(vp['width'],vp['height']) else 'viewport_crop') and e['viewport_unit'].startswith('CSS') and e['image_size_unit'].startswith('encoded'))
ck('UI03 corrected actual viewport',next(e for e in ui if e['id']=='UI03-agent-search-empty')['viewport']==dict(width=1000,height=900))
u08=next(c for c in coverage if c['id']=='U08');u06=next(e for e in ui if e['id']=='UI06-conversation-controls')
ck('U08 direct evidence remains structure only',u08['status']=='structure_only' and all(not next(e for e in ui if e['id']==i).get('accepted') for i in u08['evidence']) and 'U08' not in u06['maps'] and u08['related_entry_references']==['UI06-conversation-controls'])
ck('No unrelated image upgrades coverage',all(c['status']!='observed_partial' or any(e.get('accepted') and c['id'] in e['maps'] and e['id'] in c['evidence'] for e in ui) for c in coverage))
covcsv=list(csv.DictReader((P/'evidence/ui-coverage.csv').open(encoding='utf-8-sig',newline='')))
ck('UI CSV and JSON status and evidence agree',all(next(row for row in covcsv if row['id']==c['id'])['status']==c['status'] and next(row for row in covcsv if row['id']==c['id'])['evidence']=='; '.join(c['evidence']) for c in coverage))
phases=[u for u in ux if u['id'] in ['UXAC01','UXAC02','UXAC04','UXAC06','UXAC11']]
ck('Cross-stage UX cannot close on static fixtures',len(phases)==5 and all(u['phase_assertions']['static_fixture_can_close_full_case'] is False and u['phase_assertions']['status']=='not_run' and u['phase_assertions']['later_dependencies'] for u in phases))
ck('UXAC01 full gate R3/R4 explicit','完整UXAC01必须在R3/R4' in design and '禁止用R0静态夹具提前关闭' in design and 'UXAC01/02/04/06/11纳入W00/W01可信基础' not in design)
print(f'{sum(x["passed"] for x in checks)}/{len(checks)} artifact/contract checks passed')
for c in checks:
    if not c['passed']:print('FAIL',c['name'],c['detail'])
print('244 original product cases plus 12 proposed UX cases remain not_run; competitor web observations are bounded.')
if '--record' in sys.argv:
    (P/'checks/validation.json').write_text(json.dumps(dict(version='0.5.1',at=datetime.datetime.now(datetime.timezone.utc).isoformat(),checks=checks,passed=sum(x['passed'] for x in checks),total=len(checks),product_tests='not_run',UI='19_screenshot_25_observations_22_partial_rows'),ensure_ascii=False,indent=2),encoding='utf-8')
raise SystemExit(0 if all(x['passed'] for x in checks) else 1)
