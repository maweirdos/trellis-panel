'use strict';
(() => {
  const key = 'trellis-cockpit-convergence-v02';
  const initial = () => ({ schema: 2, page: 'read', doc: 'prd', audience: 'local', mode: 'managed', revision: 3, shared: 3, approved: 0, offline: false, sharing: true, focused: false, raw: false, pinned: false, sent: false, checked: false, sourceSaved: true, sourceKind: 'feishu', section: 'scan', child: false, ciCurrent: false, merged: false, archived: false, notes: [] });
  let s = initial();
  try { const saved = JSON.parse(localStorage.getItem(key) || 'null'); if (saved?.schema === 2 && Array.isArray(saved.notes)) s = saved; } catch { /* Storage may be unavailable in file mode. */ }
  const content = document.getElementById('content');
  const modal = document.getElementById('modal');
  const pages = { read: '阅读', context: '上下文与规范', flow: '执行过程', sources: '需求来源', history: '迭代脉络', delivery: '交付' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const b = (text, tone = '') => `<span class="badge ${tone}">${escape(text)}</span>`;
  const btn = (text, action, cls = '', disabled = false) => `<button type="button" data-action="${action}" class="${cls}" ${disabled ? 'disabled' : ''}>${escape(text)}</button>`;
  const isTeam = () => s.audience === 'team';
  const revision = () => isTeam() ? s.shared : s.revision;
  let timer;
  function save() { try { localStorage.setItem(key, JSON.stringify(s)); } catch { /* In-memory demo still works. */ } }
  function say(text) { const n = document.getElementById('notice'); n.textContent = text; n.hidden = false; clearTimeout(timer); timer = setTimeout(() => { n.hidden = true; }, 3800); }
  function show(title, body, actions = '') { document.getElementById('modal-title').textContent = title; document.getElementById('modal-body').innerHTML = body; document.getElementById('modal-actions').innerHTML = actions || btn('知道了', 'close', 'primary'); if (!modal.open) modal.showModal(); }
  function update(text, close = false) { if (close && modal.open) modal.close(); render(); save(); if (text) say(text); }
  const approvalText = () => s.approved === revision() ? `此修订已确认 · v${s.approved}` : `草稿修订 v${revision()} · 尚未确认`;

  function reading() {
    const docNames = isTeam() ? { prd: '工程 PRD', design: '设计说明' } : { prd: '工程 PRD', design: '设计说明', task: '任务信息', manifest: '上下文清单' };
    if (!docNames[s.doc]) s.doc = 'prd';
    const paragraph = revision() >= 4 ? '<p class="updated">补充：同一批次重复扫码时，显示已处理结果，不再次提交。</p>' : '';
    const documents = {
      prd: `<div class="mini-title">工程需求 · 来源与范围已由开发核对</div><h2>重复扫码的提示与处置</h2><p class="lead">来自 Jira TRACE-231 与飞书需求指定章节。此文档在开发本机结合项目形成。</p><h3 id="goal">要解决什么</h3><p>操作人员再次扫到已经处理过的码时，应明确知道当前结果，并能返回继续操作，避免误以为需要重复提交。</p><h3 id="scope">本次范围</h3><p>沿用已完成的一期扫码入口，调整重复结果提示与后续操作。历史异常恢复逻辑仍按前序任务 TRACE-182 的决定处理。</p>${paragraph}<h3 id="acceptance">如何确认做对了</h3><ol><li>重复扫码显示已处理结果，不产生第二次提交。</li><li>提示关闭后可继续扫码，焦点回到输入区域。</li><li>网络中断与重复码提示分别处理，不混成同一种错误。</li></ol><blockquote>尚需业务确认：跨批次重复码是否显示同样提示？此问题挂在任务上，不因文档生成而自动解决。</blockquote>`,
      design: `<div class="mini-title">本机工程设计 · 已共享范围内的只读副本</div><h2>复用已有处理结果，区分业务状态</h2><h3 id="goal">现有基础</h3><p>一期已提供扫码与结果展示；前序修复补过异常后的恢复行为。本次先核对这些决定在当前分支是否仍成立。</p><h3 id="scope">建议改动</h3><p>重复结果走明确的提示分支；网络错误保留重试入口。共用返回扫码的交互，避免焦点状态分散。</p><h3 id="acceptance">验证与回退</h3><p>验证重复扫描、关闭提示继续扫描、网络失败三条路径。先保留既有异常处理分支，变更范围超出预期时停止并补充计划。</p><blockquote>此示例不包含私有代码或原始工具日志；团队可读不等于获得本地执行权限。</blockquote>`,
      task: `<h2>task.json · 结构化阅读</h2><dl class="kv"><dt>任务</dt><dd>TRACE-231 / 重复扫码提示</dd><dt>原始阶段</dt><dd>check</dd><dt>本机项目</dt><dd>traceability-ui</dd><dt>工作目录身份</dt><dd>本任务独立工作区</dd><dt>后续关系</dt><dd>follow-up → TRACE-182</dd><dt>交付提交</dt><dd>c9e31d2（示例）</dd><dt>未知字段</dt><dd>custom.reviewLane = clinical-ops（保留原值）</dd></dl><div class="banner">结构化显示不删除原文件中的未知字段，也不会把无法识别的状态改写成 planning。</div>`,
      manifest: `<h2>implement.jsonl · 为什么带这些材料</h2><div class="table-wrap"><table><thead><tr><th>引用</th><th>理由</th><th>当前观察</th></tr></thead><tbody><tr><td>前端约定</td><td>修改交互与错误提示</td><td>${b('文件可读', 'green')}</td></tr><tr><td>追溯码业务规则</td><td>涉及重复提交与历史结果</td><td>${b(s.pinned ? '已由开发钉入' : '尚未纳入本次清单', s.pinned ? 'blue' : 'yellow')}</td></tr><tr><td>前序设计摘要</td><td>继承异常恢复决定</td><td>${b('已选入；片段裁剪', 'yellow')}</td></tr></tbody></table></div><p class="hint">清单引用、文件可读和实际传递是不同证据。</p>`
    };
    let sourceText = `# ${s.doc === 'design' ? '设计说明' : '重复扫码的提示与处置'}\n\n修订：v${revision()}\n来源：Jira TRACE-231 / 飞书指定章节\n\n## 目标\n重复扫码时显示已经处理的结果，不再次提交。\n\n## 验收\n- 不重复提交\n- 关闭提示后可继续扫码\n- 网络错误单独处理\n\n${revision() >= 4 ? '补充：同一批次重复扫码时显示已处理结果。' : ''}`;
    if (s.doc === 'task') sourceText = JSON.stringify({title:'重复扫码的提示与处置', status:'check', jiraKey:'TRACE-231', relations:[{kind:'follow-up', target:'TRACE-182'}], custom:{reviewLane:'clinical-ops'}}, null, 2);
    if (s.doc === 'manifest') sourceText = [{file:'.trellis/spec/frontend/index.md',reason:'修改交互与错误提示'},{file:'research/previous-design.md',reason:'前序异常恢复决定'}, ...(s.pinned ? [{file:'.trellis/spec/business/traceability.md',reason:'开发钉入重复扫码业务约束'}] : [])].map(row=>JSON.stringify(row)).join('\n');
    return `<div class="grid reading-grid"><section class="panel"><div class="panel-head"><h2>任务材料</h2>${b(approvalText(), s.approved === revision() ? 'green' : 'yellow')}</div><div class="docbar">${Object.entries(docNames).map(([id, label]) => `<button data-doc="${id}" class="${s.doc === id ? 'active' : ''}">${label}</button>`).join('')}</div><div class="reader-tools">${btn(s.focused ? '退出专注阅读' : '专注阅读', 'focus')}${btn(s.raw ? '排版阅读' : '查看原文', 'raw')}${btn('与上一修订比较', 'diff')}</div><article class="reader">${s.raw ? `<pre>${escape(sourceText)}</pre>` : documents[s.doc]}</article><div class="read-footer"><span class="hint">${isTeam() ? `团队只读快照 v${s.shared} · 来源：项目共享策略` : `本机修订 v${s.revision} · 写入稳定后自动观察`}</span><div class="actions">${btn(isTeam() ? '提出业务意见' : '针对这段提出修改', 'comment')}${!isTeam() ? btn(`确认此修订 v${s.revision}`, 'approve', 'primary', s.approved === s.revision || s.mode === 'files') : ''}</div></div></section><aside class="stack reading-side"><section class="panel soft"><h3>本页目录</h3><button class="chapter" data-anchor="goal">01　目标与已有基础</button><button class="chapter" data-anchor="scope">02　本次范围与方案</button><button class="chapter" data-anchor="acceptance">03　验收与待确认事项</button><p class="hint">文档刷新保留阅读位置，不把你拖回顶部。</p></section><section class="panel"><h3>当前需要处理</h3><div class="row"><strong>${s.sent ? '业务规范已有后续提交回执' : s.pinned ? '业务规范已钉入，等待传递' : '一条业务规范尚未纳入'}</strong><p>检索命中不代表实际传递。</p>${!isTeam() ? '<button data-page="context">查看上下文</button>' : b('开发待处理', 'yellow')}</div><div class="row"><strong>${s.checked ? '类型检查已有回执' : '未观察到类型检查结果'}</strong><p>${s.mode === 'files' ? '当前只有文件信号，不能判断是否执行。' : '查看关联本次执行的真实来源。'}</p><button data-page="flow">查看过程证据</button></div><div class="row"><strong>任务里保留的讨论</strong><p>${s.notes.length ? escape(s.notes.at(-1)) : '跨批次重复码是否使用同样提示？'}</p></div></section></aside></div>`;
  }

  function context() {
    const unknown = s.mode === 'files';
    return `<div class="grid"><section class="panel"><div class="panel-head"><h2>本次上下文，不再只看文件名</h2>${b('执行 run-17 · 示例')}</div><div class="table-wrap"><table><thead><tr><th>材料 / 为什么选入</th><th>实际内容范围</th><th>当前证据</th></tr></thead><tbody><tr><td>前端编码约定<br><small>本次修改 UI 行为</small></td><td>${unknown ? '未知' : '原文 4.8 KB / 发送 4.8 KB'}</td><td>${b(unknown ? '无回执' : s.mode === 'hooks' ? '外部 hook 已交给宿主' : '适配器确认接收', unknown ? '' : 'blue')}</td></tr><tr><td>前序设计摘要<br><small>沿用异常恢复决定</small></td><td>${unknown ? '未知' : '原文 9.2 KB / 片段 2.1 KB'}</td><td>${b(unknown ? '无回执' : '已组装 · 存在裁剪', unknown ? '' : 'yellow')}</td></tr><tr><td>追溯码业务规则<br><small>重复处理的业务约束</small></td><td>${s.pinned ? '已由开发加入必读清单' : '已检索命中，未选入'}</td><td>${b(s.sent && !unknown ? '后续检查点已有提交回执' : s.pinned ? '待下一检查点' : '未传递', s.sent && !unknown ? 'blue' : 'yellow')}</td></tr></tbody></table></div><div class="banner">已组装、已交给宿主、宿主接收、检查通过分开记录。这里的任何回执都不证明模型已经遵守所有规范。</div><div class="actions">${btn(s.pinned ? '业务规范已钉入' : '钉入追溯码业务规则', 'pin', 'primary', s.pinned)}${btn(unknown ? '生成外部交接文本' : '演示下一上下文检查点', 'checkpoint', '', !s.pinned)}</div></section><aside class="stack"><section class="panel soft"><h2>知识检索轨迹</h2><div class="row"><h3>查询</h3><p>“重复扫码、历史结果、异常恢复”</p></div><div class="row"><h3>命中</h3><p>业务规范 v5、前序任务 TRACE-182、相关故障摘要。</p></div><div class="row"><h3>选择</h3><p>前序设计已选入；业务规范${s.pinned ? '已手动钉入' : '尚未选入'}；无关入库规则未采用。</p></div><div class="row"><h3>检查对照</h3><p>仍需验证“不重复提交”对应的行为，不能仅看调用次数。</p></div></section><section class="panel"><h3>证据范围</h3><p class="hint">内容与数值是原型样例。真实回执要记录原文件与发送片段各自的 hash、裁剪理由和目标会话。</p>${btn('查看回执字段示例', 'receipt')}</section></aside></div>`;
  }

  function flow() {
    const fileOnly = s.mode === 'files';
    return `<section class="panel"><div class="panel-head"><h2>工作流中的事实与空白</h2>${b(fileOnly ? '仅观察文件，阶段执行未知' : '已支持的工作流观察配置', fileOnly ? 'yellow' : 'blue')}</div><div class="flow">${['项目准备', '工程规划', '实现', '检查', '交付'].map((t, i) => `<div class="step ${!fileOnly && i < 3 ? 'done' : i === 3 ? 'current' : ''}"><span>0${i + 1} · ${fileOnly ? '无执行回执' : i < 3 ? '有事件来源' : i === 3 ? '待核对证据' : '尚未进入'}</span>${t}</div>`).join('')}</div>${fileOnly ? '<div class="banner yellow">目前只能证明文件已经变化，不能判断主 Agent 和子 Agent 执行过哪些步骤。未观察到不等于未执行。</div>' : `<div class="lane"><strong>主执行</strong><div class="bar">规划 → 实施 → 检查阶段</div>${b('Trellis 事件', 'blue')}</div><div class="lane"><strong>前端协作</strong><div class="bar">交互变更已回报；可追到对应子执行</div>${b('channel 回执', 'blue')}</div><div class="lane"><strong>类型检查</strong><div class="bar ${s.checked ? '' : 'partial'}">${s.checked ? '本次执行命令返回 0（示例）' : '尚无可关联的命令结果'}</div>${b(s.checked ? '有检查结果' : '未观察到证据', s.checked ? 'green' : 'yellow')}</div><div class="lane"><strong>后端协作</strong><div class="bar">本任务没有后端改动，不要求该步骤</div>${b('不适用')}</div>`}<div class="inset-note">不支持的 workflow 只展示原文步骤和实际事件；不会根据自然语言猜出一套强制流程。</div></section><div class="grid" style="margin-top:18px"><section class="panel"><h2>在看到问题的地方处理</h2><p>${fileOnly ? '先接入可验证信号，或把检查要求交给当前外部 Agent。' : '检查缺少证据时，可以要求本机 Agent 补做；外部宿主未接操作桥时提供交接文本。'}</p><div class="actions">${btn(fileOnly || s.mode === 'hooks' ? '生成补检查要求' : '补跑类型检查（演示）', 'check', 'primary', s.checked && !fileOnly)}${btn('查看阶段依据', 'flow-evidence')}</div></section><section class="panel soft"><h2>确认与权限</h2><p>${s.approved === s.revision ? `计划 v${s.approved} 有开发确认记录。` : `当前 v${s.revision} 尚无对应批准记录。`}</p><p class="hint">受管启动会检查批准版本；外部直接操作仅能观察，不能假装已被阻止。权限卡仅提供 Agent 实际支持的选项。</p></section></div>`;
  }

  function sources() {
    return `<div class="grid"><section class="panel"><h2>沿用原来的需求入口</h2><div class="source"><h3>Jira TRACE-231</h3><p>所属版本 V16 · 重复扫码提示优化 · 指派开发小周</p>${b('原工单是业务入口', 'blue')}</div><div class="source"><h3>飞书 · 追溯码管理需求</h3><p>工单引用的长文档，包含多个功能章节。优先使用精确锚点；标题只作候选。</p>${btn(s.sourceSaved ? '重新选择 / 检查来源' : '选择要带入的章节', 'extract', 'primary')}</div>${s.sourceSaved ? `<div class="banner green"><strong>已固化本次来源快照</strong><p>${s.sourceKind === 'manual' ? '人工导入：' + escape(s.sourceText) + ' · 未取得远端修订号，保留来源说明与本地内容摘要。' : (s.section === 'scan' ? '3.2 重复扫码提示与处置' : '3.3 异常恢复与继续扫码') + ' · 文档修订 12 · 抓取时间与内容 hash 已记录（示例）。'}</p>原文以后更新，不会静默改写本次输入。</div>` : '<div class="banner yellow">尚未确认具体章节。不会因为 Jira 中有一个链接，就假装已读取全部需求。</div>'}<div class="actions">${btn('演示权限不足的兜底', 'import-fallback')}</div></section><aside class="panel soft"><h2>抽取后保留什么</h2><dl class="kv"><dt>来源</dt><dd>工单 ID、文档 ID、章节或块标识</dd><dt>内容</dt><dd>选中范围的正文快照</dd><dt>版本</dt><dd>可得的修订号；没有则保存抓取时间与 hash</dd><dt>附件</dt><dd>表格、图片、附件缺失时明确提示</dd><dt>存放位置</dt><dd>项目允许的 docs 或任务 research 目录</dd></dl><p class="hint">产品无需在平台维护第三份同等需求。平台原创需求可作为未来可选入口。</p></aside></div>`;
  }

  function history() {
    return `<div class="grid"><section class="panel"><div class="panel-head"><h2>这件事不是第一次做</h2>${b('确定性任务关系')}</div><div class="lineage"><div class="ancestor"><small>第一阶段 · TRACE-106</small><strong>追溯码管理一期</strong><p>形成扫码入口与结果展示。方案基于当时的代码提交，今天仍需核实。</p>${btn('查看当时的决定', 'old-decision')}</div><div class="ancestor"><small>后续修复 · TRACE-182</small><strong>扫码异常恢复</strong><p>明确网络失败与业务重复结果分别处理；遗留跨批次提示规则。</p>${btn('组装前情提要', 'capsule', 'primary')}</div><div class="ancestor"><small>当前优化 · TRACE-231</small><strong>重复扫码提示与处置</strong><p>沿用旧决定，处理新的业务范围。</p></div>${s.child ? '<div class="ancestor"><small>后续任务草稿 · 本机示例</small><strong>补充跨批次扫码提示</strong><p>关系：follow-up；携带前情来源，但不继承旧任务完成状态。</p></div>' : ''}</div></section><aside class="panel soft"><h2>带走前情，不带走旧假设</h2><p>固定顺序：已确认方案 → 澄清结论 → 遗留项 → 规范版本 → MR/提交。</p><p>相关知识检索作为补充，不把相似度自动变成任务血缘。</p><div class="banner yellow">旧任务是历史证据。新任务仍须结合当前代码分析，不能重复执行旧命令。</div>${btn(s.child ? '后续任务草稿已建立' : '基于当前任务发起后续优化', 'child', 'primary', s.child)}</aside></div>`;
  }

  function delivery() {
    return `<div class="grid"><section class="panel"><div class="panel-head"><h2>把结果绑定到具体提交</h2>${b('Git 平台元数据 · 示例', 'blue')}</div><dl class="kv"><dt>MR</dt><dd>!42 · 重复扫码提示优化</dd><dt>状态</dt><dd>${s.merged ? '已合并（示例回执）' : '打开中'}</dd><dt>当前交付 SHA</dt><dd>c9e31d2</dd><dt>流水线 SHA</dt><dd>${s.ciCurrent ? 'c9e31d2' : '8af0440'}</dd><dt>流水线结果</dt><dd>${b('success', 'green')} ${s.ciCurrent ? b('与当前提交一致', 'blue') : b('旧提交，不能算本次通过', 'yellow')}</dd><dt>本地检查</dt><dd>${b(s.checked ? '有本次执行结果' : '未观察到类型检查结果', s.checked ? 'green' : 'yellow')}</dd></dl>${!s.ciCurrent ? '<div class="banner yellow">分支最新可见的绿灯不一定属于本次交付。当前实现需要补稳定 MR ID 与提交 SHA 对齐。</div>' : '<div class="banner green">CI 已对应当前交付版本。仍需按项目规则完成代码评审与业务验收。</div>'}<div class="actions">${!isTeam() ? btn('演示当前提交的 CI 回执', 'ci', '', s.ciCurrent) + btn('演示合并回执', 'merge', '', !s.ciCurrent || !s.checked || s.approved !== s.revision || s.merged) : ''}${btn('查看关联依据', 'mr-evidence')}</div></section><aside class="stack"><section class="panel soft"><h2>归档与同步各有结果</h2><div class="row"><strong>Trellis</strong><p>${s.archived ? '本地归档已记录（示例）' : '尚未归档'}</p></div><div class="row"><strong>基座仓库</strong><p>${s.archived ? '文档包已生成，待按项目策略提交/推送' : '仅归档选定文档，不暂存整个工作目录'}</p></div><div class="row"><strong>Jira</strong><p>${s.archived ? '归档里程碑待同步；不等同远端已完成' : '等待项目完成条件与真实回执'}</p></div>${!isTeam() ? btn('预览归档文档包', 'archive-preview', 'primary', !s.merged) : ''}</section><section class="panel"><h3>让需要回答的人收到问题</h3><p class="hint">待澄清卡可以触达飞书，回复绑定任务与版本。原型只显示预览，不发真实消息。</p>${btn('预览待澄清卡片', 'im')}</section></aside></div>`;
  }

  function render() {
    const visiblePages = isTeam() ? ['read', 'flow', 'delivery'] : Object.keys(pages);
    if (!visiblePages.includes(s.page)) s.page = 'read';
    document.getElementById('audience').value = s.audience;
    document.getElementById('mode').value = s.mode;
    document.getElementById('shell').className = `shell ${s.focused && s.page === 'read' ? 'focused' : ''}`;
    document.getElementById('sync-state').innerHTML = `<div class="snapshot">${b(isTeam() ? s.offline ? `设备离线 · 最近快照 v${s.shared}` : `只读快照 v${s.shared}` : `我的本机 · 文档 v${s.revision}`, s.offline ? 'yellow' : 'green')}${!isTeam() ? btn(s.offline ? '演示恢复同步' : '演示断开连接', 'offline', 'plain') : '<small>最近成功同步 10:42 · 示例</small>'}</div>`;
    document.getElementById('heading-actions').innerHTML = !isTeam() ? btn('共享范围', 'sharing') + btn('演示本机文档更新', 'edit', 'primary') : b('文档只读 · 可反馈业务意见', 'blue');
    const caps = { managed: '可见文件与已接入的 ACP / Trellis 事件；内部子 Agent 仍以实际回执为准。', hooks: '外部宿主也可提供原生 hook 回执；未接操作桥时回到原工具执行。', files: '当前只有文件变化信号；注入、子 Agent 和工具执行情况未知。' };
    document.getElementById('capability').innerHTML = `<strong>当前观测范围：</strong>${caps[s.mode]} ${isTeam() ? '团队只看到共享策略允许的元数据与文档。' : ''}`;
    document.getElementById('tabs').innerHTML = visiblePages.map(p => `<button data-page="${p}" class="${s.page === p ? 'active' : ''}" ${s.page === p ? 'aria-current="page"' : ''}>${pages[p]}</button>`).join('');
    content.innerHTML = ({ read: reading, context, flow, sources, history, delivery }[s.page])();
    if (isTeam()) content.querySelectorAll('button[data-action]').forEach(el => { if (localOnly.has(el.dataset.action)) el.remove(); });
    content.querySelectorAll('button[data-anchor]').forEach(el => { el.disabled = !document.getElementById(el.dataset.anchor); });
  }

  const localOnly = new Set(['approve', 'edit', 'sharing', 'sharing-save', 'offline', 'pin', 'checkpoint', 'check', 'extract', 'extract-save', 'import-fallback', 'import-save', 'child', 'child-save', 'ci', 'merge', 'archive-preview', 'archive-save']);
  function action(name) {
    if (isTeam() && localOnly.has(name)) return;
    switch (name) {
      case 'close': modal.close(); break;
      case 'current': s.page = 'read'; update(); break;
      case 'quick': show('小 bug 的快车道', '<p>工单描述足够时，直接带入当前项目准备本地任务，不要求产品再发布 Brief。</p><div class="flow"><div class="step">原工单</div><div class="step">最小计划</div><div class="step">开发确认</div><div class="step">本机实施</div><div class="step">检查与回写</div></div><p class="hint">无迁移/权限等高影响改动时可用；具体材料遵循项目原工作流。</p>'); break;
      case 'focus': s.focused = !s.focused; update(); break;
      case 'raw': s.raw = !s.raw; update(); break;
      case 'diff': show('文档修订差异 · 示例', `<p>当前显示 v${revision()}。确认与评论绑定具体修订，文件变化不等于批准。</p><div class="diff">新增：${revision() >= 4 ? '同一批次重复扫码时，显示已处理结果，不再次提交。' : '网络中断与重复码提示分别处理。'}</div><p class="hint">此示例只演示阅读变化，真实产品对比对应文件快照。</p>`); break;
      case 'approve': if (s.mode === 'files') break; s.approved = s.revision; update(`已记录对 v${s.revision} 的确认（演示），未启动 Agent。`); break;
      case 'edit': s.revision += 1; s.checked = false; if (!s.offline && s.sharing) s.shared = s.revision; update(s.offline || !s.sharing ? '本机修订已变化，团队仍保留最近成功快照。' : '已自动更新允许范围内的只读快照，不需要另写战报。'); break;
      case 'offline': s.offline = !s.offline; if (!s.offline && s.sharing) s.shared = s.revision; update(s.offline ? '已模拟离线。团队页保留旧快照和离线提示。' : '已补传快照（演示），没有自动启动 Agent。'); break;
      case 'sharing': show('项目一次配置的共享范围 · 示例', `<p>项目已批准共享以下过程材料给获授权成员。正常更新按此策略自动同步。</p><label class="check"><input type="checkbox" checked disabled><span>PRD / design 的只读快照<small>区分草稿与已确认版本</small></span></label><label class="check"><input type="checkbox" checked disabled><span>选定任务字段、阶段与回执元数据</span></label><p class="hint">不默认共享源码、私有会话、终端全文、密钥和本机绝对路径。疑似敏感修订隔离处理；检测不保证覆盖全部情况。</p><label class="check"><input id="share-enabled" type="checkbox" ${s.sharing ? 'checked' : ''}><span>启用此项目的自动快照（演示开关）</span></label>`, btn('返回', 'close') + btn('保存策略', 'sharing-save', 'primary')); break;
      case 'sharing-save': s.sharing = !!document.getElementById('share-enabled')?.checked; if (s.sharing && !s.offline) s.shared = s.revision; update('示例策略已保存；未上传真实资料。', true); break;
      case 'comment': show(isTeam() ? '留下业务意见' : '针对当前材料提出修改', `<p>关联 TRACE-231 / 文档 v${revision()}，意见将保留在任务里。</p><label class="field"><span>问题或修改建议</span><textarea id="comment-text" placeholder="例如：跨批次重复码要怎样提示？"></textarea></label>`, btn('取消', 'close') + btn('保存澄清卡（演示）', 'comment-save', 'primary')); break;
      case 'comment-save': { const text = document.getElementById('comment-text')?.value.trim(); if (!text) { say('请填写具体问题。'); break; } s.notes.push(text.slice(0, 1600)); update('澄清卡已保存；不远程修改代码或启动 Agent。', true); break; }
      case 'pin': s.pinned = true; update('已钉入业务规范。尚未传递，等待下一个上下文检查点。'); break;
      case 'checkpoint': if (!s.pinned) break; if (s.mode === 'files') { show('交给当前外部 Agent 的材料', '<pre>请在继续本任务前读取追溯码业务规则 v5，并与当前任务范围核对。\n如果发生裁剪或无法读取，请明确报告。\n此文本不代表运行端已接收。</pre>'); break; } s.sent = true; update('已模拟下一个检查点的提交回执；不代表规范已被遵守。'); break;
      case 'receipt': show('回执字段 · 示例', '<pre>taskId: TRACE-231\nrunId: run-17\ntargetSession: worker-front-02\nsource: native-hook\noriginalHash: sha256:...\npayloadHash: sha256:...\noriginalBytes: 9200\nsentBytes: 2100\ntruncated: true\nevidence: assembled</pre><p class="hint">未关联任务/执行的事件进入诊断列表，不自动点亮当前任务。</p>'); break;
      case 'check': if (s.mode !== 'managed') { show('在原工具补检查', '<pre>请针对当前提交 c9e31d2 执行项目规定的类型检查，保留命令、退出码与报告。\n如果没有运行，请如实说明，不将文件存在当成执行通过。</pre><p class="hint">当前组合没有驾驶舱操作桥；可以交给原工具，不假装已经执行。</p>'); break; } s.checked = true; update('已加入本次执行的检查回执样例。'); break;
      case 'flow-evidence': show('阶段依据与未知范围', '<p>文件状态来自 task.json；已接入的阶段与子执行来自 hooks/channel；工具结果来自适配器。</p><p>工作流自然语言没有对应观察配置时，只展示原文步骤与事件，不自动判定漏执行。</p>'); break;
      case 'extract': show('选择飞书中的实际需求章节', `<p>工单链接指向一份长文档。下面是目录候选，不能默认把整份内容都当成这个任务。</p><label class="check"><input type="radio" name="section" value="scan" ${s.section === 'scan' ? 'checked' : ''}><span>3.2 重复扫码提示与处置<small>与本工单描述一致 · 示例章节 ID block-32</small></span></label><label class="check"><input type="radio" name="section" value="recovery" ${s.section === 'recovery' ? 'checked' : ''}><span>3.3 异常恢复与继续扫码<small>相关但不是同一需求</small></span></label><div class="banner yellow">代表文档的应用授权、表格和图片获取尚需真实环境验证。这里展示目录选择过程。</div>`, btn('返回', 'close') + btn('确认章节并固化快照', 'extract-save', 'primary')); break;
      case 'extract-save': s.section = document.querySelector('input[name="section"]:checked')?.value || 'scan'; s.sourceSaved = true; s.sourceKind = 'feishu'; s.approved = 0; update('已选择来源快照（演示），工程材料需核对新输入。', true); break;
      case 'import-fallback': show('自动读取不可用时，仍能继续', '<div class="banner yellow">示例：应用没有该文档的读取权限。</div><label class="field"><span>粘贴已获授权的需求章节</span><textarea id="manual-source" placeholder="只导入这个任务需要的内容"></textarea></label><p class="hint">保存原链接、人工导入标识与内容 hash；不冒充完整自动抓取。</p>', btn('取消', 'close') + btn('保存人工来源', 'import-save', 'primary')); break;
      case 'import-save': if (!document.getElementById('manual-source')?.value.trim()) { say('请先粘贴章节内容。'); break; } s.sourceText = document.getElementById('manual-source').value.trim(); s.sourceKind = 'manual'; s.sourceSaved = true; s.approved = 0; update('人工来源已记录（演示），不会丢失来源归属。', true); break;
      case 'old-decision': show('一期确认的决定', '<p>复用扫码入口；异常恢复独立于正常结果展示。来源：TRACE-106 归档设计、当时 MR 与提交。</p><div class="banner yellow">这是历史依据，不能直接证明当前分支仍然相同。</div>'); break;
      case 'capsule': show('前情提要 · 确定性组装', '<div class="row"><h3>已决定</h3><p>网络失败与业务重复结果分开处理。</p></div><div class="row"><h3>未解决</h3><p>跨批次重复码的提示规则。</p></div><div class="row"><h3>来源</h3><p>TRACE-182 的确认设计、澄清结论、归档摘要与 MR；相关规范 v5。</p></div><div class="row"><h3>重新核实</h3><p>当前代码是否仍沿用旧处理入口。旧私有聊天和命令不自动带入。</p></div><p class="hint">真实产品显示每条来源、版本与裁剪情况。</p>'); break;
      case 'child': show('创建后续优化的本机草稿', '<p>标题：补充跨批次扫码提示</p><p>关系：follow-up → TRACE-231。携带前情来源与未解决问题。</p><div class="banner">不会继承旧任务的完成状态或工具授权；仍需核对当前代码。此操作仅创建浏览器内的演示记录。</div>', btn('取消', 'close') + btn('建立后续草稿', 'child-save', 'primary')); break;
      case 'child-save': s.child = true; update('后续草稿已建立，血缘保留；没有新建真实 Trellis 任务。', true); break;
      case 'ci': s.ciCurrent = true; update('已模拟 CI 对应当前 SHA；未运行真实流水线。'); break;
      case 'merge': if (!s.ciCurrent || !s.checked || s.approved !== s.revision) { say('还需本次检查结果与当前计划确认。'); break; } s.merged = true; update('已加入示例合并回执；没有合并真实 MR。'); break;
      case 'mr-evidence': show('交付关联键', '<dl class="kv"><dt>仓库</dt><dd>traceability-ui（示例 ID）</dd><dt>MR ID</dt><dd>42</dd><dt>当前 head</dt><dd>c9e31d2</dd><dt>CI</dt><dd>必须匹配 head SHA 与要求的流水线类型</dd></dl><p class="hint">opened MR 查不到不能直接解释成已合并；需要读取真实状态。</p>'); break;
      case 'archive-preview': if (!s.merged || !s.checked || s.approved !== s.revision) { say('需要当前修订的确认、检查与合并依据。'); break; } show('只归档这一任务的材料', '<label class="check"><input type="checkbox" checked disabled><span>PRD、design、任务元数据</span></label><label class="check"><input type="checkbox" checked disabled><span>来源索引、澄清结论、交付引用</span></label><p class="hint">不包含源码、整个工作区、密钥、完整聊天和终端日志。</p><div class="banner">先生成归档包。基座提交、推送、合并和 Jira 回写各按项目策略处理，不藏在这个动作里。</div>', btn('返回', 'close') + btn('生成归档包（演示）', 'archive-save', 'primary')); break;
      case 'archive-save': if (!s.merged || !s.checked || s.approved !== s.revision) break; s.archived = true; update('归档包已生成（演示），未提交或推送任何仓库。', true); break;
      case 'im': show('飞书待澄清卡 · 预览', `<div class="source"><h3>TRACE-231 需要确认一个业务问题</h3><p>${escape(s.notes.at(-1) || '跨批次重复码是否使用同样提示？')}</p><small>关联文档 v${revision()} · 接收范围：项目产品负责人</small></div><p>回复将关联到该问题与版本；不会作为本机命令执行。</p><p class="hint">只展示卡片，不发送真实消息。实际接入需公司应用授权。</p>`); break;
      default: break;
    }
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.dataset.page) { if (isTeam() && !['read', 'flow', 'delivery'].includes(target.dataset.page)) return; s.page = target.dataset.page; update(); window.scrollTo(0, 0); }
    else if (target.dataset.doc) { s.doc = target.dataset.doc; s.raw = false; update(); }
    else if (target.dataset.anchor) document.getElementById(target.dataset.anchor)?.scrollIntoView({ block: 'start' });
    else if (target.dataset.action) action(target.dataset.action);
  });
  document.getElementById('audience').addEventListener('change', e => { s.audience = e.target.value; s.page = 'read'; s.raw = false; if (modal.open) modal.close(); update(); window.scrollTo(0, 0); });
  document.getElementById('mode').addEventListener('change', e => { s.mode = e.target.value; update(); });
  document.getElementById('reset').addEventListener('click', () => { s = initial(); if (modal.open) modal.close(); update('已重置原型示例。'); window.scrollTo(0, 0); });
  render();
})();
