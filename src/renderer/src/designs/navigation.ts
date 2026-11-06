import { create } from 'zustand'
import { useApp } from '../store'
import type { DesignSelection } from '@shared/design-workspace'
import { clearCreationTarget } from '../creations/navigation'

interface DesignNavigation { documentId: string | null; conversationTarget: { conversationId: string; documentId: string; selection?: DesignSelection; token: string } | null }
export const useDesignNavigation = create<DesignNavigation>(() => ({ documentId: null, conversationTarget: null }))
export function openDesign(documentId: string): void { clearCreationTarget(); useDesignNavigation.setState({ documentId }); useApp.getState().setPage('creations') }
export function closeDesign(): void { useDesignNavigation.setState({ documentId: null }) }
