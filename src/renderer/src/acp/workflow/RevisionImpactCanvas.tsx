import { memo, useMemo, useRef, useState, type JSX } from 'react'
import { Background, Handle, MarkerType, Position, ReactFlow, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { Check, Circle, Minus, Plus, Shuffle } from 'lucide-react'
import type { WorkflowRevisionPreview } from '../../../../shared/workflow-revisions'
import { graphPositions } from './model'

type ImpactData = { label: string; change: string; affected: boolean; kind: string }
type ImpactNode = Node<ImpactData, 'impact'>
const changeLabel = (value: string): string => ({ added: '新增', removed: '移除', changed: '变更', unchanged: '未变' })[value] ?? value
const ImpactStage = memo(function ImpactStage({ data }: NodeProps<ImpactNode>): JSX.Element {
  const Icon = data.change === 'added' ? Plus : data.change === 'removed' ? Minus : data.change === 'changed' ? Shuffle : data.affected ? Circle : Check
  return <div className="wf-impact-stage" data-change={data.change}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <span><Icon size={13} />{changeLabel(data.change)} · {data.affected ? '受影响' : '保留'}</span><strong>{data.label}</strong><small>{data.kind === 'gate' ? '平台产物检查' : data.kind === 'agent' ? '原生 Agent 阶段' : '工具阶段'}</small>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>
})
const nodeTypes = { impact: ImpactStage }
export function RevisionImpactCanvas({ preview }: { preview: WorkflowRevisionPreview }): JSX.Element {
  const instances = useRef<{ before: ReactFlowInstance<ImpactNode> | null; after: ReactFlowInstance<ImpactNode> | null }>({ before: null, after: null })
  const [selection, setSelection] = useState<{ previewId: string; side: 'before' | 'after'; id: string } | null>(null)
  const graphs = useMemo(() => (['before', 'after'] as const).map((side) => {
    const graph = preview[side], positions = graphPositions(graph)
    return { side, graph, nodes: graph.nodes.map((node): ImpactNode => {
      const mapping = preview.impact.nodes.find((entry) => entry[side] === node.nodeId)
      return { id: node.nodeId, type: 'impact', position: positions.get(node.nodeId) ?? { x: 0, y: 0 }, draggable: false, connectable: false,
        data: { label: node.label, kind: node.kind, change: mapping?.change ?? 'unchanged', affected: mapping?.affected ?? false }, ariaLabel: `${node.label}，${changeLabel(mapping?.change ?? 'unchanged')}，${mapping?.affected ? '受影响' : '保留'}` }
    }), edges: graph.edges.map((edge) => {
      const mapping = preview.impact.edges.find((entry) => entry[side] === edge.edgeId)
      return { id: edge.edgeId, source: edge.from, target: edge.to, type: 'smoothstep', className: `wf-impact-edge-${mapping?.change ?? 'unchanged'}`, markerEnd: { type: MarkerType.ArrowClosed }, label: mapping?.change && mapping.change !== 'unchanged' ? changeLabel(mapping.change) : undefined }
    }) }
  }), [preview])
  const selected = selection?.previewId === preview.previewId ? graphs.find((entry) => entry.side === selection.side)?.nodes.find((node) => node.id === selection.id) : null
  return <section className="wf-impact" aria-label="修订前后流程差异">
    <div className="wf-impact-legend"><span data-change="added">＋ 新增</span><span data-change="removed">− 移除</span><span data-change="changed">↔ 变更</span><span>✓ 保留定义，不代表跳过执行</span></div>
    <div className="wf-impact-pair">{graphs.map(({ side, nodes, edges }) => <section key={`${preview.previewId}:${side}`}><h3>{side === 'before' ? '当前固定流程' : '拟采用的流程'}<small>{nodes.length} 个节点</small></h3><div className="wf-impact-canvas" role="group" aria-label={side === 'before' ? '修订前节点图' : '修订后节点图'} onKeyDown={(event) => { if (event.key !== 'Enter' && event.key !== ' ') return; const id = (event.target as HTMLElement).closest('[data-id]')?.getAttribute('data-id'); if (id && nodes.some((node) => node.id === id)) { event.preventDefault(); setSelection({ previewId: preview.previewId, side, id }) } }}>
      <ReactFlow<ImpactNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} attributionPosition="bottom-left" onInit={(instance) => { instances.current[side] = instance }} fitView fitViewOptions={{ padding: .15, maxZoom: .9 }} minZoom={.2} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} panOnScroll={false} zoomOnScroll={false} preventScrolling={false} onNodeClick={(_event, node) => setSelection({ previewId: preview.previewId, side, id: node.id })} onNodeDoubleClick={(_event, node) => setSelection({ previewId: preview.previewId, side, id: node.id })}>
        <Background gap={24} size={1} />
      </ReactFlow><div className="wf-canvas-tools" role="group" aria-label={side === 'before' ? '修订前图视角' : '修订后图视角'}>
        <button type="button" className="my-control my-control-sm" aria-label={side === 'before' ? '缩小修订前图' : '缩小修订后图'} onClick={() => { void instances.current[side]?.zoomOut({ duration: 0 }) }}>−</button>
        <button type="button" className="my-control my-control-sm" aria-label={side === 'before' ? '放大修订前图' : '放大修订后图'} onClick={() => { void instances.current[side]?.zoomIn({ duration: 0 }) }}>+</button>
        <button type="button" className="my-control my-control-sm" aria-label={side === 'before' ? '适应修订前全图' : '适应修订后全图'} onClick={() => { void instances.current[side]?.fitView({ padding: .15, maxZoom: .9, duration: 0 }) }}>全图</button>
      </div></div></section>)}</div>
    {selected && <p className="wf-impact-selection">{selection?.side === 'before' ? '当前' : '拟采用'} · {selected.data.label}：{changeLabel(selected.data.change)}，{selected.data.affected ? '属于受影响范围' : '定义保留；是否执行以运行记录为准'}。</p>}
  </section>
}
