"""Portable documentation QA only. Does not operate the product or external services."""
from pathlib import Path
import json,re,hashlib,xml.etree.ElementTree as ET,struct,sys,datetime,zipfile
P=Path(__file__).resolve().parent.parent
PACK=P.parents[2]
checks=[]
def ck(n,v):checks.append(dict(name=n,passed=bool(v)))
def read(n):return (P/n).read_text('utf-8')
req=json.loads(read('project-requirements.json'))
cases=json.loads(read('acceptance-plan.json'))
scope=json.loads(read('scope-record.json'))
old=json.loads(read('legacy-fr-disposition.json'))
evidence=json.loads(read('evidence/project-evidence.json'))['files']
ck('formal planning version',scope['version']=='0.6' and scope['publication_state']=='formal_planning_document')
ck('user direction resolved',scope['pending_decisions']==[] and scope['resolved_directions']==['D01','D02'])
ck('future task selection stays open',scope['final_schedule_locked'] is False and scope['new_product_implementation_authorized'] is False)
ck('no inherited competitor completion mandate',scope['historical_capability_coverage_is_commitment'] is False and scope['old_r0_r5_mandatory'] is False)
ck('project requirement IDs',[r['id'] for r in req]==[f'PF-{i:02}' for i in range(1,12)])
ev={e['id'] for e in evidence};ts={c['id'] for c in cases}
ck('source index unique and content-addressed',len(ev)==len(evidence) and all(re.fullmatch('[0-9a-f]{64}',e['sha256']) and e['path'] and e['anchors'] and e['limit'] for e in evidence))
ck('new acceptance cases remain not_run',len(cases)==11 and all(c['status']=='not_run' for c in cases) and len(ts)==len(cases))
for r in req:
    ck(r['id']+' evidence and acceptance refs',set(r['evidence'])<=ev and set(r['acceptance_ids'])<=ts and r['behavior'] and r['scenario'] and r['implementation_state'])
    ck(r['id']+' no new implementation authorization',r['commitment']=='proposal_or_existing_task_closure_not_new_implementation_approval')
for t in cases:ck(t['id']+' concrete case',t['requirement'] in {r['id'] for r in req} and t['given_when'] and t['expected'] and t['method'])
ck('legacy FRs are dispositions, not backlog',[o['id'] for o in old]==[f'FR-{i:03}' for i in range(1,49)] and all(o['implementation_commitment'] is False for o in old))
main=read('01-main-roadmap.md');baseline=read('02-project-baseline.md');decision=read('06-decisions-and-delivery.md');reference=read('04-scope-and-reference-decisions.md')
ck('first screen project and useful directions',main.startswith('# 基于当前项目的场景化 Roadmap') and all(x in main[:1600] for x in ['已有','AI会话','用户偏好','独立选择']) and '64' not in main[:1400])
ck('no unresolved priority gate',all(x not in main+decision for x in ['两项方向选择等待','待定选择','等待用户优先级','待用户决定']) and '最终排期' in main)
ck('local preference and optional collaboration','本机使用' in main and '跨设备协作' in main and '后续可选场景' in main)
ck('existing ACP and weekly work not reset','已接入acpx' in main and '自然周已实现' in reference)
ck('developer tools independently selectable','无需等待ACP、多人审批或新团队后端' in main and '不依赖Hifox或共享审批' in reference)
ck('candidate corrections not reproduced or fixed',all(i in baseline for i in ['F01','F02','F03','VF01','VF02','VF03']) and '尚未执行' in baseline and '未被称作本轮产品复现或已修复' in baseline)
ck('scenarios specify behavior and outcome',all(k in main for k in ['现在怎么做','哪里卡住','改什么','改完怎么用','完成标准','依赖','不做']))
ck('competitor expansion may remain unadopted','允许以后仍不采用' in reference and '没有64能力全覆盖目标' in reference)
ck('old tests are not new obligations','旧48条FR及244+12条用例保持历史' in read('03-requirements-and-acceptance.md'))
ck('estimates not fabricated','不沿用旧22工作包的人日总和' in decision and '不继续冒充团队承诺' in decision)
ck('latest human direction recorded',json.loads(read('evidence/user-directions.json'))['id']=='U01')
for p in P.glob('*.md'):
    s=p.read_text('utf-8');ck(p.name+' UTF8','\ufffd' not in s)
    ck(p.name+' relative links resolve',all(x.startswith(('https://','http://','#')) or (P/x.split('#')[0]).exists() for x in re.findall(r'\]\(([^)]+)\)',s)))
idx=json.loads(read('diagrams/index.json'))
ck('four editable current/proposed diagrams',len(idx)==4 and sum(x['type']=='proposal_not_implemented' for x in idx)==1)
for x in idx:
    s=read(x['svg']);tree=ET.fromstring(s)
    ck(x['id']+' real SVG text',tree.tag.endswith('svg') and '<text' in s and 'foreignObject' not in s and 'Syntax error' not in s)
    b=(P/x['png']).read_bytes();w,h=struct.unpack('>II',b[16:24])
    ck(x['id']+' PNG rendered',b[:8]==b'\x89PNG\r\n\x1a\n' and 300<w<10000 and 300<h<10000)
    ck(x['id']+' editable source',(P/x['source']).is_file())
proposed=read('diagrams/C02-proposed-flow.mmd')
ck('dependency diagram keeps options open','用户偏好' in proposed and '可独立选择' in proposed and '以后有真实需要' in proposed and '不预定自建服务' in proposed and '待用户决定' not in proposed)
report=read('Trellis-Project-Roadmap.html')
ck('self contained formal reading core','v0.6 正式规划' in report and '<script src=' not in report and report.count('<svg')==4 and report.count('<details')==9)
ck('plain scenarios first','先看当前项目和可规划方向' in report and report.index('id="doc-01"')<report.index('id="doc-02"'))
ck('old plans not embedded in current HTML','FR-001' in report and '64项研究覆盖不构成必建清单' in report and 'Trellis 完整需求与数据控制模型' not in report)
pres=json.loads(read('checks/preservation-baseline.json'))
ck('root current entry',(PACK/'docs/roadmap.md').read_text('utf-8').startswith('# 基于当前项目的场景化 Roadmap'))
ck('old root byte-preserved',hashlib.sha256((P/'history/roadmap-before-v0.6.md').read_bytes()).hexdigest()==pres['root_roadmap_sha256'])
ck('old plans archived, not current appendices','不构成现行必建清单' in read('HISTORICAL-REFERENCE.md') and '历史ZIP' in decision and '现行附录' in decision)
with zipfile.ZipFile(P/'history/hifox-v0.5.1.zip') as z:
    ck('historical archive CRC',z.testzip() is None)
    for rel,sha in pres['historical_files'].items():
        name=rel.removeprefix('docs/proposals/2026-10-15-hifox-roadmap/')
        ck('historical bytes '+name,hashlib.sha256(z.read(name)).hexdigest()==sha)
print(f'{sum(c["passed"] for c in checks)}/{len(checks)} planning-document checks passed')
for c in checks:
    if not c['passed']:print('FAIL',c['name'])
print('Planning document complete; implementation selection belongs to user; product cases not_run.')
if '--record' in sys.argv:
    (P/'checks/document-validation.json').write_text(json.dumps(dict(version='0.6',at=datetime.datetime.now(datetime.timezone.utc).isoformat(),checks=checks,passed=sum(c['passed'] for c in checks),total=len(checks),product_cases='not_run',implementation_authorized=False),ensure_ascii=False,indent=2),encoding='utf-8')
raise SystemExit(0 if all(c['passed'] for c in checks) else 1)
