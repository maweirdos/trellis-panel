/** Independent local accounts, actual HTTP commands and isolated worker SQLite; no external service. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createTeamService } from '../dist/index.mjs'
import { BrowserAccount, freePort } from './oidc-fixture.mjs'

test('human lifecycle and version ledgers use actual account authority and current space projections', { timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'trellis-hifox-lifecycle-http-'))
  const origin = `http://127.0.0.1:${await freePort()}`
  const config = { dataDir: join(directory, 'store'), publicOrigin: origin }
  let service
  let projectId, spaceId, crewId, crewReceipt, taskReceipt, taskId, sourceId, targetId, privateSpace, privateCrew, privateSource, privateTarget, privateReceipt
  const accounts = new Map()
  const ids = new Map()
  const person = (name) => ids.get(name)
  const account = (name) => accounts.get(name)
  const route = (suffix) => `/api/projects/${projectId}/hifox/${suffix}`
  const ok = async (name, path, body) => {
    const response = await account(name).api(path, body)
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.body)}`)
    return response.body.value
  }
  const read = (name = 'owner') => ok(name, route('snapshot'))
  const post = async (name, operation, input, commandId = randomUUID()) => {
    const head = await read(name)
    const body = { commandId, operation, input, expectedEpoch: head.epoch, expectedRevision: head.revision }
    return { response: await account(name).api(route('commands'), body), body }
  }
  const write = async (name, operation, input, commandId) => {
    const { response, body } = await post(name, operation, input, commandId)
    assert.equal(response.status, 200, `${operation}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.value.status, 'committed')
    return { ...response.body.value.result, command: body }
  }
  const rejected = async (name, operation, input, status = 400, code = 'INVALID_INPUT') => {
    const before = await read()
    const { response } = await post(name, operation, input)
    assert.equal(response.status, status, `${operation}: ${JSON.stringify(response.body)}`)
    assert.equal(response.body.code, code)
    const after = await read()
    assert.equal(after.revision, before.revision, `${operation} advanced the rejected command's revision`)
    assert.deepEqual(after.snapshot, before.snapshot, `${operation} leaked part of a rejected write`)
  }
  const transition = (name, action, fields = {}, id = taskId) => write(name, 'transitionTask', { taskId: id, action, ...fields })
  const item = (snapshot, id = taskId) => snapshot.tasks.find((task) => task.id === id)
  const version = (snapshot, id) => snapshot.iterations.find((iteration) => iteration.id === id)
  const memberships = (snapshot) => {
    for (const task of snapshot.tasks) for (const id of task.iterationIds) assert.ok(version(snapshot, id)?.taskIds.includes(task.id))
    for (const iteration of snapshot.iterations) for (const id of iteration.taskIds) assert.ok(item(snapshot, id)?.iterationIds.includes(iteration.id))
  }
  const start = async () => {
    service = await createTeamService(config)
    await service.app.listen({ port: Number(new URL(origin).port), host: '127.0.0.1' })
  }

  try {
    await start()
    await t.test('independent registration and project roles leave product colleagues ordinary', async () => {
      for (const name of ['owner', 'product', 'designer', 'developer', 'tester', 'outsider', 'external']) {
        const browser = new BrowserAccount(origin, 'unused')
        accounts.set(name, browser)
        const options = await browser.api('/api/auth/options')
        assert.equal(options.status, 200)
        const registered = await browser.api('/auth/local/register', { username: `lifecycle.${name}`, displayName: name, password: 'isolated-lifecycle-password-123!' }, { 'X-CSRF-Token': options.body.value.csrfToken })
        assert.equal(registered.status, 200, JSON.stringify(registered.body))
        const session = registered.body.value.session
        browser.csrf = session.csrfToken
        ids.set(name, session.person.userId)
        assert.equal(session.person.isPlatformAdmin, false)
        assert.equal(session.person.provider, 'local')
      }
      assert.equal(new Set(ids.values()).size, 7)
      const teamId = (await ok('owner', '/api/teams', { commandId: randomUUID(), name: 'Lifecycle test team' })).result.teamId
      projectId = (await ok('owner', '/api/projects', { commandId: randomUUID(), teamId, name: 'Lifecycle test project' })).result.projectId
      for (const [name, role] of [['product', 'product'], ['designer', 'developer'], ['developer', 'developer'], ['tester', 'tester'], ['outsider', 'pm']]) {
        await ok('owner', `/api/teams/${teamId}/members`, { commandId: randomUUID(), userId: person(name), roles: ['member'], active: true, expectedRevision: null })
        await ok('owner', `/api/projects/${projectId}/members`, { commandId: randomUUID(), userId: person(name), roles: [role], active: true, expectedRevision: null })
      }
      const ordinary = await read('product')
      assert.equal(ordinary.actor.id, person('product'))
      assert.equal(ordinary.actor.role, 'member')
      assert.equal(ordinary.canManage, false)
      assert.equal((await read('outsider')).canManage, true)
      assert.equal((await account('external').api(route('snapshot'))).status, 403)
      assert.deepEqual(ordinary.snapshot.spaces, [])
      assert.deepEqual(ordinary.snapshot.versionDeliveries, [])
      spaceId = (await write('owner', 'createSpace', { name: 'Human work', key: 'HUMAN' })).snapshot.spaces.at(-1).id
      await write('owner', 'setSpaceMembers', { spaceId, memberIds: ['owner', 'product', 'designer', 'developer', 'tester'].map(person) })
      await rejected('product', 'saveCrew', { spaceId, name: 'Unauthorized configuration', captainMemberId: person('designer'), memberRefs: [] }, 403, 'OPERATION_FORBIDDEN')
      await rejected('owner', 'saveCrew', { spaceId, name: 'Foreign captain', captainMemberId: person('outsider'), memberRefs: [] })
      await rejected('owner', 'saveCrew', { spaceId, name: 'Foreign squad member', captainMemberId: person('designer'), memberRefs: [{ kind: 'member', id: person('outsider') }] })
      const created = await write('owner', 'saveCrew', { spaceId, name: 'Human delivery team', captainMemberId: person('designer'), ownerId: person('product'), memberRefs: ['product', 'developer', 'tester'].map((name) => ({ kind: 'member', id: person(name) })) })
      crewId = created.snapshot.crews.at(-1).id
      crewReceipt = created.command
      const projected = (await read('product')).snapshot
      const crew = projected.crews.find((entry) => entry.id === crewId)
      assert.equal(crew.captain.kind, 'member')
      assert.equal(crew.captain.id, person('designer'))
      assert.deepEqual(new Set(crew.members.map((member) => member.id)), new Set(['product', 'designer', 'developer', 'tester'].map(person)))
      assert.deepEqual(projected.agents, [])
    })

    await t.test('ordinary product creator atomically accepts and arranges; foreign actors and people roll back', async () => {
      sourceId = (await write('product', 'createIteration', { spaceId, name: 'Source version', startDate: '2026-10-01', endDate: '2026-12-01' })).snapshot.iterations.at(-1).id
      targetId = (await write('developer', 'createIteration', { spaceId, name: 'Parallel target', startDate: '2026-10-01', endDate: '2026-12-01' })).snapshot.iterations.at(-1).id
      const created = await write('product', 'createTask', { spaceId, title: 'One human code task', triagePending: true, creatorId: person('owner'), workKind: 'code', acceptanceCriteria: ['Regression checked', 'Delivery reviewed'] })
      taskId = created.taskId
      assert.equal(item(created.snapshot).creatorId, person('product'), 'the service must derive the creator from the actual account')
      await rejected('product', 'triage', { taskId, disposition: 'park' })
      await rejected('developer', 'transitionTask', { taskId, action: 'arrange', assigneeId: person('designer') })
      await rejected('outsider', 'transitionTask', { taskId, action: 'arrange', assigneeId: person('designer') })
      await rejected('product', 'transitionTask', { taskId, action: 'arrange', iterationId: sourceId, assigneeId: person('external') })
      await rejected('product', 'transitionTask', { taskId, action: 'arrange', actorId: person('owner'), assigneeId: person('designer') })
      const arranged = await transition('product', 'arrange', { expectedStage: 'accepted', iterationId: sourceId, assigneeId: person('designer'), executor: { kind: 'crew', id: crewId, name: 'forged label' }, body: 'Accepted and assigned together' })
      taskReceipt = arranged.command
      const task = item(arranged.snapshot)
      assert.equal(task.triagePending, undefined)
      assert.equal(task.workflow.stage, 'design_ready')
      assert.equal(task.workflow.handlerId, person('designer'))
      assert.equal(task.workflow.history.length, 1)
      assert.equal(task.workflow.history[0].actorId, person('product'))
      assert.deepEqual(task.iterationIds, [sourceId])
      assert.deepEqual(version(arranged.snapshot, sourceId).taskIds, [taskId])
      assert.equal(task.executor.name, 'Human delivery team')
      assert.equal(task.dispatch, undefined)
      const recipient = (await read('designer')).snapshot
      assert.ok(recipient.inbox.some((entry) => entry.taskId === taskId && entry.body === 'Accepted and assigned together' && entry.recipientIds.includes(person('designer'))))
      assert.ok(recipient.crews.some((crew) => crew.id === crewId))
      memberships(arranged.snapshot)
    })

    await t.test('current human handlers and space managers can reassign without moving stage, evidence or version scope', async () => {
      const before = (await read()).snapshot
      const original = item(before)
      await rejected('product', 'transitionTask', { taskId, action: 'reassign', assigneeId: person('developer') })
      await rejected('outsider', 'transitionTask', { taskId, action: 'reassign', assigneeId: person('developer') })
      await rejected('designer', 'transitionTask', { taskId, action: 'reassign', assigneeId: person('outsider') })
      for (const forbidden of [{ iterationId: sourceId }, { workKind: 'code' }, { acceptanceCriteria: original.acceptanceCriteria }]) {
        await rejected('designer', 'transitionTask', { taskId, action: 'reassign', assigneeId: person('developer'), ...forbidden })
      }
      const handoff = await transition('designer', 'reassign', { expectedStage: 'design_ready', expectedUpdatedAt: original.updatedAt, assigneeId: person('developer'), executor: null, body: 'Continue the current design stage' })
      const transferred = item(handoff.snapshot)
      assert.equal(transferred.workflow.stage, original.workflow.stage)
      assert.deepEqual(transferred.workflow.artifacts, original.workflow.artifacts)
      assert.deepEqual(transferred.iterationIds, original.iterationIds)
      assert.deepEqual(handoff.snapshot.iterations, before.iterations)
      assert.deepEqual(transferred.acceptanceCriteria, original.acceptanceCriteria)
      assert.equal(transferred.workKind, original.workKind)
      assert.equal(transferred.statusId, original.statusId)
      assert.equal(transferred.workflow.handlerId, person('developer'))
      assert.equal(transferred.executor, undefined)
      assert.equal(transferred.workflow.history.at(-1).actorId, person('designer'))
      assert.equal(transferred.workflow.history.at(-1).assigneeId, person('developer'))
      assert.notEqual(transferred.updatedAt, original.updatedAt)
      await rejected('owner', 'transitionTask', { taskId, action: 'reassign', expectedStage: original.workflow.stage, expectedUpdatedAt: original.updatedAt, assigneeId: person('designer') })
      const activity = handoff.snapshot.activities.find((entry) => entry.taskId === taskId && entry.kind === 'workflow')
      assert.match(activity.text, /designer.*转交任务.*developer/)
      assert.equal(activity.text.includes(person('designer')), false)
      assert.equal(activity.text.includes('reassign'), false)
      assert.ok((await read('developer')).snapshot.inbox.some((entry) => entry.taskId === taskId && entry.title.includes('任务转交') && entry.recipientIds.includes(person('developer'))))
      await rejected('designer', 'transitionTask', { taskId, action: 'reassign', assigneeId: person('tester') })
      const restored = await transition('owner', 'reassign', { assigneeId: person('designer'), executor: { kind: 'crew', id: crewId, name: 'Human delivery team' } })
      assert.equal(item(restored.snapshot).workflow.stage, original.workflow.stage)
      assert.deepEqual(item(restored.snapshot).workflow.artifacts, original.workflow.artifacts)
      assert.deepEqual(restored.snapshot.iterations, before.iterations)
      assert.equal(item(restored.snapshot).workflow.history.at(-1).actorId, person('owner'))
      assert.equal(item(restored.snapshot).dispatch, undefined)
    })

    await t.test('human design, technical plan, test rework and acceptance preserve evidence and handler authority', async () => {
      await transition('designer', 'start_design', { assigneeId: person('designer') })
      const design = await transition('designer', 'submit_design', { assigneeId: person('product'), body: 'Design: preserve all task and version indexes' })
      assert.equal(item(design.snapshot).workflow.stage, 'design_review')
      await transition('product', 'approve_design', { assigneeId: person('developer') })
      const head = (await read()).snapshot
      const doneStatus = head.taskStatuses.find((status) => status.spaceId === spaceId && status.category === 'done').id
      await rejected('developer', 'updateTask', { id: taskId, patch: { statusId: doneStatus, title: 'Must roll back' } })
      await rejected('owner', 'transitionTask', { taskId, action: 'begin_development', assigneeId: person('developer') })
      const edited = await write('product', 'updateTask', { id: taskId, patch: { description: 'Requirement edited while native preparation was in progress' } })
      assert.equal(item(edited.snapshot).workflow.stage, item(head).workflow.stage)
      assert.notEqual(item(edited.snapshot).updatedAt, item(head).updatedAt)
      await rejected('developer', 'transitionTask', { taskId, action: 'begin_development', assigneeId: person('developer'), expectedStage: 'dev_ready', expectedUpdatedAt: item(head).updatedAt })
      await transition('developer', 'begin_development', { assigneeId: person('developer'), expectedStage: 'dev_ready', expectedUpdatedAt: item(edited.snapshot).updatedAt })
      await rejected('developer', 'transitionTask', { taskId, action: 'submit_test', body: 'Bypass plan' })
      await transition('developer', 'approve_plan', { assigneeId: person('developer'), body: 'Plan: change domain, add focused regression, verify evidence' })
      await transition('developer', 'submit_test', { assigneeId: person('tester'), body: 'Implementation handoff: first patch' })
      await transition('tester', 'return_development', { assigneeId: person('developer'), body: 'Test found an omitted empty value' })
      await transition('developer', 'submit_test', { assigneeId: person('tester'), body: 'Implementation handoff: corrected patch' })
      await rejected('tester', 'transitionTask', { taskId, action: 'pass_test', body: 'Incomplete verification', checkedCriteria: ['Regression checked'] })
      await transition('tester', 'pass_test', { assigneeId: person('product'), body: 'Human tester verified the regression and reviewed delivery', checkedCriteria: ['Regression checked', 'Delivery reviewed'] })
      const accepted = await transition('product', 'accept_delivery', { assigneeId: person('product') })
      const task = item(accepted.snapshot)
      assert.equal(task.workflow.stage, 'done')
      assert.equal(task.dispatch, undefined)
      assert.ok(task.completedAt)
      for (const kind of ['design', 'plan', 'implementation', 'test', 'acceptance']) assert.ok(task.workflow.artifacts.some((artifact) => artifact.kind === kind))
      assert.equal(task.workflow.history.find((entry) => entry.action === 'approve_plan').actorId, person('developer'))
      assert.deepEqual(task.workflow.history.find((entry) => entry.action === 'pass_test').checkedCriteria, ['Regression checked', 'Delivery reviewed'])
      assert.equal(task.workflow.history.at(-1).actorId, person('product'))
      await rejected('product', 'transitionTask', { taskId, action: 'reassign', assigneeId: person('developer') })
    })

    await t.test('empty acceptance criteria reject planning atomically and real supplementation allows development', async () => {
      const created = await write('product', 'createTask', { spaceId, title: 'Existing API work without criteria', assigneeIds: [person('developer')] })
      const id = created.taskId
      const arranged = await transition('product', 'arrange', { assigneeId: person('developer'), nextStage: 'dev_ready', workKind: 'code' }, id)
      const original = item(arranged.snapshot, id)
      assert.equal(original.acceptanceCriteria, undefined)
      await rejected('developer', 'transitionTask', { taskId: id, action: 'begin_development', expectedStage: 'dev_ready', expectedUpdatedAt: original.updatedAt, body: 'Planning must not be recorded' })
      await rejected('developer', 'transitionTask', { taskId: id, action: 'begin_development', acceptanceCriteria: [], expectedUpdatedAt: original.updatedAt })
      const unchanged = item((await read()).snapshot, id)
      assert.equal(unchanged.workflow.stage, 'dev_ready')
      assert.deepEqual(unchanged.workflow, original.workflow)
      await transition('developer', 'request_info', { assigneeId: person('product'), body: 'Please supply the missing acceptance checks' }, id)
      const supplied = await transition('product', 'supplement', { assigneeId: person('developer'), body: 'Acceptance checks supplied', acceptanceCriteria: ['Expected behavior is verified'] }, id)
      const planning = await transition('developer', 'begin_development', { expectedStage: 'dev_ready', expectedUpdatedAt: item(supplied.snapshot, id).updatedAt, assigneeId: person('developer') }, id)
      assert.equal(item(planning.snapshot, id).workflow.stage, 'planning')
      assert.deepEqual(item(planning.snapshot, id).acceptanceCriteria, ['Expected behavior is verified'])
    })

    await t.test('general work reaches acceptance without Runtime, technical plans or fabricated tests', async () => {
      const created = await write('product', 'createTask', { spaceId, title: 'Prepare operations guide', triagePending: true, workKind: 'general', acceptanceCriteria: ['Guide approved'] })
      const id = created.taskId
      const arranged = await transition('product', 'arrange', { assigneeId: person('developer'), executor: { kind: 'crew', id: crewId, name: 'Human delivery team' } }, id)
      assert.equal(item(arranged.snapshot, id).workflow.stage, 'developing')
      assert.equal(item(arranged.snapshot, id).dispatch, undefined)
      await transition('developer', 'submit_delivery', { assigneeId: person('product'), body: 'artifact://operations-guide/revision-1' }, id)
      const accepted = await transition('product', 'accept_delivery', { assigneeId: person('product') }, id)
      const task = item(accepted.snapshot, id)
      assert.equal(task.workflow.stage, 'done')
      assert.ok(task.workflow.history.every((entry) => !['approve_plan', 'submit_test', 'pass_test'].includes(entry.action)))
    })

    await t.test('normal-member ledger operations preserve source/target task scope and closing never moves work', async () => {
      const created = await write('product', 'createTask', { spaceId, title: 'Unfinished source scope', iterationIds: [sourceId] })
      const unfinished = created.taskId
      await rejected('product', 'transitionTask', { taskId: unfinished, action: 'reassign', assigneeId: person('developer') })
      const legacy = await write('product', 'updateTask', { id: unfinished, patch: { assigneeIds: [person('developer')] } })
      assert.equal(item(legacy.snapshot, unfinished).workflow, undefined)
      for (const carryOver of ['next', 'backlog']) await rejected('developer', 'completeIteration', { id: sourceId, carryOver })
      const before = (await read()).snapshot
      const record = { sourceIterationId: sourceId, targetIterationId: targetId, kind: 'code', reference: 'commit:human-reviewed-1', name: 'First human-recorded increment', revision: 'human-reviewed-1' }
      const first = await write('developer', 'recordVersionDelivery', record)
      const second = await write('tester', 'recordVersionDelivery', { ...record, kind: 'artifact', reference: 'artifact://verified-test-report', name: 'Test evidence increment' })
      assert.equal(second.snapshot.versionDeliveries.length, 2)
      assert.equal(first.snapshot.versionDeliveries[0].actorId, person('developer'))
      assert.equal(second.snapshot.versionDeliveries[1].actorId, person('tester'))
      assert.notEqual(second.snapshot.versionDeliveries[0].id, second.snapshot.versionDeliveries[1].id)
      assert.deepEqual(second.snapshot.tasks, before.tasks)
      assert.deepEqual(second.snapshot.iterations, before.iterations)
      assert.notEqual(version(second.snapshot, sourceId).status, 'completed')
      await rejected('outsider', 'recordVersionDelivery', record)
      await rejected('developer', 'recordVersionDelivery', { ...record, actorId: person('owner') })
      await rejected('developer', 'recordVersionDelivery', { ...record, targetIterationId: sourceId })
      await write('product', 'updateTask', { id: unfinished, patch: { iterationIds: [] } })
      await write('tester', 'updateIteration', { id: targetId, taskIds: [taskId] })
      const closing = (await read()).snapshot
      const completed = await write('developer', 'completeIteration', { id: sourceId, carryOver: 'next' })
      assert.deepEqual(completed.snapshot.tasks, closing.tasks)
      assert.deepEqual(item(completed.snapshot).iterationIds, [sourceId, targetId])
      assert.deepEqual(version(completed.snapshot, sourceId).taskIds, [taskId])
      assert.equal(version(completed.snapshot, sourceId).status, 'completed')
      memberships(completed.snapshot)
    })

    await t.test('private crew rosters and version deliveries disappear on read and receipt after space revocation', async () => {
      privateSpace = (await write('owner', 'createSpace', { name: 'Private lifecycle room', key: 'SECRET', visibility: 'private' })).snapshot.spaces.at(-1).id
      await write('owner', 'setSpaceMembers', { spaceId: privateSpace, memberIds: ['owner', 'product', 'tester'].map(person) })
      privateCrew = (await write('owner', 'saveCrew', { spaceId: privateSpace, name: 'Private crew sentinel', captainMemberId: person('tester'), memberRefs: [{ kind: 'member', id: person('product') }] })).snapshot.crews.at(-1).id
      privateSource = (await write('product', 'createIteration', { spaceId: privateSpace, name: 'Private source sentinel', startDate: '2026-10-01', endDate: '2026-12-01' })).snapshot.iterations.at(-1).id
      privateTarget = (await write('product', 'createIteration', { spaceId: privateSpace, name: 'Private target sentinel', startDate: '2026-10-01', endDate: '2026-12-01' })).snapshot.iterations.at(-1).id
      const recorded = await write('product', 'recordVersionDelivery', { sourceIterationId: privateSource, targetIterationId: privateTarget, kind: 'artifact', reference: 'artifact://private-delivery-sentinel' })
      privateReceipt = recorded.command
      await rejected('product', 'recordVersionDelivery', { sourceIterationId: sourceId, targetIterationId: privateTarget, kind: 'artifact', reference: 'artifact://cross-space' })
      await rejected('outsider', 'recordVersionDelivery', { sourceIterationId: privateSource, targetIterationId: privateTarget, kind: 'artifact', reference: 'artifact://outside-private-space' }, 403, 'SPACE_ACCESS_DENIED')
      assert.ok((await read('product')).snapshot.crews.some((crew) => crew.id === privateCrew))
      const outsider = (await read('outsider')).snapshot
      const metadata = outsider.spaces.find((space) => space.id === privateSpace)
      assert.deepEqual(metadata.memberIds, [])
      assert.equal(metadata.ownerId, undefined)
      assert.ok(!outsider.crews.some((crew) => crew.id === privateCrew))
      assert.ok(!outsider.versionDeliveries.some((delivery) => delivery.spaceId === privateSpace))
      await write('owner', 'setSpaceMembers', { spaceId: privateSpace, memberIds: ['owner', 'tester'].map(person) })
      const authorized = (await read()).snapshot.crews.find((crew) => crew.id === privateCrew)
      assert.deepEqual(authorized.members.map((member) => member.id), [person('tester')])
      const current = (await read('product')).snapshot
      assert.ok(!current.spaces.some((space) => space.id === privateSpace))
      for (const reply of [await account('product').api(route('commands'), privateReceipt), await account('product').api(`/api/commands/${privateReceipt.commandId}`)]) {
        assert.equal(reply.status, 200, JSON.stringify(reply.body))
        const projected = reply.body.value.result.snapshot
        assert.ok(!projected.crews.some((crew) => crew.id === privateCrew))
        assert.ok(!projected.versionDeliveries.some((delivery) => delivery.spaceId === privateSpace))
        for (const sentinel of ['Private crew sentinel', 'Private source sentinel', 'Private target sentinel', 'artifact://private-delivery-sentinel']) assert.equal(JSON.stringify(projected).includes(sentinel), false)
      }
    })

    await t.test('historical human crew receipts use current roster grants and preserve no departed captain association', async () => {
      const remaining = ['owner', 'designer', 'developer', 'tester'].map(person)
      await write('owner', 'setSpaceMembers', { spaceId, memberIds: remaining })
      const replay = await account('owner').api(route('commands'), crewReceipt)
      assert.equal(replay.status, 200, JSON.stringify(replay.body))
      const crew = replay.body.value.result.snapshot.crews.find((entry) => entry.id === crewId)
      assert.ok(crew)
      assert.equal(crew.ownerId, undefined)
      assert.ok(crew.members.every((member) => member.id !== person('product')))
      await write('owner', 'removeCrew', { id: crewId })
      await write('owner', 'setSpaceMembers', { spaceId, memberIds: remaining.filter((id) => id !== person('designer')) })
      const after = (await read()).snapshot
      assert.ok(!after.crews.some((entry) => entry.id === crewId))
      assert.ok(item(after))
      assert.equal(item(after).executor, undefined)
      const historical = await ok('owner', `/api/commands/${crewReceipt.commandId}`)
      assert.ok(!historical.result.snapshot.crews.some((entry) => entry.id === crewId))
      const taskHistory = await ok('product', `/api/commands/${taskReceipt.commandId}`)
      assert.ok(item(taskHistory.result.snapshot))
      assert.equal(item(taskHistory.result.snapshot).executor, undefined)
    })

    await t.test('persisted predecessor gates and closed scope reject all task/version rewrites atomically', async () => {
      await service.close(); service = undefined
      await start()
      const predecessor = (await write('developer', 'createIteration', { spaceId, name: 'Start gate predecessor', startDate: '2026-10-01', endDate: '2026-12-01' })).snapshot.iterations.at(-1).id
      const successor = (await write('tester', 'createIteration', { spaceId, name: 'Start gate successor', predecessorId: predecessor, startDate: '2026-10-01', endDate: '2026-12-01' })).snapshot.iterations.at(-1).id
      const parallel = (await write('developer', 'createIteration', { spaceId, name: 'Independent parallel version', startDate: '2026-10-01', endDate: '2026-12-01' })).snapshot.iterations.at(-1).id
      await rejected('tester', 'updateIteration', { id: successor, status: 'active', name: 'Must roll back', goal: 'Must roll back' })
      await write('developer', 'updateIteration', { id: parallel, status: 'active' })
      await rejected('developer', 'updateIteration', { id: parallel, predecessorId: predecessor, goal: 'Must roll back' })
      await rejected('developer', 'updateIteration', { id: parallel, predecessorId: predecessor, status: 'active' })
      await write('developer', 'completeIteration', { id: predecessor })
      const started = await write('tester', 'updateIteration', { id: successor, status: 'active' })
      assert.equal(version(started.snapshot, successor).status, 'active')
      assert.equal(version(started.snapshot, parallel).status, 'active')
      const statusId = started.snapshot.taskStatuses.find((status) => status.spaceId === spaceId && status.category === 'done').id
      const first = (await write('developer', 'createTask', { spaceId, title: 'First sealed scope task', statusId })).taskId
      const second = (await write('tester', 'createTask', { spaceId, title: 'Second sealed scope task', statusId })).taskId
      const extra = (await write('developer', 'createTask', { spaceId, title: 'Task outside sealed history', statusId })).taskId
      const sealed = (await write('tester', 'createIteration', { spaceId, name: 'Sealed scope', startDate: '2026-10-01', endDate: '2026-12-01', taskIds: [first, second] })).snapshot.iterations.at(-1).id
      await write('developer', 'completeIteration', { id: sealed })
      const before = (await read('tester')).snapshot
      await rejected('developer', 'updateTask', { id: first, patch: { title: 'Must roll back', iterationIds: [] } })
      await rejected('developer', 'updateTask', { id: extra, patch: { iterationIds: [sealed] } })
      await rejected('developer', 'createTask', { spaceId, title: 'Must not allocate a task number', statusId, iterationIds: [sealed] })
      for (const taskIds of [[first], [first, second, extra], [second, extra]]) await rejected('tester', 'updateIteration', { id: sealed, name: 'Must roll back', taskIds })
      await rejected('developer', 'removeTask', { id: first })
      const preserved = await write('tester', 'updateIteration', { id: sealed, taskIds: [second, first] })
      assert.deepEqual(preserved.snapshot, before, 'equivalent scope reordered history or rewrote task data')
      const open = (await write('tester', 'createIteration', { spaceId, name: 'Open alongside sealed', startDate: '2026-10-01', endDate: '2026-12-01', taskIds: [first] })).snapshot.iterations.at(-1).id
      const moved = await write('developer', 'updateTask', { id: first, patch: { title: 'Allowed metadata edit', iterationIds: [sealed] } })
      assert.deepEqual(version(moved.snapshot, sealed).taskIds, [first, second])
      assert.deepEqual(version(moved.snapshot, open).taskIds, [])
      assert.deepEqual(item(moved.snapshot, first).iterationIds, [sealed])
      memberships(moved.snapshot)
    })

    await t.test('retained inconsistent ledger references are filtered without rewriting SQLite records', async () => {
      await service.close(); service = undefined
      const database = new DatabaseSync(join(config.dataDir, 'team.sqlite'))
      let retained
      try {
        const stored = JSON.parse(database.prepare('SELECT snapshotJson FROM hifox_workspaces WHERE projectId=?').get(projectId).snapshotJson)
        const valid = stored.versionDeliveries[0]
        // Explicit legacy-integrity fixtures, never accepted as successful domain commands.
        stored.versionDeliveries.push(
          { ...valid, id: randomUUID(), targetIterationId: privateTarget, reference: 'artifact://invalid-cross-space-sentinel' },
          { ...valid, id: randomUUID(), sourceIterationId: 'missing-version', reference: 'artifact://invalid-missing-source-sentinel' },
          { ...valid, id: randomUUID(), targetIterationId: 'missing-version', reference: 'artifact://invalid-missing-target-sentinel' }
        )
        retained = JSON.stringify(stored)
        database.prepare('UPDATE hifox_workspaces SET snapshotJson=? WHERE projectId=?').run(retained, projectId)
      } finally { database.close() }
      await start()
      const snapshot = (await read()).snapshot
      assert.equal(snapshot.versionDeliveries.length, 3, 'two ordinary increments and one authorized private record remain')
      for (const delivery of snapshot.versionDeliveries) {
        assert.equal(version(snapshot, delivery.sourceIterationId)?.spaceId, delivery.spaceId)
        assert.equal(version(snapshot, delivery.targetIterationId)?.spaceId, delivery.spaceId)
      }
      assert.equal(JSON.stringify(snapshot).includes('artifact://invalid-'), false)
      await service.close(); service = undefined
      const reopened = new DatabaseSync(join(config.dataDir, 'team.sqlite'), { readOnly: true })
      try { assert.equal(reopened.prepare('SELECT snapshotJson FROM hifox_workspaces WHERE projectId=?').get(projectId).snapshotJson, retained) }
      finally { reopened.close() }
    })
  } finally {
    await service?.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('trellis-hifox-lifecycle-http-'))
    rmSync(directory, { recursive: true, force: true })
  }
})
