import { z } from 'zod'

export const WHITEBOARD_MAX_NODES = 64
export const WHITEBOARD_MAX_EDGES = 128
export const WHITEBOARD_MAX_TEXT = 500
export const WHITEBOARD_MAX_BYTES = 256 * 1024
export const WHITEBOARD_COORDINATE_LIMIT = 100000

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
const coordinate = z.number().finite().min(-WHITEBOARD_COORDINATE_LIMIT).max(WHITEBOARD_COORDINATE_LIMIT)

export const whiteboardNodeSchema = z.strictObject({
  id,
  type: z.literal('text'),
  text: z.string().max(WHITEBOARD_MAX_TEXT),
  x: coordinate,
  y: coordinate,
})

export const whiteboardEdgeSchema = z.strictObject({
  id,
  source: id,
  target: id,
})

/** This is a data format only; it does not establish permissions or persistence. */
export const whiteboardDocumentSchema = z.strictObject({
  version: z.literal(1),
  nodes: z.array(whiteboardNodeSchema).max(WHITEBOARD_MAX_NODES),
  edges: z.array(whiteboardEdgeSchema).max(WHITEBOARD_MAX_EDGES),
}).superRefine((value, context) => {
  const nodeIds = new Set(value.nodes.map((node) => node.id))
  const edgeIds = new Set(value.edges.map((edge) => edge.id))
  if (nodeIds.size !== value.nodes.length || edgeIds.size !== value.edges.length || value.edges.some((edge) => nodeIds.has(edge.id))) {
    context.addIssue({ code: 'custom', message: 'Node and edge IDs must be unique' })
  }
  if (value.edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target)) {
    context.addIssue({ code: 'custom', message: 'Edges must connect two existing distinct nodes' })
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > WHITEBOARD_MAX_BYTES) {
    context.addIssue({ code: 'custom', message: 'Whiteboard exceeds the byte limit' })
  }
})

export type WhiteboardDocument = z.infer<typeof whiteboardDocumentSchema>

export function createEmptyWhiteboard(): WhiteboardDocument {
  return { version: 1, nodes: [], edges: [] }
}
