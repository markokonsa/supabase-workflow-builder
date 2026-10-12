# KOMA/flow

image.png

**A small visual workflow builder for the small jobs.**

Wire a few steps together on a canvas: call an API, check the answer, query Supabase, wait for someone to approve. Run it in the browser, or export it as **one `.mjs` file** you can run anywhere with Node or Bun.

<!-- Screenshot: add one of the canvas here, e.g. docs/canvas.png -->

---

## Why this exists

I kept wanting to automate small things: ping an endpoint and branch on the answer, reset some rows, run a Supabase function after an approval, glue two APIs together.

The workflow tools I tried could all do it, but each came as a whole platform: accounts and workspaces, OAuth connections for every service, AI agents and LLM nodes, hundreds of integrations, a hosted runtime, a pricing page. For a five-step job, setting up the tool was more work than the job.

KOMA/flow is the opposite trade-off:

- **A handful of node types**, each doing one plain thing (an HTTP call, a condition, a query). If you need something else, a Script node runs JavaScript.
- **No accounts, no connectors, no AI.** You give it a Supabase URL and key if a flow uses Supabase. Everything else is just HTTP.
- **Your flow is a file.** Export gives you a readable, runnable `.mjs` with the engine inside it. Put it in a repo, a cron job or CI, or compile it to a single binary. Open the same file in the builder to keep editing.
- **Nothing to host unless you want to.** The canvas runs flows in your browser; the exported file runs on any machine with Bun or Node. A server is only involved for durable runs.

It is not trying to compete with full automation platforms. If you need 300 integrations, scheduled cloud runs for a team, or an AI agent that writes the flow for you, use one of those. This is for when you need something simple that just does the job.

---

## Contents

