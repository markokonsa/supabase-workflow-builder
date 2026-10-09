// CLI wrapper appended to exported scripts — never imported by the app.
// export.ts concatenates: header + engine.mjs + `const WORKFLOW = …; const DEFAULT_URL = …;` + this file.
// Kept as a real file (served as a string by engine-source.plugin.ts) instead of a
// template literal, so Vite doesn't try to analyze the code inside it.
/* global WORKFLOW, DEFAULT_URL, runWorkflow */
import { readFile } from "node:fs/promises";

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
      else console.error(`${l.status === "error" ? "✗" : "✓"} ${l.label} (${l.ms ?? 0}ms) ${l.message}`);
    },
    { input },
  );
  const outputs = WORKFLOW.nodes.filter((n) => n.data.kind === "output").map((n) => n.id);
  const ids = outputs.length ? outputs : WORKFLOW.nodes.map((n) => n.id).slice(-1);
  const result = ids.length === 1 ? ctx[ids[0]] : Object.fromEntries(ids.map((id) => [id, ctx[id]]));
  console.log(JSON.stringify(result ?? null, null, 2));
  process.exitCode = failed ? 1 : 0; // exitCode (not exit) so piped stdout is flushed
}

main().catch((e) => {
  console.error("✗ " + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
