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
  /** Which output of a branching node (condition rule id, else, event, timeout). */
  sourceHandle?: string | null | undefined;
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
    edges: edges.map((e) => ({ source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) })),
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

/**
 * Whether an edge carries a value: its source produced output and, for branching nodes,
 * the edge leaves from a branch that fired. Mirrors edgeActive() in engine.mjs.
 */
export function edgeActive(e: FlowEdge, ctx: Record<string, unknown>, branches: Record<string, string[]>): boolean {
  if (ctx[e.source] === undefined) return false;
  const fired = branches[e.source];
  return !e.sourceHandle || !fired || fired.includes(e.sourceHandle);
}

/** "30s" / "5m" / "1h" / "2d" / "250ms" / plain milliseconds → ms. Mirrors parseDuration() in engine.mjs. */
export function parseDuration(value: string | number | undefined, fallbackMs = 5 * 60_000): number {
  if (value === undefined || value === "") return fallbackMs;
  if (typeof value === "number") return value;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!m) throw new Error(`Invalid duration "${value}" (use e.g. 30s, 5m, 1h)`);
  const unit = (m[2] ?? "ms").toLowerCase() as "ms" | "s" | "m" | "h" | "d";
  return Math.round(Number(m[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]);
}

/** Token a durable run's hook node listens on; POST /api/flows/hooks/<token> resumes it. */
export const hookToken = (runId: string, nodeId: string) => `flow:${runId}:${nodeId}`;
