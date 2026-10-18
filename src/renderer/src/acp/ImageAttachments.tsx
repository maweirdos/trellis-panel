import { useEffect, useRef, useState, type JSX } from 'react'
import { X } from 'lucide-react'
import { Modal } from '../my/ui'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import type { AcpImageAttachment } from '../../../shared/acp-images'

export function ImageAttachments({ images, onRemove }: { images: AcpImageAttachment[]; onRemove?: (id: string) => void }): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const interactive = useInteractionActive()
  const canInteract = useInteractionGuard()
  const image = images.find((entry) => entry.id === selected)
  useEffect(() => { if (!interactive) setSelected(null) }, [interactive])
  const close = (): void => { setSelected(null); if (canInteract() && returnFocus.current?.isConnected) returnFocus.current.focus() }
  if (!images.length) return null
  return <>
    <div className="acp-image-attachments" aria-label={onRemove ? '待发送图片' : '消息图片'}>
      {images.map((entry) => <div className="acp-image-tile" key={entry.id}>
        <button type="button" className="acp-image-open" aria-label={`预览图片 ${entry.name}`} title={entry.name} onClick={(event) => { returnFocus.current = event.currentTarget; setSelected(entry.id) }}>
          <img src={`data:${entry.mimeType};base64,${entry.data}`} alt={entry.name} loading="lazy" />
        </button>
        {onRemove && <button type="button" className="acp-image-remove" aria-label={`移除图片 ${entry.name}`} title="移除图片" onClick={() => onRemove(entry.id)}><X size={12} /></button>}
      </div>)}
    </div>
    <Modal open={Boolean(image)} onClose={close} width={840}>
      {image && <section className="acp-image-preview" role="dialog" aria-modal="true" aria-label={`预览图片 ${image.name}`}>
        <header><span title={image.name}>{image.name}</span><button type="button" autoFocus aria-label="关闭图片预览" onClick={close}><X size={18} /></button></header>
        <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
      </section>}
    </Modal>
  </>
}
