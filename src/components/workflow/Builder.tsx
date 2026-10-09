import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useEdgesState, useNodesState,
  BackgroundVariant, type Edge, type Node, type OnConnect, type ReactFlowInstance,
} from "@xyflow/react";
import { WorkflowNode } from "./WorkflowNode";
import { NODE_META, type Connection, type NodeKind, type NodeConfig, type NodeStatus, type WFNodeData } from "@/lib/workflow/types";
import { runWorkflow, type LogEntry } from "@/lib/workflow/executor";
import { buildWorkflowScript, downloadWorkflowScript } from "@/lib/workflow/export";
import { toFlowGraph } from "@/lib/workflow/graph";
import type { FlowRunResult } from "@/workflows/run-flow";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_LIMIT_MS = 10 * 60 * 1000;

const STORE = "sb-flow-v1";
const nodeTypes = { wf: WorkflowNode };
let seq = 0;
const nid = (k: string) => `${k}_${Date.now().toString(36)}${seq++}`;

function mk<K extends NodeKind>(kind: K, x: number, y: number, id = nid(kind)): Node<WFNodeData> {
  const meta = NODE_META[kind];
  // kind and config come from the same NODE_META entry, so they always match.
  const data = { kind, label: meta.title, config: { ...meta.defaults } } as WFNodeData;
  return { id, type: "wf", position: { x, y }, data };
}

function seed() {
  const n = [
    mk("start", 0, 120, "start"), 
    mk("auth", 280, 120, "auth"), 
    mk("edge", 560, 40, "edge"), 
    mk("rpc", 560, 220, "rpc"), 
    mk("output", 860, 120, "output")
  ];
  const e: Edge[] = [
    { id: "e1", source: "start", target: "auth" },
    { id: "e2", source: "auth", target: "edge" },
    { id: "e3", source: "edge", target: "output" }

  ];
  return { n, e };
}

type FieldType = "text" | "area" | "select" | "password";
interface FieldSpec<K extends NodeKind> {
  /** Only keys that exist on this kind's config are accepted. */
  key: keyof NodeConfig<K> & string;
  label: string;
  type?: FieldType;
  options?: readonly string[];
}
/** Loose shape used when rendering whichever node is selected. */
type AnyFieldSpec = { key: string; label: string; type?: FieldType; options?: readonly string[] };

const FIELDS: { [K in NodeKind]: FieldSpec<K>[] } = {
  start: [{ key: "payload", label: "Payload (JSON)", type: "area" }],
  auth: [
    { key: "role", label: "Role", type: "select", options: ["anon", "authenticated", "service_role"] },
    { key: "email", label: "Email (authenticated)" },
    { key: "password", label: "Password (authenticated)", type: "password" },
    { key: "serviceKey", label: "Service role key (service_role)", type: "password" },
  ],
  edge: [
    { key: "name", label: "Function name" },
    { key: "method", label: "Method", type: "select", options: ["POST", "GET", "PUT", "PATCH", "DELETE"] },
    { key: "body", label: "Body (JSON)", type: "area" },
    { key: "headers", label: "Headers (JSON)", type: "area" },
  ],
  rpc: [{ key: "fn", label: "Function name" }, { key: "args", label: "Args (JSON)", type: "area" }],
  query: [
    { key: "table", label: "Table" },
    { key: "op", label: "Operation", type: "select", options: ["select", "insert", "update", "delete"] },
    { key: "columns", label: "Columns" },
    { key: "filters", label: "Filters (one per line: col op value)", type: "area" },
    { key: "values", label: "Values (JSON, insert/update)", type: "area" },
    { key: "limit", label: "Limit" },
  ],
  transform: [{ key: "code", label: "Function body", type: "area" }],
  output: [],
};

