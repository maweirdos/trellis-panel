/** Electron component regression host for the explicitly simulated adapter in creation-workspace-ui.jsx. This does not establish native service or real model integration. */
const assert = require("node:assert/strict");
const { writeFileSync, mkdirSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const checks = [];
let lastWait = 'startup';
async function scenario(win, directory) {
  const evaluate = async (fn, ...args) => {
    const value = await win.webContents.executeJavaScript(`(async()=>{try{return await (${fn.toString()})(...${JSON.stringify(args)})}catch(e){return{__error:e.stack||e.message}}})()`);
    if (value?.__error) throw new Error(value.__error);
    return value;
  };
  const wait = async (fn, label) => {
    lastWait = label;
    for (let i = 0; i < 600; i++) {
      if (await fn()) return;
      await new Promise((done) => setTimeout(done, 30));
    }
    throw Error("Timeout " + label + " " + await evaluate(() => JSON.stringify({ text: document.body.innerText.slice(-3500), errors: window.__errors })));
  };
  const text = () => evaluate(() => document.body.innerText);
  const click = (label, selector = "body") => evaluate((label2, selector2) => {
    const roots = selector2 === "dialog" ? [...document.querySelectorAll('[role="dialog"]')].slice(-1) : [document.querySelector(selector2)];
    const button = roots.flatMap((root) => [...root?.querySelectorAll("button") ?? []]).find((button2) => button2.getClientRects().length && (button2.textContent.trim() === label2 || button2.getAttribute("aria-label") === label2));
    if (!button || button.disabled) throw Error("Unavailable " + label2);
    button.focus();
    button.click();
  }, label, selector);
  const field = (label, value, selector = "body") => evaluate((label2, value2, selector2) => {
    const root = selector2 === "dialog" ? [...document.querySelectorAll('[role="dialog"]')].at(-1) : document.querySelector(selector2);
    const control = [...root?.querySelectorAll("input,textarea") ?? []].find((element) => element.getAttribute("aria-label") === label2) || [...root?.querySelectorAll("label") ?? []].find((element) => [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("").trim() === label2)?.querySelector("input,textarea");
    if (!control || control.disabled) throw Error("Unavailable field " + label2);
    Object.getOwnPropertyDescriptor(control.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set.call(control, value2);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  }, label, value, selector);
  const check = (label) => evaluate((label2) => {
    const element = [...document.querySelectorAll("input[type=checkbox]")].find((element2) => element2.getAttribute("aria-label") === label2);
    if (!element || element.disabled) throw Error("Unavailable checkbox " + label2);
    element.click();
  }, label);
  const pass = (label) => { checks.push(label); console.log("PASS " + label); };
  const escape = async () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  };
  const capture = async (name) => {
    const [width, height] = win.getSize();
    win.setSize(width - 1, height);
    await new Promise((done) => setTimeout(done, 80));
    win.setSize(width, height);
    await new Promise((done) => setTimeout(done, 80));
    await win.capturePage().then((image) => writeFileSync(join(directory, name), image.toPNG()));
  };
  await wait(() => evaluate(() => Boolean(window.__fixture && document.querySelector(".creation-list-row"))), "list boot");
  assert.equal(await evaluate(() => window.__fixture.calls.get.length), 0, "metadata list must not get body");
  assert.ok(await evaluate(() => window.__fixture.pure.validateDraft({ title: "文档", body: "界".repeat(1e5), scenarios: [] })?.includes("256")));
  assert.equal(await evaluate(() => window.__fixture.useApp.getState().snapshot), null, 'no native project snapshot is loaded');
  assert.ok(await evaluate(() => document.querySelector('[aria-label="创作来源"]').textContent.includes('本机')));
  assert.equal(await evaluate(() => document.querySelector('[aria-label="创作来源"]').textContent.includes('已同步')), false);
  await click('选择本机或共享协作空间');
  await wait(() => evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].some(button => button.textContent.trim() === '进入共享空间')), 'existing connection picker');
  await click('进入共享空间', 'dialog');
  await wait(() => evaluate(() => !document.querySelector('[role="dialog"]') && document.querySelector('[aria-label="创作来源"]').textContent.includes('Fixture cloud')), 'private cloud source without native project');
  assert.equal(await evaluate(() => document.querySelectorAll('.creation-list-row').length), 0, 'local metadata cannot appear as cloud data');
  assert.ok(await evaluate(() => window.__fixture.calls.list.some(input => input.workspaceKey === 'fixture-cloud' && input.scope === 'personal')));
  await click('选择本机或共享协作空间');
  await wait(() => evaluate(() => Boolean(document.querySelector('[role="dialog"] button[aria-pressed]'))), 'local source choice');
  await evaluate(() => document.querySelector('[role="dialog"] button[aria-pressed]').click());
  await wait(() => evaluate(() => !document.querySelector('[role="dialog"]') && Boolean(document.querySelector('.creation-list-row')) && window.__fixture.useHifox.getState().workspaceContext.key === 'workspace-a'), 'local source restored');
  assert.equal(await evaluate(() => window.__fixture.useApp.getState().snapshot), null);
  assert.equal(await evaluate(() => window.__fixture.calls.get.length), 0, 'connection selection and lists never download creation bodies');
  pass("metadata-only personal list and explicit local/cloud source work without a native project");
  await evaluate(() => document.querySelector(".creation-list-row").click());
  await wait(() => evaluate(() => Boolean(document.querySelector('textarea[aria-label="文档正文"]'))), "source editor");
  await field("文档正文", "本地未保存输入");
  await evaluate(() => window.__fixture.externalSave("服务端并发修改"));
  await wait(async () => (await text()).includes("创作有更新"), "changed event");
  await click("刷新");
  await wait(async () => (await text()).includes("本地输入已保留"), "draft conflict");
  assert.equal(await evaluate(() => document.querySelector('textarea[aria-label="文档正文"]').value), "本地未保存输入");
  await click("用本地内容继续编辑");
  await click("保存");
  await wait(() => evaluate(() => window.__fixture.record().draft.body === "本地未保存输入" && !document.body.innerText.includes("正在保存")), "save");
  pass("server conflict retains draft and explicit rebase persists actual source");
  await field("文档正文", "未知结果输入");
  await evaluate(() => window.__fixture.controls.unknownNext = true);
  await click("保存");
  await wait(async () => (await text()).includes("核对原操作"), "unknown result");
  const mutationCount = await evaluate(() => window.__fixture.calls.command.length);
  assert.ok(await evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "保存").disabled));
  await click("核对原操作");
  await wait(() => evaluate(() => !document.body.innerText.includes("核对原操作") && document.querySelector('textarea[aria-label="文档正文"]').value === "未知结果输入"), "recovery");
  assert.equal(await evaluate(() => window.__fixture.calls.command.length), mutationCount);
  assert.equal(await evaluate(() => window.__fixture.calls.recover.length), 1);
  pass("unknown command reconciles once without another UUID or lost input");
  await click("当前草稿");
  await click("R2 · 检视文档", ".my-menu");
  await wait(() => evaluate(() => document.querySelectorAll(".creation-comment").length === 20), "R2 review");
  assert.ok((await text()).includes("来源 R1"));
  await click("加载更多批注");
  await wait(() => evaluate(() => document.querySelectorAll(".creation-comment").length === 22), "comment paging");
  await evaluate(() => document.querySelector(".creation-comment").querySelector(".creation-comment-actions button").click());
  await wait(() => evaluate(() => Boolean(document.querySelector(".creation-comment .creation-form-grid textarea"))), "rule editor");
  await field("最终规则", "固定的人工作业规则", ".creation-comment");
  await click("确认", ".creation-comment");
  await wait(() => evaluate(() => window.__fixture.record().comments[0].status === "confirmed" && document.querySelectorAll(".creation-comment").length === 22), "confirm continuity");
  assert.equal(await evaluate(() => window.__fixture.calls.command.at(-1).command.reviewRevisionId), await evaluate(() => window.__fixture.r2));
  assert.ok((await text()).includes("确认于 R2"));
  pass("real comment paging retains range and R1 opinion confirms in displayed R2");
  await click("采纳到任务");
  await wait(() => evaluate(() => Boolean(document.querySelector('[role="dialog"]'))), "adoption dialog");
  await click("选择同空间任务", "dialog");
  await click("同空间任务", ".my-menu");
  await evaluate(() => document.querySelector(".creation-rule-option input").click());
  await click("固定采用 R2", "dialog");
  await wait(() => evaluate(() => window.__fixture.record().adoptions.length === 1 && !document.querySelector('[role="dialog"]')), "adopt task");
  assert.equal(await evaluate(() => window.__fixture.record().adoptions[0].confirmedRules[0].finalRule), "固定的人工作业规则");
  await evaluate(() => window.__fixture.addAdoption([]));
  const getBeforeRefs = await evaluate(() => window.__fixture.calls.get.length);
  await evaluate(() => window.__fixture.mountReferences());
  await wait(() => evaluate(() => Boolean(document.querySelector(".creation-task-reference"))), "task references");
  assert.equal(await evaluate(() => window.__fixture.calls.get.length), getBeforeRefs);
  assert.equal(await evaluate(() => document.querySelectorAll(".creation-task-reference").length), 1);
  assert.ok((await text()).includes("0 条规则"));
  await evaluate(() => document.querySelector(".creation-task-reference").click());
  assert.equal(await evaluate(() => window.__fixture.navigation.useCreationNavigation.getState().target.revisionId), await evaluate(() => window.__fixture.r2));
  pass("task pins exact revision and latest explicit adoption renders without body reads");
  await evaluate(() => {
    window.__fixture.mountWorkspace("team");
  });
  await wait(() => evaluate(() => document.querySelectorAll(".creation-comment").length === 20), "team opened reference");
  await check("将批注 1 用于 AI 修改");
  await click("AI 修改");
  await click("估算用量", "dialog");
  await wait(async () => (await text()).includes("尚未配置模型"), "model absent");
  assert.ok((await text()).includes("800") && (await text()).includes("12,288"));
  assert.ok(await evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "生成候选").disabled));
  const planCount = await evaluate(() => window.__fixture.calls.plan.length);
  await field("补充要求", "补充交互", "dialog");
  assert.equal(await evaluate(() => window.__fixture.calls.plan.length), planCount);
  await escape();
  await wait(() => evaluate(() => !document.querySelector('[role="dialog"]') && document.activeElement?.textContent.trim() === 'AI 修改'), 'Escape returns focus to the AI trigger');
  await click('AI 修改');
  await wait(() => evaluate(() => Boolean(document.querySelector('[role="dialog"] textarea'))), 'AI form reopened');
  assert.equal(await evaluate(() => document.querySelector('[role="dialog"] textarea').value), '补充交互', 'cancelled form retains user instructions');
  await evaluate(() => window.__fixture.controls.modelAvailable = true);
  await click("估算用量", "dialog");
  await wait(async () => (await text()).includes("fixture-only-model"), "configured plan");
  await click("生成候选", "dialog");
  await wait(() => evaluate(() => Boolean(window.__fixture.record().candidate) && Boolean(document.querySelector(".creation-comparison"))), "generated comparison");
  await wait(() => evaluate(() => document.body.innerText.includes("候选正文")), "candidate body");
  assert.equal(await evaluate(() => window.__fixture.calls.generate.at(-1).commandId), await evaluate(() => window.__fixture.calls.plan.at(-1).commandId));
  assert.ok(await evaluate(() => window.__fixture.calls.get.some((call) => call.revisionId === window.__fixture.record().candidate.candidateId)));
  await click("当前草稿", ".creation-comparison-toolbar");
  await wait(async () => (await text()).includes("未知结果输入"), "comparison original");
  await click("采用到草稿");
  await wait(() => evaluate(() => window.__fixture.record().draft.body === "候选正文" && !window.__fixture.record().candidate), "candidate adopt");
  assert.equal(await evaluate(() => window.__fixture.record().revisions.length), 2, "adoption does not publish");
  pass("estimated bounded plan, Settings state, no per-keystroke calls and fetched candidate adoption");
  await evaluate(() => {
    window.__fixture.navigation.useCreationNavigation.setState({ target: { workspaceKey: "workspace-a", actorId: "person-one", creationId: window.__fixture.record().creationId, scope: "team", spaceId: "space-1", revisionId: window.__fixture.r2 } });
  });
  await wait(() => evaluate(() => document.querySelectorAll(".creation-comment").length === 20), "review after candidate");
  await check("将批注 2 用于 AI 修改");
  await click("AI 修改");
  await click("估算用量", "dialog");
  await wait(async () => (await text()).includes("fixture-only-model"), "cancel plan");
  await evaluate(() => window.__fixture.controls.deferGeneration = true);
  await click("生成候选", "dialog");
  await wait(async () => (await text()).includes("停止生成"), "running");
  await click("停止生成", "dialog");
  await wait(() => evaluate(() => window.__fixture.calls.cancel.length > 0 && !document.body.innerText.includes("正在停止")), "cancel generation");
  assert.equal(await evaluate(() => window.__fixture.record().candidate), null);
  await click("估算用量", "dialog");
  await wait(async () => (await text()).includes("fixture-only-model"), "race plan");
  await evaluate(() => window.__fixture.controls.cancelFalseOnce = true);
  await click("生成候选", "dialog");
  await wait(async () => (await text()).includes("停止生成"), "race generation");
  await click("停止生成", "dialog");
  await wait(async () => {
    const value = await text();
    return value.includes("核对原操作") && !value.includes("正在停止");
  }, "cancel already-completed race");
  await click("核对原操作", "dialog");
  await wait(async () => !(await text()).includes("核对原操作"), "race reconciled");
  assert.equal(await evaluate(() => window.__fixture.record().candidate), null);
  pass("owned generation cancellation and completion race require real recovery without fake success");
  await click("关闭", "dialog");
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evaluate(() => {
    document.querySelector(".my-root").dataset.myTheme = "dark";
    document.querySelector(".my-root").dataset.myFontSize = "large";
  });
  win.webContents.invalidate();
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(await evaluate(() => document.querySelectorAll("button button").length), 0);
  assert.ok(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await capture("dark-large.png");
  win.setSize(960, 780);
  await new Promise((done) => setTimeout(done, 80));
  assert.ok(await evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await capture("narrow.png");
  pass("dark/large and narrow DOM geometry has no nested buttons or outer horizontal overflow");
  await click("返回创作列表");
  await wait(() => evaluate(() => Boolean(document.querySelector(".creation-list-row"))), "back to list");
  await click("新建创作");
  await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="新建创作"]'))), "new creation dialog");
  await evaluate(() => {
    const input = document.querySelector(".creation-file-input");
    const transfer = new DataTransfer();
    transfer.items.add(new File(['<!doctype html><html><body><button id="choose" onclick="this.textContent=String(Number(this.dataset.count||0)+1);this.dataset.count=this.textContent">执行</button></body></html>'], "交互验证.html", { type: "text/html" }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait(() => evaluate(() => document.querySelector(".creation-import-source")?.value.includes('id="choose"')), "real File import");
  await click("创建草稿", "dialog");
  await wait(() => evaluate(() => Boolean(document.querySelector(".prototype-preview iframe")) && document.querySelector(".creation-title h1")?.textContent === "交互验证"), "prototype opens preview");
  assert.equal(await evaluate(() => Boolean(document.querySelector('textarea[aria-label="HTML 源码"]'))), false, "new prototype must open product preview");
  await click("源码");
  await wait(() => evaluate(() => Boolean(document.querySelector('textarea[aria-label="HTML 源码"]'))), "created HTML editor");
  await click("添加场景");
  await field("场景 1 标题", "按钮计数");
  await field("操作步骤", "点击按钮", ".creation-scenarios");
  await field("预期结果", "计数加一", ".creation-scenarios");
  await click("保存");
  await wait(() => evaluate(() => window.__fixture.record().draft.scenarios.length === 1 && !document.body.innerText.includes("正在保存")), "scenario persistence");
  await click("预览");
  await wait(() => evaluate(() => Boolean(document.querySelector(".prototype-preview iframe")) && !document.body.innerText.includes("正在启动")), "HTML frame");
  await wait(async () => {
    const frame = win.webContents.mainFrame.framesInSubtree.find((frame2) => frame2.parent !== null);
    if (!frame) return false;
    try {
      return await frame.executeJavaScript('Boolean(document.querySelector("#choose"))');
    } catch {
      return false;
    }
  }, "isolated preview ready");
  const previewFrame = win.webContents.mainFrame.framesInSubtree.find((frame) => frame.parent !== null);
  assert.equal(await evaluate(() => document.querySelector("#choose")), null);
  assert.equal(await previewFrame.executeJavaScript('document.querySelector("#choose").click();document.querySelector("#choose").textContent'), "1");
  await click("评审");
  await new Promise((done) => setTimeout(done, 60));
  await previewFrame.executeJavaScript('document.querySelector("#choose").click()');
  await wait(() => evaluate(() => Boolean(document.querySelector('textarea[aria-label="批注意见"]'))), "web annotation editor");
  await wait(() => evaluate(() => document.activeElement === document.querySelector('textarea[aria-label="批注意见"]')), 'in-page selection focuses its annotation editor');
  await field("批注意见", "计数按钮意见");
  await click("发送", ".creation-annotation-editor");
  await wait(() => evaluate(() => window.__fixture.record().comments.length === 1), "anchored annotation commit");
  assert.equal(await evaluate(() => window.__fixture.record().comments[0].target.kind), "web");
  assert.ok(await evaluate(() => Boolean(window.__fixture.record().comments[0].target.selector)));
  assert.equal(await previewFrame.executeJavaScript('document.querySelector("#choose").textContent'), "1", "annotation click does not execute product action");
  pass("real HTML file import, scenario save, interactive sandbox and strict web target adapter");
  await evaluate(() => {
    document.querySelector(".my-root").dataset.myTheme = "light";
    document.querySelector(".my-root").dataset.myFontSize = "standard";
  });
  win.webContents.invalidate();
  await new Promise((done) => setTimeout(done, 100));
  await capture("html-annotation.png");
  await click("发布评审版");
  await wait(() => evaluate(() => Boolean(document.querySelector('[aria-label="发布评审版"]'))), "publish modal");
  await click("发布评审版", "dialog");
  await wait(() => evaluate(() => window.__fixture.record().revisions.length === 1 && !document.querySelector('[role="dialog"]') && document.body.innerText.includes("评审版 R1")), "published fixed revision");
  assert.equal(await evaluate(() => window.__fixture.navigation.useCreationNavigation.getState().target.revisionId), await evaluate(() => window.__fixture.record().revisions[0].revisionId));
  assert.ok((await text()).includes("选择页面元素添加批注"));
  await click("返回创作列表");
  await wait(() => evaluate(() => Boolean(document.querySelector(".creation-list-row"))), "prototype list");
  await evaluate(() => document.querySelector(".creation-list-row").click());
  await wait(() => evaluate(() => Boolean(document.querySelector(".prototype-preview iframe"))), "reopened preview");
  assert.equal(await evaluate(() => Boolean(document.querySelector('textarea[aria-label="HTML 源码"]'))), false, "existing prototype must default preview");
  pass("prototype defaults Preview with explicit source tab, publication opens exact Rn review");
  await evaluate(() => {
    window.__fixture.controls.getOverride = (input) => new Promise((resolve) => {
      (window.__deferred ??= []).push({ input, resolve, actorId: window.__fixture.useHifox.getState().workspaceContext.actorId });
    });
    window.__deferred = [];
    window.__fixture.mountProbe();
  });
  await wait(() => evaluate(() => window.__deferred.length >= 1), "deferred A");
  await evaluate(() => window.__setProbe({ id: window.__fixture.record().creationId, revisionId: window.__fixture.probeRevisions().b }));
  await wait(() => evaluate(() => window.__deferred.some((item) => item.input.revisionId === window.__fixture.probeRevisions().b)), "deferred B");
  await evaluate(() => {
    const newest = window.__deferred.findLast((item) => item.input.revisionId === window.__fixture.probeRevisions().b);
    window.__fixture.resolveDeferred(newest, 'newest-B');
  });
  await wait(() => evaluate(() => document.querySelector("#probe").textContent === "newest-B"), "latest response");
  await evaluate(() => {
    for (const item of window.__deferred.filter((item2) => item2.input.revisionId === window.__fixture.probeRevisions().a)) window.__fixture.resolveDeferred(item, 'obsolete-A');
  });
  await new Promise((done) => setTimeout(done, 70));
  assert.equal(await evaluate(() => document.querySelector("#probe").textContent), "newest-B");
  await evaluate(() => { void window.__probe.refresh(); });
  await wait(() => evaluate(() => window.__deferred.some(item => !item.settled && item.input.workspaceKey === 'workspace-a')), 'original workspace read');
  await evaluate(() => {
    window.__originalWorkspaceRead = window.__deferred.findLast(item => !item.settled);
    window.__fixture.useHifox.setState({ workspaceContext: { ...window.__fixture.workspace, key: 'workspace-b' } });
  });
  await wait(() => evaluate(() => window.__deferred.some(item => item.input.workspaceKey === 'workspace-b')), 'workspace B read');
  await evaluate(() => window.__fixture.useHifox.setState({ workspaceContext: window.__fixture.workspace }));
  await wait(() => evaluate(() => window.__deferred.findLast(item => !item.settled && item.input.workspaceKey === 'workspace-a') !== window.__originalWorkspaceRead), 'workspace A returned with a new lease');
  await evaluate(() => window.__fixture.resolveDeferred(window.__deferred.findLast(item => !item.settled && item.input.workspaceKey === 'workspace-a'), 'fresh-workspace-A'));
  await wait(() => evaluate(() => document.querySelector('#probe').textContent === 'fresh-workspace-A'), 'new workspace A response');
  await evaluate(() => window.__fixture.resolveDeferred(window.__originalWorkspaceRead, 'stale-workspace-A'));
  await new Promise(done => setTimeout(done, 50));
  assert.equal(await evaluate(() => document.querySelector('#probe').textContent), 'fresh-workspace-A', 'A to B to A cannot revive the earlier A response');
  await evaluate(() => window.__fixture.useHifox.setState({ workspaceContext: { ...window.__fixture.workspace, actorId: "person-two" } }));
  await wait(() => evaluate(() => document.querySelector("#probe").textContent === "none"), "actor fence");
  await wait(() => evaluate(() => window.__deferred.some(item => !item.settled && item.actorId === 'person-two')), 'new actor request');
  await evaluate(() => window.__setInteractionActive(false));
  await wait(() => evaluate(() => document.querySelector('.my-root').dataset.fixtureInteraction === 'hidden'), 'interaction scope suspended');
  await evaluate(() => {
    for (const item of window.__deferred.filter(item => !item.settled)) window.__fixture.resolveDeferred(item, 'hidden-scope-reply');
  });
  await new Promise(done => setTimeout(done, 50));
  assert.equal(await evaluate(() => document.querySelector('#probe').textContent), 'none', 'hidden interaction scope owns no response or focus');
  await evaluate(() => window.__setInteractionActive(true));
  await wait(() => evaluate(() => document.querySelector('.my-root').dataset.fixtureInteraction === 'active'), 'interaction scope resumed');
  await evaluate(() => { void window.__probe.refresh(); });
  await wait(() => evaluate(() => window.__deferred.some(item => !item.settled)), 'last request before unmount');
  await evaluate(() => window.__fixture.unmount());
  await evaluate(() => {
    for (const item of window.__deferred.filter(item => !item.settled)) window.__fixture.resolveDeferred(item, 'after-unmount');
  });
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(await evaluate(() => window.__fixture.listeners.size), 0);
  assert.equal(await evaluate(() => window.__fixture.connectionListeners.size), 0);
  assert.deepEqual(await evaluate(() => window.__errors), []);
  assert.deepEqual(await evaluate(() => window.__consoleErrors), []);
  pass("revision/workspace ABA/actor/hidden/unmount fences discard late replies and release subscriptions");
}

const directory = realpathSync.native(process.env.CREATION_WORKSPACE_FIXTURE ?? '');
assert.equal(dirname(directory), realpathSync.native(tmpdir()), 'fixture must be a direct owned TEMP child');
assert.ok(basename(directory).startsWith('trellis-creation-workspace-'));
const url = new URL(process.env.CREATION_WORKSPACE_URL ?? '');
assert.equal(url.protocol, 'http:');
assert.equal(url.hostname, '127.0.0.1');
for (const [kind, name] of [['userData', 'profile'], ['sessionData', 'session'], ['logs', 'logs']]) {
  mkdirSync(join(directory, name), { recursive: true });
  app.setPath(kind, join(directory, name));
}
app.disableHardwareAcceleration();
const timeout = setTimeout(() => { console.error('Creation workspace UI timed out at ' + lastWait); app.exit(1); }, 110_000);
app.whenReady().then(async () => {
  const blockedRequests = [];
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const request = new URL(details.url);
    const allowed = ['about:', 'data:', 'blob:'].includes(request.protocol) || (['http:', 'ws:'].includes(request.protocol) && request.hostname === url.hostname && request.port === url.port);
    if (!allowed) blockedRequests.push(details.url);
    callback({ cancel: !allowed });
  });
  const win = new BrowserWindow({ show: false, width: 1360, height: 960, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await win.loadURL(url.href);
    await scenario(win, directory);
    assert.equal(checks.length, 11, 'all component regression groups must execute');
    assert.deepEqual(blockedRequests, [], 'the adapter suite must not contact external services');
    writeFileSync(join(directory, 'ui-report.json'), JSON.stringify({ scope: 'Production renderer components; in-memory API, source-selection and model test adapters; no native project, IPC, real service or real model.', checks }, null, 2));
    console.log('CREATION_WORKSPACE_UI_PASSED');
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    writeFileSync(join(directory, 'failure.json'), JSON.stringify({ lastWait, checks, error: error.stack ?? String(error), blockedRequests }, null, 2));
    try { writeFileSync(join(directory, 'failure.png'), (await win.capturePage()).toPNG()); } catch (captureError) { console.error(captureError.message); }
    console.error(error.stack ?? error);
    clearTimeout(timeout);
    app.exit(1);
  }
}).catch((error) => { console.error(error.stack ?? error); clearTimeout(timeout); app.exit(1); });
