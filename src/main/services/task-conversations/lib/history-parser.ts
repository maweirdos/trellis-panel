import type { NativeHistoryFile, NativeRuntimeAlias, NativeTaskEvidence } from '../types'
import { pathKey, timestamp } from './paths'
import { commandEvidence, failedOutput, nestedShellInputs, outputParts, successfulOutputs, taskCommands, type TaskCommand } from './history-command'

export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
const MAX_PENDING_CALLS = 128
const MAX_EVIDENCE = 2048

/** Retains only task commands waiting for their own result, IDs and task evidence. */
export class HistoryParser {
  private verified = false
  private invalid = false
  private readonly pending = new Map<string, { slots: TaskCommand[][]; nested: boolean }>()
  private readonly found = new Map<string, NativeTaskEvidence>()
  limited = false
  constructor(private readonly root: string, private readonly descriptor: NativeHistoryFile) {}
  private reject(): void { this.invalid = true; this.limited = true; this.pending.clear(); this.found.clear() }
  private metadata(id: unknown, cwd: unknown): boolean {
    const expected = this.descriptor.conversation
    if (typeof id !== 'string' || typeof cwd !== 'string' || id !== expected.sessionId || pathKey(cwd) !== pathKey(expected.cwd)) {
      this.reject(); return false
    }
    this.verified = true
    return true
  }
  private acceptsSource(source: string): boolean {
    const { conversation: item, providerId } = this.descriptor
    if (item.source === 'codex') return source === `session:codex_${item.sessionId}`
    if (item.source === 'claude-code') return source === `session:claude_${item.sessionId}` || source === `session:claude_sess_${item.sessionId}`
    return source === `session:zcode_${item.sessionId}` || !!providerId && (source === `session:claude_${providerId}` || source === `session:claude_sess_${providerId}` || source === `session:zcode_${providerId}`)
  }
  private commands(name: unknown, input: unknown): TaskCommand[][] {
    const record = object(input)
    const cwd = this.descriptor.conversation.cwd
    if (name === 'exec' || name === 'functions.exec') {
      return typeof input === 'string' ? nestedShellInputs(input).map(shell => taskCommands(this.root, shell.cmd, cwd, shell.workdir)) : []
    }
    if ((name === 'exec_command' || name === 'functions.exec_command') && typeof record?.cmd === 'string') {
      return [taskCommands(this.root, record.cmd, cwd, typeof record.workdir === 'string' ? record.workdir : undefined)]
    }
    if (name === 'Bash' && typeof record?.command === 'string') return [taskCommands(this.root, record.command, cwd)]
    // Older Codex direct shell command.
    if (name === 'shell_command' && typeof record?.command === 'string') return [taskCommands(this.root, record.command, cwd, typeof record.workdir === 'string' ? record.workdir : undefined)]
    return []
  }
  private call(id: unknown, name: unknown, input: unknown): void {
    if (!this.verified || this.invalid || typeof id !== 'string' || id.length > 256) return
    const commands = this.commands(name, input)
    if (!commands.some(slot => slot.length)) return
    if (this.pending.size >= MAX_PENDING_CALLS) { this.pending.delete(this.pending.keys().next().value || ''); this.limited = true }
    this.pending.set(id, { slots: commands, nested: name === 'exec' || name === 'functions.exec' })
  }
  private result(id: unknown, output: unknown, at: unknown, nativeSuccess = false): void {
    if (typeof id !== 'string') return
    const call = this.pending.get(id)
    this.pending.delete(id)
    if (!call || this.invalid || !this.verified) return
    const { slots, nested } = call
    const parts = outputParts(output).filter(part => !/^Script completed\r?\nWall time:?[ \t]+\d+(?:\.\d+)? seconds\r?\nOutput:\r?\n?$/.test(part))
    // Every proven text() has one output slot, including a single nested call.
    if ((nested || slots.length > 1) && slots.length !== parts.length) { this.limited = true; return }
    if (parts.some(failedOutput)) return
    for (const [index, slot] of slots.entries()) for (const text of successfulOutputs(nested || slots.length > 1 ? parts[index] : output, nativeSuccess, true)) {
      for (const evidence of commandEvidence(this.root, slot, text, source => this.acceptsSource(source))) {
        if (this.found.size >= MAX_EVIDENCE) { this.limited = true; return }
        const item = { source: this.descriptor.conversation.source, sessionId: this.descriptor.conversation.sessionId, ...evidence, occurredAt: timestamp(at) }
        this.found.set(JSON.stringify([item.taskDir, item.trellisId, item.occurredAt]), item)
      }
    }
  }
  line(raw: unknown): void {
    const entry = object(raw)
    if (!entry || this.invalid) return
    if (this.descriptor.conversation.source === 'codex') {
      const payload = object(entry.payload)
      if (!payload) return
      if (entry.type === 'session_meta') {
        const source = object(payload.source), subagent = object(source?.subagent), spawn = object(subagent?.thread_spawn)
        if (typeof spawn?.parent_thread_id === 'string' || payload.thread_source === 'subagent') { this.reject(); return }
        this.metadata(payload.id, payload.cwd)
      }
      if (entry.type !== 'response_item') return
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        let input: unknown = payload.input
        if (payload.type === 'function_call' && typeof payload.arguments === 'string') {
          try { input = JSON.parse(payload.arguments) } catch { return }
        }
        this.call(payload.call_id, payload.name, input)
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') this.result(payload.call_id, payload.output, entry.timestamp)
    } else if (this.descriptor.conversation.source === 'claude-code') {
      if (entry.isSidechain === true) { this.reject(); return }
      if (entry.sessionId !== undefined && entry.sessionId !== this.descriptor.conversation.sessionId) { this.reject(); return }
      if (entry.cwd !== undefined && !this.metadata(entry.sessionId, entry.cwd)) return
      const message = object(entry.message)
      if (!Array.isArray(message?.content)) return
      for (const value of message.content.slice(0, 256)) {
        const block = object(value)
        if (!block) continue
        if (entry.type === 'assistant' && block.type === 'tool_use') this.call(block.id, block.name, block.input)
        if (entry.type === 'user' && block.type === 'tool_result') {
          if (block.is_error === true) { if (typeof block.tool_use_id === 'string') this.pending.delete(block.tool_use_id) }
          else this.result(block.tool_use_id, block.content, entry.timestamp, true)
        }
      }
    }
  }
  zcode(kind: 'meta' | 'message', raw: unknown): void {
    const value = object(raw)
    if (!value || this.invalid) return
    if (kind === 'meta') {
      if (!this.metadata(value.taskId, value.workspacePath)) return
      if ((this.descriptor.providerId || null) !== (typeof value.acpSessionId === 'string' ? value.acpSessionId : null)) this.reject()
      return
    }
    if (!this.verified || value.role !== 'assistant' || !Array.isArray(value.tools)) return
    for (const item of value.tools.slice(0, 256)) {
      const tool = object(item), rawTool = object(tool?.raw), meta = object(rawTool?._meta), provider = object(meta?.claudeCode)
      if (!tool || tool.status !== 'completed' || provider?.toolName !== 'Bash') continue
      const id = 'completed-zcode-tool'
      this.call(id, 'Bash', tool.input)
      this.result(id, tool.output, value.timestamp ?? value.createdAt, true)
    }
  }
  evidence(): NativeTaskEvidence[] { return this.invalid || !this.verified ? [] : [...this.found.values()] }
  aliases(): NativeRuntimeAlias[] {
    const { conversation: item, providerId } = this.descriptor
    return this.verified && !this.invalid && item.source === 'zcode' && providerId ? [
      { source: 'claude-code', sessionId: providerId, conversationId: item.id },
      { source: 'zcode', sessionId: providerId, conversationId: item.id }
    ] : []
  }
}
