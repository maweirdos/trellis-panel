import type { JSX } from 'react'
import { clsx } from 'clsx'
import { BrandMotion } from '../my/BrandMotion'
import { useInteractionActive } from '../utils/interaction-scope'
import type { CurrentTurnActivity } from './current-turn-activity'

/** Visual projection only; the current-turn projector owns the actual phase. */
export function AgentActivityMark({ phase, size = 16, active = true, className }: {
  phase?: CurrentTurnActivity['phase']
  size?: number
  active?: boolean
  className?: string
}): JSX.Element {
  const interactive = useInteractionActive()
  const state = phase === 'waiting' ? 'waiting' : phase === 'thinking' || phase === 'knowledge' ? 'observe' : 'loading'
  return <BrandMotion state={state} size={size} active={interactive && active} className={clsx('acp-agent-mark', className)} />
}
