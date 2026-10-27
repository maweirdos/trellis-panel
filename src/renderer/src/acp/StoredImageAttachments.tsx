import { useEffect, useState, type JSX } from 'react'
import { api } from '../api'
import type { AcpImageAttachment, AcpStoredImage } from '../../../shared/acp-images'
import { ImageAttachments } from './ImageAttachments'

export function StoredImageAttachments({ images, sessionId }: { images: AcpStoredImage[]; sessionId: string }): JSX.Element {
  const [loaded, setLoaded] = useState<AcpImageAttachment[]>([])
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const identity = JSON.stringify(images)
  useEffect(() => {
    let current = true
    setLoaded([]); setError(false)
    const entries = JSON.parse(identity) as AcpStoredImage[]
    void Promise.allSettled(entries.map(async entry => {
      const result = await api.acpPiImage(sessionId, entry.id)
      if (!result.ok || result.image.mimeType !== entry.mimeType) throw new Error('图片读取失败')
      return { ...entry, data: result.image.data }
    })).then(results => {
      if (!current) return
      setLoaded(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []))
      setError(results.some(result => result.status === 'rejected'))
    })
    return () => { current = false }
  }, [identity, sessionId, attempt])
  return <>{loaded.length > 0 && <ImageAttachments images={loaded} onSave={async id => { const result = await api.acpPiImageSave(sessionId, id); if (!result.ok) throw new Error(result.error) }} />}{error && <p role="alert">部分图片读取失败。 <button type="button" className="underline" onClick={() => setAttempt(value => value + 1)}>重试</button></p>}</>
}
