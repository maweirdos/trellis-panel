import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { X, RefreshCw } from 'lucide-react'

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useLayoutEffect(() => {
    const dialog = ref.current, origin = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog?.showModal()
    return () => { dialog?.close(); if (origin?.isConnected) origin.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={ref} aria-labelledby={titleId} className={'tw-dialog' + (wide ? ' wide' : '')} onCancel={(event) => { event.preventDefault(); onClose() }} onClick={(event) => { if (event.target === ref.current) { const box = ref.current.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose() } }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" className="icon" aria-label="关闭" onClick={onClose}><X size={18} /></button></header><div className="dialog-body">{children}</div>
  </dialog>
}
export function Notice({ children }: { children: ReactNode }) { return <div className="notice" role="status">{children}</div> }
export function ErrorLine({ children }: { children: ReactNode }) { return children ? <p className="error" role="alert">{children}</p> : null }
export function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty"><h3>{title}</h3><p>{children}</p></div> }
export function Pager({ page }: { page: { loading: boolean; more: boolean; error: string; next: () => void; refresh: () => void } }) { return <div className="pager"><ErrorLine>{page.error}</ErrorLine>{page.more && <button type="button" disabled={page.loading} onClick={page.next}>{page.loading ? '读取中…' : '加载更多'}</button>}{page.error && <button type="button" disabled={page.loading} onClick={page.refresh}><RefreshCw size={14} />重新载入</button>}</div> }
export const roleName = (role: string): string => ({ product: '产品', pm: '项目经理', developer: '开发', tester: '测试', admin: '管理员', owner: '所有者', member: '成员' })[role] ?? role
export const kindName = (kind: string): string => ({ 'product-requirement': '产品需求', 'trellis-prd': '开发 PRD', design: '设计', spec: '规范', code: '代码', feedback: '反馈', other: '其他' })[kind] ?? kind
export const visibilityName = (visibility: string): string => ({ personal: '仅自己', project: '项目成员', team: '团队成员' })[visibility] ?? visibility
export const time = (value: number | null): string => value === null ? '尚无记录' : new Date(value).toLocaleString('zh-CN', { hour12: false })
