import { createFileRoute } from "@tanstack/react-router";
import { start } from "workflow/api";
import { toFlowGraph, type FlowGraph } from "../../../lib/workflow/graph";
import { runFlow } from "../../../workflows/run-flow";

interface RunRequest {
  graph?: FlowGraph;
  input?: unknown;
  conn?: { url?: string; anonKey?: string };
}

// POST /api/flows/run  { graph, input?, conn?: { url, anonKey } }  ->  { runId }
// Starts a durable run and returns immediately. Secrets are stripped again here in
// case a client sent them; the steps read SUPABASE_SERVICE_ROLE_KEY / WF_PASSWORD from env.
export const Route = createFileRoute("/api/flows/run")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: RunRequest;
        try {
          body = (await request.json()) as RunRequest;
        } catch {
          return Response.json({ error: "Body must be JSON" }, { status: 400 });
        }
        if (!body.graph?.nodes?.length) {
          return Response.json({ error: "graph.nodes is required" }, { status: 400 });
        }
        const graph = toFlowGraph(body.graph.nodes, body.graph.edges ?? []);
        const conn = { url: body.conn?.url, anonKey: body.conn?.anonKey };
        const run = await start(runFlow, [graph, body.input, conn]);
        return Response.json({ runId: run.runId }, { status: 202 });
      },
    },
  },
});
