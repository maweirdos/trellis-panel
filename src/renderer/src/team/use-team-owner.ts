import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useInteractionActive, useInteractionGuard, useInteractionSignal } from '../utils/interaction-scope'
export function useTeamOwner(key: string) {
  const active = useInteractionActive(), guard = useInteractionGuard(), signal = useInteractionSignal()
  const lifetime = useMemo(() => Symbol('team-ui-owner'), [key, active, signal])
  const current = useRef(lifetime); current.current = lifetime
  const mounted = useRef(false)
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const capture = useCallback(() => lifetime, [lifetime])
  const valid = useCallback((owner: symbol): boolean => mounted.current && current.current === owner && guard(), [guard])
  return { active, capture, valid, lifetime }
}
