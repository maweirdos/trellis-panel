import type { AppSlice, ChatSlice } from '../types'
import type { ChatDoneEvent, ChatMessageView, ChatSessionMeta, ChatToolOp } from '../../../../shared/types'
import { api } from '../../api'

/**
 * 对话切片：流式增量按 runId 累积；队列项由主进程预分配 runId，
 * 当前轮 done 后主进程自动续发，渲染层凭 chat:output 首个增量把队列项转为流式态。
 */
export const chatSlice: AppSlice<ChatSlice> = (set, get) => ({
  chatSessions: [],
  chatActiveId: null,
  chatMessages: [],
  chatStreaming: null,
  chatPending: [],
  chatPendingPermission: null,

  chatAttachEvents: () => {
    const offPermission = api.onChatPermission((e) => {
      if (e.sessionId !== get().chatActiveId) return
      set({
        chatPendingPermission: { permId: e.permId, toolName: e.toolName, argsSummary: e.argsSummary, timeoutSec: e.timeoutSec }
      })
    })
    const offSteer = api.onChatSteer((e) => {
      const st = get()
      if (e.sessionId !== st.chatActiveId) return
      set({
        chatMessages: [
          ...st.chatMessages,
          { id: `steer-${Date.now()}`, role: 'user', content: e.content, siblingCount: 1, siblingIndex: 0, siblingIds: [] }
        ]
      })
    })
    const offOutput = api.onChatOutput((e) => {
      const st = get()
      if (st.chatStreaming?.runId === e.runId) {
        const cur = st.chatStreaming
        set({
          chatStreaming: {
            runId: e.runId,
            content: e.delta ? cur.content + e.delta : cur.content,
            reasoning: e.reasoning ? cur.reasoning + e.reasoning : cur.reasoning,
            toolOps: e.toolOp ? [...cur.toolOps, e.toolOp] : cur.toolOps
          }
        })
        return
      }
      if (e.sessionId !== st.chatActiveId) return
      // 队列项开跑：先把它携带的用户消息上屏
      const pending = st.chatPending.find((p) => p.runId === e.runId)
      if (pending) {
        set({
          chatPending: st.chatPending.filter((p) => p.runId !== e.runId),
          chatMessages: [
            ...st.chatMessages,
            { id: pending.runId, role: 'user', content: pending.content, siblingCount: 1, siblingIndex: 0, siblingIds: [pending.runId] }
          ],
          chatStreaming: { runId: e.runId, content: e.delta ?? '', reasoning: e.reasoning ?? '', toolOps: [] }
        })
      }
    })
    const offDone = api.onChatDone((e: ChatDoneEvent) => {
      const st = get()
      if (e.sessionId !== st.chatActiveId) {
        // 其他会话完成 / 标题总结事件：刷新列表即可
        void st.chatLoadSessions()
        return
      }
      if (e.kind === 'done' && e.message) {
        const optimistic: ChatMessageView = {
          ...e.message,
          id: `m-${e.runId}`,
          siblingCount: 1,
          siblingIndex: 0,
          siblingIds: [`m-${e.runId}`]
        }
        set({ chatMessages: [...st.chatMessages, optimistic], chatStreaming: null, chatPendingPermission: null })
        // 后台刷新拿准确的兄弟分支信息
        if (st.chatActiveId) void api.chatOpen(st.chatActiveId).then((r) => {
          if (r.ok && r.session && get().chatActiveId === st.chatActiveId) {
            set({ chatMessages: r.session.messages })
          }
        })
      } else {
        set({ chatStreaming: null, chatPendingPermission: null })
        if (e.kind === 'error' && e.error) {
          st.pushToast({ kind: 'error', title: '本轮请求失败', body: e.error })
        }
      }
      void st.chatLoadSessions()
    })
    return () => {
      offPermission()
      offSteer()
      offOutput()
      offDone()
    }
  },

  chatLoadSessions: async () => {
    const res = await api.chatList()
    if (res.ok && res.sessions) set({ chatSessions: res.sessions })
  },

  chatOpenSession: async (id) => {
    const res = await api.chatOpen(id)
    if (res.ok && res.session) {
      set({ chatActiveId: id, chatMessages: res.session.messages, chatStreaming: null, chatPending: [] })
    }
  },

  chatNewSession: async (binding) => {
    const res = await api.chatNew(binding)
    if (res.ok && res.session) {
      const meta: ChatSessionMeta = {
        id: res.session.id,
        title: res.session.title,
        createdAt: res.session.createdAt,
        updatedAt: res.session.updatedAt,
        messageCount: 0,
        providerId: res.session.providerId,
        modelId: res.session.modelId,
        thinkingLevel: res.session.thinkingLevel ?? 'off'
      }
      set({
        chatSessions: [meta, ...get().chatSessions],
        chatActiveId: meta.id,
        chatMessages: [],
        chatStreaming: null,
        chatPending: []
      })
      return meta
    }
    return null
  },

  chatDeleteSession: async (id) => {
    await api.chatDelete(id)
    const st = get()
    const sessions = st.chatSessions.filter((s) => s.id !== id)
    set({ chatSessions: sessions })
    if (st.chatActiveId === id) {
      set({ chatActiveId: sessions[0]?.id ?? null, chatMessages: [], chatStreaming: null, chatPending: [] })
      if (sessions[0]) await st.chatOpenSession(sessions[0].id)
    }
  },

  chatRenameSession: async (id, title) => {
    await api.chatRename(id, title)
    set({ chatSessions: get().chatSessions.map((s) => (s.id === id ? { ...s, title } : s)) })
  },

  chatSend: async (content, binding) => {
    const st = get()
    let sessionId = st.chatActiveId
    if (!sessionId) {
      const meta = await st.chatNewSession(binding)
      if (!meta) return
      sessionId = meta.id
    }
    const trimmed = content.trim()
    if (!trimmed && !(binding?.images?.length)) return
    const res = await api.chatSend({
      sessionId,
      content: trimmed,
      providerId: binding?.providerId,
      modelId: binding?.modelId,
      thinkingLevel: binding?.thinkingLevel,
      images: binding?.images,
      agent: binding?.agent
    })
    if (!res.ok) {
      st.pushToast({ kind: 'error', title: '发送失败', body: res.error })
      return
    }
    const userView: ChatMessageView = {
      id: res.runId ?? `m-${Date.now()}`,
      role: 'user',
      content: trimmed,
      siblingCount: 1,
      siblingIndex: 0,
      siblingIds: [res.runId ?? '']
    }
    if (res.queued) {
      set({ chatPending: [...st.chatPending, { runId: res.runId ?? `q-${Date.now()}`, content: trimmed }] })
    } else {
      set({
        chatMessages: [...get().chatMessages, userView],
        chatStreaming: res.runId ? { runId: res.runId, content: '', reasoning: '', toolOps: [] } : null
      })
    }
    void get().chatLoadSessions()
  },

  chatAbort: async () => {
    const id = get().chatActiveId
    if (id) await api.chatAbort(id)
  },

  chatResolvePermission: async (permId, decision) => {
    await api.chatResolvePermission(permId, decision)
    set({ chatPendingPermission: null })
  },

  chatSteer: async (content) => {
    const st = get()
    const id = st.chatActiveId
    if (!id) return
    const res = await api.chatSteer(id, content)
    if (!res.ok) st.pushToast({ kind: 'error', title: 'Steer 失败', body: res.error })
  },

  chatRegenerate: async () => {
    const st = get()
    const id = st.chatActiveId
    if (!id || st.chatStreaming) return
    const res = await api.chatRegenerate(id)
    if (!res.ok) {
      st.pushToast({ kind: 'error', title: '重新生成失败', body: res.error })
      return
    }
    // 旧回答在主进程保留为兄弟分支；渲染层移除旧叶并进入流式态
    set({
      chatMessages: st.chatMessages.slice(0, -1),
      chatStreaming: res.runId ? { runId: res.runId, content: '', reasoning: '', toolOps: [] } : null
    })
  },

  chatEditResend: async (messageId, content) => {
    const st = get()
    const id = st.chatActiveId
    if (!id || st.chatStreaming) return
    const res = await api.chatEditResend(id, messageId, content)
    if (!res.ok) {
      st.pushToast({ kind: 'error', title: '编辑重发失败', body: res.error })
      return
    }
    // 编辑生成兄弟分支：本地截断到该消息之前，替换为编辑后的用户消息
    const idx = st.chatMessages.findIndex((m) => m.id === messageId)
    const base = idx >= 0 ? st.chatMessages.slice(0, idx) : st.chatMessages
    set({
      chatMessages: [...base, { id: messageId, role: 'user', content: content.trim(), siblingCount: 1, siblingIndex: 0, siblingIds: [messageId] }],
      chatStreaming: res.runId ? { runId: res.runId, content: '', reasoning: '', toolOps: [] } : null
    })
    if (st.chatActiveId) {
      void api.chatOpen(st.chatActiveId).then((r) => {
        if (r.ok && r.session && get().chatActiveId === id && !get().chatStreaming) {
          set({ chatMessages: r.session.messages })
        }
      })
    }
  },

  chatBranch: async (messageId) => {
    const st = get()
    const id = st.chatActiveId
    if (!id || st.chatStreaming) return
    const res = await api.chatBranch(id, messageId)
    if (!res.ok) {
      st.pushToast({ kind: 'error', title: '切换分支失败', body: res.error })
      return
    }
    await st.chatOpenSession(id)
  }
})
