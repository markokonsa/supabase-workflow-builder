// CLI wrapper appended to exported scripts — never imported by the app.
// export.ts concatenates: header + engine.mjs + `const WORKFLOW = …; const DEFAULT_URL = …;` + this file.
// Kept as a real file (served as a string by engine-source.plugin.ts) instead of a
// template literal, so Vite doesn't try to analyze the code inside it.
/* global WORKFLOW, DEFAULT_URL, runWorkflow */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

/**
 * Hook nodes: listen on 127.0.0.1 and wait for one request to /hook/<nodeId> (any method).
 * The request's method, query, headers and JSON (or text) body become the node's output.
 */
function waitForHookHttp({ nodeId, label, timeoutMs, port }) {
  return new Promise((resolve, reject) => {
    const path = `/hook/${encodeURIComponent(nodeId)}`;
    let timer;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== path) {
        res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* text body */
      }
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}\n');
      clearTimeout(timer);
      server.close();
      resolve({ payload: { method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body } });
    });
    server.on("error", reject);
    server.listen(Number(port) || 0, "127.0.0.1", () => {
      const { port: p } = server.address();
      console.error(`… ${label}: waiting for a request to http://127.0.0.1:${p}${path} (times out in ${Math.round(timeoutMs / 1000)}s)`);
      timer = setTimeout(() => {
        server.close();
        resolve({ timedOut: true });
      }, timeoutMs);
    });
  });
}

async function readInput(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: workflow [json-input | - ] [--input-file path] [--json-log]\nSee the header of this file for env vars.");
    process.exit(0);
  }
  const fileIdx = argv.indexOf("--input-file");
  let raw;
  if (fileIdx !== -1) {
    raw = await readFile(argv[fileIdx + 1], "utf8");
  } else {
    raw = argv.find((a) => a === "-" || !a.startsWith("-"));
    if (raw === "-") {
      let s = "";
      for await (const chunk of process.stdin) s += chunk;
      raw = s.trim() || undefined;
    }
  }
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Input is not valid JSON");
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonLog = argv.includes("--json-log");
  const input = await readInput(argv);
  const env = process.env;
  const conn = {
    url: env.SUPABASE_URL || DEFAULT_URL,
    anonKey: env.SUPABASE_ANON_KEY || "",
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    password: env.WF_PASSWORD,
  };
  let failed = false;
  const ctx = await runWorkflow(
    WORKFLOW.nodes,
    WORKFLOW.edges,
    conn,
    () => {},
    (l) => {
      if (l.status === "error") failed = true;
      if (jsonLog) console.error(JSON.stringify(l));
      else if (l.status === "idle") console.error(`… ${l.label} ${l.message}`);
      else console.error(`${l.status === "error" ? "✗" : "✓"} ${l.label} (${l.ms ?? 0}ms) ${l.message}`);
    },
    { input, waitForHook: waitForHookHttp },
  );
  // Result nodes that ran (others sat on branches not taken); without any, the last node that ran.
  const ran = (ids) => ids.filter((id) => ctx[id] !== undefined);
  const outputs = ran(WORKFLOW.nodes.filter((n) => n.data.kind === "output").map((n) => n.id));
  const ids = outputs.length ? outputs : ran(topo(WORKFLOW.nodes, WORKFLOW.edges)).slice(-1);
  const result = ids.length === 1 ? ctx[ids[0]] : Object.fromEntries(ids.map((id) => [id, ctx[id]]));
  console.log(JSON.stringify(result ?? null, null, 2));
  process.exitCode = failed ? 1 : 0; // exitCode (not exit) so piped stdout is flushed
}

main().catch((e) => {
  console.error("✗ " + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