- [What a flow looks like](#what-a-flow-looks-like)
- [Quick start](#quick-start)
- [Nodes](#nodes)
- [Data between nodes](#data-between-nodes)
- [Three ways to run a flow](#three-ways-to-run-a-flow)
- [Exported files](#exported-files)
- [Using it inside KOMA Home](#using-it-inside-koma-home)
- [Configuration](#configuration)
- [How it's built](#how-its-built)
- [Security notes](#security-notes)
- [Scripts](#scripts)

---

## What a flow looks like

An approval flow, the kind of thing it's made for:

```
Webhook ──▶ HTTP: GET /orders/{{prev.id}} ──▶ Hook: wait ≤ 1h ──triggered──▶ Condition ──approved──▶ DB: Function ship_order()
                                                  │                             └──else──────▶ HTTP: POST Slack "rejected"
                                                  └──timeout──▶ HTTP: POST Slack "approval expired"
```

Build it on the canvas, click **▶ Run** to try it, then **⤓ Export** to get `order-approval.mjs`:

```bash
SUPABASE_ANON_KEY=… bun order-approval.mjs '{"id": 42}'
# … Wait for approval: waiting for a request to http://127.0.0.1:53114/hook/wait (times out in 3600s)
```

```bash
curl -X POST http://127.0.0.1:53114/hook/wait -d '{"approved": true}'
```

---

## Quick start

**Requirements:** Node.js 22+ and pnpm.

```bash
pnpm install
pnpm dev                  # http://localhost:8080
```

1. Drag nodes from the palette onto the canvas and connect them.
2. Select a node to edit it in the side panel. Name the flow in the header.
3. Click **▶ Run**. Nodes turn green or red; the run log shows each node's output and timing.
4. Using Supabase nodes? Enter your project URL and anon key in the header first. Flows that only use HTTP, Condition, Hook and Script nodes need no keys.

The current canvas is kept in the browser's `localStorage`. **⤓ Export** saves it as a file, **Open…** loads a file back, and **Reset** restores the starter flow.

A `.env` is only needed for durable runs (see [Configuration](#configuration)).

---

## Nodes

| Node | What it does | Outputs |
| --- | --- | --- |
| **Webhook** | Entry point. Emits the run's input, or its saved `payload` (JSON) when there is none | 1 |
| **HTTP Request** | `fetch(url)` with method (GET, POST, PUT, PATCH, DELETE), headers and body. Output: `{ status, ok, headers, body }`; a JSON response body is parsed. A non-2xx response either fails the node or is passed on (`On a non-2xx response: fail / continue`) | 1 |
| **Condition** | One input, a list of rules. Each rule is its own output; **else** fires when no rule matched. Fire the *first* matching rule only, or *all* of them. Passes its input through unchanged | 1 per rule + else |
| **Hook** | Waits for a trigger or times out (`30s`, `5m`, `1h`, `2d`). The trigger's body becomes the output; on timeout the output is `{ timedOut: true, prev }` | triggered, timeout |
| **Script** | A JavaScript function body with `prev` and `ctx` in scope: `return { ...prev, at: Date.now() };` | 1 |
| **Role / Auth** | Switches the Supabase client for the nodes after it: `anon`, `authenticated` (email + password) or `service_role` | 1 |
| **Edge Function** | `supabase.functions.invoke(name, { method, body, headers })` | 1 |
| **DB: Function** | `supabase.rpc(fn, args)` | 1 |
| **DB: Query** | `select`, `insert`, `update` or `delete` on a table, with filters and a limit | 1 |
| **Result** | Marks the value the flow returns | none |

**Condition rules** compare two templated values: `{{prev.status}}` *equals* `200`. Operators: equals, not equals, `>`, `≥`, `<`, `≤`, contains, doesn't contain, matches regex, exists, is empty. Both sides are compared as numbers when both are numeric, otherwise as text.

**Hook triggers** depend on where the flow runs:

| Running in | How to trigger it |
| --- | --- |
| Browser (▶ Run) | A panel in the run log, with a JSON payload box, **Trigger** and **Time out now** |
| Exported file | Any request to `http://127.0.0.1:<port>/hook/<nodeId>`; the address is printed when the hook starts waiting. Set a fixed port on the node, or leave it empty for any free port |
| Durable run | `POST /api/flows/hooks/<token>`; the full trigger URL is shown in the run log when the run starts |

**DB: Query filters** go one per line, as `column operator value`, using any PostgREST operator:

```
status eq active
created_at gte {{prev.since}}
```

---

## Data between nodes

Nodes run in dependency order (a cycle is an error). Each node gets:

- `prev`: the output of the node feeding into it
- `ctx`: the outputs of every node that has run so far, by node id

Any text setting (URLs, JSON bodies, headers, filters, condition values) can use `{{…}}` tokens:

```json
{ "user_id": "{{prev.body.id}}", "source": "{{start.name}}" }
```

Objects are inserted as JSON; a missing path becomes `null`.

**Branches.** Only the nodes behind a Condition rule (or Hook output) that fired will run; the rest are marked *skipped*. The same happens downstream of a failed node, while independent branches keep going.

**The result** of a run is the value of the Result node(s) that ran. Without one, it's the output of the last node that ran.

---

## Three ways to run a flow

All three use the same engine (`src/lib/workflow/engine.mjs`), so a flow behaves the same everywhere.

| | Where it runs | Good for |
| --- | --- | --- |
| **▶ Run** | Your browser | Building and trying things. HTTP calls need the target to allow CORS |
| **⤓ Export** | Node or Bun, anywhere | Cron, CI, scripts, a single binary, [KOMA Home](#using-it-inside-koma-home) |
| **⟳ Durable run** | This app's server, via the [Workflow SDK](https://useworkflow.dev) | Long waits and unreliable APIs: every node is a step that is retried and persisted, and a run survives restarts |

### Durable runs

Each node becomes its own `"use step"` (`src/workflows/steps.ts`), giving you:

- **Retries on transient failures** (3 by default). Config errors and 4xx responses other than 408 and 429 fail straight away.
- **Persistence.** A run continues after a restart. Hook nodes wait durably: a one-hour approval doesn't hold a process open.
- **Visibility.** Every step appears by name in the Workflow dashboard: `npx workflow web`. In local dev, state is kept in `.workflow-data/`.

Without the UI:

```http
POST /api/flows/run
{ "graph": { "nodes": [...], "edges": [...] }, "input": { ... }, "conn": { "url": "...", "anonKey": "..." } }
→ 202 { "runId": "wrun_…" }

GET /api/flows/runs/:runId
→ { runId, status } while running, then { runId, status: "completed", result } or { runId, status: "failed" | "cancelled", error }

POST /api/flows/hooks/flow:<runId>:<nodeId>      (any JSON or text body)
→ 202 { runId }, or 404 if no run is waiting on that hook
```

A completed `result` is `{ result, outputs, logs, failed }`.

---

## Exported files

**⤓ Export** downloads `<flow-name>.mjs`: a self-contained ES module with the engine source and your flow inside it. Passwords and service keys are removed; the file reads them from environment variables. Its one dependency is `@supabase/supabase-js`: Bun installs it on the fly, with Node run `npm i @supabase/supabase-js` once next to the file.

```bash
bun ./my-flow.mjs '{"name":"Ada"}'                         # Bun installs the dependency on the fly
npm i @supabase/supabase-js && node ./my-flow.mjs --input-file input.json
echo '{"name":"Ada"}' | node ./my-flow.mjs -               # input on stdin
bun build --compile ./my-flow.mjs --outfile my-flow        # single executable
```

| Flag | Meaning |
| --- | --- |
| `<json>` | Input as the first argument |
| `--input-file <path>` | Read the input from a file |
| `-` | Read the input from stdin |
| `--json-log` | Per-node log on stderr as JSON lines |
| `-h`, `--help` | Usage |

Without input, the Webhook node's saved payload is used. The result goes to **stdout** as JSON, the per-node log to **stderr**, and the exit code is `1` if a node failed.

Environment: `SUPABASE_URL` (defaults to the URL set in the canvas), `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `WF_PASSWORD`.

### Reopening a file

The export is also the flow's save file. Next to the runnable code it holds three plain data blocks:

```js
const WORKFLOW = { nodes: [...], edges: [...] };   // what the script runs
const DEFAULT_URL = "https://….supabase.co";
const FLOW_META = { name: "…", layout: { … } };    // node positions, used only by the builder
```

**Open…** reads those blocks as JSON (the file is never executed) and puts the flow back on the canvas. Files exported before `FLOW_META` existed still open, laid out automatically. Keys aren't in the file, so enter them again in the header if the flow uses Supabase.

---

## Using it inside KOMA Home

**KOMA Home** is a small desktop app (Tauri) that keeps projects and one-click "doors": open the project in your editor, run a script, run a flow. It embeds this builder:

- Open the builder from a project, build a flow, and **Save to KOMA Home**. The flow becomes a card on that project, stored as its exported `.mjs`.
- Clicking the card runs the file with Bun or Node, with that project's Supabase keys, and shows the output live.
- Editing the card reopens the same file in the embedded builder.

The builder detects it is embedded (`?embed=koma`) and talks to the app over `postMessage` (`src/lib/workflow/bridge.ts`), only with KOMA Home's own origins.

---

## Configuration

Server-side variables live in `.env` (git-ignored); start from `.env.example`. Only the API routes and durable steps read them; they never reach the browser bundle.

| Variable | Needed for | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | durable runs | Project the durable steps run against |
| `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`) | durable runs | Anon / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | `service_role` Auth nodes | Service key. **Never prefix with `VITE_`.** |
| `WF_PASSWORD` | `authenticated` Auth nodes | Sign-in password |
| `WF_EMAIL` | optional | Default sign-in email for durable runs |

When `SUPABASE_URL` and an anon key are set on the server, they replace the connection entered in the canvas for durable runs, and secrets are only ever used against `SUPABASE_URL`.

---

## How it's built

```
                   ┌──────────────────────────────┐
                   │  src/lib/workflow/engine.mjs │
                   │  executeNode · runWorkflow   │
                   └──────────────┬───────────────┘
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
  Browser canvas            Workflow SDK steps        Exported .mjs
  (▶ Run)                   (⟳ Durable run)           (⤓ Export)
  hooks: Trigger button     hooks: createHook +       hooks: local HTTP
                            sleep, resumed by API     server on 127.0.0.1
```

- **One engine, three runtimes.** `engine.mjs` is plain JavaScript that reads no `process` or `window` globals. Each runtime passes in what differs, such as how to wait for a hook. The Supabase client is created only when a node needs one.
- **Embedding the engine.** `engine-source.plugin.ts` serves `engine.mjs` and `cli.mjs` as string modules, and the exporter concatenates them with the flow. (Vite's `?raw` isn't used because Vite 8's oxc transform tries to parse those ids as JS.)
- **Branches.** Condition and Hook nodes report which outputs fired. An edge only carries a value if it leaves from one of those outputs (`edgeActive` in `engine.mjs` and `graph.ts`).
- **Auth across durable steps.** Clients can't be persisted between steps, so each step rebuilds one from a secret-free auth state (`{ role, email }`).
- **Plugin order.** `workflow()` must be the first Vite plugin, and Nitro is needed in dev as well as build, which is why `vite.config.ts` uses plain TanStack Start config.

```
src/
├── components/workflow/
│   ├── Builder.tsx          # canvas, palette, inspector, run log, run/export/open
│   ├── WorkflowNode.tsx     # node renderer, incl. branch outputs
│   └── ConditionRules.tsx   # rule editor for Condition nodes
├── lib/workflow/
│   ├── engine.mjs           # the node engine (plain JS)
│   ├── engine.d.mts         # its types
│   ├── graph.ts             # serializable graph, secret stripping, ordering, branch helpers
│   ├── types.ts             # node kinds, configs, palette defaults
│   ├── export.ts            # builds the exported .mjs
│   ├── flowfile.ts          # reads an exported .mjs back into the canvas
│   ├── bridge.ts            # postMessage bridge to KOMA Home
│   └── cli.mjs              # command-line wrapper appended to exports
├── workflows/
│   ├── run-flow.ts          # "use workflow": a durable run, incl. hook waits
│   └── steps.ts             # one "use step" per node kind
└── routes/api/flows/
    ├── run.ts               # POST /api/flows/run
    ├── runs/$runId.ts       # GET  /api/flows/runs/:runId
    └── hooks/$token.ts      # POST /api/flows/hooks/:token
```

**Stack:** TanStack Start (React 19, SSR on Nitro), React Flow (`@xyflow/react`), Workflow SDK, Supabase JS, Tailwind CSS 4, shadcn/ui, Vitest.

---

## Security notes

- `password` and `serviceKey` are removed before a flow leaves the browser, for durable runs and exports alike (`SECRET_KEYS` in `graph.ts`). Servers and exported files read them from environment variables.
- **The canvas in `localStorage` is not stripped.** A key typed into a Role/Auth node stays in that browser. Prefer leaving those fields empty and using env vars.
- Script nodes run arbitrary JavaScript (`new Function`) with full access to their runtime, which for durable runs and exports is Node with server env vars. Only run flows you trust.
- `service_role` bypasses Row Level Security.
- Hook trigger URLs aren't authenticated: the exported file only listens on `127.0.0.1`, and a durable hook's token contains the run id. Check the payload in a Condition node if it matters who triggered it.

---

## Scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Dev server on port 8080 |
| `pnpm build` | Production build (Nitro output in `.output/`) |
| `pnpm preview` | Preview the production build |
| `pnpm test` / `pnpm test:watch` | Vitest |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |

The Nitro preset is picked automatically: `node-server` locally, the matching preset on Vercel, Netlify, Cloudflare and similar.

---

## License

[CHOOSE A LICENSE, e.g. MIT, and add a LICENSE file]
