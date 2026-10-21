import { memo, useCallback, useMemo, useRef, type JSX } from 'react'
import { Background, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import { Check, Circle, CircleDot, OctagonAlert, Square } from 'lucide-react'
import type { CompiledWorkflow } from '../../../../shared/workflow'
import type { WorkflowApplicationSnapshot } from '../../../../shared/workflow-application'
import { graphPositions, stateLabel, type WorkflowView } from './model'
import '@xyflow/react/dist/style.css'

type StageData = { label: string; state: string; phase: string; outputs: number; selected: boolean; index: number; incoming: boolean; outgoing: boolean }
type StageNode = Node<StageData, 'stage'>
const Stage = memo(function Stage({ data }: NodeProps<StageNode>): JSX.Element {
  const Icon = data.state === 'verified' ? Check : ['running', 'dispatched', 'waiting'].includes(data.state) ? CircleDot : ['outcome-unknown', 'failed'].includes(data.state) ? OctagonAlert : data.state === 'stopped' || data.state === 'cancelled' ? Square : Circle
  return <div className="wf-stage" data-state={data.state} data-selected={data.selected}>
    {data.incoming && <Handle type="target" position={Position.Left} isConnectable={false} />}
    <div className="wf-stage-kicker"><span>阶段 {String(data.index + 1).padStart(2, '0')}</span><Icon size={15} aria-hidden="true" /></div>
    <strong>{data.label}</strong><div className="wf-stage-status"><span>{stateLabel(data.state)}</span>{data.outputs > 0 && <span>{data.outputs} 份产物</span>}</div>
    {data.outgoing && <Handle type="source" position={Position.Right} isConnectable={false} />}
  </div>
})
const nodeTypes = { stage: Stage }
const ariaLabelConfig = { 'node.a11yDescription.default': '按 Enter 查看阶段，使用 Tab 浏览。', 'edge.a11yDescription.default': '按 Enter 查看此依赖的交接记录。', 'controls.zoomIn.ariaLabel': '放大流程图', 'controls.zoomOut.ariaLabel': '缩小流程图' }

/** Geometry depends on topology only. Passive execution changes never fit/pan/focus. */
export function WorkflowCanvas({ graph, snapshot, view, onView, onSelected, locate }: {
  graph: CompiledWorkflow['graph']; snapshot: WorkflowApplicationSnapshot | null; view: WorkflowView;
  onView: (patch: Partial<WorkflowView>) => void; onSelected: (id: string) => void; locate: string | null
}): JSX.Element {
  const instance = useRef<ReactFlowInstance<StageNode> | null>(null)
  const previous = useRef(new Map<string, StageNode>())
  const topology = JSON.stringify([graph.nodes.map((node) => [node.nodeId, node.label, node.phaseId]), graph.edges, graph.layout])
  const positions = useMemo(() => graphPositions(graph), [topology])
  const nodes = useMemo(() => {
    const entries = graph.nodes.map((node, index): StageNode => {
      const actual = snapshot?.nodes.find((entry) => entry.nodeId === node.nodeId)
      const data: StageData = { label: node.label, state: actual?.state ?? 'planned', phase: node.phaseId, outputs: actual?.outputRefs.length ?? 0, selected: view.selected === node.nodeId, index, incoming: graph.edges.some((edge) => edge.to === node.nodeId), outgoing: graph.edges.some((edge) => edge.from === node.nodeId) }
      const old = previous.current.get(node.nodeId)
      if (old && JSON.stringify(old.data) === JSON.stringify(data) && old.position.x === positions.get(node.nodeId)?.x && old.position.y === positions.get(node.nodeId)?.y) return old
      return { id: node.nodeId, type: 'stage', position: positions.get(node.nodeId) ?? { x: 0, y: 0 }, data, width: 192, height: 96, draggable: false, connectable: false, selected: data.selected,
        ariaLabel: `${node.label}，${stateLabel(data.state)}，按 Enter 查看记录` }
    })
    previous.current = new Map(entries.map((node) => [node.id, node]))
    return entries
  }, [topology, positions, snapshot?.nodes, view.selected])
  const edges = useMemo(() => graph.edges.map((edge): Edge => ({ id: edge.edgeId, source: edge.from, target: edge.to, type: 'smoothstep', selectable: true, focusable: true, selected: view.selected === edge.edgeId,
    className: `wf-edge wf-edge-${edge.kind}`, markerEnd: { type: MarkerType.ArrowClosed }, ariaLabel: `${edge.kind === 'sequence' ? '预设顺序' : edge.kind === 'retry' ? '有界重试' : edge.kind === 'feedback' ? '反馈依赖' : '检查依赖'}，按 Enter 查看交接记录`, interactionWidth: 24 })), [topology, view.selected])
  const onInit = useCallback((flow: ReactFlowInstance<StageNode>): void => { instance.current = flow }, [])
  const focusCurrent = (): void => {
    if (!locate) return
    const position = positions.get(locate)
    if (!position) return
    onSelected(locate)
    void instance.current?.setCenter(position.x + 96, position.y + 48, { zoom: .9, duration: 0 })
  }
  return <div className="wf-canvas-shell">
    <div className="wf-canvas" role="group" aria-label="Trellis 运行节点图" onKeyDown={(event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const id = (event.target as HTMLElement).closest('[data-id]')?.getAttribute('data-id')
      if (id && (graph.nodes.some((node) => node.nodeId === id) || graph.edges.some((edge) => edge.edgeId === id))) { event.preventDefault(); onSelected(id) }
    }}>
      <ReactFlow<StageNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onInit={onInit}
        viewport={view.viewport} onViewportChange={(viewport) => onView({ viewport })}
        minZoom={.35} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
        deleteKeyCode={null} multiSelectionKeyCode={null} selectionOnDrag={false} panOnScroll={false} zoomOnScroll={false} zoomOnPinch
        preventScrolling={false} onNodeClick={(_event, node) => onSelected(node.id)} onEdgeClick={(_event, edge) => onSelected(edge.id)}
        onNodeDoubleClick={(_event, node) => onSelected(node.id)} ariaLabelConfig={ariaLabelConfig} attributionPosition="bottom-left" proOptions={{ hideAttribution: false }}>
        <Background gap={24} size={1} />
      </ReactFlow>
    </div>
    <div className="wf-canvas-tools" role="group" aria-label="流程图视角">
      <button type="button" className="my-control my-control-sm" aria-label="缩小流程图" onClick={() => { void instance.current?.zoomOut({ duration: 0 }) }}>−</button>
      <span aria-label={`当前缩放 ${Math.round(view.viewport.zoom * 100)}%`}>{Math.round(view.viewport.zoom * 100)}%</span>
      <button type="button" className="my-control my-control-sm" aria-label="放大流程图" onClick={() => { void instance.current?.zoomIn({ duration: 0 }) }}>+</button>
      <button type="button" className="my-control my-control-sm" disabled={!locate} onClick={focusCurrent}>定位当前</button>
    </div>
  </div>
}
