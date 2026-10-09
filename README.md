# KOMA/flow

A visual workflow builder for Supabase. Drag nodes onto a canvas, wire them together, and run the chain against your Supabase project: auth as a role, call Edge Functions, run RPCs and table queries, and transform data with small JavaScript snippets in between.

You can run each workflow in three ways, and all three use the same node engine:

| Mode | Where it runs | Good for |
| --- | --- | --- |
| **▶ Run** | In the browser | Fast iteration while building |
| **⟳ Durable run** | On the server, via the [Workflow SDK](https://useworkflow.dev) | Retried, observable runs; each node is its own durable step |
| **⤓ Export** | As a standalone `.mjs` script under Node or Bun | Cron jobs, CI, scripts, or a single compiled binary |

---

## Contents

- [Quick start](#quick-start)
- [Node types](#node-types)
- [Templating and data flow](#templating-and-data-flow)
- [Durable runs](#durable-runs)
- [Exporting a workflow](#exporting-a-workflow)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [Architecture](#architecture)
- [Scripts](#scripts)
- [Security notes](#security-notes)

---

## Quick start

**Requirements:** Node.js 22+ and pnpm.

```bash
pnpm install
cp .env.example .env      # optional; only needed for durable runs (see Configuration)
pnpm dev                  # http://localhost:8080
```

1. Open the app and enter your Supabase **project URL** and **anon key** in the header.
2. Drag nodes from the palette onto the canvas and connect them.
3. Select a node to edit its settings in the side panel.
4. Click **▶ Run**. Each node turns green or red, and the run log shows its output and timing.

The canvas (nodes, edges and connection settings) is saved to `localStorage`, so it's still there after a reload. **Reset** restores the starter workflow.

---

## Node types

| Node | Kind id | Supabase call | Settings |
| --- | --- | --- | --- |
| **Webhook** | `start` | none (entrypoint) | `payload`: JSON emitted when no input is passed in |
| **Role / Auth** | `auth` | `supabase.auth` | `role` (`anon` · `authenticated` · `service_role`), `email`, `password`, `serviceKey` |
| **Edge Function** | `edge` | `supabase.functions.invoke(name, …)` | `name`, `method`, `body` (JSON), `headers` (JSON) |
| **DB: Function** | `rpc` | `supabase.rpc(fn, args)` | `schema`, `fn`, `args` (JSON) |
| **DB: Query** | `query` | `supabase.from(table)` | `schema`, `table`, `op` (`select` · `insert` · `update` · `delete`), `columns`, `filters`, `values`, `limit` |
| **Script** | `transform` | none (runs JavaScript) | `code`: a function body with `prev` and `ctx` in scope |
| **Result** | `output` | none | Collects the final value |

**Role / Auth** changes which client the nodes after it use. `authenticated` signs in with email and password. `service_role` uses the service key and bypasses RLS.

**DB: Query filters** go one per line, in the form `column operator value`, using any PostgREST operator:

```
status eq active
created_at gte {{prev.since}}
```

---

## Templating and data flow

Nodes run in topological order, and a cycle is an error. Each node receives:

- `prev`: the output of its first incoming node
- `ctx`: the outputs of every node that has finished, keyed by node id

String settings (function names, JSON bodies, filters, table names) support `{{…}}` tokens:

```json
{ "user_id": "{{prev.id}}", "source": "{{node-1.name}}" }
```

Objects are inserted as JSON, and a missing path becomes `null`. When a node fails, the nodes downstream of it are skipped, but independent branches keep running.

The Script node takes a plain function body:

```js
return { ...prev, at: Date.now() };
```

---

## Durable runs

**⟳ Durable run** sends the graph to the server, which runs it as a [Workflow SDK](https://useworkflow.dev) workflow (`src/workflows/run-flow.ts`). Each node kind maps to its own `"use step"` function (`src/workflows/steps.ts`), so you get:

- **Retries on transient failures.** The default is 3. Config errors and 4xx responses (other than 408 and 429) fail immediately instead of retrying.
- **Durability.** Steps are persisted, and a run picks up again after a restart.
- **Observability.** Each step shows up by name in the Workflow dashboard:

  ```bash
  npx workflow web
  ```

In local dev, run state is stored in `.workflow-data/`.

### HTTP API

You can also start durable runs without the UI:

```http
POST /api/flows/run
Content-Type: application/json

{ "graph": { "nodes": [...], "edges": [...] }, "input": { ... }, "conn": { "url": "...", "anonKey": "..." } }
```

→ `202 { "runId": "wrun_…" }`

```http
GET /api/flows/runs/:runId
```

→ `{ runId, status }` while the run is in progress, then `{ runId, status: "completed", result }` or `{ runId, status: "failed" | "cancelled", error }`.

A completed `result` has the shape `{ result, outputs, logs, failed }`. `result` holds the value of the Result node(s), and falls back to the last node if there is no Result node.

---

## Exporting a workflow

**⤓ Export** downloads a self-contained ES module. It embeds the engine source verbatim, plus your graph with all secrets removed. The only runtime dependency is `@supabase/supabase-js`.

```bash
# Bun installs the dependency on the fly
SUPABASE_ANON_KEY=... bun ./my-flow.mjs '{"name":"Ada"}'

# Node
npm i @supabase/supabase-js
SUPABASE_ANON_KEY=... node ./my-flow.mjs --input-file input.json

# Pipe input on stdin
echo '{"name":"Ada"}' | node ./my-flow.mjs -

# Compile to a single executable
bun build --compile ./my-flow.mjs --outfile my-flow
```

| Flag | Meaning |
| --- | --- |
| `<json>` | Input as the first argument |
| `--input-file <path>` | Read the input from a file |
| `-` | Read the input from stdin |
| `--json-log` | Write per-node logs to stderr as JSON lines |
| `-h`, `--help` | Show usage |

Without input, the Webhook node's saved payload is used. The final result goes to **stdout** as JSON and the per-node log goes to **stderr**. The exit code is `1` if any node failed.

The export reads its connection from environment variables: `SUPABASE_URL` (defaults to the URL set in the canvas), `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `WF_PASSWORD`.

---

## Configuration

Server-side variables live in `.env`, which is git-ignored. Start from `.env.example`. Only the API routes and durable steps read them, and they are never sent to the browser bundle.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | for durable runs | Project the durable steps run against |
| `SUPABASE_ANON_KEY` *(or `SUPABASE_PUBLISHABLE_KEY`)* | for durable runs | Anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` *(or `SUPABASE_SECRET_KEY`)* | if a Role/Auth node uses `service_role` | Service key. **Never prefix with `VITE_`.** |
| `WF_PASSWORD` | if a Role/Auth node uses `authenticated` | Sign-in password |
| `WF_EMAIL` | optional | Default sign-in email for durable runs |

If both `SUPABASE_URL` and an anon key are set on the server, they override the connection entered in the canvas for durable runs. Secret values are only ever used against `SUPABASE_URL`.

---

## Project structure

```
src/
├── components/
│   ├── workflow/
│   │   ├── Builder.tsx        # Canvas, palette, inspector, run log, run/export actions
│   │   └── WorkflowNode.tsx   # Node renderer
│   └── ui/                    # shadcn/ui components
├── lib/workflow/
│   ├── engine.mjs             # Shared node engine (plain JS, Supabase-only dependency)
│   ├── engine.d.mts           # Types for the engine
│   ├── executor.ts            # App-facing re-export of the engine
│   ├── graph.ts               # Serializable graph, secret stripping, topological sort
│   ├── types.ts               # Node kinds, per-node configs, NODE_META (palette defaults)
│   ├── export.ts              # Builds and downloads the standalone script
│   └── cli.mjs                # CLI wrapper appended to exported scripts
├── workflows/
│   ├── run-flow.ts            # "use workflow": orchestrates a durable run
│   └── steps.ts               # "use step" function per node kind
├── routes/
│   ├── index.tsx              # Builder page
│   ├── __root.tsx             # App shell
│   └── api/flows/
│       ├── run.ts             # POST /api/flows/run
│       └── runs/$runId.ts     # GET  /api/flows/runs/:runId
├── server.ts                  # SSR entry with error wrapper
└── test/                      # Vitest + Testing Library
engine-source.plugin.ts        # Vite plugin: serves engine.mjs / cli.mjs as string modules
vite.config.ts                 # TanStack Start + Workflow SDK + Tailwind
```

---

## Architecture

```
                   ┌──────────────────────────────┐
                   │  lib/workflow/engine.mjs     │
                   │  executeNode · runWorkflow   │
                   └──────────────┬───────────────┘
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
  Browser canvas            Workflow SDK steps        Exported CLI script
  (▶ Run)                   (⟳ Durable run)            (⤓ Export)
  runWorkflow()             one "use step" per kind   engine source embedded
                            via executeNode()         via virtual module
```

- **One engine, three runtimes.** `engine.mjs` is plain JavaScript on purpose. It reads no `process` or `window` globals and depends only on `@supabase/supabase-js`, so the browser, the server steps and the exported script all execute nodes the same way.
- **Embedding.** `engine-source.plugin.ts` exposes `virtual:workflow-engine-source` and `virtual:workflow-cli-source` as string modules. The exporter concatenates them into the downloaded file. Vite's `?raw` imports aren't used because Vite 8's oxc transform tries to process them as JS.
- **Auth across steps.** Supabase clients can't be persisted between durable steps, so each step rebuilds a client from a persisted, secret-free auth state (`{ role, email }`).
- **Plugin order.** `workflow()` has to be the first Vite plugin, and Nitro is needed in dev as well as in build. That is why `vite.config.ts` uses plain TanStack Start config instead of the Lovable wrapper.

**Stack:** TanStack Start (React 19, file-based routing, SSR on Nitro), React Flow (`@xyflow/react`), Workflow SDK, Supabase JS, Tailwind CSS 4, shadcn/ui, Vitest.

---

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the dev server on port 8080 |
| `pnpm build` | Production build (Nitro output in `.output/`) |
| `pnpm build:dev` | Build in development mode |
| `pnpm preview` | Preview the production build |
| `pnpm test` / `pnpm test:watch` | Run Vitest |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier |

The Nitro preset is auto-detected: `node-server` locally, and the matching preset on Vercel, Netlify, Cloudflare and similar hosts.

---

## Security notes

- `password` and `serviceKey` are removed from the graph before it leaves the browser, for both durable runs and exports (`SECRET_KEYS` in `graph.ts`). Servers and exported scripts read them from environment variables instead.
- **The canvas state in `localStorage` is not stripped.** If you type a service key or password into a Role/Auth node, it is stored in the browser. Prefer leaving those fields empty and supplying them via env.
- The Script node runs arbitrary JavaScript (`new Function`) with full access to its runtime. In durable runs and exports, that runtime is Node with server-side env vars. Only run workflows you trust.
- `service_role` bypasses Row Level Security.
