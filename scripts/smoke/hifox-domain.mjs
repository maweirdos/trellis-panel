/** Real domain services and filesystem, isolated from Electron/user data. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'trellis-hifox-domain-'))
const originalDir = process.env.HIFOX_STORE_DIR
const require = createRequire(import.meta.url)
const bundle = join(root, 'services.cjs')
const results = []
let api
const current = () => api.loadSnapshot()
const task = (id) => current().tasks.find((item) => item.id === id)
const iteration = (id) => current().iterations.find((item) => item.id === id)
const automation = (id) => current().automations.find((item) => item.id === id)
const create = (input = {}) => api.createTask({ spaceId: 'sp-eng', title: 'Regression task', ...input }).taskId
const patch = (id, value) => api.updateTask({ id, patch: value })
const lastId = (snapshot, collection) => snapshot[collection].at(-1).id
const executor = { kind: 'agent', id: 'ag-fe', name: 'caller-supplied name' }
const disk = () => readFileSync(join(process.env.HIFOX_STORE_DIR, 'store.json'), 'utf8')
const normalize = (value) => JSON.parse(JSON.stringify(value))

function check(name, run) {
  run()
  results.push(name)
  console.log(`PASS ${name}`)
}

function unchanged(run, pattern) {
  const before = normalize(current()), beforeDisk = disk()
  assert.throws(run, pattern)
  assert.deepEqual(normalize(current()), before, 'failed transaction changed memory')
  assert.equal(disk(), beforeDisk, 'failed transaction changed disk')
}

function assertMemberships() {
  const snapshot = current()
  for (const item of snapshot.tasks) for (const id of item.iterationIds) {
    const group = snapshot.iterations.find((it) => it.id === id)
    assert.ok(group, `missing iteration ${id}`)
    assert.equal(group.spaceId, item.spaceId)
    assert.ok(group.taskIds.includes(item.id), `${item.id} missing in ${id}`)
  }
  for (const group of snapshot.iterations) for (const id of group.taskIds) {
    const item = snapshot.tasks.find((t) => t.id === id)
    assert.ok(item, `missing task ${id}`)
    assert.equal(item.spaceId, group.spaceId)
    assert.ok(item.iterationIds.includes(group.id), `${group.id} missing in ${id}`)
  }
}

try {
  await build({
    stdin: { contents: `export * from './src/main/services/hifox/core.ts'; export * from './src/main/services/hifox/planning.ts'; export * from './src/main/services/hifox/store.ts'; export * as agents from './src/main/services/hifox/agents.ts'`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent'
  })
  process.env.HIFOX_STORE_DIR = join(root, 'domain')
  api = require(bundle)

  check('first launch is an empty local workspace and newly created teams can create tasks immediately', () => {
    const initial = current()
    assert.equal(initial.members.length, 1)
    assert.equal(initial.members[0].name, '我')
    for (const [key, value] of Object.entries(initial)) if (key !== 'members') assert.deepEqual(value, [], key)
    const snapshot = api.createSpace({ name: 'My real team', key: 'LOCAL' })
    const space = snapshot.spaces[0]
    assert.deepEqual(space.memberIds, [initial.members[0].id])
    const id = create({ spaceId: space.id })
    assert.equal(task(id).creatorId, initial.members[0].id)
    api.setSpaceMembers({ spaceId: space.id, memberIds: [] })
    unchanged(() => create({ spaceId: space.id }), /空间没有成员/)
  })
  api.resetDemoSnapshot()

  check('member email edits persist trimmed values, preserve omitted email and clear blank values', () => {
    const snapshot = api.inviteMember({ name: 'Email edit fixture', email: '  original@example.com  ' })
    const id = lastId(snapshot, 'members')
    const member = () => current().members.find((item) => item.id === id)
    const storedMember = () => JSON.parse(disk()).members.find((item) => item.id === id)
    assert.equal(member().email, 'original@example.com')
    api.updateMember({ id, email: '  changed@example.com  ' })
    assert.equal(member().email, 'changed@example.com')
    assert.equal(storedMember().email, 'changed@example.com')
    api.updateMember({ id, title: 'Contact' })
    assert.equal(member().email, 'changed@example.com')
    unchanged(() => api.updateMember({ id, name: 'Must not leak', email: 123 }), /邮箱必须为文本/)
    unchanged(() => api.inviteMember({ name: 'Invalid email', email: 123 }), /邮箱必须为文本/)
    api.updateMember({ id, email: '   ' })
    assert.equal(member().email, undefined)
    assert.equal(Object.hasOwn(storedMember(), 'email'), false)
    api.updateMember({ id, email: 'restored@example.com' })
    api.updateMember({ id, email: '' })
    assert.equal(member().email, undefined)
    assert.equal(Object.hasOwn(storedMember(), 'email'), false)
  })

  check('rollback covers validation after partial writes, task numbering and prior snapshots', () => {
    unchanged(() => api.inviteMember({ name: 'Must not leak', spaceId: 'missing' }), /空间不存在/)
    unchanged(() => create({ typeId: 'missing' }), /类型/)
    const id = create()
    unchanged(() => create({ spaceId: 'sp-ops', creatorId: 'm-lin' }), /创建人/)
    const explicitCreator = create({ creatorId: 'm-zhao' })
    assert.equal(task(explicitCreator).creatorId, 'm-zhao')
    unchanged(() => patch(id, { title: 'Must not leak', assigneeIds: ['missing'] }), /处理人/)
    unchanged(() => api.mutate((draft) => { draft.tasks.length = 0; throw Error('rollback seam') }), /rollback seam/)
    unchanged(() => api.mutate((draft) => { draft.members[0].role = 'invalid-role' }), /数据校验失败/)
    unchanged(() => api.updateSpace({ id: 'sp-eng', multiAssignee: 'invalid-boolean' }), /数据校验失败/)
    unchanged(() => api.mutate(() => api.inviteMember({ name: 'Nested mutation' })), /嵌套/)
    const snapshot = current()
    snapshot.tasks.length = 0
    assert.ok(current().tasks.length > 0, 'reads expose cache references')
    let retained
    const committed = api.mutate((draft) => { retained = draft; draft.tasks[0].description = 'Committed' })
    retained.tasks[0].description = 'Retained callback reference'
    committed.snapshot.tasks[0].description = 'Returned reference'
    assert.equal(current().tasks[0].description, 'Committed')
  })

  check('actual disk failure rolls back cache and returned snapshots remain immutable across writes', () => {
    const previous = current(), before = normalize(previous), beforeDisk = disk()
    const tempFile = join(process.env.HIFOX_STORE_DIR, 'store.json.tmp')
    mkdirSync(tempFile)
    assert.throws(() => patch(previous.tasks[0].id, { title: 'Cannot persist' }))
    assert.deepEqual(normalize(current()), before)
    assert.equal(disk(), beforeDisk)
    rmdirSync(tempFile) // Exact empty fault-injection directory, never user data.
    patch(previous.tasks[0].id, { title: 'Successful commit' })
    assert.deepEqual(normalize(previous), before)
  })

  check('task create/update reject missing and cross-space references atomically', () => {
    const otherProject = lastId(api.createProject({ spaceId: 'sp-ops', name: 'Other scope' }), 'projects')
    const otherIteration = lastId(api.createIteration({ spaceId: 'sp-ops', name: 'Other iteration', startDate: '2026-10-26', endDate: '2026-11-01' }), 'iterations')
    const otherLabel = lastId(api.createLabel({ spaceId: 'sp-ops', name: 'Other label' }), 'taskLabels')
    const id = create()
    for (const input of [
      { typeId: 'tt-feedback' }, { statusId: 'st-sup-todo' }, { labelIds: ['missing'] },
      { labelIds: [otherLabel] }, { projectId: otherProject }, { projectId: 'missing' },
      { iterationIds: [otherIteration] }, { iterationIds: ['missing'] },
      { parentTaskId: 'missing' }, { parentTaskId: 'SUP-12' }, { assigneeIds: ['m-missing'] },
      { executor: { kind: 'agent', id: 'missing', name: 'Missing' } }, { priority: 'invalid' }
    ]) {
      unchanged(() => create(input))
      unchanged(() => patch(id, { title: 'Must roll back', ...input }))
    }
    unchanged(() => create({ parentTaskId: `ENG-${current().spaces.find((s) => s.id === 'sp-eng').taskSeq + 1}` }), /循环/)
    const child = create({ parentTaskId: id })
    unchanged(() => patch(id, { parentTaskId: child }), /循环/)
    patch(child, { parentTaskId: null })
    assert.equal(task(child).parentTaskId, undefined)
    const globalLabel = lastId(api.createLabel({ name: 'Organization label' }), 'taskLabels')
    patch(id, { labelIds: [globalLabel, globalLabel] })
    assert.deepEqual(task(id).labelIds, [globalLabel])
    api.archiveLabel({ id: globalLabel })
    assert.deepEqual(task(id).labelIds, [globalLabel], 'archive erased historical labels')
    patch(id, { labelIds: [globalLabel] })
    unchanged(() => create({ labelIds: [globalLabel] }), /归档/)
  })

  check('multi-assignee disabling preserves and permits historical sets; new tasks stay single', () => {
    const id = create({ assigneeIds: ['m-lin', 'm-zhao'] })
    api.updateSpace({ id: 'sp-eng', multiAssignee: false })
    assert.deepEqual(task(id).assigneeIds, ['m-lin', 'm-zhao'])
    patch(id, { title: 'Historical set still editable', assigneeIds: ['m-lin', 'm-chen'] })
    assert.deepEqual(task(id).assigneeIds, ['m-lin', 'm-chen'])
    unchanged(() => create({ assigneeIds: ['m-lin', 'm-zhao'] }), /多人/)
    const single = create({ assigneeIds: ['m-lin'] })
    unchanged(() => patch(single, { assigneeIds: ['m-lin', 'm-zhao'] }), /多人/)
    api.updateSpace({ id: 'sp-eng', multiAssignee: true })
  })

  check('only backlog queues and Todo/In Progress wait for runtime; terminal/review/blocked suppress dispatch', () => {
    const input = { ...executor }
    const id = create({ statusId: 'st-backlog', executor: input })
    assert.equal(input.name, 'caller-supplied name', 'service mutated caller input')
    assert.equal(task(id).dispatch.status, 'queued')
    for (const statusId of ['st-todo', 'st-progress']) {
      patch(id, { statusId })
      assert.equal(task(id).dispatch.status, 'waiting_runtime')
    }
    for (const statusId of ['st-done', 'st-cancelled', 'st-review', 'st-blocked']) {
      patch(id, { statusId })
      assert.equal(task(id).dispatch, undefined, statusId)
      assert.equal(create({ statusId, executor }) && current().tasks[0].dispatch, undefined, statusId)
    }
    patch(id, { statusId: 'st-done' })
    assert.ok(task(id).completedAt)
    patch(id, { statusId: 'st-todo' })
    assert.equal(task(id).completedAt, undefined)
    patch(id, { executor: null })
    assert.equal(task(id).dispatch, undefined)
    const typeId = lastId(api.createTaskType({ spaceId: 'sp-eng', name: 'Restricted type', statusIds: ['st-progress', 'st-done'] }), 'taskTypes')
    assert.equal(task(create({ typeId })).statusId, 'st-progress')
    unchanged(() => create({ typeId, statusId: 'st-todo' }), /可用状态/)
    unchanged(() => api.updateTaskType({ id: typeId, statusIds: ['st-done'] }), /先迁移/)
    unchanged(() => api.removeTaskType({ id: typeId }), /先迁移/)
  })

  check('an explicit valid status takes precedence over type fallback during a combined edit', () => {
    const typeId = lastId(api.createTaskType({ spaceId: 'sp-eng', name: 'Terminal only type', statusIds: ['st-done'] }), 'taskTypes')
    const id = create({ executor })
    patch(id, { typeId, statusId: 'st-done' })
    assert.equal(task(id).typeId, typeId)
    assert.equal(task(id).statusId, 'st-done')
    assert.ok(task(id).completedAt)
    assert.equal(task(id).dispatch, undefined)
    const nextTypeId = lastId(api.createTaskType({ spaceId: 'sp-eng', name: 'Progress only type', statusIds: ['st-progress'] }), 'taskTypes')
    patch(id, { typeId: nextTypeId })
    assert.equal(task(id).statusId, 'st-progress')
    assert.equal(task(id).completedAt, undefined)
    assert.equal(task(id).dispatch.status, 'waiting_runtime')
  })

  check('iteration task membership stays bidirectional across both write paths and deletion', () => {
    const id = create()
    unchanged(() => api.createIteration({ spaceId: 'sp-eng', name: 'Bad scope', startDate: '2026-10-01', endDate: '2026-10-07', taskIds: ['SUP-12'] }), /同一空间/)
    unchanged(() => api.createIteration({ spaceId: 'sp-eng', name: 'Invalid day', startDate: '2026-02-30', endDate: '2026-03-07' }), /不存在/)
    const it = lastId(api.createIteration({ spaceId: 'sp-eng', name: 'Membership', startDate: '2026-10-01', endDate: '2026-10-07', taskIds: [id, id] }), 'iterations')
    api.updateIteration({ id: it, startDate: '2026-10-02', endDate: '2026-10-08' })
    assert.equal(iteration(it).startDate, '2026-10-02')
    unchanged(() => api.updateIteration({ id: it, endDate: '2026-02-30' }), /不存在/)
    unchanged(() => api.updateIteration({ id: it, startDate: '2026-10-10' }), /早于/)
    api.updateIteration({ id: it, status: 'active' })
    unchanged(() => api.updateIteration({ id: it, startDate: '2026-10-03' }), /未开始/)
    api.updateIteration({ id: it, endDate: '2026-10-09' })
    assert.equal(iteration(it).endDate, '2026-10-09')
    assert.deepEqual(iteration(it).taskIds, [id])
    assertMemberships()
    patch(id, { iterationIds: ['it-42'] })
    assert.deepEqual(iteration(it).taskIds, [])
    api.updateIteration({ id: it, taskIds: [id] })
    assertMemberships()
    unchanged(() => api.updateIteration({ id: it, taskIds: ['SUP-12'] }), /同一空间/)
    api.updateIteration({ id: it, taskIds: [] })
    assert.ok(!task(id).iterationIds.includes(it))
    api.removeTask({ id })
    assertMemberships()
  })

  check('real roster archive and exclusive membership cannot restart task or automation dispatch', () => {
    const standalone = lastId(api.agents.saveAgent({ spaceId: 'sp-eng', name: 'Archive fixture', instructions: 'Regression instructions' }), 'agents')
    const ref = { kind: 'agent', id: standalone, name: 'Archive fixture' }
    const id = create({ executor: ref })
    assert.equal(task(id).dispatch.status, 'waiting_runtime')
    api.agents.removeAgent({ id: standalone })
    patch(id, { title: 'Historical archived executor' })
    assert.equal(task(id).executor.id, standalone)
    assert.equal(task(id).dispatch, undefined)
    unchanged(() => create({ executor: ref }), /归档/)
    unchanged(() => api.saveAutomation({ spaceId: 'sp-eng', name: 'Archived target', trigger: { kind: 'task_created' }, target: ref }), /归档/)

    const exclusive = lastId(api.agents.saveAgent({ spaceId: 'sp-eng', name: 'Exclusive fixture', instructions: 'Regression instructions' }), 'agents')
    const exclusiveRef = { kind: 'agent', id: exclusive, name: 'Exclusive fixture' }
    const direct = create({ executor: exclusiveRef })
    const crewId = lastId(api.agents.saveCrew({ spaceId: 'sp-eng', name: 'Archive crew fixture', captainAgentId: 'ag-research', memberRefs: [{ kind: 'agent', id: exclusive }], exclusiveAgentIds: [exclusive] }), 'crews')
    patch(direct, { title: 'Historical exclusive executor' })
    assert.equal(task(direct).dispatch, undefined)
    unchanged(() => create({ executor: exclusiveRef }), /专属/)
    unchanged(() => api.saveAutomation({ spaceId: 'sp-eng', name: 'Exclusive target', trigger: { kind: 'task_created' }, target: exclusiveRef }), /专属/)
    const crewRef = { kind: 'crew', id: crewId, name: 'Archive crew fixture' }
    const crewTask = create({ executor: crewRef })
    const rule = lastId(api.saveAutomation({ spaceId: 'sp-eng', name: 'Crew runtime boundary', trigger: { kind: 'comment', value: '/fixture' }, target: crewRef }), 'automations')
    api.agents.removeCrew({ id: crewId })
    patch(crewTask, { title: 'Historical archived crew' })
    assert.equal(task(crewTask).dispatch, undefined)
    unchanged(() => create({ executor: crewRef }), /归档/)
    api.runAutomation({ id: rule })
    assert.equal(automation(rule).runs[0].outcome, 'skipped')
  })

  check('closing versions rejects unfinished work and preserves finished scope without carry-over', () => {
    for (const carryOver of ['backlog', 'next']) {
      const unfinished = create({ statusId: 'st-progress', executor })
      const done = create({ statusId: 'st-done' })
      const cancelled = create({ statusId: 'st-cancelled' })
      const it = lastId(api.createIteration({ spaceId: 'sp-eng', name: `Complete ${carryOver}`, startDate: '2027-01-01', endDate: '2027-01-07', taskIds: [unfinished, done, cancelled] }), 'iterations')
      unchanged(() => api.completeIteration({ id: it, carryOver }), /未完成/)
      assert.deepEqual(iteration(it).taskIds, [unfinished, done, cancelled])
      assert.ok(task(unfinished).iterationIds.includes(it))
      // Handling unfinished scope is an explicit independent command.
      patch(unfinished, { iterationIds: [] })
      const beforeTasks = normalize(current().tasks)
      api.completeIteration({ id: it, carryOver })
      assert.deepEqual(normalize(current().tasks), beforeTasks)
      assert.equal(iteration(it).status, 'completed')
      assert.deepEqual(iteration(it).taskIds, [done, cancelled])
      assert.equal(task(unfinished).statusId, 'st-progress')
      const snapshot = normalize(current())
      api.completeIteration({ id: it, carryOver })
      assert.deepEqual(normalize(current()), snapshot)
      unchanged(() => patch(unfinished, { iterationIds: [it] }), /已关闭版本/)
      unchanged(() => patch(unfinished, { statusId: 'st-done', iterationIds: [it] }), /已关闭版本/)
      patch(unfinished, { statusId: 'st-done' })
      unchanged(() => patch(unfinished, { iterationIds: [it] }), /已关闭版本/)
      unchanged(() => patch(done, { iterationIds: [] }), /已关闭版本/)
      unchanged(() => api.updateIteration({ id: it, name: 'Must roll back', taskIds: [done, cancelled, unfinished] }), /已关闭版本/)
      unchanged(() => api.updateIteration({ id: it, taskIds: [cancelled] }), /已关闭版本/)
      unchanged(() => api.removeTask({ id: done }), /已关闭版本/)
      assertMemberships()
    }
  })

  check('direct version completion rejects atomically; explicit completion never moves scope', () => {
    const id = create()
    const it = lastId(api.createIteration({ spaceId: 'sp-eng', name: 'Direct completion', startDate: '2027-02-01', endDate: '2027-02-07', taskIds: [id] }), 'iterations')
    const rejectCompletion = (fields = {}) => unchanged(
      () => api.updateIteration({ id: it, name: 'Must not leak', goal: 'Must not leak', taskIds: [], ...fields, status: 'completed' }), /请通过完成版本操作检查未完成任务/
    )
    rejectCompletion({ startDate: '2027-02-02', endDate: '2027-02-08' })
    assert.equal(iteration(it).status, 'pending')
    api.updateIteration({ id: it, status: 'active', name: 'Started version' })
    rejectCompletion({ endDate: '2027-02-09' })
    unchanged(() => api.completeIteration({ id: it }), /未完成/)
    unchanged(() => api.completeIteration({ id: it, carryOver: 'backlog' }), /未完成/)
    patch(id, { statusId: 'st-done' })
    api.completeIteration({ id: it })
    assert.equal(iteration(it).status, 'completed')
    assert.deepEqual(iteration(it).taskIds, [id])
    assert.ok(task(id).iterationIds.includes(it))
    assert.equal(task(id).statusId, 'st-done')
    rejectCompletion({ endDate: '2027-02-10' })
    const completed = normalize(current()), completedDisk = disk()
    api.completeIteration({ id: it, carryOver: 'backlog' })
    assert.deepEqual(normalize(current()), completed)
    assert.equal(disk(), completedDisk)
    const empty = lastId(api.createIteration({ spaceId: 'sp-eng', name: 'Empty version', startDate: '2027-03-01', endDate: '2027-03-07' }), 'iterations')
    unchanged(() => api.updateIteration({ id: empty, status: 'completed' }), /请通过完成版本操作检查未完成任务/)
    api.completeIteration({ id: empty })
    assert.equal(iteration(empty).status, 'completed')
    assertMemberships()
  })

  check('legacy triage stays explicit without forcing a lifecycle conversion', () => {
    const createLegacyTriage = (input = {}) => {
      const id = create({ triagePending: true, ...input })
      assert.equal(task(id).workflow, undefined)
      assert.equal(task(id).workKind, undefined)
      return id
    }
    const backlog = create({ statusId: 'st-backlog' })
    const queued = createLegacyTriage({ statusId: 'st-backlog', executor, assigneeIds: ['m-lin'] })
    const ids = api.triageQueue(current(), 'sp-eng').map((item) => item.task.id)
    assert.ok(!ids.includes(backlog))
    assert.ok(ids.includes(queued))
    assert.equal(task(queued).dispatch, undefined)
    unchanged(() => api.triage({ taskId: backlog, disposition: 'park' }), /待分拣/)
    api.triage({ taskId: queued, disposition: 'assign', assigneeIds: ['m-zhao'] })
    assert.equal(task(queued).workflow, undefined)
    assert.equal(task(queued).triagePending, undefined)
    assert.equal(task(queued).dispatch.status, 'waiting_runtime')
    assert.ok(!api.triageQueue(current(), 'sp-eng').some((item) => item.task.id === queued))
    const parked = createLegacyTriage()
    api.triage({ taskId: parked, disposition: 'park' })
    assert.equal(task(parked).statusId, 'st-backlog')
    assert.ok(!api.triageQueue(current(), 'sp-eng').some((item) => item.task.id === parked))
    const rejected = createLegacyTriage({ executor })
    api.triage({ taskId: rejected, disposition: 'close' })
    assert.equal(task(rejected).statusId, 'st-cancelled')
    assert.equal(task(rejected).dispatch, undefined)
    const pending = createLegacyTriage()
    const other = current().iterations.find((it) => it.spaceId === 'sp-ops')
    unchanged(() => api.triage({ taskId: pending, disposition: 'iterate', iterationId: other.id }), /该空间/)
    api.triage({ taskId: pending, disposition: 'iterate', iterationId: 'it-43' })
    assertMemberships()
  })

  check('automation validates scope, edit pause state and trigger values; runtime is never reported done', () => {
    const base = { spaceId: 'sp-eng', name: 'Scope automation', trigger: { kind: 'task_created' }, target: { kind: 'agent', id: 'ag-fe' }, projectId: 'pr-panel' }
    const id = lastId(api.saveAutomation(base), 'automations')
    create()
    assert.equal(automation(id).runs.length, 0)
    create({ projectId: 'pr-panel' })
    assert.equal(automation(id).runs[0].outcome, 'waiting_runtime')
    api.saveAutomation({ ...base, id, enabled: false })
    assert.equal(automation(id).enabled, false)
    create({ projectId: 'pr-panel' })
    assert.equal(automation(id).runs.length, 1)
    api.runAutomation({ id })
    assert.equal(automation(id).runs[0].outcome, 'skipped')
    unchanged(() => api.saveAutomation({ ...base, target: { kind: 'member', id: 'missing' } }), /成员/)
    unchanged(() => api.saveAutomation({ ...base, spaceId: 'sp-ops' }), /专项|空间/)
    unchanged(() => api.saveAutomation({ ...base, trigger: { kind: 'task_status', value: 'st-sup-todo' } }), /状态/)
    unchanged(() => api.saveAutomation({ ...base, trigger: { kind: 'schedule', value: '25:00' } }), /时间/)
    const noTarget = lastId(api.saveAutomation({ ...base, name: 'No target', target: { kind: 'none' } }), 'automations')
    api.runAutomation({ id: noTarget })
    assert.equal(automation(noTarget).runs[0].outcome, 'skipped')
    const member = lastId(api.saveAutomation({ ...base, name: 'Local reminder', target: { kind: 'member', id: 'm-chen' } }), 'automations')
    api.runAutomation({ id: member })
    assert.equal(automation(member).runs[0].outcome, 'done')
    assert.match(automation(member).runs[0].detail, /本地收件箱/)
    api.setSpaceMembers({ spaceId: 'sp-eng', memberIds: current().spaces.find((s) => s.id === 'sp-eng').memberIds.filter((id) => id !== 'm-chen') })
    api.runAutomation({ id: member })
    assert.equal(automation(member).runs[0].outcome, 'skipped')
  })

  check('resident scheduler handles local weekdays, same-day catch-up, durable dedup and disk rollback', () => {
    const id = lastId(api.saveAutomation({ spaceId: 'sp-eng', name: 'Scheduled runtime boundary', target: { kind: 'agent', id: 'ag-fe' }, trigger: { kind: 'schedule', value: '09:00', days: [1, 3] } }), 'automations')
    api.tickScheduledAutomations(new Date(2026, 9, 26, 8, 59))
    assert.equal(automation(id).runs.length, 0)
    api.tickScheduledAutomations(new Date(2026, 9, 26, 14, 5))
    assert.equal(automation(id).runs.length, 1)
    assert.equal(automation(id).lastScheduledDate, '2026-10-26')
    assert.equal(automation(id).runs[0].outcome, 'waiting_runtime')
    delete require.cache[bundle]
    api = require(bundle)
    api.tickScheduledAutomations(new Date(2026, 9, 26, 23, 59))
    assert.equal(automation(id).runs.length, 1, 'restart duplicated occurrence')
    api.tickScheduledAutomations(new Date(2026, 9, 27, 15, 0))
    assert.equal(automation(id).runs.length, 1, 'Tuesday bypassed weekday filter')
    const tempFile = join(process.env.HIFOX_STORE_DIR, 'store.json.tmp')
    mkdirSync(tempFile)
    unchanged(() => api.tickScheduledAutomations(new Date(2026, 9, 28, 9, 0)))
    rmdirSync(tempFile)
    api.tickScheduledAutomations(new Date(2026, 9, 28, 10, 0))
    assert.equal(automation(id).runs.length, 2)
    api.tickScheduledAutomations(new Date(2026, 10, 2, 10, 0))
    assert.equal(automation(id).runs.length, 3, 'must catch up today once, not replay missed dates')
    api.tickScheduledAutomations(new Date(2026, 9, 28, 10, 0))
    assert.equal(automation(id).runs.length, 3, 'clock rollback duplicated a past occurrence')
    api.toggleAutomation({ id, enabled: false })
    api.tickScheduledAutomations(new Date(2026, 10, 4, 15, 0))
    assert.equal(automation(id).runs.length, 3)
  })

  check('task relations are symmetric; isolated non-task inbox snooze does not snooze every notification', () => {
    const a = create(), b = create()
    api.addRelation({ taskId: a, relation: { kind: 'related', taskId: b } })
    assert.ok(task(a).relations.some((ref) => ref.taskId === b))
    assert.ok(task(b).relations.some((ref) => ref.taskId === a))
    api.removeRelation({ taskId: b, targetTaskId: a })
    assert.ok(!task(a).relations.some((ref) => ref.taskId === b))
    const item = current().inbox.find((item) => !item.taskId)
    const before = current().inbox.filter((other) => other.id !== item.id).map((other) => [other.id, other.snoozedUntil])
    api.snoozeInbox({ id: item.id, option: '20m' })
    assert.deepEqual(current().inbox.filter((other) => other.id !== item.id).map((other) => [other.id, other.snoozedUntil]), before)
    assertMemberships()
  })

  check('saved view status filters and edited project owners stay within their team', () => {
    const id = lastId(api.saveView({ spaceId: 'sp-eng', name: '待评审', groupBy: 'status', filter: { statusIds: ['st-review'] } }), 'views')
    const viewCount = current().views.length
    api.saveView({ id, spaceId: 'sp-eng', name: '我的高优评审', groupBy: 'assignee', filter: { statusIds: ['st-review'], priorities: ['high'] } })
    assert.equal(current().views.length, viewCount, 'editing a saved view must retain its identity')
    assert.deepEqual(current().views.find((view) => view.id === id).filter, { statusIds: ['st-review'], priorities: ['high'] })
    unchanged(() => api.saveView({ id, spaceId: 'sp-ops', name: 'Foreign edit', groupBy: 'status', filter: {} }), /视图不属于/)
    assert.deepEqual(current().views.find((v) => v.id === id).filter.statusIds, ['st-review'])
    unchanged(() => api.saveView({ spaceId: 'sp-eng', name: 'Wrong status', groupBy: 'status', filter: { statusIds: ['st-sup-todo'] } }), /视图状态/)
    unchanged(() => api.saveView({ spaceId: 'sp-eng', name: 'Missing status', groupBy: 'status', filter: { statusIds: ['missing'] } }), /视图状态/)
    api.updateProject({ id: 'pr-panel', ownerIds: ['m-zhao', 'm-zhao'] })
    assert.deepEqual(current().projects.find((p) => p.id === 'pr-panel').ownerIds, ['m-zhao'])
    unchanged(() => api.updateProject({ id: 'pr-panel', name: 'Cannot leak', ownerIds: ['missing'] }), /负责人/)
    const other = current().projects.find((p) => p.spaceId === 'sp-ops')
    unchanged(() => api.updateProject({ id: other.id, ownerIds: ['m-lin'] }), /负责人/)
    api.updateProject({ id: 'pr-panel', ownerIds: [] })
    assert.deepEqual(current().projects.find((p) => p.id === 'pr-panel').ownerIds, [])
  })

  check('restoring a task notification restores its whole cleared group, isolated notifications stay isolated', () => {
    const id = create()
    patch(id, { statusId: 'st-progress' })
    patch(id, { statusId: 'st-review' })
    const grouped = current().inbox.filter((item) => item.taskId === id)
    assert.ok(grouped.length >= 2)
    const standalone = current().inbox.filter((item) => !item.taskId).slice(0, 2)
    assert.equal(standalone.length, 2)
    api.clearInbox({ ids: [...grouped, ...standalone].map((item) => item.id) })
    api.restoreInbox({ id: grouped[0].id })
    assert.ok(current().inbox.filter((item) => item.taskId === id).every((item) => item.cleared === false))
    assert.ok(standalone.every((item) => current().inbox.find((other) => other.id === item.id).cleared))
    api.restoreInbox({ id: standalone[0].id })
    assert.equal(current().inbox.find((item) => item.id === standalone[0].id).cleared, false)
    assert.equal(current().inbox.find((item) => item.id === standalone[1].id).cleared, true)
  })

  check('tomorrow snooze uses the next local calendar day even before 09:00', () => {
    const base = new Date(2026, 9, 26, 8, 0)
    const expected = new Date(2026, 9, 27, 9, 0).toISOString()
    const id = current().inbox.find((item) => !item.taskId).id
    const originalNow = Date.now
    try {
      Date.now = () => base.getTime()
      api.snoozeInbox({ id, option: 'tomorrow' })
      assert.equal(current().inbox.find((item) => item.id === id).snoozedUntil, expected)
    } finally { Date.now = originalNow }
  })

  check('comment replies retain their parent, mentions and activity; foreign-task parents roll back', () => {
    const id = create(), otherTask = create()
    const root = lastId(api.addComment({ taskId: id, body: 'Root discussion', authorId: 'm-lin' }), 'comments')
    const reply = lastId(api.addComment({ taskId: id, body: '@赵启 Please review', authorId: 'm-lin', parentId: root }), 'comments')
    const saved = current().comments.find((item) => item.id === reply)
    assert.equal(saved.parentId, root)
    assert.deepEqual(saved.mentions, ['m-zhao'])
    assert.ok(current().activities.some((item) => item.taskId === id && item.kind === 'comment' && item.text.includes('Please review')))
    const nested = lastId(api.addComment({ taskId: id, body: 'Nested response', authorId: 'm-zhao', parentId: reply }), 'comments')
    assert.equal(current().comments.find((item) => item.id === nested).parentId, reply)
    unchanged(() => api.addComment({ taskId: otherTask, body: 'Cannot cross tasks', authorId: 'm-lin', parentId: root }), /同一任务/)
    unchanged(() => api.addComment({ taskId: id, body: 'Cannot use missing parent', authorId: 'm-lin', parentId: 'missing' }), /不存在/)
    api.resolveComment({ id: root, resolved: true })
    assert.equal(current().comments.find((item) => item.id === root).resolved, true)
    assert.equal(current().comments.find((item) => item.id === reply).parentId, root)
  })

  check('existing snapshots are read without rewriting bytes and additive fields survive later writes', () => {
    const snapshot = current()
    snapshot.automations[0].trigger.futureExtension = { retained: true }
    snapshot.tasks[0].futureExtension = { retained: true }
    process.env.HIFOX_STORE_DIR = join(root, 'existing-snapshot')
    mkdirSync(process.env.HIFOX_STORE_DIR)
    const file = join(process.env.HIFOX_STORE_DIR, 'store.json')
    const bytes = JSON.stringify(snapshot, null, 4) + '\n'
    writeFileSync(file, bytes)
    assert.deepEqual(normalize(current()), normalize(snapshot))
    assert.equal(readFileSync(file, 'utf8'), bytes, 'loading rewrote an existing file')
    patch(snapshot.tasks[0].id, { title: 'Edited existing task' })
    const stored = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(stored.automations[0].trigger.futureExtension, { retained: true })
    assert.deepEqual(stored.tasks[0].futureExtension, { retained: true })
  })

  check('malformed optional persisted fields are rejected without overwriting original bytes', () => {
    const valid = current()
    const restoreDir = process.env.HIFOX_STORE_DIR
    const corruptions = [
      ['executor', (snapshot) => { snapshot.tasks[0].executor = 'broken' }],
      ['dispatch', (snapshot) => { snapshot.tasks[0].dispatch = { status: 'executed', since: '2026-10-26' } }],
      ['view-filter', (snapshot) => { snapshot.views[0].filter.statusIds = { broken: true } }],
      ['member-email', (snapshot) => { snapshot.members[0].email = ['broken'] }],
      ['archive-flag', (snapshot) => { snapshot.agents[0].archived = 'false' }],
      ['schedule-date', (snapshot) => { snapshot.automations[0].lastScheduledDate = 20261026 }]
    ]
    try {
      for (const [name, corrupt] of corruptions) {
        const snapshot = structuredClone(valid)
        corrupt(snapshot)
        process.env.HIFOX_STORE_DIR = join(root, `optional-${name}`)
        mkdirSync(process.env.HIFOX_STORE_DIR)
        const file = join(process.env.HIFOX_STORE_DIR, 'store.json')
        const bytes = JSON.stringify(snapshot)
        writeFileSync(file, bytes)
        assert.throws(() => api.loadSnapshot(), /数据读取失败.*原文件已保留/, name)
        assert.throws(() => create(), /数据读取失败/, name)
        assert.equal(readFileSync(file, 'utf8'), bytes)
      }
    } finally { process.env.HIFOX_STORE_DIR = restoreDir }
  })

  check('corrupt JSON and wrong snapshot shape surface errors and preserve exact original bytes', () => {
    for (const [name, bytes] of [['syntax', '{broken'], ['shape', '{"spaces":[]}'], ['nested-shape', JSON.stringify({ ...current(), tasks: [{ id: 'broken' }] })]]) {
      process.env.HIFOX_STORE_DIR = join(root, name)
      mkdirSync(process.env.HIFOX_STORE_DIR)
      const file = join(process.env.HIFOX_STORE_DIR, 'store.json')
      writeFileSync(file, bytes)
      assert.throws(() => api.loadSnapshot(), /数据读取失败.*原文件已保留/)
      assert.throws(() => create(), /数据读取失败/)
      assert.equal(readFileSync(file, 'utf8'), bytes)
    }
  })

  console.log(`PASS hifox domain: ${results.length} real-service regression groups`)
} finally {
  if (originalDir === undefined) delete process.env.HIFOX_STORE_DIR
  else process.env.HIFOX_STORE_DIR = originalDir
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.ok(basename(root).startsWith('trellis-hifox-domain-'))
  rmSync(root, { recursive: true, force: true })
}