export default function Builder() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<WFNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [conn, setConn] = useState<Connection>({ url: "", anonKey: "" });
  const [selId, setSelId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [rf, setRf] = useState<ReactFlowInstance<Node<WFNodeData>, Edge> | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || "null");
      if (s?.nodes) { setNodes(s.nodes); setEdges(s.edges); setConn(s.conn ?? { url: "", anonKey: "" }); }
      else { const { n, e } = seed(); setNodes(n); setEdges(e); }
    } catch { const { n, e } = seed(); setNodes(n); setEdges(e); }
    setLoaded(true);
  }, [setNodes, setEdges]);

  useEffect(() => {
    if (!loaded) return;
    const clean = nodes.map((n) => ({ ...n, data: { ...n.data, status: undefined, result: undefined } }));
    localStorage.setItem(STORE, JSON.stringify({ nodes: clean, edges, conn }));
  }, [nodes, edges, conn, loaded]);

  const onConnect: OnConnect = useCallback((p) => setEdges((e) => addEdge({ ...p, animated: false }, e)), [setEdges]);
  const sel = useMemo(() => nodes.find((n) => n.id === selId), [nodes, selId]);

  const patch = (id: string, d: { label?: string; status?: NodeStatus; result?: unknown }) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...d } } : n)));

  const setConfigField = (id: string, key: string, value: string) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } as WFNodeData } : n)));

  const addNode = (kind: NodeKind, pos?: { x: number; y: number }) => {
    const p = pos ?? rf?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? { x: 0, y: 0 };
    const n = mk(kind, p.x, p.y);
    setNodes((ns) => [...ns, n]);
    setSelId(n.id);
  };

  const run = async () => {
    setRunning(true);
    setLogs([]);
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: "idle", result: undefined } })));
    setEdges((es) => es.map((e) => ({ ...e, animated: true })));
    try {
      await runWorkflow(nodes, edges, conn, (id, status, result) => patch(id, { status, result }), (l) => setLogs((x) => [...x, l]));
    } catch (e) {
      setLogs((x) => [...x, { nodeId: "-", label: "Workflow", status: "error", message: (e as Error).message }]);
    }
    setEdges((es) => es.map((e) => ({ ...e, animated: false })));
    setRunning(false);
  };

  // Run on the server as a Workflow SDK run: every node is a durable, retried step.
  const runDurable = async () => {
    setRunning(true);
    setLogs([]);
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: "idle", result: undefined } })));
    setEdges((es) => es.map((e) => ({ ...e, animated: true })));
    const fail = (message: string) => setLogs((x) => [...x, { nodeId: "-", label: "Durable run", status: "error", message }]);
    try {
      const res = await fetch("/api/flows/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ graph: toFlowGraph(nodes, edges), conn: { url: conn.url, anonKey: conn.anonKey } }),
      });
      const started = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !started.runId) throw new Error(started.error || res.statusText);
      setLogs([{ nodeId: "-", label: "Durable run", status: "running", message: `${started.runId} · inspect with npx workflow web` }]);

      const deadline = Date.now() + POLL_LIMIT_MS;
      while (Date.now() < deadline) {
        await sleep(1000);
        const poll = await fetch(`/api/flows/runs/${encodeURIComponent(started.runId)}`);
        const s = (await poll.json()) as { status?: string; result?: FlowRunResult; error?: string };
        if (s.status === "completed" && s.result) {
          const { logs: runLogs, outputs } = s.result;
          for (const l of runLogs) {
            if (l.status !== "skipped") patch(l.nodeId, { status: l.status, result: l.status === "error" ? { error: l.message } : outputs[l.nodeId] });
          }
          setLogs((x) => [
            ...x,
            ...runLogs.map((l) => ({ nodeId: l.nodeId, label: l.label, status: l.status === "skipped" ? ("idle" as const) : l.status, message: l.message, ...(l.ms !== undefined ? { ms: l.ms } : {}) })),
          ]);
          return;
        }
        if (s.status === "failed" || s.status === "cancelled" || !poll.ok) {
          fail(`Run ${s.status ?? poll.status}: ${s.error ?? "see npx workflow web"}`);
          return;
        }
      }
      fail("Still running after 10 minutes — check npx workflow web");
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setEdges((es) => es.map((e) => ({ ...e, animated: false })));
      setRunning(false);
    }
  };

  const exportScript = () => downloadWorkflowScript(buildWorkflowScript(nodes, edges, conn));

  const reset = () => { const { n, e } = seed(); setNodes(n); setEdges(e); setSelId(null); setLogs([]); };

  return (
    <div className="wf-shell">
      <header className="wf-top site-header">
        
        <div className="flex flex-row gap-1 flex-1 bg-transparent">

           {/* <img src="/icon.png" alt="KOMA" className="wf-logo w-6 h-6" /> */}
           <span className="koma-mark koma-mark--inline " aria-label="KOMA"><span aria-hidden="true">KO<i className="comma " aria-hidden="true"></i>MA</span></span>
           <h2 className="text-xl tracking-wide text-accent">flow</h2> 
           </div>
           <div className="flex flex-row gap-1">
           <input className="wf-input wf-conn" placeholder="Project URL" value={conn.url} onChange={(e) => setConn({ ...conn, url: e.target.value.trim() })} />
           <input className="wf-input wf-conn" type="password" placeholder="ANON_KEY / PUBLISHABLE_KEY" value={conn.anonKey} onChange={(e) => setConn({ ...conn, anonKey: e.target.value.trim() })} />
           <div className="flex-1" />
           <button className="wf-btn-ghost" onClick={reset}>Reset</button>
           <button className="wf-btn-ghost" onClick={exportScript} title="Download a standalone Node/Bun script (keys read from env)">⤓ Export</button>
           <button className="wf-btn-ghost" onClick={runDurable} disabled={running} title="Run on the server with Workflow SDK: each node is a durable, retried step">⟳ Durable run</button>
           <button className="wf-btn" onClick={run} disabled={running}>{running ? "Running…" : "▶ Run"}</button>
           </div>
         
      </header>

      <aside className="wf-palette">
        <div className="wf-section">Nodes</div>
        {(Object.keys(NODE_META) as NodeKind[]).map((k) => (
          <button key={k} className="wf-pal-item" data-kind={k} draggable
            onDragStart={(e) => e.dataTransfer.setData("application/wf", k)} onClick={() => addNode(k)}>
            <span className="wf-dot" />
            <span>{NODE_META[k].title}</span>
            <code>{NODE_META[k].sdk}</code>
          </button>
        ))}
        <p className="wf-help">Drag onto the canvas. Use <code>{"{{prev.field}}"}</code> or <code>{"{{nodeId.field}}"}</code> in any field.</p>
      </aside>

      <main className="wf-canvas" onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { const k = e.dataTransfer.getData("application/wf") as NodeKind; if (k && rf) addNode(k, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY })); }}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={onConnect} onInit={setRf} onNodeClick={(_, n) => setSelId(n.id)} onPaneClick={() => setSelId(null)}
          fitView colorMode="dark" deleteKeyCode={["Backspace", "Delete"]}>
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </main>

      <aside className="wf-inspector">
        {sel ? (
          <>
            <div className="wf-section">{NODE_META[sel.data.kind].title} <span className="wf-id">#{sel.id}</span></div>
            <p className="wf-help">{NODE_META[sel.data.kind].hint}</p>
            <label className="wf-label">Label</label>
            <input className="wf-input" value={sel.data.label} onChange={(e) => patch(sel.id, { label: e.target.value })} />
            {(FIELDS[sel.data.kind] as readonly AnyFieldSpec[]).map((f) => {
              const v = (sel.data.config as Record<string, string | undefined>)[f.key] ?? "";
              const set = (val: string) => setConfigField(sel.id, f.key, val);
              return (
                <div key={f.key}>
                  <label className="wf-label">{f.label}</label>
                  {f.type === "area" ? <textarea className="wf-input wf-area" value={v} onChange={(e) => set(e.target.value)} spellCheck={false} />
                    : f.type === "select" ? <select className="wf-input" value={v} onChange={(e) => set(e.target.value)}>{f.options!.map((o) => <option key={o}>{o}</option>)}</select>
                    : <input className="wf-input" type={f.type === "password" ? "password" : "text"} value={v} onChange={(e) => set(e.target.value)} />}
                </div>
              );
            })}
            {sel.data.kind === "auth" && sel.data.config.role === "service_role" && (
              <p className="wf-warn">Service role bypasses RLS. Key stays in this browser only — never use it on shared machines.</p>
            )}
            {sel.data.result !== undefined && (<><label className="wf-label">Last result</label><pre className="wf-pre">{JSON.stringify(sel.data.result, null, 2)}</pre></>)}
            <button className="wf-btn-danger" onClick={() => { setNodes((ns) => ns.filter((n) => n.id !== sel.id)); setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id)); setSelId(null); }}>Delete node</button>
          </>
        ) : (
          <div className="wf-help">Select a node to configure it.</div>
        )}
      </aside>

      <footer className="wf-log">
        <div className="wf-section">Run log</div>
        {logs.length === 0 && <div className="wf-help">No runs yet.</div>}
        {logs.map((l, i) => (
          <div key={i} className="wf-log-row" data-status={l.status} onClick={() => l.nodeId !== "-" && setSelId(l.nodeId)}>
            <span className="wf-dot" /><b>{l.label}</b>{l.ms !== undefined && <span className="wf-ms">{l.ms}ms</span>}<span className="wf-msg">{l.message}</span>
          </div>
        ))}
      </footer>
    </div>
  );
}
