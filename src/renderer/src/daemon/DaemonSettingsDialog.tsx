import { useEffect, useState } from 'react'
import type { DaemonApi } from '../../../shared/daemon'
import { api } from '../api'
import { Button, Modal } from '../my/ui'
import { DaemonSettings } from './DaemonSettings'
import { InteractionScope } from '../utils/interaction-scope'

/** Reuses the settings controls without changing the selected conversation/page. */
export function DaemonSettingsDialog(): JSX.Element {
  const [open, setOpen] = useState(false)
  useEffect(() => (api as typeof api & { daemon?: DaemonApi })?.daemon?.onOpenSettings?.(() => setOpen(true)), [])
  return <Modal open={open} onClose={() => setOpen(false)} ariaLabel="后台设置" width={620}>
    <div className="flex items-center justify-between border-b border-my-line px-5 py-3">
      <h1 className="text-my-sm font-semibold">后台设置</h1>
      <Button onClick={() => setOpen(false)}>关闭</Button>
    </div>
    {open && <InteractionScope active><DaemonSettings /></InteractionScope>}
  </Modal>
}
