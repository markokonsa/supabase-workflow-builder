// Plain TanStack Start + Nitro config (replaces @lovable.dev/vite-tanstack-config).
// Workflow SDK needs Nitro in dev as well as in build, and its plugin must run first;
// the Lovable wrapper only adds Nitro on build and appends user plugins last.
import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { workflow } from "workflow/vite";

import { workflowEngineSource } from "./engine-source.plugin";

export default defineConfig(({ mode }) => {
  // Load .env, .env.local, .env.[mode], .env.[mode].local into process.env for server code
  // (API routes, workflow steps). Variables already set in the shell/host win.
  // Only VITE_* variables are ever exposed to the browser bundle.
  for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) {
    process.env[key] ??= value;
  }

  return {
    server: { port: 8080 },
    resolve: {
      dedupe: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@tanstack/react-query",
      ],
    },
    plugins: [
      workflow(), // must be first: transforms "use workflow" / "use step" before other plugins
      workflowEngineSource(),
      tailwindcss(),
      tsConfigPaths({ projects: ["./tsconfig.json"] }),
      tanstackStart({
        // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
        server: { entry: "server" },
      }),
      // Zero-config preset: node-server locally, auto-detected on Vercel/Netlify/etc.
      viteReact(),
    ],
  };
});
