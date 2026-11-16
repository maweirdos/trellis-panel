import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { Background, Handle, Position, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { WHITEBOARD_COORDINATE_LIMIT, WHITEBOARD_MAX_EDGES, WHITEBOARD_MAX_NODES, WHITEBOARD_MAX_TEXT, whiteboardDocumentSchema, type WhiteboardDocument } from '../../../shared/creation-whiteboard'
import { Select } from '../components/Select'
import '@xyflow/react/dist/style.css'
import './whiteboard-editor.css'

type TextNode = Node<{ text: string; readonly: boolean }, 'text'>

const TextCard = memo(function TextCard({ data }: NodeProps<TextNode>): JSX.Element {
  return <div className="whiteboard-node">
    <Handle type="target" position={Position.Left} isConnectable={!data.readonly} />
    <span>{data.text || '空节点'}</span>
    <Handle type="source" position={Position.Right} isConnectable={!data.readonly} />
  </div>
})
const nodeTypes = { text: TextCard }
const labels = {
  'node.a11yDescription.default': '按 Enter 选中节点，然后使用方向键移动或编辑内容。',
  'edge.a11yDescription.default': '选中连线后可删除。',
}
const readonlyLabels = {
  'node.a11yDescription.default': '只读节点。',
  'edge.a11yDescription.default': '只读连线。',
}

export interface WhiteboardEditorProps {
  /** Untrusted values are validated before rendering; the parent owns persistence. */
  value: unknown
  readonly?: boolean
  onChange: (value: WhiteboardDocument) => void
}

export function WhiteboardEditor({ value, readonly = false, onChange }: WhiteboardEditorProps): JSX.Element {
  const parsed = useMemo(() => whiteboardDocumentSchema.safeParse(value), [value])
  if (!parsed.success) return <div className="whiteboard-error" role="alert">无法打开此白板：格式无效或版本不受支持。</div>
  return <WhiteboardCanvas value={parsed.data} readonly={readonly} onChange={onChange} />
}

function WhiteboardCanvas({ value, readonly, onChange }: { value: WhiteboardDocument; readonly: boolean; onChange: (value: WhiteboardDocument) => void }): JSX.Element {
  const flow = useRef<ReactFlowInstance<TextNode> | null>(null)
  const canvas = useRef<HTMLDivElement | null>(null)
  const [selectedNode, setSelectedNode] = useState('')
  const [selectedEdge, setSelectedEdge] = useState('')
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    let previous = { width: element.clientWidth, height: element.clientHeight }
    const updateViewport = (): void => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      if (!next.width || !next.height) return
      const instance = flow.current
      if (instance && previous.width && previous.height && (next.width !== previous.width || next.height !== previous.height)) {
        const viewport = instance.getViewport()
        void instance.setViewport({ x: viewport.x + (next.width - previous.width) / 2, y: viewport.y + (next.height - previous.height) / 2, zoom: viewport.zoom }, { duration: 0 })
      }
      previous = next
    }
    const observer = new ResizeObserver(updateViewport)
    observer.observe(element)
    window.addEventListener('resize', updateViewport)
    return () => { window.removeEventListener('resize', updateViewport); observer.disconnect() }
  }, [])
  const node = value.nodes.find((entry) => entry.id === selectedNode)
  const edge = value.edges.find((entry) => entry.id === selectedEdge)
  const emit = useCallback((next: WhiteboardDocument): void => {
    if (readonly) return
    const result = whiteboardDocumentSchema.safeParse(next)
    if (!result.success) { setError('操作超出白板容量或坐标范围。'); return }
    setError('')
    onChange(result.data)
  }, [onChange, readonly])
  const nodes = useMemo(() => value.nodes.map((entry): TextNode => ({
    id: entry.id, type: 'text', position: { x: entry.x, y: entry.y }, data: { text: entry.text, readonly },
    selected: entry.id === selectedNode, ariaLabel: `节点：${entry.text || '空节点'}`,
  })), [value.nodes, readonly, selectedNode])
  const edges = useMemo(() => value.edges.map((entry): Edge => ({
    ...entry, selected: entry.id === selectedEdge, focusable: true,
    ariaLabel: `连线：${value.nodes.find((item) => item.id === entry.source)?.text || '空节点'} 到 ${value.nodes.find((item) => item.id === entry.target)?.text || '空节点'}`,
    interactionWidth: 24,
  })), [value.edges, value.nodes, selectedEdge])
  const addEdge = (from: string, to: string): void => {
    if (!from || !to || from === to || value.edges.length >= WHITEBOARD_MAX_EDGES) return
    if (!value.nodes.some((item) => item.id === from) || !value.nodes.some((item) => item.id === to)) return
    emit({ ...value, edges: [...value.edges, { id: crypto.randomUUID(), source: from, target: to }] })
  }
  const onNodesChange = (changes: NodeChange<TextNode>[]): void => {
    for (const change of changes) if (change.type === 'select' && change.selected) { setSelectedNode(change.id); setSelectedEdge('') }
    if (readonly) return
    const positions = new Map(changes.flatMap((change) => change.type === 'position' && change.position ? [[change.id, change.position] as const] : []))
    if (positions.size) emit({ ...value, nodes: value.nodes.map((item) => {
      const position = positions.get(item.id)
      return position ? { ...item, x: Math.max(-WHITEBOARD_COORDINATE_LIMIT, Math.min(WHITEBOARD_COORDINATE_LIMIT, position.x)), y: Math.max(-WHITEBOARD_COORDINATE_LIMIT, Math.min(WHITEBOARD_COORDINATE_LIMIT, position.y)) } : item
    }) })
  }
  return <section className="whiteboard-editor" aria-label="白板" data-readonly={readonly}>
    <div className="whiteboard-toolbar" role="toolbar" aria-label="白板操作">
      {!readonly && <button type="button" className="my-control" disabled={value.nodes.length >= WHITEBOARD_MAX_NODES} onClick={() => {
        const bounds = canvas.current?.getBoundingClientRect()
        const center = bounds ? flow.current?.screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }) ?? { x: 0, y: 0 } : { x: 0, y: 0 }
        const id = crypto.randomUUID()
        emit({ ...value, nodes: [...value.nodes, { id, type: 'text', text: '', x: Math.max(-WHITEBOARD_COORDINATE_LIMIT, Math.min(WHITEBOARD_COORDINATE_LIMIT, center.x)), y: Math.max(-WHITEBOARD_COORDINATE_LIMIT, Math.min(WHITEBOARD_COORDINATE_LIMIT, center.y)) }] })
        setSelectedNode(id); setSelectedEdge('')
      }}><Plus size={16} aria-hidden="true" /> 添加节点</button>}
      <span className="my-item-description">{readonly ? '只读' : `${value.nodes.length}/${WHITEBOARD_MAX_NODES} 节点 · ${value.edges.length}/${WHITEBOARD_MAX_EDGES} 连线`}</span>
      <div className="whiteboard-zoom" role="group" aria-label="画布缩放">
        <button type="button" className="my-control" aria-label="缩小画布" onClick={() => { void flow.current?.zoomOut({ duration: 0 }) }}><Minus size={16} aria-hidden="true" /></button>
        <button type="button" className="my-control" aria-label="放大画布" onClick={() => { void flow.current?.zoomIn({ duration: 0 }) }}><Plus size={16} aria-hidden="true" /></button>
        <button type="button" className="my-control" aria-label="适应全图" onClick={() => { void flow.current?.fitView({ padding: .2, duration: 0 }) }}><Maximize size={16} aria-hidden="true" /></button>
      </div>
    </div>
    {error && <div className="whiteboard-error" role="alert">{error}</div>}
    <div className="whiteboard-body">
      <div ref={canvas} className="whiteboard-canvas" role="group" aria-label="白板画布">
        <ReactFlow<TextNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={(instance) => { flow.current = instance }}
          onNodesChange={onNodesChange} onNodeClick={(_event, item) => { setSelectedNode(item.id); setSelectedEdge('') }}
          onEdgeClick={(_event, item) => { setSelectedEdge(item.id); setSelectedNode('') }}
          onEdgesChange={(changes) => { for (const change of changes) if (change.type === 'select' && change.selected) { setSelectedEdge(change.id); setSelectedNode('') } }}
          onConnect={(connection: Connection) => { if (!readonly && connection.source && connection.target) addEdge(connection.source, connection.target) }}
          nodesDraggable={!readonly} nodesConnectable={!readonly} edgesReconnectable={false} deleteKeyCode={null}
          minZoom={.2} maxZoom={2} fitView fitViewOptions={{ maxZoom: 1, duration: 0 }} ariaLabelConfig={readonly ? readonlyLabels : labels} attributionPosition="bottom-left">
          <Background gap={24} size={1} />
        </ReactFlow>
      </div>
      {!readonly && <div className="whiteboard-inspector">
        {value.nodes.length > 0 && <label className="whiteboard-picker"><span className="my-item-title">选择节点</span><Select value={node?.id ?? ''} onChange={(val) => { setSelectedNode(val); setSelectedEdge('') }} options={[{ value: '', label: '选择节点' }, ...value.nodes.map((item, index) => ({ value: item.id, label: item.text || `空节点 ${index + 1}` }))]} /></label>}
        {node && <div className="whiteboard-fields">
          <label><span className="my-item-title">节点内容</span><textarea className="my-input nodrag" value={node.text} maxLength={WHITEBOARD_MAX_TEXT} onChange={(event) => emit({ ...value, nodes: value.nodes.map((item) => item.id === node.id ? { ...item, text: event.target.value } : item) })} /></label>
          <button type="button" className="my-control" onClick={() => { emit({ ...value, nodes: value.nodes.filter((item) => item.id !== node.id), edges: value.edges.filter((item) => item.source !== node.id && item.target !== node.id) }); setSelectedNode('') }}>删除节点</button>
        </div>}
        {value.edges.length > 0 && <label className="whiteboard-picker"><span className="my-item-title">选择连线</span><Select value={edge?.id ?? ''} onChange={(val) => { setSelectedEdge(val); setSelectedNode('') }} options={[{ value: '', label: '选择连线' }, ...value.edges.map((item, index) => ({ value: item.id, label: `${value.nodes.find((entry) => entry.id === item.source)?.text || '空节点'} → ${value.nodes.find((entry) => entry.id === item.target)?.text || '空节点'} (${index + 1})` }))]} /></label>}
        {edge && <button type="button" className="my-control" onClick={() => { emit({ ...value, edges: value.edges.filter((item) => item.id !== edge.id) }); setSelectedEdge('') }}>删除连线</button>}
        <div className="whiteboard-fields" role="group" aria-label="创建连线">
          <label><span className="my-item-title">起点</span><Select value={source} onChange={setSource} options={[{ value: '', label: '选择节点' }, ...value.nodes.map((item, index) => ({ value: item.id, label: item.text || `空节点 ${index + 1}` }))]} /></label>
          <label><span className="my-item-title">终点</span><Select value={target} onChange={setTarget} options={[{ value: '', label: '选择节点' }, ...value.nodes.map((item, index) => ({ value: item.id, label: item.text || `空节点 ${index + 1}` }))]} /></label>
          <button type="button" className="my-control" disabled={!value.nodes.some((item) => item.id === source) || !value.nodes.some((item) => item.id === target) || source === target || value.edges.length >= WHITEBOARD_MAX_EDGES} onClick={() => addEdge(source, target)}>添加连线</button>
        </div>
      </div>}
    </div>
  </section>
}
