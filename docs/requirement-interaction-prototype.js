/* Standalone interaction simulation. No business transport or external requests. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const root = document.body;
  function applyAppearance(theme = root.dataset.myTheme, density = root.dataset.myFontSize) {
    root.dataset.myTheme = theme;
    root.dataset.myFontSize = density;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    $('theme').setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
    $('density').value = density;
  }
  const initial = $('requirement').innerHTML;
  const storageKey = 'trellis.requirement-interaction-prototype.v1';
  let previousDraft = null;
  let unsaved = false;
  const names = ['客户访谈摘录', '产品体验规范', '客户支持周报'];
  const state = { tab: 'requirement', revision: 0, planRevision: -1, sources: [], answer: '', busy: null, generation: 0, selection: null, undo: null, runStep: -1, runStatus: '', saveTimer: null, toastTimer: null, scroll: { requirement: 0, plan: 0 } };
  const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const doc = () => $(state.tab);
  const stale = () => state.planRevision !== state.revision;
  const hasPlan = () => $('plan').textContent.trim().length > 0;
  const runLocked = () => ['unknown', 'running', 'checking'].includes(state.runStatus);
  let navigationVersion = 0;
  let followActivity = false;
  let activityVersion = 0;
  function enterStage() {
    $('assistant-context').classList.add('compact');
    $('assistant-context').open = false;
    $('context-summary-detail').textContent = `${state.sources.length} 份资料 · ${state.answer ? '已回答' : '问题待补充'}`;
    followActivity = true;
  }
  function revealActivity(id) {
    const version = ++activityVersion;
    requestAnimationFrame(() => {
      if (!followActivity || version !== activityVersion) return;
      const scroller = $('assistant-scroll'), target = $(id);
      if (!scroller.clientHeight || target.hidden) return;
      const viewport = scroller.getBoundingClientRect(), bounds = target.getBoundingClientRect();
      if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) {
        scroller.scrollTop += bounds.top - viewport.top - 12;
      }
    });
  }
  function shortenHeading(text) {
    const characters = typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].map((part) => part.segment)
      : Array.from(text);
    return characters.slice(0, 24).join('');
  }
  function toast(text) { clearTimeout(state.toastTimer); $('toast').textContent = text; $('toast').hidden = false; state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3400); }
  function pane(name) { document.querySelector('.workbench').dataset.mobilePane = name; document.querySelectorAll('[data-pane]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pane === name))); }
  function update() {
    $('run-recovery').hidden = state.runStatus !== 'unknown' && state.runStatus !== 'checking';
    $('check-original-run').disabled = !!state.busy;
    $('context-summary-detail').textContent = `${state.sources.length} 份资料 · ${state.answer ? '已回答' : '问题待补充'}`;
    $('requirement').hidden = state.tab !== 'requirement';
    $('plan').hidden = state.tab !== 'plan' || !hasPlan();
    $('plan-empty').hidden = state.tab !== 'plan' || hasPlan();
    $('requirement-tab').setAttribute('aria-pressed', String(state.tab === 'requirement'));
    $('plan-tab').setAttribute('aria-pressed', String(state.tab === 'plan'));
    $('plan-dot').hidden = !hasPlan() || !stale();
    $('stale-banner').hidden = !hasPlan() || !stale();
    $('advance').innerHTML = (state.busy === 'plan' ? '生成中' : hasPlan() && !stale() ? '开始构建' : hasPlan() ? '更新计划' : '生成计划') + icon('arrow');
    $('advance').disabled = !!state.busy || runLocked();
    $('plan').contentEditable = String(state.busy !== 'plan');
    $('plan').setAttribute('aria-readonly', String(state.busy === 'plan'));
    $('refresh-plan').disabled = !!state.busy;
    $('empty-generate').disabled = !!state.busy;
    $('send').disabled = !!state.busy;
    $('start-build').disabled = !!state.busy || stale() || runLocked();
    $('word-count').textContent = `${doc().textContent.trim().replace(/\s/g, '').length} 字 · ${state.tab === 'plan' ? '独立计划' : '需求草稿'}`;
    $('undo').disabled = !state.undo;
  }
  // Persist only this prototype's plain editable markup, never arbitrary active HTML.
  function safeMarkup(markup) {
    const template = document.createElement('template'); template.innerHTML = markup;
    const allowed = new Set(['H1', 'H2', 'H3', 'P', 'DIV', 'BR', 'UL', 'OL', 'LI', 'STRONG', 'EM', 'B', 'I', 'MARK']);
    for (const node of [...template.content.querySelectorAll('*')].reverse()) {
      if (!allowed.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent)); continue; }
      for (const a of [...node.attributes]) node.removeAttribute(a.name);
    }
    return template.innerHTML;
  }
  function draftSnapshot() {
    return {
      requirement: safeMarkup($('requirement').innerHTML), plan: safeMarkup($('plan').innerHTML),
      revision: state.revision, planRevision: state.planRevision, sources: [...state.sources],
      answer: state.answer, audience: document.querySelector('input[name="audience"]:checked')?.value || '',
      clarification: $('clarification').value, prompt: $('prompt').value,
      project: $('project').value, runStatus: state.runStatus, runStep: state.runStep,
    };
  }
  function restoreDraft(saved) {
    $('requirement').innerHTML = safeMarkup(saved.requirement);
    $('plan').innerHTML = safeMarkup(saved.plan || '');
    state.revision = Number(saved.revision) || 0;
    state.planRevision = Number.isFinite(saved.planRevision) ? saved.planRevision : -1;
    state.sources = Array.isArray(saved.sources) ? saved.sources.filter((i) => [0,1,2].includes(i)) : [];
    state.answer = typeof saved.answer === 'string' ? saved.answer : '';
    // Legacy drafts can recover a choice only when their saved answer names it exactly.
    document.querySelectorAll('input[name="audience"]').forEach((input) => {
      input.checked = typeof saved.audience === 'string' ? input.value === saved.audience
        : state.answer === input.value || state.answer.startsWith(`${input.value}；`);
    });
    $('clarification').value = saved.clarification || '';
    $('prompt').value = saved.prompt || '';
    $('project').value = saved.project || '';
    state.runStatus = ['running', 'checking', 'unknown'].includes(saved.runStatus) ? 'unknown' : '';
    state.runStep = Number.isInteger(saved.runStep) ? saved.runStep : -1;
    if (state.runStatus === 'unknown') {
      $('run').hidden = false; $('run-label').textContent = '模拟 · 结果待核对'; runSteps();
    }
  }
  function save({ quiet = false } = {}) {
    clearTimeout(state.saveTimer);
    if ($('scenario').value === 'save-failure') { unsaved = true; $('save-state').textContent = '未保存'; $('retry-save').hidden = false; if (!quiet) toast('模拟保存失败，草稿仍在当前页面'); return false; }
    try {
      localStorage.setItem(storageKey, JSON.stringify({ ...draftSnapshot(), previousDraft, theme: root.dataset.myTheme, density: root.dataset.myFontSize }));
      unsaved = false;
      $('save-state').textContent = '已存此浏览器'; $('retry-save').hidden = true;
      return true;
    } catch { unsaved = true; $('save-state').textContent = '未保存'; $('retry-save').hidden = false; if (!quiet) toast('浏览器未允许保存，当前草稿仍保留'); return false; }
  }
  function changed(which = state.tab) {
    unsaved = true;
    if (which === 'requirement') state.revision++;
    $('save-state').textContent = '保存中…'; clearTimeout(state.saveTimer); state.saveTimer = setTimeout(save, 500);
    if (state.selection && $(state.selection.tab).innerHTML !== state.selection.html) {
      $('selection-warning').textContent = '原文已变化，请重新选择；本次建议仍可复制。'; $('selection-warning').hidden = false; $('adopt').disabled = true;
    }
    update();
  }
  function tab(name, { fromTop = false } = {}) {
    const scroller = $('document-scroll');
    if (scroller.clientHeight > 0) state.scroll[state.tab] = scroller.scrollTop;
    if (fromTop) state.scroll[name] = 0;
    const target = state.scroll[name], version = ++navigationVersion;
    closePreview(false); $('selection-menu').hidden = true;
    state.tab = name; pane('document'); update(); scroller.scrollTop = target;
    requestAnimationFrame(() => {
      if (version === navigationVersion && state.tab === name) scroller.scrollTop = target;
    });
  }
  function message(text, user = false) { const el = document.createElement('div'); el.className = `message${user ? ' user' : ''}`; if (!user) el.innerHTML = `<header>${icon('spark')}<span class="my-item-title">需求助手</span></header>`; const p = document.createElement('p'); p.textContent = text; el.append(p); $('messages').append(el); el.scrollIntoView({ block: 'nearest' }); }
  function operation(title, detail, actions = []) {
    $('operation').hidden = false; $('operation-title').textContent = title; $('operation-detail').textContent = detail; $('operation-actions').replaceChildren();
    actions.forEach(([label, action, primary]) => { const b = document.createElement('button'); b.className = `my-control my-button-${primary ? 'primary' : 'neutral'}`; b.textContent = label; b.onclick = action; $('operation-actions').append(b); });
    revealActivity('operation');
  }
  function begin(kind) { if (state.busy) return null; state.busy = kind; const id = ++state.generation; update(); return id; }
  function later(id, fn, ms = 900) { setTimeout(() => { if (id === state.generation) fn(); }, $('scenario').value === 'slow' ? ms * 4 : ms); }
  function finish() { state.busy = null; update(); }
  function stop() { ++state.generation; state.busy = null; const wasRun = state.runStatus === 'running'; if (wasRun) { state.runStatus = 'stopped'; $('run-label').textContent = '模拟 · 已停止'; } operation('已停止', '已有文档与结果已保留。', [...(wasRun ? [['继续构建', () => startBuild(state.runStep === 2), true]] : []), ['继续编辑', () => { $('operation').hidden = true; pane('document'); }]]); update(); }
  function generatePlan() {
    if (!$('requirement').textContent.trim()) { toast('先写下你的需求'); tab('requirement'); $('requirement').focus(); return; }
    const id = begin('plan'); if (!id) return;
    enterStage();
    const revision = state.revision, answer = state.answer, sourceNames = state.sources.map((i) => names[i]).join('、');
    const firstPlan = !hasPlan();
    const title = $('requirement').querySelector('h1')?.textContent.trim() || '新需求';
    const paragraph = [...$('requirement').querySelectorAll('p, div')].find((node) =>
      !node.closest('li') && !node.querySelector('h1,h2,h3,ul,ol,p,div') && node.textContent.trim());
    const summary = paragraph?.textContent.trim() || '以当前需求文档中的范围与验收条件作为实施依据。';
    operation('正在生成独立计划', '整理范围、实现步骤与验收条件。模拟生成。', [['停止', stop]]);
    pane('assistant');
    later(id, () => {
      if ($('scenario').value === 'plan-failure') { finish(); operation('计划生成失败', '模拟连接中断，原需求和已有计划都已保留。', [['重试生成', () => { $('scenario').value = 'normal'; generatePlan(); }, true], ['继续编辑', () => tab('requirement')]]); return; }
      $('plan').innerHTML = `<h1>${escape(title)} · 实施计划</h1><p class="document-lead">把需求拆成三个可验证的交付步骤。</p><h2>范围与依据</h2><p>${escape(summary)}</p><p>使用对象：${escape(answer || '暂未确认，实施前补充')}。参考资料：${escape(sourceNames || '当前需求文档')}。</p><h2>1. 建立反馈的基础结构</h2><ul><li>定义来源、描述、负责人和处理状态。</li><li>完成列表与详情的可编辑工作面。</li><li>验证空列表、长内容和必填项。</li></ul><h2>2. 接通收集与跟进</h2><ul><li>实现新增、分配负责人和更新状态。</li><li>保留筛选条件与返回位置。</li><li>失败时保留输入，并提供就地重试。</li></ul><h2>3. 检查并交付</h2><ul><li>走查创建、筛选、处理和关闭的完整路径。</li><li>核对深浅主题、窄窗口和键盘操作。</li><li>交付可预览工作台与检查记录。</li></ul><h2>验收条件</h2><p>所有关键操作可恢复，来源可追溯。检查完成后才标记交付；缺少产物时保持未完成。</p>`;
      state.planRevision = revision; finish(); save(); tab('plan', { fromTop: firstPlan });
      $('plan').classList.remove('result-arrive'); void $('plan').offsetWidth; $('plan').classList.add('result-arrive');
      operation('计划已生成', stale() ? '生成期间需求发生变化，请更新计划后构建。' : '三个交付步骤，保存在独立计划中。', [['查看计划', () => tab('plan')], [stale() ? '更新计划' : '准备构建', () => stale() ? generatePlan() : prepare(), true]]);
      toast('独立计划已就绪');
    }, 1600);
  }
  function prepare() { if (runLocked() || state.busy) { toast('先完成当前操作或核对原构建'); return; } if (!hasPlan() || stale()) { generatePlan(); return; } tab('plan'); $('preparation').hidden = false; $('project').focus(); }
  function runSteps() { [...$('run-steps').children].forEach((li, i) => { li.className = i < state.runStep ? 'done' : i === state.runStep ? 'active' : ''; }); }
  function completeBuild() {
    state.runStatus = 'complete'; state.runStep = 3; runSteps(); finish(); $('operation').hidden = true; $('run-label').textContent = '模拟 · 已完成';
    $('run-result').innerHTML = `<button class="result-link result-arrive" id="open-artifact">${icon('doc')}<span><span class="my-item-title">反馈工作台</span><small class="my-item-description">示例预览 · 附检查结果</small></span>${icon('arrow')}</button><p class="my-item-description">模拟检查通过；未创建真实文件。</p>`;
    $('open-artifact').onclick = () => $('artifact-dialog').showModal(); toast('模拟构建完成，预览已就绪');
    revealActivity('run-result');
    save();
  }
  function checkBuild() { if (state.runStatus !== 'unknown') return; const id = begin('check'); if (!id) return; state.runStatus = 'checking'; update(); save(); enterStage(); operation('正在核对原操作', '仅查询模拟结果，不重复启动构建。'); later(id, completeBuild, 900); }
  function startBuild(fromCheck = false) {
    if (runLocked() || state.busy) { toast(state.runStatus === 'unknown' ? '先核对原构建，不能重复启动' : '当前操作仍在进行'); return; }
    if (stale()) { toast('先更新计划再构建'); return; }
    if (!$('project').value) { $('prepare-error').textContent = '请选择要使用的项目'; $('project').focus(); return; }
    const id = begin('build'); if (!id) return;
    enterStage();
    $('preparation').hidden = true; $('run').hidden = false; $('run-result').replaceChildren(); state.runStatus = 'running'; state.runStep = fromCheck ? 2 : 0; runSteps(); $('run-label').textContent = '模拟 · 进行中'; pane('assistant');
    save();
    operation('正在构建', `${$('project').selectedOptions[0].textContent} · 模拟运行`, [['停止', stop]]);
    function step() {
      if (state.runStep < 2) { state.runStep++; runSteps(); later(id, step, 1200); return; }
      if ($('scenario').value === 'unknown') { state.runStatus = 'unknown'; finish(); save(); $('run-label').textContent = '模拟 · 结果待核对'; operation('暂时无法确认结果', '模拟回执中断。请使用上方入口核对原操作。'); return; }
      if ($('scenario').value === 'build-failure') { state.runStatus = 'failed'; finish(); $('run-label').textContent = '模拟 · 检查未通过'; $('run-result').innerHTML = '<p>页面示例已生成，键盘焦点检查未通过。</p><details><summary class="my-item-description">查看检查记录</summary><p>模拟发现：关闭详情后，焦点没有回到原反馈行。</p></details>'; operation('需要修复一项检查', '保留已完成实现，从检查步骤继续。', [['修复并继续检查', () => { $('scenario').value = 'normal'; startBuild(true); }, true]]); return; }
      completeBuild();
    }
    later(id, step, 1000);
  }
  function captureSelection() {
    if (!$('selection-preview').hidden) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || !doc().contains(selection.anchorNode) || !doc().contains(selection.focusNode)) { $('selection-menu').hidden = true; return; }
    const range = selection.getRangeAt(0).cloneRange();
    if (!range.toString().trim()) return;
    state.selection = { range, text: range.toString(), html: doc().innerHTML, tab: state.tab, rect: range.getBoundingClientRect() };
    const rect = state.selection.rect;
    $('selection-menu').hidden = false;
    $('selection-menu').style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 275))}px`;
    $('selection-menu').style.top = `${Math.max(60, Math.min(rect.top - 44, innerHeight - 90))}px`;
  }
  function sampleSelection() { tab('requirement'); const paragraphs = [...$('requirement').querySelectorAll('h2 + p, li, p')]; const el = paragraphs.find((p) => p.textContent.trim().length > 12); if (!el) { toast('先写一段正文，再选择文字优化'); $('requirement').focus(); return; } el.scrollIntoView({ block: 'center' }); const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); captureSelection(); $('polish').focus(); }
  function suggestedText(selection) {
    const text = selection.text.trim();
    const node = selection.range.commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (element.closest('h1,h2,h3')) {
      if (text.includes('反馈')) return '让客户反馈形成闭环';
      if (text.includes('第一版')) return '第一版的核心范围';
      if (text.includes('做好')) return '验收标准';
      return shortenHeading(text.replace(/^我们要|^关于|[。！]+$/g, ''));
    }
    if (text.includes('散落')) return '客户反馈分散在聊天、工单和会议记录中，缺少统一的跟进记录。产品团队需要反复整理，仍难以确认每个问题的负责人、处理进展和解决结果。';
    if (text.includes('小林')) return '小林打开本周反馈，合并重复问题并分配负责人。团队在同一条记录中更新处理进展，客户再次询问时，任何同事都能找到最新结果。';
    if (text.includes('统一收集')) return '集中收集客户反馈，保留提交人、原始来源和完整描述，支持追溯。';
    if (text.includes('负责人')) return '为每条反馈指定一位负责人，并记录状态变更与最近一次跟进。';
    if (text.includes('筛选')) return '支持按状态和主题组合筛选；打开详情再返回时，保留筛选条件与阅读位置。';
    if (text.includes('暂时') || text.includes('自动回复')) return '第一版不包含自动回复、跨团队报表和复杂审批。';
    return text.replace(/一个轻量的/g, '轻量').replace(/可以/g, '能够').replace(/很难知道/g, '无法确认').replace(/大量时间/g, '重复时间');
  }
  function previewSelection() {
    if (!state.selection) return;
    const { text, rect } = state.selection;
    $('selection-menu').hidden = true; $('selection-preview').hidden = false;
    $('selection-preview').style.left = `${Math.max(16, Math.min(rect.left, innerWidth - 436))}px`;
    $('selection-preview').style.top = `${Math.max(70, Math.min(rect.bottom + 12, innerHeight - 370))}px`;
    $('original-text').textContent = text;
    $('replacement').value = suggestedText(state.selection);
    $('selection-warning').hidden = true; $('adopt').disabled = false; $('replacement').focus();
  }
  function closePreview(focus = true) { $('selection-preview').hidden = true; if (focus) doc().focus(); }
  function adopt() {
    const s = state.selection; if (!s || ! $('replacement').value.trim()) return;
    const target = $(s.tab);
    if (target.innerHTML !== s.html || !target.contains(s.range.commonAncestorContainer)) { $('selection-warning').textContent = '原文已变化，请重新选择；不会覆盖你的修改。'; $('selection-warning').hidden = false; $('adopt').disabled = true; return; }
    const before = target.innerHTML;
    s.range.deleteContents(); const mark = document.createElement('mark'); mark.className = 'adopted'; mark.textContent = $('replacement').value; s.range.insertNode(mark);
    state.undo = { tab: s.tab, before, after: target.innerHTML }; state.selection = null; closePreview(); getSelection().removeAllRanges(); changed(s.tab); toast('已采用选区修改 · 可撤销');
  }
  function renderSources(animate = false) {
    $('source-count').textContent = String(state.sources.length); $('source-chips').replaceChildren();
    state.sources.forEach((i) => { const b = document.createElement('button'); b.className = `source-chip${animate ? ' arrive' : ''}`; b.innerHTML = icon(i === 1 ? 'book' : 'doc') + escape(names[i]) + icon('close'); b.setAttribute('aria-label', `移除引用 ${names[i]}`); b.onclick = () => { state.sources = state.sources.filter((n) => n !== i); renderSources(); changed('requirement'); toast('已移除引用'); }; $('source-chips').append(b); });
  }
  let sourceLinkTimer;
  function linkSources(added) {
    clearTimeout(sourceLinkTimer);
    document.querySelector('.source-link-feedback')?.remove();
    if (!added.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const section = document.querySelector('.context-section');
    if (!section.getBoundingClientRect().height) return;
    const feedback = document.createElement('div');
    feedback.className = 'source-link-feedback'; feedback.setAttribute('aria-hidden', 'true');
    const label = names[added[0]] + (added.length > 1 ? ` +${added.length - 1}` : '');
    feedback.innerHTML = `<svg viewBox="0 0 320 68" class="source-link-drawing"><g class="source-link-origin"><rect x="2" y="12" width="162" height="42"/><use href="#i-book" x="14" y="25" width="16" height="16"/><text x="40" y="38">${escape(label)}</text></g><path class="source-link-track" d="M170 33H247"/><path class="source-link-trace" d="M170 33H247"/><circle class="source-link-packet" cx="170" cy="33" r="3"/><g class="source-link-document"><path d="M267 14h19l10 10v30h-29zM286 14v10h10M274 31h10M274 37h8"/><path class="source-link-check" d="m280 46 5 5 12-12"/></g></svg>`;
    section.append(feedback);
    $('source-chips').classList.remove('linked'); void $('source-chips').offsetWidth; $('source-chips').classList.add('linked');
    sourceLinkTimer = setTimeout(() => { feedback.remove(); $('source-chips').classList.remove('linked'); }, 1150);
  }
  function toggleSources(open) { $('source-picker').hidden = !open; $('sources-toggle').setAttribute('aria-expanded', String(open)); if (open) { document.querySelectorAll('.source-row input').forEach((c) => { c.checked = state.sources.includes(Number(c.value)); }); $('source-consent').checked = state.sources.includes(2); $('source-permission').hidden = !document.querySelector('.source-row input[value="2"]').checked; } }
  function answerSummary() { $('questions').hidden = !!state.answer; $('answer-summary').hidden = !state.answer; $('answer-text').textContent = state.answer; }
  function send() {
    const text = $('prompt').value.trim(); if (!text || state.busy) return;
    const id = begin('message'); if (!id) return; message(text, true); $('prompt').value = ''; $('quote-context').hidden = true;
    operation('正在整理建议', '模拟回复，文档不会自动改写。', [['停止', stop]]);
    later(id, () => { finish(); $('operation').hidden = true; message('建议补充两处边界：谁可以更改负责人，以及重复反馈如何保留原始来源。你可以直接编辑文档，或选中文字生成局部修改预览。'); $('questions').hidden = false; $('answer-summary').hidden = true; }, 1000);
  }
  $('requirement-tab').onclick = () => tab('requirement'); $('plan-tab').onclick = () => tab('plan');
  $('advance').onclick = () => hasPlan() && !stale() ? prepare() : generatePlan(); $('refresh-plan').onclick = generatePlan; $('empty-generate').onclick = generatePlan;
  $('start-build').onclick = () => startBuild(); document.querySelector('[data-close="preparation"]').onclick = () => { $('preparation').hidden = true; $('advance').focus(); };
  document.querySelectorAll('[data-pane]').forEach((b) => { b.onclick = () => pane(b.dataset.pane); });
  document.querySelectorAll('[data-prompt]').forEach((b) => { b.onclick = () => { $('prompt').value = b.dataset.prompt; $('prompt').focus(); }; });
  ['requirement', 'plan'].forEach((id) => { $(id).addEventListener('input', () => changed(id)); $(id).addEventListener('mouseup', captureSelection); $(id).addEventListener('keyup', (e) => { if (e.shiftKey || e.key.startsWith('Arrow')) captureSelection(); }); $(id).addEventListener('paste', (e) => { e.preventDefault(); const text = e.clipboardData.getData('text/plain'); const selection = getSelection(); if (!selection.rangeCount) return; const r = selection.getRangeAt(0); r.deleteContents(); const node = document.createTextNode(text); r.insertNode(node); r.setStartAfter(node); r.collapse(true); selection.removeAllRanges(); selection.addRange(r); changed(id); }); });
  $('sample-selection').onclick = sampleSelection; $('polish').onclick = previewSelection;
  $('selection-menu').addEventListener('mousedown', (e) => e.preventDefault());
  $('quote').onclick = () => { if (!state.selection) return; $('quote-context').textContent = state.selection.text; $('quote-context').hidden = false; $('selection-menu').hidden = true; pane('assistant'); $('prompt').focus(); };
  $('adopt').onclick = adopt; $('cancel-preview').onclick = () => closePreview(); $('regenerate-selection').onclick = () => { closePreview(); toast('请在文档中重新选择要修改的文字'); };
  $('undo').onclick = () => { const u = state.undo; if (!u) return; if ($(u.tab).innerHTML !== u.after) { toast('采用后还有新编辑，未覆盖新内容；请使用编辑器撤销'); return; } $(u.tab).innerHTML = u.before; state.undo = null; changed(u.tab); toast('已撤销采用'); };
  $('sources-toggle').onclick = () => toggleSources($('source-picker').hidden); $('sources-cancel').onclick = () => { toggleSources(false); $('sources-toggle').focus(); };
  document.querySelector('.source-row input[value="2"]').onchange = (e) => { $('source-permission').hidden = !e.target.checked; };
  $('sources-apply').onclick = () => { const selected = [...document.querySelectorAll('.source-row input:checked')].map((c) => Number(c.value)); if (selected.includes(2) && !$('source-consent').checked) { $('source-consent').focus(); toast('受限资料需要本次读取授权'); return; } const different = JSON.stringify(selected) !== JSON.stringify(state.sources); const added = selected.filter((i) => !state.sources.includes(i)); state.sources = selected; renderSources(); toggleSources(false); linkSources(added); if (different) changed('requirement'); toast(selected.length ? `已引用 ${selected.length} 份资料` : '已清空引用'); $('sources-toggle').focus(); };
  $('answer-question').onclick = () => { const choice = document.querySelector('input[name="audience"]:checked'); if (!choice) { toast('请选择使用对象后再发送'); document.querySelector('input[name="audience"]').focus(); return; } state.answer = choice.value + ($('clarification').value.trim() ? `；${$('clarification').value.trim()}` : ''); answerSummary(); changed('requirement'); toast('答案已发送，纳入下次计划'); };
  $('skip-question').onclick = () => { $('questions').hidden = true; $('answer-summary').hidden = false; $('answer-text').textContent = '使用对象 · 稍后补充'; };
  $('edit-answer').onclick = () => { $('questions').hidden = false; $('answer-summary').hidden = true; $('clarification').focus(); };
  $('send').onclick = send; $('prompt').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } };
  $('theme').onclick = () => { applyAppearance(root.dataset.myTheme === 'dark' ? 'light' : 'dark'); save(); };
  $('density').onchange = (e) => { applyAppearance(root.dataset.myTheme, e.target.value); save(); };
  $('scenario').onchange = () => { if ($('scenario').value === 'save-failure') { changed(); } };
  $('retry-save').onclick = () => { $('scenario').value = 'normal'; save(); };
  $('close-artifact').onclick = () => $('artifact-dialog').close();
  $('check-original-run').onclick = checkBuild;
  $('reset').onclick = () => reset(false);
  function clearWorkbench() {
    clearTimeout(sourceLinkTimer); document.querySelector('.source-link-feedback')?.remove();
    followActivity = false; ++activityVersion; ++navigationVersion; ++state.generation;
    $('assistant-context').classList.remove('compact'); $('assistant-context').open = true;
    state.scroll = { requirement: 0, plan: 0 }; $('document-scroll').scrollTop = 0;
    clearTimeout(state.saveTimer);
    Object.assign(state, { tab: 'requirement', revision: 0, planRevision: -1, sources: [], answer: '', busy: null, selection: null, undo: null, runStep: -1, runStatus: '' });
    $('prompt').value = ''; $('clarification').value = ''; $('messages').replaceChildren(); $('project').value = '';
    document.querySelectorAll('input[name="audience"]').forEach((input) => { input.checked = false; });
    ['operation','run','preparation','quote-context','selection-menu','selection-preview'].forEach((id) => { $(id).hidden = true; });
    $('scenario').value = 'normal'; toggleSources(false);
  }
  function canReplaceDraft() {
    if (state.busy || runLocked()) { toast('先停止当前操作或核对原构建，再切换草稿'); return false; }
    return true;
  }
  function reset(blank) {
    if (!canReplaceDraft()) return;
    previousDraft = draftSnapshot();
    if (!save()) { toast('当前草稿尚未保存，请重试保存后新建'); return; }
    clearWorkbench();
    $('requirement').innerHTML = blank ? '<h1>未命名需求</h1><p><br></p>' : initial;
    $('plan').innerHTML = '';
    restoreButton.hidden = false;
    renderSources(); answerSummary(); update(); save(); pane('document');
    toast(blank ? '已新建空白需求 · 可恢复上一稿' : '已恢复示例 · 原草稿可恢复');
  }
  function restorePreviousDraft() {
    if (!previousDraft || !canReplaceDraft()) return;
    const target = previousDraft, current = draftSnapshot();
    if (!save()) { toast('请先保存当前草稿'); return; }
    clearWorkbench(); restoreDraft(target); previousDraft = current;
    renderSources(); answerSummary(); update(); save(); pane('document'); toast('已恢复上一稿');
  }
  const newButton = document.createElement('button'); newButton.className = 'text-button'; newButton.id = 'new-blank'; newButton.textContent = '新建空白'; newButton.onclick = () => reset(true); $('reset').before(newButton);
  const restoreButton = document.createElement('button'); restoreButton.className = 'text-button'; restoreButton.id = 'restore-draft'; restoreButton.textContent = '恢复上一稿'; restoreButton.hidden = true; restoreButton.onclick = restorePreviousDraft; $('reset').before(restoreButton);
  window.addEventListener('pagehide', () => { save({ quiet: true }); });
  window.addEventListener('beforeunload', (event) => {
    if (!save({ quiet: true }) && unsaved) { event.preventDefault(); event.returnValue = ''; }
  });
  document.querySelectorAll('input[name="audience"]').forEach((input) => { input.addEventListener('change', () => { unsaved = true; save(); }); });
  for (const id of ['prompt', 'clarification']) $(id).addEventListener('input', () => { unsaved = true; clearTimeout(state.saveTimer); state.saveTimer = setTimeout(save, 500); });
  document.addEventListener('keydown', (e) => { if (e.altKey && e.key === 'F10') { e.preventDefault(); captureSelection(); if (!$('selection-menu').hidden) $('polish').focus(); else toast('先选择文档中的文字'); } if (e.key === 'Escape') { if (!$('selection-preview').hidden) closePreview(); $('selection-menu').hidden = true; if (!$('source-picker').hidden) { toggleSources(false); $('sources-toggle').focus(); } } if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
  window.addEventListener('resize', () => { $('selection-menu').hidden = true; if (!$('selection-preview').hidden) { $('selection-preview').style.left = '16px'; $('selection-preview').style.top = '80px'; } });
  $('document-scroll').addEventListener('scroll', () => { $('selection-menu').hidden = true; });
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    $('assistant-scroll').addEventListener(type, () => { followActivity = false; }, { passive: true });
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved.requirement === 'string') {
      restoreDraft(saved);
      previousDraft = saved.previousDraft && typeof saved.previousDraft.requirement === 'string' ? saved.previousDraft : null;
      restoreButton.hidden = !previousDraft;
      if (['dark','light'].includes(saved.theme)) root.dataset.myTheme = saved.theme;
      if (['small','standard','large'].includes(saved.density)) root.dataset.myFontSize = saved.density;
      $('save-state').textContent = '已恢复草稿';
    }
  } catch { /* An unavailable or invalid browser draft does not block editing. */ }
  applyAppearance(); renderSources(); answerSummary(); update();
})();
