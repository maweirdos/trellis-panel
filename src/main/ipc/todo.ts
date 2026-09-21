import { ipcInvoke } from '../../shared/ipc-channels'
import { errorText } from '../../shared/errors'
import { IpcErrorCode, ipcFail, noProject } from '../../shared/ipc-errors'
import { listTodos, saveTodo, deleteTodo } from '../services/todo'
import { getProjectRoot } from '../state'
import { handle } from './registry'

export function registerTodoIpc(): void {
  handle(ipcInvoke.todo.list, () => {
    const root = getProjectRoot()
    if (!root) return noProject()
    return { ok: true, todos: listTodos(root) }
  })

  handle(ipcInvoke.todo.save, (_e, input) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      const todo = saveTodo(root, input)
      return { ok: true, todo }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorText(e, '保存待办失败'))
    }
  })

  handle(ipcInvoke.todo.delete, (_e, id: string) => {
    const root = getProjectRoot()
    if (!root) return noProject()
    try {
      deleteTodo(root, id)
      return { ok: true }
    } catch (e) {
      return ipcFail(IpcErrorCode.Io, errorText(e, '删除待办失败'))
    }
  })
}
