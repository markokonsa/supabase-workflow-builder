// The durable workflow: walks the graph in topological order and runs every node
// as its own step. Runs in the Workflow SDK sandbox, so it only orchestrates —
// all I/O happens inside the steps.
import { topoOrder, type FlowGraph } from "../lib/workflow/graph";
import type { NodeKind } from "../lib/workflow/types";
import {
  authStep,
  dbFunctionStep,
  dbQueryStep,
  edgeFunctionStep,
  resultStep,
  scriptStep,
  webhookStep,
  type PublicConnection,
  type StepAuth,
  type StepInput,
  type StepOutput,
} from "./steps";

const STEP_BY_KIND: Record<NodeKind, (args: StepInput) => Promise<StepOutput>> = {
  start: webhookStep,
  auth: authStep,
  edge: edgeFunctionStep,
  rpc: dbFunctionStep,
  query: dbQueryStep,
  transform: scriptStep,
  output: resultStep,
};

export interface FlowLogEntry {
  nodeId: string;
  label: string;
  status: "success" | "error" | "skipped";
  message: string;
  ms?: number;
}

export interface FlowRunResult {
  /** Value of the Result node(s); falls back to the last node. */
  result: unknown;
  /** Output of every node that succeeded, by node id. */
  outputs: Record<string, unknown>;
  logs: FlowLogEntry[];
  failed: boolean;
}

export async function runFlow(
  graph: FlowGraph,
  input?: unknown,
  conn: PublicConnection = {},
): Promise<FlowRunResult> {
  "use workflow";

  const order = topoOrder(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ctx: Record<string, unknown> = {};
  const logs: FlowLogEntry[] = [];
  let auth: StepAuth = { role: "anon" };
  let failed = false;

  for (const id of order) {
    const node = byId.get(id)!;
    const incoming = graph.edges.filter((e) => e.target === id);
    if (incoming.length && incoming.every((e) => ctx[e.source] === undefined)) {
      logs.push({ nodeId: id, label: node.data.label, status: "skipped", message: "upstream failed" });
      continue;
    }
    const prev = incoming.length ? ctx[incoming[0]!.source] : undefined;
    try {
      const r = await STEP_BY_KIND[node.data.kind]({ node, prev, ctx, input, auth, conn });
      ctx[id] = r.out ?? null;
      if (r.auth) auth = r.auth;
      logs.push({
        nodeId: id,
        label: node.data.label,
        status: "success",
        message: JSON.stringify(r.out)?.slice(0, 300) ?? "null",
        ms: r.ms,
      });
    } catch (err) {
      // Retries are exhausted (or the error was fatal): record it and let
      // independent branches carry on, like the in-browser runner does.
      failed = true;
      logs.push({ nodeId: id, label: node.data.label, status: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  const outputIds = graph.nodes.filter((n) => n.data.kind === "output").map((n) => n.id);
  const ids = outputIds.length ? outputIds : order.slice(-1);
  const result = ids.length === 1 ? ctx[ids[0]!] : Object.fromEntries(ids.map((id) => [id, ctx[id]]));
  return { result: result ?? null, outputs: ctx, logs, failed };
}
