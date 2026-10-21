/** Owned renderer fixture. Production components are real; wrapped IPC is explicit. */
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TeamCollaborationEntry, PublishWorkflowVersionButton } from '../../../src/renderer/src/team'
import { InteractionScope } from '../../../src/renderer/src/utils/interaction-scope'
import { dispatchEscKey } from '../../../src/renderer/src/utils/esc-layer'

const ids = { connection: '11111111-1111-4111-8111-111111111111', project: '22222222-2222-4222-8222-222222222222', person: '33333333-3333-4333-8333-333333333333', device: '44444444-4444-4444-8444-444444444444', pairing: '55555555-5555-4555-8555-555555555555', team: '66666666-6666-4666-8666-666666666666', material: '77777777-7777-4777-8777-777777777777', otherConnection: '99999999-9999-4999-8999-999999999999', otherPerson: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', otherProject: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', otherMaterial: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
const bodyA = '# 订单导出需求\n\n普通员工不导出手机号🙂。\n\n主管可查看本组的导出记录。\n\n## 字段与权限\n\n| 字段 | 规则 |\n| --- | --- |\n| 姓名 | 可见 |\n| 手机号 | 普通员工不可导出 |\n\n[本地链接](file:///C:/private.md)\n\n[参考网页](https://example.invalid/reference)\n\n![本地原型](C:/private/prototype.png)\n\n![未发布远程原型](https://example.invalid/unpublished.png)\n\n<script>window.untrustedTeamExecuted=true</script>\n\n<img src="https://example.invalid/raw-image.png" onerror="window.untrustedTeamExecuted=true">\n\n' + '稳定阅读段落，不会被后台新版替换。\n\n'.repeat(8)
const bodyB = '# 新版需求 B\n\n新版业务范围，必须由用户主动切换。\n'
const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((value) => value.toString(16).padStart(2, '0')).join('')
const ok = <T,>(value: T) => ({ ok: true, value })
const fail = (code: string, error: string, outcomeUnknown = false) => ({ ok: false, code, error, outcomeUnknown })
const listeners = new Set<(event: unknown) => void>()
const now = Date.now()
const connection = (id = ids.connection) => ({ connectionId: id, origin: 'https://owned-team.example.invalid', pairingId: id === ids.connection ? ids.pairing : crypto.randomUUID(), deviceId: id === ids.connection ? ids.device : crypto.randomUUID(), deviceName: id === ids.connection ? 'Alice 的工作台' : 'Bob 的工作台', state: 'active', projectId: id === ids.connection ? ids.project : ids.otherProject, ownerId: id === ids.connection ? ids.person : ids.otherPerson, userCode: null, verificationUri: null, expiresAt: now + 60000, pollAfterMs: 1000, nextPollAt: now, accessLocked: false, network: 'reachable', lastCheckedAt: now, lastErrorCode: null, remoteDevice: { deviceId: ids.device, deviceName: 'Owned fixture', lastSeenAt: now - 70000, online: false, capabilityClaims: [], capabilityEvidence: 'device-declared', sequence: 1, status: 'active', projectId: ids.project, ownerId: ids.person } })
const fixture: any = { ids, bodyA, bodyB, listVersion: 1, offline: false, deny: false, defer: '', release: () => {}, loseQueue: false, emptyPage: false, connections: [connection(), connection(ids.otherConnection)], rows: new Map(), bodies: new Map(), cached: new Set(), calls: { authored: [], workflow: [], feedback: [], reads: [], external: [], local: [], contexts: [], dispatch: [], reconcile: [], pairs: [] }, materials: [], snapshot: null }
;(window as any).teamFixture = fixture
const wait = async (kind: string) => { if (fixture.defer === kind) await new Promise<void>((resolve) => { fixture.release = resolve }) }
const rejectAccess = () => fixture.deny ? fail('FORBIDDEN', '原设备访问已撤销') : fixture.offline ? fail('NETWORK_UNAVAILABLE', '团队服务暂时离线') : null
const page = (items: unknown[], more = false, nextCursor: string | null = null) => ({ items, hasMore: more, nextCursor })
const currentMaterial = (id: string, version: number) => fixture.materials.find((item: any) => item.materialId === id && item.version === version)
const materialFor = (connectionId: string, version = fixture.listVersion) => currentMaterial(connectionId === ids.connection ? ids.material : ids.otherMaterial, connectionId === ids.connection ? version : 1)
const rowFor = (payload: any, kind: string) => ({ commandId: payload.commandId, connectionId: payload.connectionId, kind, state: 'queued', materialId: payload.materialId, version: 'version' in payload ? payload.version : null, title: payload.title ?? null, createdAt: Date.now(), updatedAt: Date.now(), payloadDigest: 'a'.repeat(64), lastErrorCode: null, attempts: 0, outcomeUnknown: false, reconciliation: 'not-checked', reconciledAt: null, receipt: null })
const queue = async (payload: any, kind: 'publication' | 'feedback', call: string) => {
  fixture.calls[call].push(structuredClone(payload))
  let row = fixture.rows.get(payload.commandId)
  if (!row) { row = rowFor(payload, kind); fixture.rows.set(payload.commandId, row) }
  const result = structuredClone(row)
  await wait(call)
  if (fixture.loseQueue) return fail('ACKNOWLEDGEMENT_UNKNOWN', '保存结果尚未确认，请核对原操作', true)
  return ok(result)
}
fixture.emit = () => { for (const listener of listeners) listener({ connectionId: null, reason: 'updated', occurredAt: Date.now() }) }
fixture.api = {
  openExternal: async (url: string) => { fixture.calls.external.push(url) }, copyToClipboard: async () => {}, openLocalDocument: async (href: string) => { fixture.calls.local.push(href); return { ok: false } },
  teamDesktop: {
    connections: async () => ok(structuredClone(fixture.connections.map((item: any) => ({ ...item, network: fixture.offline ? 'offline' : item.network })))),
    connectionContext: async (id: string) => { fixture.calls.contexts.push(id); const denial = rejectAccess(); if (denial) return denial; const c = fixture.connections.find((item: any) => item.connectionId === id); return ok({ person: { userId: c.ownerId, displayName: id === ids.connection ? 'Alice 产品' : 'Bob 测试', active: true, isPlatformAdmin: false, revision: 1 }, project: { projectId: c.projectId, teamId: ids.team, name: id === ids.connection ? '订单管理平台' : '设备管理项目', createdAt: now, roles: id === ids.connection ? ['product', 'developer'] : ['tester'] } }) },
    onChanged: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    listMaterials: async (input: any) => { const denial = rejectAccess(); if (denial) return denial; if (fixture.emptyPage && !input.cursor) return ok(page([], true, 'next-visible-page')); return ok(page([structuredClone(materialFor(input.connectionId))])) },
    refreshSharedSnapshot: async (id: string) => { const denial = rejectAccess(); if (denial) return denial; const result = { items: [structuredClone(materialFor(id))], fetchedAt: Date.now(), stale: true, authorization: 'last-observed', resetRequired: false, eventsHasMore: false }; fixture.snapshot = structuredClone(result); return ok(result) },
    cachedSnapshot: async () => { fixture.calls.cache.push(true); return fixture.deny ? fail('ACCESS_LOCKED', '旧缓存已锁定') : ok(structuredClone(fixture.snapshot)) },
    listVersions: async (input: any) => { const denial = rejectAccess(); if (denial) return denial; return ok(page(fixture.materials.filter((item: any) => item.materialId === input.materialId).map((item: any) => structuredClone(item)))) },
    readDocument: async (input: any) => {
      fixture.calls.reads.push(structuredClone(input)); const material = structuredClone(currentMaterial(input.materialId, input.version)), text = fixture.bodies.get(`${input.materialId}:${input.version}`)
      const denial = fixture.deny ? fail('FORBIDDEN', '此文档的读取权限已撤销') : null
      if (denial) return denial
      if (fixture.offline && (!input.allowOffline || !fixture.cached.has(`${input.materialId}:${input.version}`))) return fail('NETWORK_UNAVAILABLE', '此版本缓存尚不可用')
      const result = { document: { material, text }, fetchedAt: Date.now(), freshness: fixture.offline ? 'cached-offline' : 'remote', authorization: fixture.offline ? 'last-observed' : 'current-server' }
      if (fixture.corruptBody) result.document.text += 'invalid bytes'
      await wait('read'); fixture.cached.add(`${input.materialId}:${input.version}`); return ok(result)
    },
    listFeedback: async () => { const denial = rejectAccess(); if (denial) return denial; return ok(page(fixture.feedbacks ?? [])) },
    queueAuthoredPublication: (input: any) => queue(input, 'publication', 'authored'),
    queueWorkflowMaterial: async (root: string, input: any) => { fixture.calls.workflow.push({ root, input: structuredClone(input) }); return queue(input, 'publication', 'workflowSaved') },
    queueFeedback: (input: any) => queue(input, 'feedback', 'feedback'),
    outbox: async (id: string, options: any) => ok(page([...fixture.rows.values()].filter((row: any) => row.connectionId === id).map((row: any) => structuredClone(row)))),
    cancelQueued: async (id: string) => { const row = fixture.rows.get(id); if (row.state !== 'queued') return fail('RECONCILE_REQUIRED', '不是尚未发送的操作'); row.state = 'cancelled-before-dispatch'; return ok(structuredClone(row)) },
    reconcile: async (id: string) => { fixture.calls.reconcile.push(id); const row = fixture.rows.get(id); if (!row) return fail('NOT_FOUND', '原操作不存在于当前读取点'); row.reconciliation = 'missing-at-read-point'; row.reconciledAt = Date.now(); return ok(structuredClone(row)) },
    dispatch: async (id: string, options: any) => { fixture.calls.dispatch.push({ id, options }); const row = fixture.rows.get(id); row.state = 'committed'; row.outcomeUnknown = false; row.receipt = materialFor(row.connectionId); return ok(structuredClone(row)) },
    beginPairing: async (input: any) => { fixture.calls.pairs.push(input); const id = crypto.randomUUID(), c = { ...connection(id), deviceName: input.deviceName, state: 'pending', ownerId: null, projectId: null, remoteDevice: null, userCode: 'ABCD2345EF', verificationUri: `${input.origin}/?pairing=${crypto.randomUUID()}` }; fixture.connections.push(c); return ok({ connection: structuredClone(c), browser: 'opened' }) },
    openPairing: async () => ok(undefined), pollPairing: async (id: string) => ok(structuredClone(fixture.connections.find((item: any) => item.connectionId === id))),
    disconnect: async (id: string) => { const c = fixture.connections.find((item: any) => item.connectionId === id); c.state = 'disconnected'; c.accessLocked = true; return ok(structuredClone(c)) }
  }
}
fixture.calls.workflowSaved = []
fixture.calls.cache = []
async function ready() {
  for (const [version, text] of [[1, bodyA], [2, bodyB]] as const) {
    const material = { materialId: ids.material, version, projectId: ids.project, teamId: ids.team, ownerId: ids.person, title: '订单导出需求', kind: 'product-requirement', visibility: 'project', bodyDigest: await hash(text), byteLength: new TextEncoder().encode(text).byteLength, source: { kind: 'authored', sourceId: 'owned-requirement', version: `source-${version}` }, createdAt: now + version, authorId: ids.person }
    fixture.materials.push(material); fixture.bodies.set(`${ids.material}:${version}`, text)
  }
  const otherText = '# 设备项目资料\n\n另一项目的独立文档。\n'
  fixture.materials.push({ ...fixture.materials[0], materialId: ids.otherMaterial, projectId: ids.otherProject, ownerId: ids.otherPerson, title: '另一项目文档', bodyDigest: await hash(otherText), byteLength: new TextEncoder().encode(otherText).byteLength, authorId: ids.otherPerson }); fixture.bodies.set(`${ids.otherMaterial}:1`, otherText)
  function Fixture() {
    const [state, setState] = useState({ root: 'D:/owned-team-desktop-ui', active: true, theme: 'light', mount: 0, sourceRevision: 1, fixedSource: false })
    ;(window as any).setTeamFixture = (patch: unknown) => setState((old) => ({ ...old, ...(patch as object) }))
    return <div className="my-root team-fixture-root" data-my-theme={state.theme} data-my-font-size="standard"><InteractionScope active={state.active}><main key={state.mount}><h1>团队协作 · 桌面阅读与发布</h1><p>Actual React/Chromium. Team, native and HTTP boundaries are explicit owned fixtures.</p><div className="team-inline-actions"><TeamCollaborationEntry root={state.root} /><PublishWorkflowVersionButton expectedRoot={state.root} source={state.fixedSource ? { kind: 'fixed-document', token: 'rd-' + String(state.sourceRevision).repeat(64) } : { kind: 'task-run', taskDir: 'task-a', run: { runId: 'run-a', revision: state.sourceRevision }, ref: 'wm-' + String(state.sourceRevision).repeat(64) }} title="开发需求 PRD" kind="trellis-prd" /></div></main></InteractionScope></div>
  }
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') dispatchEscKey(event) })
  createRoot(document.getElementById('root') as HTMLElement).render(<Fixture />)
}
void ready()
