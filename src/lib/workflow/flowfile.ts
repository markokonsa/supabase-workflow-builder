// Reopen exported flows. An export (export.ts) is a runnable script that also carries the flow:
//   const WORKFLOW = {...};    nodes + edges (no secrets, no positions) — what the script runs
//   const DEFAULT_URL = "...";  the Supabase project URL
//   const FLOW_META = {...};    name + node positions — only for reopening in the builder
// The blocks are read as JSON; the file is never executed. Exports made before FLOW_META existed
// still open, with an automatic left-to-right layout.
import type { Edge, Node } from "@xyflow/react";
import { topoOrder, type FlowGraph } from "./graph";
import { NODE_META, type NodeKind, type WFNodeData } from "./types";

export interface FlowMeta {
  version: 1;
  name: string;
  layout: Record<string, { x: number; y: number }>;
}

export interface OpenedFlow {
  name: string;
  url: string;
  nodes: Node<WFNodeData>[];
  edges: Edge[];
}

export function flowMeta(name: string, nodes: readonly Node<WFNodeData>[]): FlowMeta {
  return {
    version: 1,
    name,
    layout: Object.fromEntries(nodes.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])),
  };
}

function between(text: string, start: string, end: string): string | undefined {
  const i = text.indexOf(start);
  if (i === -1) return undefined;
  const from = i + start.length;
  const j = text.indexOf(end, from);
  return j === -1 ? undefined : text.slice(from, j);
}

function isGraph(value: unknown): value is FlowGraph {
  const g = value as Partial<FlowGraph> | null;
  return !!g && Array.isArray(g.nodes) && Array.isArray(g.edges);
}

/** Columns by dependency depth, nodes stacked within a column. */
function autoLayout(graph: FlowGraph): FlowMeta["layout"] {
  let order: string[];
  try {
    order = topoOrder(graph);
  } catch {
    order = graph.nodes.map((n) => n.id);
  }
  const depth = new Map<string, number>();
  for (const id of order) {
    const parents = graph.edges.filter((e) => e.target === id).map((e) => depth.get(e.source) ?? 0);
    depth.set(id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  const columns = new Map<number, string[]>();
  for (const id of order) {
    const d = depth.get(id) ?? 0;
    columns.set(d, [...(columns.get(d) ?? []), id]);
  }
  const layout: FlowMeta["layout"] = {};
  for (const [d, ids] of columns) {
    ids.forEach((id, i) => {
      layout[id] = { x: d * 280, y: 120 + (i - (ids.length - 1) / 2) * 160 };
    });
  }
  return layout;
}

/** Parse an exported .mjs (or a .json with { graph | nodes, edges }) back into canvas nodes and edges. */
export function parseFlowFile(text: string, fileName = ""): OpenedFlow {
  let graph: unknown;
  let url = "";
  let meta: Partial<FlowMeta> = {};

  if (text.trimStart().startsWith("{")) {
    const data = JSON.parse(text) as { graph?: unknown; meta?: Partial<FlowMeta>; url?: string };
    graph = data.graph ?? data;
    meta = data.meta ?? {};
    url = data.url ?? "";
  } else {
    const wf = between(text, "\nconst WORKFLOW = ", ";\nconst DEFAULT_URL = ");
    if (!wf) throw new Error("This file isn't a KOMA/flow export (no WORKFLOW block found).");
    graph = JSON.parse(wf);
    const u = between(text, "\nconst DEFAULT_URL = ", ";\n");
    if (u) url = JSON.parse(u) as string;
    const m = between(text, "\nconst FLOW_META = ", ";\n");
    if (m) meta = JSON.parse(m) as Partial<FlowMeta>;
  }

  if (!isGraph(graph)) throw new Error("The flow in this file has no nodes or edges.");
  const layout = meta.layout ?? autoLayout(graph);

  const nodes = graph.nodes.map((n): Node<WFNodeData> => {
    const kind = n.data?.kind as NodeKind;
    const nodeMeta = NODE_META[kind];
    if (!nodeMeta) throw new Error(`Unknown node type "${String(kind)}" in this file.`);
    const data = { kind, label: n.data.label || nodeMeta.title, config: { ...nodeMeta.defaults, ...n.data.config } } as WFNodeData;
    return { id: n.id, type: "wf", position: layout[n.id] ?? { x: 0, y: 0 }, data };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e, i): Edge => ({
      id: `e_${e.source}_${e.sourceHandle ?? "out"}_${e.target}_${i}`,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    }));

  const name = meta.name || fileName.replace(/\.(m?js|json)$/i, "") || "workflow";
  return { name, url, nodes, edges };
}

/** Let the user pick a .mjs/.json file and parse it. Resolves to null if they cancel. */
export function pickFlowFile(): Promise<OpenedFlow | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mjs,.js,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try {
        resolve(parseFlowFile(await file.text(), file.name));
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
