/* Temporary CDP helper: evaluate JS in the panel renderer and capture screenshots. */
const port = process.argv[2] ?? '9333'
const mode = process.argv[3] ?? 'eval' // eval | shot | flow
const expr = process.argv[4] ?? 'document.title'
const outPath = process.argv[5] ?? 'D:/my_demo/trellis-panel/.cdp-shot.png'

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const pages = list.filter((t) => t.type === 'page')
const wantCapsule = process.env.CDP_TARGET === 'capsule'
const page = pages.find((t) => t.url.includes('mode=capsule') === wantCapsule) ?? pages[0]
console.error('target:', page.url)
if (!page) {
  console.error('no page target')
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 1
const pending = new Map()

function send(method, params = {}) {
  const id = seq++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => reject(new Error('timeout ' + method)), 30000)
  })
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}

await new Promise((r) => (ws.onopen = r))

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? 'eval error')
  }
  return res.result.value
}

async function shot(file) {
  const res = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('fs')
  writeFileSync(file, Buffer.from(res.data, 'base64'))
  console.log('saved', file)
}

try {
  if (mode === 'eval') {
    console.log(JSON.stringify(await evaluate(expr), null, 1))
  } else if (mode === 'shot') {
    await shot(outPath)
  } else if (mode === 'flow') {
    // mode=flow: expr is JSON array of steps
    // {"eval": "..."} | {"clickSel": "..."} | {"shot": "path"} | {"wait": ms}
    const steps = JSON.parse(expr)
    for (const step of steps) {
      if (step.eval) {
        const v = await evaluate(step.eval)
        if (v !== undefined) console.log('=>', JSON.stringify(v)?.slice(0, 400))
      } else if (step.clickSel) {
        await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.clickSel)}); if (!el) throw new Error('not found: ' + ${JSON.stringify(step.clickSel)}); el.click(); })()`)
        console.log('clicked', step.clickSel)
      } else if (step.wait) {
        await new Promise((r) => setTimeout(r, step.wait))
      } else if (step.shot) {
        await shot(step.shot)
      }
    }
  }
} finally {
  ws.close()
}
