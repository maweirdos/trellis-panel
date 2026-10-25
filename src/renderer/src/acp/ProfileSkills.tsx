import { useEffect, useRef, useState, type JSX } from 'react'
import { Loader2 } from 'lucide-react'
import { api, hasIpc } from '../api'
import { Button } from '../my/ui'
import { relativePathUnderRoot, sameRelativeDocumentPath } from '../reader/reader-paths'
import { useInteractionActive, useInteractionGuard } from '../utils/interaction-scope'
import { acpSkillPathSchema } from '../../../shared/acp-context'

interface ProjectSkill { relativePath: string; name: string; description: string }
interface SkillScan { root: string; loading: boolean; skills: ProjectSkill[]; error: string; complete: boolean }

export function ProfileSkills({ root, value, onChange, disabled = false, isCurrent }: {
  root: string
  value: string[]
  onChange: (paths: string[]) => void
  disabled?: boolean
  isCurrent: () => boolean
}): JSX.Element {
  const active = useInteractionActive()
  const canInteract = useInteractionGuard()
  const current = useRef({ root, isCurrent })
  current.current = { root, isCurrent }
  const [attempt, setAttempt] = useState(0)
  const [scan, setScan] = useState<SkillScan>({ root, loading: true, skills: [], error: '', complete: false })
  useEffect(() => {
    let cancelled = false
    const owned = (): boolean => !cancelled && current.current.root === root && current.current.isCurrent() && canInteract()
    if (!active) return () => { cancelled = true }
    if (!root || !hasIpc) {
      setScan({ root, loading: false, skills: [], error: !root ? '请先打开项目。' : '当前无法读取项目技能。', complete: false })
      return () => { cancelled = true }
    }
    setScan((previous) => ({ root, loading: true, skills: previous.root === root ? previous.skills : [], error: '', complete: false }))
    void (async () => {
      try {
        const result = await api.studioScan()
        if (!owned()) return
        if (!result.ok || !result.scan) throw new Error(result.error ?? '读取项目技能失败')
        const skills: ProjectSkill[] = []
        for (const entry of result.scan.extensions) {
          if (entry.kind !== 'skill') continue
          const relative = relativePathUnderRoot(root, entry.path)
          const parsed = acpSkillPathSchema.safeParse(relative)
          if (!parsed.success || skills.some((skill) => sameRelativeDocumentPath(root, skill.relativePath, parsed.data))) continue
          skills.push({ relativePath: parsed.data, name: entry.name, description: entry.frontmatter.description ?? '' })
        }
        skills.sort((left, right) => left.name.localeCompare(right.name) || left.relativePath.localeCompare(right.relativePath))
        setScan({ root, loading: false, skills, error: '', complete: true })
      } catch (cause) {
        if (owned()) setScan((previous) => ({ ...previous, loading: false, complete: false, error: cause instanceof Error ? cause.message : '读取项目技能失败' }))
      }
    })()
    return () => { cancelled = true }
  }, [root, active, attempt, canInteract])

  const visible = scan.root === root ? scan : { root, loading: true, skills: [], error: '', complete: false }
  const selected = (path: string): boolean => value.some((item) => sameRelativeDocumentPath(root, item, path))
  const missing = value.filter((path) => !visible.skills.some((skill) => sameRelativeDocumentPath(root, skill.relativePath, path)))
  const toggle = (path: string): void => {
    if (disabled || !canInteract() || !isCurrent()) return
    if (selected(path)) onChange(value.filter((item) => !sameRelativeDocumentPath(root, item, path)))
    else if (value.length < 32) onChange([...value, path])
  }
  return <section aria-label="项目技能" className="space-y-2 text-my-sm text-my-secondary">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium text-my-primary">项目技能</h3><span className="text-my-tertiary">已选 {value.length} / 32</span></div>
    <p className="text-my-tertiary">额外选择当前项目技能；执行引擎原有的技能仍会继承。</p>
    {visible.loading && <p role="status" className="flex items-center gap-1 text-my-tertiary"><Loader2 size={12} className="animate-spin" />正在读取项目技能…</p>}
    {visible.error && <div><p role="alert" className="text-my-danger-text">{visible.error}</p><Button size="sm" variant="outline" disabled={disabled || !active || !hasIpc || !root} onClick={() => { if (canInteract() && isCurrent()) setAttempt((previous) => previous + 1) }}>重试读取技能</Button></div>}
    <div className="space-y-2">
      {visible.skills.map((skill) => <label key={skill.relativePath} className="flex items-start gap-2">
        <input type="checkbox" className="my-checkbox mt-1 shrink-0" checked={selected(skill.relativePath)} disabled={disabled || !active || (!selected(skill.relativePath) && value.length >= 32)} onChange={() => toggle(skill.relativePath)} />
        <span className="min-w-0"><strong className="font-medium text-my-primary">{skill.name}</strong>{skill.description && <span className="block break-words text-my-tertiary">{skill.description}</span>}<span className="block break-all font-mono text-my-xs text-my-tertiary">{skill.relativePath}</span></span>
      </label>)}
      {missing.map((path) => <label key={path} className="flex items-start gap-2">
        <input type="checkbox" className="my-checkbox mt-1 shrink-0" checked disabled={disabled || !active} onChange={() => toggle(path)} />
        <span className="min-w-0"><span className="block break-all font-mono">{path}</span><span className="text-my-tertiary">{visible.complete ? '未在本次扫描中找到，已保留选择' : '已保留选择，尚未核对文件'}</span></span>
      </label>)}
    </div>
    {visible.complete && !visible.skills.length && <p className="text-my-tertiary">当前项目未发现可选技能。</p>}
    {value.length >= 32 && <p role="status" className="text-my-tertiary">最多选择 32 个技能；取消一项后可继续选择。</p>}
  </section>
}
