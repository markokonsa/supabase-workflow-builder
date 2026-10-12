import { createFileRoute } from "@tanstack/react-router";
import { resumeHook } from "workflow/api";

// POST /api/flows/hooks/<token>  (any JSON or text body)  ->  { runId }
// Resumes a durable run waiting in a Hook node. The token (flow:<runId>:<nodeId>) is shown in the
// builder's run log when the durable run starts. Method, query and body become the node's output.
async function resume(request: Request, token: string) {
  const url = new URL(request.url);
  const raw = request.method === "GET" ? "" : await request.text();
  let body: unknown = raw;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    /* text body */
  }
  try {
    const hook = await resumeHook(token, { method: request.method, query: Object.fromEntries(url.searchParams), body });
    return Response.json({ runId: hook.runId }, { status: 202 });
  } catch {
    return Response.json({ error: "No run is waiting on this hook (finished, timed out, or wrong token)" }, { status: 404 });
  }
}

export const Route = createFileRoute("/api/flows/hooks/$token")({
  server: {
    handlers: {
      POST: ({ request, params }) => resume(request, params.token),
      GET: ({ request, params }) => resume(request, params.token),
    },
  },
});
