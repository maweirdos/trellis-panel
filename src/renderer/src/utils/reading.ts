/**
 * FR：阅读位置持久化（每项目一条）——记住最后阅读的任务、文档与滚动位置。
 * 热键唤起与任务页启动恢复均从此读取；只存面板本地偏好，不写任何任务权威字段。
 */

export interface ReadingPos {
  dirName: string
  docName: string
  docType: string
  scrollTop: number
}

const key = (project: string): string => `tp:reading:${project}`

export function getReading(project: string): ReadingPos | null {
  if (!project) return null
  try {
    const raw = localStorage.getItem(key(project))
    if (!raw) return null
    const obj = JSON.parse(raw) as Partial<ReadingPos>
    if (typeof obj.dirName !== 'string') return null
    return {
      dirName: obj.dirName,
      docName: typeof obj.docName === 'string' ? obj.docName : 'prd.md',
      docType: typeof obj.docType === 'string' ? obj.docType : 'prd',
      scrollTop: typeof obj.scrollTop === 'number' ? obj.scrollTop : 0
    }
  } catch {
    return null
  }
}

export function setReading(project: string, pos: ReadingPos | null): void {
  if (!project) return
  try {
    if (pos) localStorage.setItem(key(project), JSON.stringify(pos))
    else localStorage.removeItem(key(project))
  } catch {
    // localStorage 不可用（隐私模式等）——阅读记忆是尽力而为
  }
}
