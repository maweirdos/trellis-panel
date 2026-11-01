import { useId, useState, type JSX } from 'react'

/** Keep the raw draft editable; the host resolves exact names in the current project. */
export function ProfileMcpServers({ value, disabled, onChange }: {
  value: string[]
  disabled: boolean
  onChange: (names: string[]) => void
}): JSX.Element {
  const id = useId()
  const [text, setText] = useState(() => value.join(', '))
  return <div>
    <label htmlFor={id} className="my-item-title block">项目 MCP（名称，逗号分隔）</label>
    <input id={id} className="my-input mt-1 w-full" value={text} disabled={disabled} aria-describedby={`${id}-help`} onChange={(event) => {
      const next = event.target.value
      setText(next)
      onChange([...new Set(next.split(/[,，]/).map((name) => name.trim()).filter(Boolean))])
    }} />
    <p id={`${id}-help`} className="my-item-description mt-1">可选；填写当前项目 .pi/mcp.json 中的服务器名称。项目知识工具自动提供。</p>
  </div>
}
