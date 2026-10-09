// Serializable graph shape shared by the canvas, the exporter and the durable workflow.
// Dependency-free on purpose: src/workflows/run-flow.ts imports it into the
// Workflow SDK sandbox, which cannot load npm packages.
import type { AuthConfig, NodeConfig, NodeKind } from "./types";

export interface FlowNode {
  id: string;
  data: { kind: NodeKind; label: string; config: NodeConfig };
}

export interface FlowEdge {
  source: string;
  target: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** Config keys that never leave the browser (exports, durable runs). Servers read them from env. */
export const SECRET_KEYS: (keyof AuthConfig)[] = ["password", "serviceKey"];

/** Strip canvas-only fields (position, status, results) and secrets. */
export function toFlowGraph(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): FlowGraph {
  return {
    nodes: nodes.map((n) => {
      const config: Record<string, unknown> = { ...n.data.config };
      for (const k of SECRET_KEYS) delete config[k];
      return { id: n.id, data: { kind: n.data.kind, label: n.data.label, config: config as NodeConfig } };
    }),
    edges: edges.map((e) => ({ source: e.source, target: e.target })),
  };
}

/** Topological order; throws on cycles. */
export function topoOrder(graph: FlowGraph): string[] {
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  const queue = graph.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of graph.edges) {
      if (e.source !== id) continue;
      const left = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, left);
      if (left === 0) queue.push(e.target);
    }
  }
  if (order.length !== graph.nodes.length) throw new Error("Workflow contains a cycle");
  return order;
}
