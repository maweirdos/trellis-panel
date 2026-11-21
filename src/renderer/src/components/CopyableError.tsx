import type { JSX } from 'react'
import { FeedbackNotice } from '../my/FeedbackNotice'

export function CopyableError({ message, summary = '操作失败' }: { message: string; summary?: string }): JSX.Element {
  return <FeedbackNotice title={summary} diagnostic={message} />
}
