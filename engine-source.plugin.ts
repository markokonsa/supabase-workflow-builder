// Serves files from src/lib/workflow as plain-string modules so the Export feature
// can embed them into the generated script:
//   virtual:workflow-engine-source -> engine.mjs
//   virtual:workflow-cli-source    -> cli.mjs
// We don't use `?raw`: Vite 8's oxc transform tries to process those ids as JS and
// fails ("Failed to load tsconfig").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const SOURCES: Record<string, string> = {
  "virtual:workflow-engine-source": "./src/lib/workflow/engine.mjs",
  "virtual:workflow-cli-source": "./src/lib/workflow/cli.mjs",
};
const PREFIX = "\0";

export function workflowEngineSource(): Plugin {
  return {
    name: "workflow-engine-source",
    enforce: "pre",
    resolveId(id) {
      return id in SOURCES ? PREFIX + id : undefined;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return undefined;
      const rel = SOURCES[id.slice(PREFIX.length)];
      if (!rel) return undefined;
      const file = fileURLToPath(new URL(rel, import.meta.url));
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
    },
  };
}
