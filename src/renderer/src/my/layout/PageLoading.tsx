import { Loader2 } from 'lucide-react'

export function PageLoading(): JSX.Element {
  return (
    <div className="flex h-full w-full items-center justify-center text-my-tertiary" role="status" aria-label="正在加载页面">
      <Loader2 size={18} className="animate-spin text-my-icon-tertiary motion-reduce:animate-none" aria-hidden="true" />
    </div>
  )
}
