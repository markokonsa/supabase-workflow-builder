import { createFileRoute } from "@tanstack/react-router";
import { getRun } from "workflow/api";

const DONE = new Set(["completed", "failed", "cancelled"]);

// GET /api/flows/runs/:runId  ->  { runId, status, result? , error? }
export const Route = createFileRoute("/api/flows/runs/$runId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const run = getRun(params.runId);
        if (!(await run.exists)) {
          return Response.json({ error: "Run not found" }, { status: 404 });
        }
        const status = String(await run.status);
        if (status === "completed") {
          return Response.json({ runId: params.runId, status, result: await run.returnValue });
        }
        if (DONE.has(status)) {
          let error: string | undefined;
          try {
            await run.returnValue;
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
          }
          return Response.json({ runId: params.runId, status, error });
        }
        return Response.json({ runId: params.runId, status });
      },
    },
  },
});
