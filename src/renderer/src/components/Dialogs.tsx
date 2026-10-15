import { useEffect, useState } from 'react'
import { useEscLayer } from '../utils/use-esc-layer'
import type { JSX } from 'react'
import { Button } from '../my/ui'

/**
 * 命令式对话框（Promise API）。
 * Electron 渲染进程不支持 window.prompt/confirm/alert（规范 electron-browser-api-restrictions.md），
 * 所有确认/输入流程统一走这里；<DialogHost /> 必须在 App 中挂载一次，否则调用会永久挂起。
 */

export interface ConfirmDialogOptions {
  title: string
  message?: string
  confirmText?: string
  danger?: boolean
}

export interface PromptDialogOptions {
  title: string
  label?: string
  placeholder?: string
  defaultValue?: string
  multiline?: boolean
  /** 返回错误文案则阻止提交并展示，返回 null 表示通过 */
  validator?: (value: string) => string | null
}

interface ConfirmRequest {
  kind: 'confirm'
  id: number
  opts: ConfirmDialogOptions
  settle: (confirmed: boolean) => void
}

interface PromptRequest {
  kind: 'prompt'
  id: number
  opts: PromptDialogOptions
  settle: (value: string | null) => void
}

type DialogRequest = ConfirmRequest | PromptRequest

// 模块级请求队列：任意页面命令式发起，DialogHost 单点渲染当前请求，其余排队等待
let seq = 0
let current: DialogRequest | null = null
const queue: DialogRequest[] = []
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const l of listeners) l()
}

const promote = (): void => {
  current = queue.shift() ?? null
  notify()
}

const enqueue = (req: DialogRequest): void => {
  queue.push(req)
  if (!current) promote()
}

/** 取消语义：confirm → false，prompt → null（与原生 API 的取消返回值对齐） */
function settleCancel(r: DialogRequest): void {
  if (r.kind === 'confirm') r.settle(false)
  else r.settle(null)
}

/**
 * 结算并弹出下一个，但仅当 req 仍是当前对话框。
 * 防止重复触发（快速双击确认 / 按住 Esc 的 key repeat）用旧闭包二次 promote，
 * 把队列中下一个请求跳过、导致其 Promise 永久悬挂。
 */
function settleIfCurrent(req: DialogRequest, value: boolean | string | null): void {
  if (current !== req) return
  if (req.kind === 'confirm') req.settle(Boolean(value))
  else req.settle(typeof value === 'string' ? value : null)
  promote()
}

function cancelIfCurrent(r: DialogRequest): void {
  if (current !== r) return
  settleCancel(r)
  promote()
}

export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    seq += 1
    enqueue({ kind: 'confirm', id: seq, opts, settle: resolve })
  })
}

export function promptDialog(opts: PromptDialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    seq += 1
    enqueue({ kind: 'prompt', id: seq, opts, settle: resolve })
  })
}

/** 全局对话框宿主：在 App 顶层挂载一次即可 */
export function DialogHost(): JSX.Element | null {
  const [req, setReq] = useState<DialogRequest | null>(current)

  useEffect(() => {
    const sync = (): void => setReq(current)
    listeners.add(sync)
    // 挂载前可能已有请求入队，先同步一次
    sync()
    return () => {
      listeners.delete(sync)
      // 卸载（如 HMR 重载）时结算全部未决请求，调用方拿到取消值而非永久悬挂
      if (current) {
        settleCancel(current)
        current = null
      }
      for (const r of queue.splice(0)) settleCancel(r)
    }
  }, [])

  // Esc 取消走全局 Esc 层（modal 最高优先级；焦点不在面板内也能生效）。
  // 层协调器保证与查看器/预览等下层同按时只关最上层一层（design §6.3）。
  useEscLayer(req !== null, {
    kind: 'modal',
    id: 'dialog-host',
    onClose: () => {
      if (req) cancelIfCurrent(req)
    }
  })

  if (!req) return null

  const cancel = (): void => {
    cancelIfCurrent(req)
  }

  const closeOnBackdrop = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) cancel()
  }

  return (
    <div className="absolute inset-0 z-50 grid my-fade place-items-center bg-my-backdrop" onClick={closeOnBackdrop}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-w-[90%] rounded-my-xl border border-my-line bg-my-layer-2 p-5 shadow-[var(--my-shadow-overlay-200)]"
      >
        {req.kind === 'confirm' ? <ConfirmPanel key={req.id} req={req} onCancel={cancel} /> : <PromptPanel key={req.id} req={req} onCancel={cancel} />}
      </div>
    </div>
  )
}

function ConfirmPanel({ req, onCancel }: { req: ConfirmRequest; onCancel: () => void }): JSX.Element {
  const { title, message, confirmText, danger } = req.opts
  return (
    <>
      <div className="text-my-sm font-semibold text-my-primary">{title}</div>
      {message && <div className="mt-2 whitespace-pre-line text-my-xs leading-5 text-my-secondary">{message}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button
          // autoFocus 让 Enter 直接触发确认（按钮聚焦时原生响应 Enter）
          variant={danger ? 'danger' : 'primary'}
          onClick={() => settleIfCurrent(req, true)}
        >
          {confirmText ?? '确定'}
        </Button>
      </div>
    </>
  )
}

function PromptPanel({ req, onCancel }: { req: PromptRequest; onCancel: () => void }): JSX.Element {
  const { title, label, placeholder, defaultValue, multiline } = req.opts
  const [value, setValue] = useState(defaultValue ?? '')
  const [error, setError] = useState<string | null>(null)

  const submit = (): void => {
    const v = value.trim()
    // 与原生输入框的取消语义对齐：空输入不产生结果，只能取消
    if (!v) return
    const err = req.opts.validator?.(v) ?? null
    if (err) {
      setError(err)
      return
    }
    settleIfCurrent(req, v)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Enter') return
    // 多行模式下 Enter 换行，Ctrl/Cmd+Enter 提交
    if (multiline && !e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    submit()
  }

  return (
    <>
      <div className="text-my-sm font-semibold text-my-primary">{title}</div>
      {label && <label className="mt-3 mb-1.5 block text-my-xs text-my-secondary">{label}</label>}
      {multiline ? (
        <textarea
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={4}
          className="w-full rounded-my-md border border-my-line bg-my-surface-1 px-2.5 py-1.5 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent resize-y"
        />
      ) : (
        <input
          autoFocus
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="h-8 w-full rounded-my-md border border-my-line bg-my-surface-1 px-2.5 text-my-sm text-my-primary outline-none placeholder:text-my-placeholder focus:border-my-line-accent"
        />
      )}
      {error && <div className="mt-1.5 text-my-xs text-my-danger-text">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" onClick={submit} disabled={!value.trim()}>
          确定
        </Button>
      </div>
    </>
  )
}
