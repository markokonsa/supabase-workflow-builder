import engineSource from "virtual:workflow-engine-source";
import cliSource from "virtual:workflow-cli-source";
import type { Connection } from "./types";
import { toFlowGraph, type FlowEdge, type FlowNode } from "./graph";

export function exportFileName(name = "workflow") {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow";
  return `${slug}.mjs`;
}

/**
 * Build a standalone ES module that runs the workflow from the command line.
 * The engine source is embedded verbatim; only @supabase/supabase-js is needed
 * at runtime (Bun installs it automatically, Node needs `npm i`).
 * Keys and passwords are stripped and read from env vars instead.
 */
export function buildWorkflowScript(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  conn: Pick<Connection, "url">,
): string {
  const workflow = toFlowGraph(nodes, edges);

  const header = `#!/usr/bin/env node
// Exported from sb/flow on ${new Date().toISOString()}
//
// Run:
//   bun ./${exportFileName()}                          # Bun installs @supabase/supabase-js on the fly
//   npm i @supabase/supabase-js && node ./${exportFileName()}
//   bun build --compile ./${exportFileName()} --outfile my-flow   # single executable
//
// Env:
//   SUPABASE_URL               (default: ${conn.url || "none — required"})
//   SUPABASE_ANON_KEY          required
//   SUPABASE_SERVICE_ROLE_KEY  needed if a Role/Auth node uses service_role
//   WF_PASSWORD                needed if a Role/Auth node signs in as "authenticated"
//
// Input: first argument as JSON, --input-file <path>, or "-" to read JSON from stdin.
//   Without input the Start node's saved payload is used.
// Output: final result as JSON on stdout, per-node log on stderr, exit 1 on any failure.
`;

  const data =
    "\n// ---------------------------------------------------------------------------\n" +
    "// Exported workflow\n" +
    "// ---------------------------------------------------------------------------\n" +
    `const WORKFLOW = ${JSON.stringify(workflow, null, 2)};\n` +
    `const DEFAULT_URL = ${JSON.stringify(conn.url || "")};\n\n`;

  return header + "\n" + engineSource.trimEnd() + "\n" + data + cliSource;
}

/** Trigger a browser download of the generated script. */
export function downloadWorkflowScript(source: string, fileName = exportFileName()) {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
