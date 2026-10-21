/** Pure extracted graph/patch algorithms; real Git patches, no application/repository mutations. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = mkdtempSync(join(tmpdir(), 'tpanel-git-algorithms-'))
let checks = 0
const check = (name, run) => { run(); checks++; console.log('PASS ' + name) }
const commit = (hash, parents = []) => ({ hash, parents })
try {
  const bundle = join(directory, 'algorithms.mjs')
  const absolute = file => resolve(file).replace(/\\/g, '/')
  await build({
    stdin: { contents: `export * from ${JSON.stringify(absolute('src/renderer/src/my/git/graph.ts'))};export * from ${JSON.stringify(absolute('src/renderer/src/my/git/patch.ts'))};`, resolveDir: process.cwd(), loader: 'ts' },
    outfile: bundle, platform: 'node', format: 'esm', bundle: true
  })
  const { layoutGraph, visibleEdges, ROW_HEIGHT, patchRows } = await import(pathToFileURL(bundle).href)
  const merge = [commit('merge', ['left', 'right']), commit('left', ['root']), commit('right', ['root']), commit('root')]
  check('merge lanes, all parent relations and independent roots', () => {
    const graph = layoutGraph([...merge, commit('other-root')], 'merge')
    assert.notEqual(graph.positions.get('left').lane, graph.positions.get('right').lane)
    assert.equal(graph.positions.size, 5)
    assert.deepEqual(graph.edges.map(edge => [edge.fromHash, edge.toHash]), [['merge', 'left'], ['merge', 'right'], ['left', 'root'], ['right', 'root']])
    assert.ok(graph.edges.every(edge => !edge.pending && edge.to.index > edge.from.index))
    assert.deepEqual(visibleEdges(layoutGraph([], null), 0, 1), [])
    assert.deepEqual(visibleEdges(graph, 2, 2), [])
  })
  check('long crossing edges survive interval-index pruning', () => {
    const commits = [commit('merge', ['next-1', 'far'])]
    for (let i = 1; i < 180; i++) commits.push(commit(`next-${i}`, [i === 179 ? 'far' : `next-${i + 1}`]))
    commits.push(commit('far', ['unloaded']))
    const graph = layoutGraph(commits, 'merge')
    for (const start of [0, 1, 17, 82, 178, 180, 181, 200]) {
      for (const length of [1, 7, 50]) {
        const end = start + length
        assert.deepEqual(visibleEdges(graph, start, end), graph.edges.filter(edge => edge.from.index < end && edge.to.index >= start))
      }
    }
    assert.ok(visibleEdges(graph, 80, 90).some(edge => edge.fromHash === 'merge' && edge.toHash === 'far'))
    assert.ok(visibleEdges(graph, 180, 182).some(edge => edge.pending && edge.toHash === 'unloaded'))
  })
  check('page extension preserves existing positions and pending-parent lanes', () => {
    const first = merge.slice(0, 3)
    const before = layoutGraph(first, 'merge')
    const after = layoutGraph(merge, 'merge')
    assert.equal(before.edges.filter(edge => edge.pending).length, 2)
    for (const entry of first) assert.deepEqual(before.positions.get(entry.hash), after.positions.get(entry.hash))
    for (const edge of before.edges.filter(edge => edge.pending)) {
      assert.equal(edge.to.x, after.positions.get(edge.toHash).x)
      assert.equal(edge.to.lane, after.positions.get(edge.toHash).lane)
      assert.ok(edge.to.y > first.length * ROW_HEIGHT)
    }
    assert.ok(after.edges.every(edge => !edge.pending))
    const chain = Array.from({ length: 240 }, (_, i) => commit(String(i), [String(i + 1)]))
    for (const size of [100, 200]) {
      const page = layoutGraph(chain.slice(0, size), '0')
      const appended = layoutGraph(chain.slice(0, size + 40), '0')
      for (const [hash, point] of page.positions) assert.deepEqual(point, appended.positions.get(hash))
    }
  })
  check('unloaded parents remain distinct at an octopus/page boundary', () => {
    const graph = layoutGraph([commit('merge', ['p1', 'p2', 'p3'])], 'merge')
    assert.equal(new Set(graph.edges.map(edge => edge.to.x)).size, 3)
    assert.equal(new Set(graph.edges.map(edge => edge.to.lane)).size, 3)
    assert.ok(graph.edges.every(edge => edge.pending))
  })
  check('hunk offsets, zero counts and no-newline notes retain real line numbers', () => {
    const rows = patchRows('--- a/file\n+++ b/file\n@@ -2,1 +2,2 @@\n-old\n+new\n\\ No newline at end of file\n+second\n@@ -10,0 +12,1 @@\n+last\n')
    assert.deepEqual(rows.map(({ kind, a, b }) => [kind, a, b]), [
      ['meta', null, null], ['meta', null, null], ['hunk', null, null], ['remove', 2, null], ['add', null, 2],
      ['meta', null, null], ['add', null, 3], ['hunk', null, null], ['add', null, 12]
    ])
    assert.equal(patchRows('@@ -0,0 +1,1 @@\n+new')[1].b, 1)
    assert.equal(patchRows('@@ -1,1 +0,0 @@\n-old')[1].a, 1)
    assert.deepEqual(patchRows(''), [])
    const multi = patchRows('@@ -1 +1 @@\n---old\n+++new\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -4 +8 @@\n context')
    assert.deepEqual(multi.filter(row => row.kind === 'meta').map(row => [row.a, row.b]), [[null, null], [null, null], [null, null]])
    assert.deepEqual(multi.at(-1), { text: ' context', kind: 'context', a: 4, b: 8 })
    assert.equal(patchRows('@@@ -1 -1 +1 @@@\n++combined')[1].kind, 'meta')
  })
  check('line numbers match a real Git patch with separated hunks and missing EOF newline', () => {
    const oldLines = Array.from({ length: 32 }, (_, i) => `line ${i + 1}`)
    const newLines = [...oldLines]
    newLines[1] = 'replacement'
    newLines.splice(25, 1, 'inserted first', 'inserted second')
    newLines.push('last without newline')
    const oldFile = join(directory, 'old.txt'), newFile = join(directory, 'new.txt')
    writeFileSync(oldFile, oldLines.join('\n'))
    writeFileSync(newFile, newLines.join('\n'))
    let patch = ''
    try {
      patch = execFileSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', oldFile, newFile], { encoding: 'utf8', windowsHide: true })
    } catch (error) {
      if (error.status !== 1 || typeof error.stdout !== 'string') throw error
      patch = error.stdout
    }
    const rows = patchRows(patch)
    assert.ok(rows.filter(row => row.kind === 'hunk').length >= 2)
    assert.ok(rows.some(row => row.text.startsWith('\\ No newline')))
    for (const row of rows) {
      if (row.a !== null) assert.equal(row.text.slice(1), oldLines[row.a - 1])
      if (row.b !== null) assert.equal(row.text.slice(1), newLines[row.b - 1])
      if (row.kind === 'meta' || row.kind === 'hunk') assert.deepEqual([row.a, row.b], [null, null])
    }
    assert.equal(rows.findLast(row => row.b !== null).b, newLines.length)
  })
  console.log(`PASS ${checks} Git algorithm groups (including actual Git patch)`)
} finally {
  assert.equal(resolve(directory), directory, 'cleanup uses the exact absolute fixture directory')
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()), 'cleanup is confined to the named temporary fixture directory')
  assert.ok(directory.split(/[\\/]/).at(-1).startsWith('tpanel-git-algorithms-'))
  rmSync(directory, { recursive: true, force: true })
}
