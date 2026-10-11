'use strict';

(() => {
  const STORAGE_KEY = 'trellis-team-local-prototype-v1';
  const roles = { pm: ['产品 · 小林', '林'], dev: ['开发 · 小周', '周'], qa: ['验收 · 小陈', '陈'], maint: ['规范维护 · 阿宁', '宁'] };
  const views = { inbox: ['我的工作', '☷'], brief: ['需求空间', '▤'], engineering: ['本地开发', '⌘'], delivery: ['交付与验收', '✓'], knowledge: ['知识与规范', '◇'] };
  const allowedViews = { pm: ['inbox', 'brief', 'delivery', 'knowledge'], dev: ['inbox', 'brief', 'engineering', 'delivery', 'knowledge'], qa: ['inbox', 'brief', 'delivery', 'knowledge'], maint: ['knowledge', 'inbox'] };
  const criteria = ['重复请求不会产生第二笔退款', '超过重试上限后明确提示人工处理', '客服能查看本次重试的业务结果', '原交易处于处理中时，先查询，不重复发起'];
  const baseGoal = '支付网关超时后，客服可以对失败的退款单再次发起处理，减少人工联系研发的次数。';
  const originalScope = '在客服后台提供重试入口。历史订单是否支持，交给开发结合当前项目评估。';
  const confirmedScope = '本次只支持新创建的退款单；历史订单继续走人工处理。处理中先查询原交易，不能新建第二笔退款。';
  const makeRevision = (version, scope, extra = false) => ({ version, goal: baseGoal, scope, criteria: extra ? [...criteria, '客服可以查看失败原因和下一步建议'] : [...criteria] });
  function fixture(kind) {
    const s = { schema: 1, role: 'pm', view: 'brief', scenario: kind, title: '退款失败后，允许安全重试', draftGoal: baseGoal, draftScope: originalScope, revisions: [], published: false, claimed: false, bound: false, analyzed: false, feedback: false, resolved: false, adopted: 0, plan: false, confirmed: false, running: false, checked: false, merged: false, offline: false, publication: null, acceptance: [], accepted: false, rejectReason: '', jira: 'waiting', archived: false, rule: 'none', ruleAdopted: false, doc: 'prd', messages: [], changeNote: '', agent: 'Codex（本机已有配置）' };
    if (kind !== 'discovery') Object.assign(s, { role: 'dev', view: 'engineering', published: true, revisions: [makeRevision(1, originalScope), makeRevision(2, confirmedScope)], draftScope: confirmedScope, claimed: true, bound: true, analyzed: true, resolved: true, adopted: 2, plan: true });
    if (kind === 'change') Object.assign(s, { revisions: [...s.revisions, makeRevision(3, confirmedScope + ' 新增：展示失败原因和下一步建议。', true)], draftScope: confirmedScope + ' 新增：展示失败原因和下一步建议。', confirmed: true, running: true });
    if (kind === 'offline') Object.assign(s, { confirmed: true, running: true, offline: true });
    if (kind === 'delivery') Object.assign(s, { role: 'qa', view: 'delivery', confirmed: true, checked: true, merged: true, publication: { version: 1, briefVersion: 2, criteria: [...criteria], summary: '已完成新退款单的重试能力；处理中先查询原交易，历史订单仍走人工处理。', evidence: true, technical: false }, acceptance: criteria.map(() => false) });
    return s;
  }
  let state = fixture('discovery');
  try { const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); if (saved?.schema === 1 && roles[saved.role] && Array.isArray(saved.revisions) && Array.isArray(saved.messages)) state = saved; } catch { /* File-mode storage may be unavailable. */ }
  const main = document.getElementById('main');
  const dialog = document.getElementById('dialog');
  const toast = document.getElementById('toast');
  let toastTimer;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const latest = () => state.revisions.at(-1)?.version || 0;
  const currentBrief = () => state.revisions.at(-1) || makeRevision(0, state.draftScope);
  const adoptedBrief = () => state.revisions.find(r => r.version === state.adopted) || currentBrief();
  const stale = () => state.adopted > 0 && latest() > state.adopted;
  const badge = (text, tone = '') => `<span class="badge ${tone}">${esc(text)}</span>`;
  const button = (text, action, type = '', disabled = false) => `<button type="button" class="${type}" data-action="${action}" ${disabled ? 'disabled' : ''}>${esc(text)}</button>`;
  function persist() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Keep this browser session usable. */ } }
  function notify(message) { toast.textContent = message; toast.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 4600); }
  function modal(title, body, footer = '') { document.getElementById('dialog-title').textContent = title; document.getElementById('dialog-body').innerHTML = body; document.getElementById('dialog-footer').innerHTML = footer || button('知道了', 'close-dialog', 'primary'); if (!dialog.open) dialog.showModal(); }
  function go(view) { if (allowedViews[state.role].includes(view)) { state.view = view; render(); persist(); window.scrollTo(0, 0); } }
  function stage() { if (state.archived) return '已归档'; if (state.accepted) return '业务已验收'; if (state.publication) return '待验收'; if (state.checked) return '等待发布交付'; if (state.running) return '本地实施中'; if (state.plan) return '工程规划中'; if (state.feedback && !state.resolved) return '待产品澄清'; if (state.analyzed) return '项目分析完成'; if (state.claimed) return '开发评估中'; return state.published ? '待开发领取' : '业务澄清中'; }
  function heading(title, subtitle, actions = '', eyebrow = '支付产品组 / PAY-128 · 示例工单') { return `<div class="heading"><div class="heading-copy"><div class="eyebrow">${eyebrow}</div><h1>${esc(title)}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`; }
  function listCriteria(items = criteria) { return `<ul class="criteria">${items.map((c, i) => `<li><span class="criterion-id">AC-${i + 1}</span><span>${esc(c)}</span></li>`).join('')}</ul>`; }
  function publicProgress() { return `<div class="info-grid"><div class="info-item"><small>业务阶段</small>${stage()}</div><div class="info-item"><small>需求版本</small>${state.published ? `已发布 v${latest()}` : '未发布草稿'}</div><div class="info-item"><small>开发负责人</small>${state.claimed ? '小周 · 已领取' : '小周 · 待领取'}</div></div>`; }

  function inbox() {
    const msg = state.role === 'pm' ? (state.feedback && !state.resolved ? '开发提出了一个范围问题，等待你的回复' : '把需求说明整理成可交接的业务简报') : state.role === 'dev' ? (state.published ? '阅读需求、领取任务，再到自己的电脑评估' : '需求仍在澄清，发布后再领取') : state.role === 'qa' ? (state.publication ? '有一份交付包等待验收' : '尚无可验收的交付包') : '查看待发布的规范提案';
    const target = state.role === 'dev' ? 'engineering' : state.role === 'qa' ? 'delivery' : state.role === 'maint' ? 'knowledge' : 'brief';
    return heading('今天需要你处理', '只把需要人作出判断的事项放在这里。') + `<button type="button" class="inbox-card" data-view="${target}"><div><div class="eyebrow">PAY-128 · 退款重试</div><strong>${msg}</strong><small>产品小林 · 开发小周 · 验收小陈</small></div>${badge(stage(), 'blue')}</button>` + publicProgress() + `<div class="panel"><h2>任务如何在团队中流动</h2><div class="flow-strip"><span>产品澄清</span> → <span>发布给真人</span> → <span>开发本机评估</span> → <span>工程规划与实施</span> → <span>发布成果与验收</span></div><p class="muted">收到任务与启动 Agent 是两个独立动作。工作进展来自明确回执，共享内容由开发选择。</p></div>`;
  }

  function brief() {
    const pm = state.role === 'pm';
    const b = currentBrief();
    const feedback = state.feedback ? `<div class="note ${state.resolved ? 'good' : 'warn'}"><strong>${state.resolved ? '范围问题已回复' : '开发反馈 · 需要确认历史订单范围'}</strong><p>${state.resolved ? '本次只支持新退款单；历史订单保留人工处理。开发仍需明确采用这一版本。' : esc(state.feedbackText || '小周结合本地项目发现：历史订单缺少重试识别信息。是否先只支持新创建的退款单？代码证据保留在开发本机。')}</p>${pm && !state.resolved ? `<div class="actions">${button('确认仅支持新单并发布修订', 'resolve', 'small')}</div>` : ''}</div>` : '';
    const pmActions = pm ? button('保存草稿', 'save-brief') + button(state.published ? '发布新版本' : '发布给开发', 'publish-brief', 'primary') : '';
    const body = pm ? `<label class="field"><span>业务目标</span><textarea id="brief-goal" data-field="draftGoal">${esc(state.draftGoal)}</textarea></label><label class="field"><span>范围与边界</span><textarea class="long" id="brief-scope" data-field="draftScope">${esc(state.draftScope)}</textarea></label>` : `<h3>业务目标</h3><p class="read-only">${esc(b.goal)}</p><h3>范围与边界</h3><p class="read-only">${esc(b.scope)}</p>`;
    const chat = pm ? `<aside class="panel soft"><div class="panel-head"><h2>一起把需求说清楚</h2>${badge('需求助手', 'good')}</div><div class="assistant-label"><span class="assistant-dot"></span>仅参考授权知识 · 尚未读取代码</div><div class="chat-entry"><strong>需求助手 · 示例回答</strong><p>从已发布的退款业务规则来看，需要明确“处理中”的处理方式，以及历史订单是否在本次范围内。</p><p>我可以先整理业务验收项；历史数据与现有实现是否支持，需要开发评估。</p><div class="source-chips">${button('退款业务规则 v5', 'source-rule', 'source-chip')}${button('项目能力卡 · 10/08', 'source-card', 'source-chip')}</div>${button('采用验收建议', 'suggest-criteria', 'small')}</div>${state.messages.map(m => `<div class="chat-entry user"><strong>小林</strong><p>${esc(m)}</p></div><div class="chat-entry"><strong>需求助手 · 演示回复</strong><p>已记录补充。建议把它写入业务范围，并将涉及当前实现的部分保留为开发待核实事项。</p></div>`).join('')}<div class="compose"><label for="chat-input" class="hint">补充一个使用场景或限制</label><textarea id="chat-input" placeholder="例如：客服能看到失败原因，但不能重复退款"></textarea><div class="actions"><span class="hint">只演示讨论，不调用模型</span>${button('发送', 'send-chat', 'small')}</div></div></aside>` : `<aside class="panel soft"><h2>业务材料与公开进展</h2><dl class="detail-list"><dt>最新发布</dt><dd>${state.published ? `Brief v${latest()}` : '尚未发布'}</dd><dt>业务指派</dt><dd>小周 · 开发员工</dd><dt>当前阶段</dt><dd>${stage()}</dd><dt>共享成果</dt><dd>${state.publication ? `交付包 v${state.publication.version}` : '尚未发布'}</dd></dl><div class="note">本页显示团队可见的需求与反馈。工程文档在开发本机，按选择发布副本。</div>${state.role === 'dev' ? `<button type="button" class="primary" data-view="engineering">到我的本地工作台</button>` : ''}</aside>`;
    return heading(state.title, '先确认要解决的业务问题，再由开发结合真实项目评估。', pmActions) + `<div class="meta">${badge(state.published ? `已发布 v${latest()}` : '未发布草稿', 'blue')}<span>负责人：小林</span><span>接收人：小周</span><span>本阶段材料：需求简报</span></div><div class="section-spacer"></div>${feedback}<div class="two-columns"><section class="panel"><div class="panel-head"><h2>${pm ? '需求简报 · 可编辑草稿' : '需求简报'}</h2>${badge('业务资料')}</div>${body}<h3>期望怎样验收</h3>${listCriteria(state.published ? b.criteria : criteria)}<div class="note warn"><strong>待项目核实</strong><br>${state.resolved ? '产品已确认仅支持新退款单；具体方案由开发在本机形成。' : '当前代码是否具备重试标识、历史订单兼容成本，需要开发结合项目评估。'}</div><div class="footer-caption">发布记录可追溯；本简报不代表 Trellis 工程规划已经完成。</div></section>${chat}</div>`;
  }

  function engineering() {
    if (!state.published) return heading('我的本地开发', '任务由你领取，项目和 Agent 由你在自己的电脑上选择。') + `<div class="empty"><div class="empty-icon">◇</div><h2>需求还未发布</h2><p>产品经理仍在澄清业务。此时不会替你创建工程任务，也不会启动 Agent。</p><button type="button" data-view="brief">查看需求草稿</button></div>`;
    const header = heading(state.title, `我的本机 · 需求最新 v${latest()}${state.adopted ? ` / 当前工程采用 v${state.adopted}` : ''}`, state.running ? button('暂停本地执行', 'pause') : '', '开发工作台 / PAY-128');
    if (!state.claimed) return header + `<div class="panel"><div class="panel-head"><h2>先领取这项工作</h2>${badge('指派给小周', 'blue')}</div><p>${esc(currentBrief().goal)}</p><div class="note">领取只确认责任人。你可以先评估、反馈问题，再决定何时进入工程规划。</div>${button('领取任务', 'claim', 'primary')}</div>`;
    if (!state.bound) return header + `<div class="empty"><div class="empty-icon">⌘</div><h2>已领取，尚未绑定本地项目</h2><p>选择你的工作目录后才能结合代码评估。本地路径只保存在这台电脑上。</p>${button('绑定本地项目', 'bind', 'primary')}</div>`;
    const localInfo = `<div class="meta">${badge('本机项目：payment-service', 'good')}<span>分支：feature/refund-retry</span><span>${esc(state.agent)}</span>${button('本机工具设置', 'local-settings', 'subtle small', state.running)}</div><div class="section-spacer"></div>`;
    if (!state.analyzed) return header + localInfo + `<div class="panel"><h2>结合当前项目做一次评估</h2><p>先读取业务简报、项目约定与当前实现。这个动作不授权修改业务代码。</p><div class="flow-strip"><span>Brief v${latest()}</span> → <span>本机项目上下文</span> → <span>可行性与待确认问题</span></div>${button('开始只读项目分析', 'analyze', 'primary')}</div>`;
    if (!state.plan) return header + localInfo + `<div class="two-columns"><section class="panel"><div class="panel-head"><h2>项目分析结果</h2>${badge('本机私有材料', 'good')}</div><div class="decision"><strong>新退款单可以支持重试</strong><small>可以基于现有退款标识做幂等判断。</small></div><div class="decision"><strong>历史订单需要明确范围</strong><small>当前历史数据缺少部分识别信息；应先向产品确认。</small></div><div class="note ${state.resolved ? 'good' : 'warn'}">${state.resolved ? `产品已回复，Brief v${latest()}：本次只支持新退款单。采用后才能继续工程规划。` : '先把业务影响说明给产品。具体文件和原始分析日志留在本机。'}</div><div class="actions">${state.resolved ? button(`采用 v${latest()} 并创建工程规划`, 'create-plan', 'primary') : button(state.feedback ? '反馈已发出，等待回复' : '预览并发送业务反馈', 'feedback', 'primary', state.feedback)}</div></section><aside class="panel soft"><h2>工程材料</h2><p class="muted">尚未形成正式工程 PRD 与 design。</p><p class="hint">原生 Trellis 创建任务时可能先生成骨架；空文件不会被标记为“规划已完成”。</p>${button('查看本地分析依据', 'analysis-detail', 'small')}</aside></div>`;
    const changed = stale() ? `<div class="note warn"><strong>需求已更新到 v${latest()}，本次工程仍采用 v${state.adopted}</strong><p>新增要求不会自动进入当前执行。由你确认影响，再决定如何调整工程计划。</p><div class="actions">${button('查看差异与影响', 'impact', 'small')}${state.changeNote ? `<small>${esc(state.changeNote)}</small>` : ''}</div></div>` : '';
    const offline = state.offline ? `<div class="note warn"><strong>本机与团队服务暂时断开</strong><p>团队看到的最近进展停留在 10:24。本机已获准执行可继续；共享事件等待补传。</p>${button('模拟重新连接', 'reconnect', 'small')}</div>` : '';
    const phases = ['项目分析', '工程规划', '本地实施', '检查与交付', '本地归档'];
    const idx = state.archived ? 4 : state.checked ? 3 : state.running || state.confirmed ? 2 : 1;
    const lane = `<div class="progress-lane">${phases.map((p, i) => `<div class="stage ${i === idx ? 'current' : i < idx ? 'done' : ''}"><span>0${i + 1}${i < idx ? ' · 已完成' : ''}</span>${p}</div>`).join('')}</div>`;
    let action = !state.confirmed ? button('确认工程计划', 'confirm-plan', 'primary') : !state.running && !state.checked ? button('开始本地实施', 'start-run', 'primary', stale() || state.offline) : state.running ? button('演示：完成本轮检查', 'finish-run', 'primary', stale()) : button('预览并发布交付包', 'publish-preview', 'primary', state.offline || stale());
    if (state.checked && !state.merged) action += button('记录代码合并确认', 'merge');
    if (state.accepted && state.merged && !state.archived) action += button('在本机归档任务', 'archive');
    const docs = { prd: `# 退款重试 · 工程 PRD\n\n来源：Brief v${state.adopted}\n项目：payment-service（本地分析后确认）\n\n目标\n${adoptedBrief().goal}\n\n范围\n${adoptedBrief().scope}\n\n验收关联\n${adoptedBrief().criteria.map((c, i) => `AC-${i + 1} · ${c}`).join('\n')}\n\n工程约束\n沿用现有退款单标识；先查询原交易状态。`, design: `# 技术设计 · 本机文档\n\n来自实际项目分析的示例结构\n1. 复用现有退款入口与单号。\n2. 处理中先查原交易，再决定能否重试。\n3. 为重复提交与超时返回补回归用例。\n\n兼容范围\n历史订单暂不迁移，仍走人工处理。\n\n此完整设计默认不在产品或验收页面共享。`, plan: `# 实施清单\n\n${state.checked ? '[x]' : '[ ]'} 梳理并修改重试判断\n${state.checked ? '[x]' : '[ ]'} 增加处理中查询逻辑\n${state.checked ? '[x]' : '[ ]'} 检查重复请求与超时场景\n[ ] 开发预览并发布交付摘要\n[ ] 等待业务验收\n\n每项检查结果均需关联真实命令或人工记录。\n本原型里的结果仅用于演示。` };
    return header + localInfo + changed + offline + lane + `<div class="engineering-grid"><section class="panel document"><div class="panel-head"><h2>工程材料</h2>${badge(state.confirmed ? '开发已确认计划' : '等待开发确认', state.confirmed ? 'good' : 'warn')}</div><div class="doc-tabs">${Object.entries({ prd: 'prd.md', design: 'design.md', plan: '实施清单' }).map(([id, name]) => `<button type="button" class="${state.doc === id ? 'active' : ''}" data-doc="${id}">${name}</button>`).join('')}</div><pre>${esc(docs[state.doc] || docs.prd)}</pre><div class="private-line">● 完整工程材料只在我的本机</div><div class="actions section-spacer">${action}</div></section><aside class="stack"><section class="panel"><h2>本次带入的规范</h2><div class="rule-row"><h3>退款幂等规范 · v5</h3><small>因涉及重复退款而选入</small>${badge('运行端确认加载', 'good')}</div><div class="rule-row"><h3>后端错误处理约定</h3><small>本项目 / 服务端</small>${badge('已传递', 'blue')}</div><div class="rule-row"><h3>历史业务事故摘要</h3><small>公司知识库 / 已发布资料</small>${badge('已选入')}</div><p class="hint section-spacer">加载回执不代表代码已符合规范。需要对应检查证据。</p>${button('查看回执证据', 'receipts', 'text-button')}</section><section class="panel soft"><h3>本次执行记录</h3><div class="timeline"><div class="event">采用需求 v${state.adopted}<small>由小周确认 · 示例</small></div><div class="event">工程材料已形成<small>本机 Trellis 文档 · 示例</small></div>${state.confirmed ? '<div class="event">开发确认计划<small>允许进入本地实施</small></div>' : ''}${state.running ? '<div class="event">正在处理回归场景<small>本地执行中 · 示例事件</small></div>' : ''}${state.checked ? '<div class="event">本轮检查结束<small>结果等待开发发布</small></div>' : ''}</div>${button('查看本机工具详情', 'tool-detail', 'text-button')}</section></aside></div>`;
  }

  function delivery() {
    if (!state.publication) return heading('交付与验收', '只展示开发已发布、你有权查看的成果。') + `<div class="empty"><div class="empty-icon">✓</div><h2>还没有共享交付包</h2><p>${state.checked ? '开发本机已有检查结果，仍需由开发预览内容和受众后发布。' : '工程材料仍在开发本机。发布后，验收人才能看到选定摘要与证据。'}</p>${state.role === 'dev' && state.checked ? button('预览并发布', 'publish-preview', 'primary', state.offline) : ''}</div>`;
    const pub = state.publication;
    const qa = state.role === 'qa';
    const outdated = pub.briefVersion !== latest();
    const allChecked = state.acceptance.length === pub.criteria.length && state.acceptance.every(Boolean);
    const syncText = { waiting: '等待完成条件', ok: '已确认 · Jira 完成', error: '回写失败 · 可重试' }[state.jira];
    const rows = pub.criteria.map((c, i) => `<tr><td><span class="criterion-id">AC-${i + 1}</span><br>${esc(c)}</td><td>${pub.evidence ? '开发发布的测试摘要<br><span class="hint">示例：回归结果与验收步骤</span>' : '等待人工补充验收证据'}</td><td>${qa && !state.accepted ? `<label class="check-label"><input type="checkbox" data-acceptance="${i}" ${state.acceptance[i] ? 'checked' : ''}><span>验收符合</span></label>` : badge(state.accepted || state.acceptance[i] ? '已确认' : '待确认', state.accepted || state.acceptance[i] ? 'good' : '')}</td></tr>`).join('');
    return heading(state.title, `共享交付包 v${pub.version} · 对应需求 v${pub.briefVersion} · 发布者：小周`, qa ? button(state.accepted ? '业务已验收' : '通过业务验收', 'accept', 'primary', state.accepted || !allChecked || outdated) : '') + `${outdated ? '<div class="note warn">需求已有新版本。此交付包仍对应旧版，需开发评估并重新发布后再验收。</div>' : ''}${state.rejectReason ? `<div class="note warn"><strong>已退回开发</strong><p>${esc(state.rejectReason)}</p></div>` : ''}<div class="two-columns"><section class="panel"><div class="panel-head"><h2>按业务要求逐项确认</h2>${badge(state.accepted ? '业务验收通过' : '待验收', state.accepted ? 'good' : 'warn')}</div><p class="delivery-body">${esc(pub.summary)}</p><div class="table-wrap"><table><thead><tr><th>验收项</th><th>共享证据</th><th>结论</th></tr></thead><tbody>${rows}</tbody></table></div><div class="actions section-spacer">${qa && !state.accepted ? button('退回并说明', 'reject', 'danger') : ''}${button('查看共享内容与来源', 'publication-detail', 'small')}</div><div class="footer-caption">代码审查继续使用团队现有 Git 平台。本页不提供本机源码和终端日志。</div></section><aside class="stack"><section class="panel soft"><h2>结果与同步分别记录</h2><dl class="detail-list"><dt>业务验收</dt><dd>${state.accepted ? '已通过' : '待确认'}</dd><dt>代码合并</dt><dd>${state.merged ? '开发已记录确认（示例）' : '等待开发确认'}</dd><dt>Trellis 归档</dt><dd>${state.archived ? '本机已归档（示例回执）' : '等待开发本机操作'}</dd><dt>Jira</dt><dd>${badge(syncText, state.jira === 'error' ? 'error' : state.jira === 'ok' ? 'good' : '')}</dd></dl>${state.jira === 'error' ? button('重试同一同步请求', 'retry-sync', 'small') : ''}<div class="note">示例完成条件：业务验收通过 + 开发确认代码已合并。网络失败不会撤销已记录的验收。</div>${state.accepted && state.merged ? button('演示 Jira 回写失败', 'fail-sync', 'subtle small') : ''}</section>${state.role === 'dev' ? `<section class="panel"><h3>开发收尾</h3><div class="actions">${!state.merged ? button('记录代码合并确认', 'merge', 'small') : ''}${state.accepted && state.merged && !state.archived ? button('在本机归档任务', 'archive', 'small', state.offline) : ''}${button('提出一条规范建议', 'propose-rule', 'small')}</div></section>` : ''}</aside></div>`;
  }

  function knowledge() {
    const maintain = state.role === 'maint';
    const hasProposal = state.rule !== 'none';
    return heading('知识有来源，规则有版本', '知识用于参考；规则经过评审，再由开发引入具体项目。', '', '支付产品组 / 知识与规范') + `<div class="two-columns"><section class="panel"><div class="panel-head"><h2>团队可用的资料</h2>${badge('按项目授权', 'blue')}</div><div class="list-row"><div><h3>退款业务规则</h3><p>已发布 v5 · 维护人阿宁 · 适用支付项目</p></div>${button('查看来源', 'source-rule', 'small')}</div><div class="list-row"><div><h3>支付项目能力卡</h3><p>研发发布 · 更新于 10/08 · 需结合当前实现核实</p></div>${button('查看摘要', 'source-card', 'small')}</div><div class="list-row"><div><h3>历史重复退款事故摘要</h3><p>经发布的业务复盘，不包含私有代码日志</p></div>${button('阅读摘要', 'source-incident', 'small')}</div><div class="footer-caption">需求助手只能使用这些授权的发布资料；员工本机代码索引不会出现在这里。</div></section><aside class="panel soft"><div class="panel-head"><h2>从任务沉淀的规则</h2>${badge(state.rule === 'published' ? '已发布 v6' : hasProposal ? '待维护人评审' : '尚无提案', state.rule === 'published' ? 'good' : hasProposal ? 'warn' : '')}</div>${hasProposal ? `<h3>重试前先查询原交易状态</h3><p>原交易处于处理中时，不再次发起退款；先查询结果，再决定是否重试。</p><dl class="detail-list"><dt>来源任务</dt><dd>PAY-128</dd><dt>适用范围</dt><dd>支付项目 / 退款业务</dd><dt>证据</dt><dd>交付验收项 AC-4</dd><dt>替代关系</dt><dd>在 v5 基础上补充，不覆盖其他例外</dd></dl><div class="actions">${maintain && state.rule === 'proposed' ? button('评审并发布规则 v6', 'review-rule', 'primary') : ''}${state.role === 'dev' && state.rule === 'published' ? button(state.ruleAdopted ? '本机已引入 v6' : '查看差异并引入本机', 'adopt-rule', 'primary', state.ruleAdopted || state.offline) : ''}</div>` : `<p class="muted">开发完成检查后，可以从真实任务提出规则建议。维护人决定是否发布。</p>${state.role === 'dev' && state.checked ? button('从本次任务提出建议', 'propose-rule', 'primary') : ''}`}<div class="note">发布不会自动修改员工仓库；正在执行的任务仍采用原先锁定的版本。</div></aside></div>`;
  }

  function render() {
    if (!allowedViews[state.role].includes(state.view)) state.view = allowedViews[state.role][0];
    document.getElementById('role').value = state.role;
    document.getElementById('scenario').value = state.scenario;
    document.getElementById('avatar').textContent = roles[state.role][1];
    document.getElementById('view-name').textContent = views[state.view][0];
    const local = state.role === 'dev' && state.view === 'engineering';
    document.getElementById('place').textContent = local ? '我的本机 · 演示' : '团队空间';
    document.getElementById('place').className = `location ${local ? 'local' : ''}`;
    document.getElementById('nav').innerHTML = allowedViews[state.role].map(v => `<button type="button" data-view="${v}" class="${state.view === v ? 'active' : ''}" ${state.view === v ? 'aria-current="page"' : ''}><span class="nav-symbol" aria-hidden="true">${views[v][1]}</span>${views[v][0]}</button>`).join('');
    main.innerHTML = ({ inbox, brief, engineering, delivery, knowledge }[state.view])();
    const localSidebar = state.role === 'dev' && state.view === 'engineering' ? main.querySelector('.engineering-grid > aside') : null;
    if (localSidebar) localSidebar.insertAdjacentHTML('beforeend', `<section class="panel soft"><h3>与本机 Agent 交流</h3><p class="hint">你可以补充约束、要求解释或调整当前计划。消息不进入团队交付副本。</p>${(state.localMessages || []).map(m => `<div class="chat-entry user"><strong>小周 · 本机消息</strong><p>${esc(m)}</p></div><div class="chat-entry"><strong>开发助手 · 演示回复</strong><p>已记录补充，需结合当前工程计划处理；不会替你发布需求版本或团队成果。</p></div>`).join('')}<div class="compose"><label for="local-chat" class="hint">给本机 Agent 补充要求</label><textarea id="local-chat" placeholder="例如：先解释影响范围，再继续修改"></textarea><div class="actions"><span class="hint">仅本机 · 示例会话</span>${button('发送本机消息', 'local-message', 'small')}</div></div></section>`);
  }

  const devActions = new Set(['claim', 'bind', 'confirm-bind', 'analyze', 'feedback', 'send-feedback', 'create-plan', 'confirm-plan', 'start-run', 'pause', 'finish-run', 'local-settings', 'save-local-settings', 'analysis-detail', 'receipts', 'tool-detail', 'impact', 'adopt-change', 'keep-change', 'reconnect', 'publish-preview', 'confirm-publication', 'merge', 'confirm-merge', 'archive', 'propose-rule', 'adopt-rule', 'confirm-rule-adopt']);
  const pmActions = new Set(['save-brief', 'publish-brief', 'confirm-publish', 'resolve', 'send-chat', 'suggest-criteria']);
  const qaActions = new Set(['accept', 'reject', 'confirm-reject']);
  function update(message, close = false) { if (close && dialog.open) dialog.close(); render(); persist(); if (message) notify(message); }
  function publishRevision() {
    const version = latest() + 1;
    state.revisions.push({ version, goal: state.draftGoal.trim(), scope: state.draftScope.trim(), criteria: [...currentBrief().criteria] });
    state.published = true;
  }
  function syncIfReady() { if (state.accepted && state.merged && state.jira !== 'error') state.jira = 'ok'; }
  function action(name) {
    if (name === 'local-message') {
      if (state.role !== 'dev' || state.view !== 'engineering' || !state.plan) return;
      const text = document.getElementById('local-chat')?.value.trim();
      if (!text) { notify('请填写给本机 Agent 的补充要求。'); return; }
      state.localMessages = [...(state.localMessages || []), text.slice(0, 2000)];
      update('消息只进入本机示例会话，没有发布给团队。');
      return;
    }
    if (devActions.has(name) && state.role !== 'dev') return;
    if (pmActions.has(name) && state.role !== 'pm') return;
    if (qaActions.has(name) && state.role !== 'qa') return;
    if (['review-rule', 'confirm-rule-release'].includes(name) && state.role !== 'maint') return;
    switch (name) {
      case 'close-dialog': dialog.close(); break;
      case 'save-brief': persist(); notify('草稿已保存在此浏览器；尚未发布给开发。'); break;
      case 'publish-brief':
        if (!state.draftGoal.trim() || !state.draftScope.trim()) { notify('请先填写业务目标与范围。'); break; }
        modal('发布业务需求版本', `<div class="preview-body"><h3>接收人：小周 · 开发员工</h3><p>${esc(state.draftGoal)}</p><h3>范围</h3><p>${esc(state.draftScope)}</p><small>待项目核实的事项将一并保留。</small></div><div class="note">发布只通知开发，不启动任何本地 Agent，也不会生成工程 PRD/design。</div>`, button('返回修改', 'close-dialog') + button(`发布 v${latest() + 1}`, 'confirm-publish', 'primary')); break;
      case 'confirm-publish': publishRevision(); update('需求版本已发布（演示），等待开发自行处理。', true); break;
      case 'resolve': if (!state.feedback || state.resolved) break; state.draftScope = confirmedScope; state.resolved = true; publishRevision(); update('已发布修订：仅支持新退款单。开发需明确采用新版。'); break;
      case 'send-chat': { const input = document.getElementById('chat-input'); const value = input?.value.trim(); if (!value) { notify('先补充一个业务场景。'); break; } state.messages.push(value.slice(0, 2000)); update('已加入示例讨论；可继续编辑简报。'); break; }
      case 'suggest-criteria': state.draftScope = `${state.draftScope}\n补充：重复请求不得产生第二笔退款；处理中应先查询原交易。`; update('验收建议已加入草稿，请检查后发布。'); break;
      case 'claim': if (!state.published || state.claimed) break; state.claimed = true; update('已领取。还没有启动项目分析或 Agent。'); break;
      case 'bind': modal('选择你电脑上的项目', `<label class="field"><span>本地项目（示例）</span><select id="local-project"><option>payment-service · 已有 Trellis</option></select></label><dl class="detail-list"><dt>示例路径</dt><dd>D:/work/payment-service</dd><dt>当前分支</dt><dd>feature/refund-retry</dd></dl><div class="note">真实产品中由本机选择目录。这里只绑定预置示例，不读取文件；路径不会进入团队简报。</div>`, button('取消', 'close-dialog') + button('确认本地绑定', 'confirm-bind', 'primary')); break;
      case 'confirm-bind': if (!state.claimed) break; state.bound = true; update('本地绑定已建立（演示）。分析仍需由你启动。', true); break;
      case 'analyze': if (!state.bound) break; state.analyzed = true; update('已展示预置项目分析结果；没有调用模型或读取代码。'); break;
      case 'feedback': modal('发布给产品的业务反馈', `<label class="field"><span>反馈摘要</span><textarea id="feedback-text">历史订单缺少重试识别信息。建议本次只支持新创建的退款单，历史订单继续人工处理，是否可行？</textarea></label><div class="note">共享范围：该项目的产品与开发。具体文件、原始日志和代码片段不包含在此摘要中。</div>`, button('返回', 'close-dialog') + button('发布业务反馈', 'send-feedback', 'primary')); break;
      case 'send-feedback': if (!document.getElementById('feedback-text')?.value.trim()) { notify('请填写反馈摘要。'); break; } state.feedbackText = document.getElementById('feedback-text').value.trim(); state.feedback = true; update('已发布业务反馈（演示）。切换产品角色可以回复。', true); break;
      case 'create-plan': if (!state.resolved || !state.bound) break; state.adopted = latest(); state.plan = true; state.doc = 'prd'; update(`已采用 Brief v${state.adopted}，展示本机工程规划样例。`); break;
      case 'confirm-plan': if (stale()) { notify('先处理新需求版本的影响。'); break; } state.confirmed = true; update('工程计划已确认。开始实施仍需点击本机操作。'); break;
      case 'start-run': if (!state.confirmed || state.offline || stale()) break; state.running = true; update('进入本地实施示例；没有实际启动 Agent。'); break;
      case 'pause': state.running = false; update('本地执行已暂停（演示），材料和任务现场保留。'); break;
      case 'finish-run': if (!state.running || stale()) break; state.running = false; state.checked = true; update('示例检查完成。请选择发布内容，再交给团队验收。'); break;
      case 'local-settings': modal('我的本机工具', `<label class="field"><span>已配置的 Agent（示例）</span><select id="agent-choice"><option${state.agent.startsWith('Codex') ? ' selected' : ''}>Codex（本机已有配置）</option><option${state.agent.startsWith('Gemini') ? ' selected' : ''}>Gemini CLI（本机已有配置）</option></select></label><p class="hint">模型与账号沿用员工既有配置。本原型不读取或保存真实密钥。</p>`, button('取消', 'close-dialog') + button('保存本机选择', 'save-local-settings', 'primary')); break;
      case 'save-local-settings': state.agent = document.getElementById('agent-choice')?.value || state.agent; update('示例 Agent 选择已保存；未启动执行。', true); break;
      case 'analysis-detail': modal('本地分析依据 · 示例', '<div class="preview-body"><p>检查了退款状态处理与历史数据兼容约定。</p><p>发现：历史数据缺少重试所需的业务标识。</p><p>建议：先确认历史订单是否纳入范围。</p></div><p class="hint">正式产品保留可追溯的本地文件依据；共享时改写为业务问题。</p>'); break;
      case 'receipts': modal('规范传递回执 · 示例', '<dl class="detail-list"><dt>退款规范 v5</dt><dd>运行端报告已加载；记录版本摘要。</dd><dt>错误处理约定</dt><dd>仅有已传递回执，未报告加载。</dd><dt>是否符合</dt><dd>必须关联检查结果，当前不能仅凭加载判定。</dd></dl>'); break;
      case 'tool-detail': modal('本机工具详情 · 示例', '<div class="preview-body"><p>读取项目约定 → 分析现有行为 → 形成规划材料。</p><p>实现阶段的命令和文件差异只在本地查看。</p></div><p class="hint">团队默认收到阶段摘要，不收到整段终端输出。</p>'); break;
      case 'impact': modal('需求变化对当前工程的影响', `<div class="diff-old">当前执行：Brief v${state.adopted} · 保留原有退款范围。</div><div class="diff-new">新需求：Brief v${latest()} · ${esc(currentBrief().scope)}</div><p>采用后暂停当前示例执行，重新检查 PRD、设计和受影响的验收项。不会自动恢复 Agent。</p>`, button('保留当前安全步骤', 'keep-change') + button('采用新版并重新规划', 'adopt-change', 'primary')); break;
      case 'adopt-change': state.adopted = latest(); state.running = false; state.confirmed = false; state.checked = false; state.accepted = false; state.changeNote = ''; update('已采用新版，回到工程规划，等待开发确认。', true); break;
      case 'keep-change': state.changeNote = '已记录：先完成当前安全步骤；进入下一阶段前仍需评估新版。'; update('保留当前版本，未批准进入下一受影响阶段。', true); break;
      case 'reconnect': state.offline = false; update('已恢复同步（演示）。不会因此启动新的 Agent。'); break;
      case 'publish-preview':
        if (!state.checked || state.offline || stale()) break;
        modal('预览将共享给团队的交付包', `<div class="preview-body"><h3>业务交付摘要</h3><p id="publication-summary">已完成新退款单的重试能力；处理中先查询原交易，历史订单仍走人工处理。</p><h3>验收关联</h3><p>关联 Brief v${state.adopted} 的 ${adoptedBrief().criteria.length} 项业务验收条件。</p></div><label class="check-label"><input type="checkbox" checked disabled><span>业务摘要与验收项<small>共享给支付产品组的授权成员</small></span></label><label class="check-label"><input id="share-evidence" type="checkbox" checked><span>发布测试摘要与验收步骤<small>仅摘要，无终端原始输出</small></span></label><label class="check-label"><input id="share-technical" type="checkbox"><span>加入经整理的技术摘要<small>“复用现有单号判断，补充查询与幂等检查。”</small></span></label><div class="note">不包含：完整源码、design 原文、本机路径、密钥和完整聊天。实际产品提供正文编辑与附件预览。</div>`, button('返回修改', 'close-dialog') + button('发布选定内容', 'confirm-publication', 'primary')); break;
      case 'confirm-publication':
        if (!state.checked || state.offline || stale()) break;
        state.publication = { version: (state.publication?.version || 0) + 1, briefVersion: state.adopted, criteria: [...adoptedBrief().criteria], summary: document.getElementById('publication-summary')?.textContent || '', evidence: !!document.getElementById('share-evidence')?.checked, technical: !!document.getElementById('share-technical')?.checked };
        state.acceptance = state.publication.criteria.map(() => false); state.accepted = false; state.rejectReason = ''; state.jira = 'waiting'; state.view = 'delivery'; update('交付副本已发布（演示）；可切换验收角色。', true); break;
      case 'merge': modal('记录现有代码流程的合并确认', '<p>确认开发已在团队现有 Git 流程中完成代码审查与合并。本原型只记录示例确认，不创建或合并真实 PR。</p>', button('返回', 'close-dialog') + button('记录已合并（演示）', 'confirm-merge', 'primary')); break;
      case 'confirm-merge': if (!state.checked) break; state.merged = true; syncIfReady(); update('已记录开发合并确认（演示）。', true); break;
      case 'accept': if (!state.publication || state.publication.briefVersion !== latest() || !state.acceptance.every(Boolean) || state.acceptance.length !== state.publication.criteria.length) break; state.accepted = true; syncIfReady(); update(state.merged ? '业务验收已通过；示例 Jira 回写已确认。' : '业务验收已通过，等待代码合并确认。'); break;
      case 'reject': modal('退回当前交付版本', '<label class="field"><span>未满足的验收项与原因</span><textarea id="reject-text" placeholder="例如：AC-3 的客服提示还不清楚，请补充验收步骤。"></textarea></label>', button('取消', 'close-dialog') + button('退回给开发', 'confirm-reject', 'primary')); break;
      case 'confirm-reject': { const reason = document.getElementById('reject-text')?.value.trim(); if (!reason) { notify('请说明具体未满足的验收项。'); break; } state.rejectReason = reason; state.accepted = false; state.acceptance = state.acceptance.map(() => false); state.jira = 'waiting'; update('退回原因已记录（演示），不会远程启动修复。', true); break; }
      case 'fail-sync': if (!state.accepted || !state.merged) break; state.jira = 'error'; update('已模拟 Jira 网络超时；验收与交付记录保留。'); break;
      case 'retry-sync': if (state.jira !== 'error') break; state.jira = 'ok'; update('同一同步意图已确认（演示），没有新建任务或评论。'); break;
      case 'archive': if (!state.accepted || !state.merged || state.offline) break; state.archived = true; update('已记录本机归档回执（演示）。'); break;
      case 'publication-detail': if (!state.publication) break; modal('团队可读的发布副本', `<div class="preview-body"><h3>交付包 v${state.publication.version}</h3><p>${esc(state.publication.summary)}</p><p>来源：需求 v${state.publication.briefVersion} / 开发发布记录</p>${state.publication.evidence ? '<p>测试摘要：重复请求、超时与处理中场景的示例结果。</p>' : ''}${state.publication.technical ? '<p>技术摘要：复用现有单号判断，补充查询与幂等检查。</p>' : ''}</div><p class="hint">这是独立发布副本。没有通往员工本机任意文件的入口。</p>`); break;
      case 'propose-rule': if (!state.checked) break; state.rule = state.rule === 'published' ? 'published' : 'proposed'; state.view = 'knowledge'; update('已建立规则提案，等待规范维护人评审。'); break;
      case 'review-rule': modal('评审退款规则提案', '<div class="diff-old">v5：重复请求沿用同一退款单标识。</div><div class="diff-new">新增：原交易为处理中时，先查询结果，不重新发起退款。</div><dl class="detail-list"><dt>证据</dt><dd>PAY-128 · AC-4 交付记录</dd><dt>适用范围</dt><dd>支付项目 / 退款业务</dd><dt>发布结果</dt><dd>形成 v6；通知相关开发，不直接覆盖本机文件。</dd></dl>', button('暂不发布', 'close-dialog') + button('发布规则 v6', 'confirm-rule-release', 'primary')); break;
      case 'confirm-rule-release': if (state.rule !== 'proposed') break; state.rule = 'published'; update('规则 v6 已发布（演示），员工需自行引入。', true); break;
      case 'adopt-rule': modal('引入到我的本机项目', '<p>将经发布的 v6 作为本地规范修改建议，走项目既有审阅与提交流程。当前执行锁定的 v5 不会被改写。</p>', button('取消', 'close-dialog') + button('记录本机引入（演示）', 'confirm-rule-adopt', 'primary')); break;
      case 'confirm-rule-adopt': if (state.rule !== 'published' || state.offline) break; state.ruleAdopted = true; update('已记录本机引入（演示）；后续执行可采用 v6。', true); break;
      case 'source-rule': modal('退款业务规则 · 发布来源', '<div class="preview-body"><h3>退款幂等规范 v5</h3><p>同一次业务退款必须保持唯一标识。重复请求不能产生新的退款结果。</p><p>维护人：阿宁；适用：支付产品组。</p></div><p class="hint">已发布知识样例。它不是对当前项目源码的实时检查。</p>'); break;
      case 'source-card': modal('项目能力卡 · 研发发布', '<div class="preview-body"><p>支持新退款单的状态查询。</p><p>历史订单兼容能力需要结合当前分支确认。</p><p>来源时间：2026-10-08；维护人：支付研发组。</p></div><div class="note warn">能力卡可能落后于代码，以开发本机评估为准。</div>'); break;
      case 'source-incident': modal('历史事故业务摘要', '<div class="preview-body"><p>曾因超时后的重复请求造成重复处理风险。</p><p>经验：超时不是明确失败，需要先查原交易。</p></div><p class="hint">示例已发布摘要；不附原始生产日志或私有代码。</p>'); break;
      default: break;
    }
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.view) { go(target.dataset.view); return; }
    if (target.dataset.doc && state.role === 'dev') { state.doc = target.dataset.doc; update(); return; }
    if (target.dataset.action) action(target.dataset.action);
  });
  document.addEventListener('input', event => { const key = event.target.dataset.field; if (state.role === 'pm' && ['draftGoal', 'draftScope'].includes(key)) { state[key] = event.target.value; persist(); } });
  document.addEventListener('change', event => { if (event.target.dataset.acceptance !== undefined && state.role === 'qa' && !state.accepted) { const index = Number(event.target.dataset.acceptance); if (Number.isInteger(index) && index >= 0 && index < state.acceptance.length) { state.acceptance[index] = event.target.checked; update(); } } });
  document.getElementById('role').addEventListener('change', event => { state.role = event.target.value; state.view = state.role === 'pm' ? 'brief' : state.role === 'dev' ? 'engineering' : state.role === 'qa' ? 'delivery' : 'knowledge'; if (dialog.open) dialog.close(); update(); window.scrollTo(0, 0); });
  document.getElementById('scenario').addEventListener('change', event => { state = fixture(event.target.value); if (dialog.open) dialog.close(); update('已加载预置场景；所有内容均为示例。'); window.scrollTo(0, 0); });
  document.getElementById('reset').addEventListener('click', () => { state = fixture('discovery'); if (dialog.open) dialog.close(); update('已重置本原型的示例状态。'); window.scrollTo(0, 0); });
  render();
})();
