/**
 * 渲染契约冒烟（roadmap #9 / TPD-017）：
 * Entry 管道身份断言——流式更新只换变化的尾条目引用，前缀条目保持对象身份。
 * （纯 node 断言管道契约；React.memo 链路依赖该契约消除全列表重渲染。）
 * 运行：node scripts/smoke/render-contract.mjs
 */
import { pathToFileURL } from 'url'

const { buildEntries, reuseEntries } = await import(new URL('../../src/renderer/src/chat/entries.ts', import.meta.url).href)

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}${cond ? '' : ` ${extra}`}`)
  if (!cond) failures += 1
}

const base = [
  { id: 'u1', role: 'user', content: '问题一', siblingCount: 1, siblingIndex: 0, siblingIds: ['u1'] },
  { id: 'a1', role: 'assistant', content: '回答一的', siblingCount: 1, siblingIndex: 0, siblingIds: ['a1'] }
]

/* ① 恒等输入 → 恒等引用 */
const e1 = buildEntries(base)
const e2 = reuseEntries(e1, buildEntries(base))
check('恒等输入复用全部条目引用', e1.every((entry, i) => entry === e2[i]) && e1.length === e2.length)

/* ② 流式增长：末条 assistant 内容增长 → 前缀引用保持、尾条目新引用 */
const grown = base.map((m, i) => (i === 1 ? { ...m, content: '回答一的内容变长了' } : m))
const e3 = reuseEntries(e2, buildEntries(grown))
check('流式增长时前缀引用保持', e3[0] === e2[0])
check('流式增长时仅尾条目为新引用', e3[1] !== e2[1] && e3[1].content === '回答一的内容变长了')

/* ③ 追加新消息 → 前缀全部保持 */
const appended = [...grown, { id: 'u2', role: 'user', content: '问题二', siblingCount: 1, siblingIndex: 0, siblingIds: ['u2'] }]
const e4 = reuseEntries(e3, buildEntries(appended))
check('追加消息时既有引用全部保持', e4[0] === e3[0] && e4[1] === e3[1] && e4.length === 3)

/* ④ 分支变化：中间条目切换到不同兄弟 → 仅该条目与受影响后缀为新引用 */
const branched = base.map((m, i) =>
  i === 1 ? { ...m, content: '全新回答', reasoning: '全新思考', siblingCount: 2, siblingIndex: 1, siblingIds: ['a0', 'a1'] } : m
)
const e5 = reuseEntries(e4, buildEntries(branched))
check('分支切换仅变更目标条目（前缀保持）', e5[0] === e4[0] && e5[1] !== e4[1])
check('分支条目携带 reasoning 与兄弟信息', e5[1].reasoning === '全新思考' && e5[1].siblingCount === 2)
// 后缀（问题二）在 e5 中尚不存在——补充一条以验证后缀保持
const e5full = reuseEntries(e5, buildEntries([...branched, appended[2]]))
check('分支切换不影响前缀引用', e5full[0] === e4[0] && e5full[1] !== e4[1])
const e6 = reuseEntries(e5full, buildEntries([...branched, appended[2]]))
check('连续恒等构建时全部引用稳定', e6[0] === e5full[0] && e6[1] === e5full[1] && e6[2] === e5full[2])

/* ⑤ 首次调用无 prev → 全新数组 */
const e0 = reuseEntries(undefined, buildEntries(base))
check('首次调用返回全新条目', e0.length === 2 && e0.every((en) => typeof en === 'object'))

if (failures > 0) {
  console.error(`render-contract smoke: ${failures} 项失败`)
  process.exit(1)
}
console.log('render-contract smoke: 全部通过')
