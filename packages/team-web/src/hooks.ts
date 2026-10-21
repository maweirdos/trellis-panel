import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { request, ApiError, authEvents, prepareCommand, sendCommand, type PreparedCommand } from './client'
import { teamPageSchema, type TeamPage } from './contracts'

export function useQuery<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled = true, interval = 0) {
  const loader = useRef(load); loader.current = load
  const owner = useRef({ key, enabled }); if (owner.current.key !== key || owner.current.enabled !== enabled) owner.current = { key, enabled }
  const [retry, setRetry] = useState(0), [data, setData] = useState<{ key: string; value: T | null; loading: boolean; error: string; at: number }>({ key, value: null, loading: enabled, error: '', at: 0 })
  useEffect(() => {
    if (!enabled) return
    let live = true, pending = false
    const captured = owner.current
    const abort = new AbortController()
    const run = async (): Promise<void> => {
      if (pending || owner.current !== captured) return
      pending = true
      setData((old) => old.key === key ? { ...old, loading: true } : { key, value: null, loading: true, error: '', at: 0 })
      try { const value = await loader.current(abort.signal); if (live && owner.current === captured) setData({ key, value, loading: false, error: '', at: Date.now() }) }
      catch (error) { if (live && owner.current === captured) { setData((old) => ({ key, value: old.key === key && !(error instanceof ApiError && [401, 403].includes(error.status)) ? old.value : null, loading: false, error: error instanceof Error ? error.message : '读取失败', at: old.key === key ? old.at : 0 })); if (error instanceof ApiError && [401, 403].includes(error.status)) authEvents.dispatchEvent(new CustomEvent('denied', { detail: error.status })) } }
      finally { pending = false }
    }
    void run()
    const timer = interval ? setInterval(() => { if (document.visibilityState === 'visible') void run() }, interval) : null
    const visible = (): void => { if (interval && document.visibilityState === 'visible') void run() }
    document.addEventListener('visibilitychange', visible)
    return () => { live = false; abort.abort(); if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [key, enabled, retry, interval])
  return { value: enabled && data.key === key ? data.value : null, loading: enabled && (data.key !== key || data.loading), error: enabled && data.key === key ? data.error : '', at: data.key === key ? data.at : 0, refresh: () => setRetry((old) => old + 1) }
}
export function usePage<T>(key: string, path: string, item: z.ZodType<T>, enabled = true, notifyDenied = true) {
  const [pageState, setPage] = useState<{ key: string; items: T[]; nextCursor: string | null; more: boolean; error: string; loading: boolean }>({ key: '', items: [], nextCursor: null, more: false, error: '', loading: false })
  const current = useRef({ key, generation: Symbol(), enabled }); if (current.current.key !== key || current.current.enabled !== enabled) current.current = { key, generation: Symbol(), enabled }
  const busy = useRef(false), version = useRef(0), mounted = useRef(false)
  const read = async (append = false): Promise<void> => {
    const owner = current.current
    if (!enabled || busy.current) return
    const cursor = append && pageState.key === key ? pageState.nextCursor : null
    if (append && !cursor) return
    busy.current = true; const ticket = ++version.current
    setPage((old) => old.key === key ? { ...old, loading: true, error: '' } : { key, items: [], nextCursor: null, more: false, error: '', loading: true })
    try {
      const separator = path.includes('?') ? '&' : '?'
      const page: TeamPage<T> = await request(path + separator + 'limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), teamPageSchema(item), { notifyDenied, isCurrent: () => mounted.current && current.current === owner && owner.enabled && ticket === version.current })
      if (current.current !== owner || !owner.enabled || ticket !== version.current) return
      if (cursor && page.nextCursor === cursor) throw new ApiError('CURSOR_CONFLICT', '分页位置没有前进，请重新载入')
      setPage((old) => ({ key, items: append && old.key === key ? [...old.items, ...page.items] : page.items, nextCursor: page.nextCursor, more: page.hasMore, loading: false, error: '' }))
    } catch (error) { if (current.current === owner && ticket === version.current) setPage((old) => ({ ...old, key, loading: false, error: error instanceof Error ? error.message : '列表读取失败', ...(error instanceof ApiError && [401, 403, 409].includes(error.status) ? { items: [], more: false, nextCursor: null } : {}) })) }
    finally { if (ticket === version.current) busy.current = false }
  }
  const reader = useRef(read); reader.current = read
  useEffect(() => { mounted.current = true; busy.current = false; version.current++; if (enabled) void reader.current(); return () => { mounted.current = false; version.current++ } }, [key, enabled])
  return { items: enabled && pageState.key === key ? pageState.items : [], more: enabled && pageState.key === key && pageState.more, loading: enabled && (pageState.key !== key || pageState.loading), error: enabled && pageState.key === key ? pageState.error : '', refresh: () => { void reader.current() }, next: () => { void reader.current(true) } }
}
export function useWrite<T>(path: string, schema: z.ZodType<T>, projectId: string | null, done: (result: T) => void) {
  const saved = useRef<PreparedCommand<T> | null>(null), lock = useRef(false), alive = useRef(true)
  const [state, setState] = useState({ busy: false, error: '', uncertain: false })
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  return { ...state, async submit(body: Record<string, unknown>): Promise<void> {
    if (lock.current) return
    lock.current = true; setState((old) => ({ ...old, busy: true, error: '' }))
    try {
      if (!saved.current) saved.current = await prepareCommand(path, body, schema, projectId)
      const reply = await sendCommand(saved.current)
      saved.current = null
      if (alive.current) { setState({ busy: false, error: '', uncertain: false }); done(reply.result) }
    } catch (error) {
      const uncertain = error instanceof ApiError && error.uncertain
      if (!uncertain) saved.current = null
      if (alive.current) setState({ busy: false, error: error instanceof Error ? error.message : '写入失败', uncertain })
    } finally { lock.current = false }
  } }
}
