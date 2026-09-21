import type { AppSlice, TodosSlice } from '../types'
import { api } from '../../api'

export const todosSlice: AppSlice<TodosSlice> = (set, get) => ({
  todos: [],

  loadTodos: async () => {
    const res = await api.todoList()
    if (res.ok && res.todos) {
      set({ todos: res.todos })
    }
  },

  saveTodo: async (input) => {
    const res = await api.todoSave(input)
    if (res.ok && res.todo) {
      await get().loadTodos()
      get().pushToast({ kind: 'success', title: '待办已保存', body: res.todo.filePath })
      return true
    } else {
      get().pushToast({ kind: 'error', title: '保存待办失败', body: res.error })
      return false
    }
  },

  deleteTodo: async (id) => {
    const res = await api.todoDelete(id)
    if (res.ok) {
      await get().loadTodos()
      get().pushToast({ kind: 'success', title: '待办已删除', body: id })
      return true
    } else {
      get().pushToast({ kind: 'error', title: '删除待办失败', body: res.error })
      return false
    }
  }
})
