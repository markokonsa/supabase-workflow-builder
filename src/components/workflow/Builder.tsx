import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useEdgesState,
  useNodesState,
  BackgroundVariant,
  type Edge,
  type Node,
  type OnConnect,
  type ReactFlowInstance,
} from "@xyflow/react";
import { WorkflowNode } from "./WorkflowNode";
import { ConditionRules } from "./ConditionRules";
import {
  NODE_META,
  type Connection,
  type NodeKind,
  type NodeConfig,
  type NodeStatus,
  type WFNodeData,
} from "@/lib/workflow/types";
import { runWorkflow, type LogEntry } from "@/lib/workflow/executor";
import type { HookWaitRequest, HookWaitResult } from "@/lib/workflow/engine.mjs";
import { buildWorkflowScript, downloadWorkflowScript, exportFileName } from "@/lib/workflow/export";
import { parseFlowFile, pickFlowFile, type OpenedFlow } from "@/lib/workflow/flowfile";
import { isEmbeddedInKomaHome, onHostMessage, postToHost } from "@/lib/workflow/bridge";
import { hookToken, toFlowGraph } from "@/lib/workflow/graph";
import type { FlowRunResult } from "@/workflows/run-flow";
import { Button } from "../ui/button";

function CollapseButton({
  open,
  side,
  label,
  onClick,
}: {
  open: boolean;
  side: "left" | "right";
  label: string;
  onClick: () => void;
}) {
  const glyph = side === "left" ? (open ? "‹" : "›") : open ? "›" : "‹";
  return (
    <button
      type="button"
      className="wf-collapse"
      aria-expanded={open}
      aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
      title={open ? `Collapse ${label}` : `Expand ${label}`}
      onClick={onClick}
    >
      {glyph}
    </button>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_LIMIT_MS = 10 * 60 * 1000;

const STORE = "koma-flow-v1";
const nodeTypes = { wf: WorkflowNode };
let seq = 0;
const nid = (k: string) => `${k}_${Date.now().toString(36)}${seq++}`;

/** Columns follow the longest path from a start. Each step sits on the row of the node that feeds it. */
function arrange(nodes: Node<WFNodeData>[], edges: Edge[]): Node<WFNodeData>[] {
  const ids = nodes.map((n) => n.id);
  const incoming = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of edges) incoming.get(e.target)?.push(e.source);
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = incoming.get(id) ?? [];
    const next = parents.length === 0 ? 0 : Math.max(...parents.map(visit)) + 1;
    visiting.delete(id);
    rank.set(id, next);
    return next;
  };
  for (const id of ids) visit(id);

  const yOf = new Map(nodes.map((n) => [n.id, n.position.y]));
  const columns = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    const col = columns.get(r) ?? [];
    col.push(id);
    columns.set(r, col);
  }

  const placedY = new Map<string, number>();
  const gap = 180;
  for (const r of [...columns.keys()].sort((a, b) => a - b)) {
    const items = (columns.get(r) ?? []).map((id) => {
      const parents = (incoming.get(id) ?? []).filter((p) => placedY.has(p));
      const desired = parents.length
        ? parents.reduce((sum, p) => sum + (placedY.get(p) ?? 0), 0) / parents.length
        : (yOf.get(id) ?? 0);
      return { id, desired, linked: parents.length > 0 };
    });
    items.sort((a, b) => a.desired - b.desired || a.id.localeCompare(b.id));
    const raw = items.map((_, i) => i * gap);
    const center = raw.length ? (raw[0] + raw[raw.length - 1]) / 2 : 0;
    const target = items.reduce((sum, it) => sum + it.desired, 0) / (items.length || 1);
    const shift = items.some((it) => it.linked) ? target - center : -center;
    items.forEach((it, i) => placedY.set(it.id, raw[i] + shift));
  }

  return nodes.map((n) => ({
    ...n,
    position: { x: (rank.get(n.id) ?? 0) * 300, y: placedY.get(n.id) ?? n.position.y },
  }));
}

type CanvasMenu = { x: number; y: number; nodeId: string | null };

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
    mk("output", 860, 120, "output"),
  ];
  const e: Edge[] = [
    { id: "e1", source: "start", target: "auth" },
    { id: "e2", source: "auth", target: "edge" },
    { id: "e3", source: "edge", target: "output" },
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
  start: [
    {
      key: "method",
      label: "Method",
      type: "select",
      options: ["POST", "GET", "PUT", "PATCH", "DELETE"],
    },
    { key: "body", label: "Body (JSON)", type: "area" },
    { key: "headers", label: "Headers (JSON)", type: "area" },
  ],
  auth: [
    {
      key: "role",
      label: "Role",
      type: "select",
      options: ["anon", "authenticated", "service_role"],
    },
    { key: "email", label: "Email (authenticated)" },
    { key: "password", label: "Password (authenticated)", type: "password" },
    { key: "serviceKey", label: "Service role key (service_role)", type: "password" },
  ],
  edge: [
    { key: "name", label: "Function name" },
    {
      key: "method",
      label: "Method",
      type: "select",
      options: ["POST", "GET", "PUT", "PATCH", "DELETE"],
    },
    { key: "body", label: "Body (JSON)", type: "area" },
    { key: "headers", label: "Headers (JSON)", type: "area" },
  ],
  rpc: [
    { key: "fn", label: "Function name" },
    { key: "args", label: "Args (JSON)", type: "area" },
  ],
  query: [
    { key: "table", label: "Table" },
    {
      key: "op",
      label: "Operation",
      type: "select",
      options: ["select", "insert", "update", "delete"],
    },
    { key: "columns", label: "Columns" },
    { key: "filters", label: "Filters (one per line: col op value)", type: "area" },
    { key: "values", label: "Values (JSON, insert/update)", type: "area" },
    { key: "limit", label: "Limit" },
  ],
  transform: [{ key: "code", label: "Function body", type: "area" }],
  condition: [
    {
      key: "mode",
      label: "Fire (first = first matching branch only, all = every match)",
      type: "select",
      options: ["first", "all"],
    },
  ],
  http: [
    {
      key: "method",
      label: "Method",
      type: "select",
      options: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    },
    { key: "url", label: "URL" },
    { key: "headers", label: "Headers (JSON)", type: "area" },
    { key: "body", label: "Body (JSON or text; not sent with GET)", type: "area" },
    {
      key: "onError",
      label: "On a non-2xx response",
      type: "select",
      options: ["fail", "continue"],
    },
  ],
  hook: [
    { key: "timeout", label: "Timeout (30s, 5m, 1h, 2d)" },
    { key: "port", label: "Port in the exported script (empty = any free port)" },
  ],
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
  const [name, setName] = useState("workflow");
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [menu, setMenu] = useState<CanvasMenu | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const embedded = useMemo(() => isEmbeddedInKomaHome(), []);

  // Hook nodes in canvas runs: wait for the Trigger button (with a payload) or the timeout.
  const [hookWait, setHookWait] = useState<{
    nodeId: string;
    label: string;
    deadline: number;
  } | null>(null);
  const [hookPayload, setHookPayload] = useState("{}");
  const [now, setNow] = useState(() => Date.now());
  const hookFinish = useRef<((r: HookWaitResult) => void) | null>(null);
  useEffect(() => {
    if (!hookWait) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hookWait]);
  const waitForHook = useCallback(
    ({ nodeId, label, timeoutMs }: HookWaitRequest) =>
      new Promise<HookWaitResult>((resolve) => {
        const finish = (r: HookWaitResult) => {
          clearTimeout(timer);
          hookFinish.current = null;
          setHookWait(null);
          resolve(r);
        };
        const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
        hookFinish.current = finish;
        setNow(Date.now());
        setHookWait({ nodeId, label, deadline: Date.now() + timeoutMs });
      }),
    [],
  );
  const triggerHook = () => {
    let payload: unknown = hookPayload;
    try {
      payload = hookPayload.trim() ? JSON.parse(hookPayload) : null;
    } catch {
      /* send as text */
    }
    hookFinish.current?.({ payload: { method: "MANUAL", query: {}, body: payload } });
  };

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem(STORE) || "null");
      if (s?.nodes) {
        setNodes(s.nodes);
        setEdges(s.edges);
        setConn(s.conn ?? { url: "", anonKey: "" });
        if (typeof s.name === "string") setName(s.name);
      } else {
        const { n, e } = seed();
        setNodes(n);
        setEdges(e);
      }
    } catch {
      const { n, e } = seed();
      setNodes(n);
      setEdges(e);
    }
    setLoaded(true);
  }, [setNodes, setEdges]);

  useEffect(() => {
    if (!loaded) return;
    const clean = nodes.map((n) => ({
      ...n,
      data: { ...n.data, status: undefined, result: undefined },
    }));
    localStorage.setItem(STORE, JSON.stringify({ nodes: clean, edges, conn, name }));
  }, [nodes, edges, conn, name, loaded]);

  const onConnect: OnConnect = useCallback(
    (p) => setEdges((e) => addEdge({ ...p, animated: false }, e)),
    [setEdges],
  );
  const sel = useMemo(() => nodes.find((n) => n.id === selId), [nodes, selId]);

  const patch = (id: string, d: { label?: string; status?: NodeStatus; result?: unknown }) =>
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...d } } : n)));

  const setConfigField = (id: string, key: string, value: string) =>
    setNodes((ns) =>
      ns.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, config: { ...n.data.config, [key]: value } } as WFNodeData }
          : n,
      ),
    );

  const addNode = (kind: NodeKind, pos?: { x: number; y: number }) => {
    const p = pos ??
      rf?.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }) ?? {
        x: 0,
        y: 0,
      };
    const n = mk(kind, p.x, p.y);
    setNodes((ns) => [...ns, n]);
    setSelId(n.id);
  };

  const run = async () => {
    setRunning(true);
    setLogs([]);
    setNodes((ns) =>
      ns.map((n) => ({ ...n, data: { ...n.data, status: "idle", result: undefined } })),
    );
    setEdges((es) => es.map((e) => ({ ...e, animated: true })));
    try {
      await runWorkflow(
        nodes,
        edges,
        conn,
        (id, status, result) => patch(id, { status, result }),
        (l) => setLogs((x) => [...x, l]),
        { waitForHook },
      );
    } catch (e) {
      setLogs((x) => [
        ...x,
        { nodeId: "-", label: "Workflow", status: "error", message: (e as Error).message },
      ]);
    }
    setEdges((es) => es.map((e) => ({ ...e, animated: false })));
    setRunning(false);
  };

  // Run on the server as a Workflow SDK run: every node is a durable, retried step.
  const runDurable = async () => {
    setRunning(true);
    setLogs([]);
    setNodes((ns) =>
      ns.map((n) => ({ ...n, data: { ...n.data, status: "idle", result: undefined } })),
    );
    setEdges((es) => es.map((e) => ({ ...e, animated: true })));
    const fail = (message: string) =>
      setLogs((x) => [...x, { nodeId: "-", label: "Durable run", status: "error", message }]);
    try {
      const res = await fetch("/api/flows/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          graph: toFlowGraph(nodes, edges),
          conn: { url: conn.url, anonKey: conn.anonKey },
        }),
      });
      const started = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !started.runId) throw new Error(started.error || res.statusText);
      // Hook nodes in a durable run are resumed by calling their trigger URL.
      const hookLogs: LogEntry[] = nodes
        .filter((n) => n.data.kind === "hook")
        .map((n) => ({
          nodeId: n.id,
          label: n.data.label,
          status: "idle",
          message: `trigger: POST ${window.location.origin}/api/flows/hooks/${encodeURIComponent(hookToken(started.runId!, n.id))}`,
        }));
      setLogs([
        {
          nodeId: "-",
          label: "Durable run",
          status: "running",
          message: `${started.runId} · inspect with npx workflow web`,
        },
        ...hookLogs,
      ]);

      const deadline = Date.now() + POLL_LIMIT_MS;
      while (Date.now() < deadline) {
        await sleep(1000);
        const poll = await fetch(`/api/flows/runs/${encodeURIComponent(started.runId)}`);
        const s = (await poll.json()) as {
          status?: string;
          result?: FlowRunResult;
          error?: string;
        };
        if (s.status === "completed" && s.result) {
          const { logs: runLogs, outputs } = s.result;
          for (const l of runLogs) {
            if (l.status !== "skipped")
              patch(l.nodeId, {
                status: l.status,
                result: l.status === "error" ? { error: l.message } : outputs[l.nodeId],
              });
          }
          setLogs((x) => [
            ...x,
            ...runLogs.map((l) => ({
              nodeId: l.nodeId,
              label: l.label,
              status: l.status === "skipped" ? ("idle" as const) : l.status,
              message: l.message,
              ...(l.ms !== undefined ? { ms: l.ms } : {}),
            })),
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

  /** Put an opened/exported flow on the canvas. Keys stay as they are (exports never contain them). */
  const loadFlow = useCallback(
    (f: OpenedFlow) => {
      setNodes(f.nodes);
      setEdges(f.edges);
      setName(f.name);
      if (f.url) setConn((c) => ({ ...c, url: f.url }));
      setSelId(null);
      setLogs([]);
      setTimeout(() => rf?.fitView({ padding: 0.2 }), 50);
    },
    [setNodes, setEdges, rf],
  );

  const openFile = async () => {
    try {
      const f = await pickFlowFile();
      if (f) loadFlow(f);
    } catch (e) {
      setLogs([{ nodeId: "-", label: "Open", status: "error", message: (e as Error).message }]);
    }
  };

  const saveScript = (flowName: string, flowNodes: Node<WFNodeData>[], flowEdges: Edge[]) => {
    const source = buildWorkflowScript(flowNodes, flowEdges, conn, flowName);
    const fileName = exportFileName(flowName);
    // Inside KOMA Home the file goes to the app (it becomes a door); in a browser it downloads.
    if (embedded) postToHost({ type: "koma-flow:save", name: flowName, fileName, source });
    else downloadWorkflowScript(source, fileName);
  };

  const exportScript = () => {
    const flowName = name.trim().replace(/\s+/g, " ") || "workflow";
    saveScript(flowName, nodes, edges);
  };

  const exportNode = (id: string) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) return;
    const flowName = node.data.label.trim().replace(/\s+/g, " ") || node.data.kind;
    saveScript(flowName, [node], []);
  };

  const deleteNode = (id: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelId((cur) => (cur === id ? null : cur));
  };

  const duplicateNode = (id: string) => {
    const src = nodes.find((n) => n.id === id);
    if (!src) return;
    const copy: Node<WFNodeData> = {
      ...src,
      id: nid(src.data.kind),
      position: { x: src.position.x + 48, y: src.position.y + 48 },
      selected: false,
      data: {
        ...src.data,
        config: structuredClone(src.data.config),
        status: undefined,
        result: undefined,
      },
    };
    setNodes((ns) => [...ns, copy]);
    setSelId(copy.id);
  };

  const autoLayout = () => {
    setNodes((ns) => arrange(ns, edges));
    setTimeout(() => rf?.fitView({ padding: 0.2 }), 50);
  };

  const openMenu = (e: { preventDefault: () => void; clientX: number; clientY: number }, nodeId: string | null) => {
    e.preventDefault();
    const x = Math.min(e.clientX, window.innerWidth - 196);
    const y = Math.min(e.clientY, window.innerHeight - (nodeId ? 140 : 96));
    setMenu({ x, y, nodeId });
    if (nodeId) setSelId(nodeId);
  };

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onPointer = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as globalThis.Node)) return;
      setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [menu]);

  // KOMA Home: load the flow it sends, send the flow back when asked. Refs keep the handlers current.
  const exportRef = useRef(exportScript);
  exportRef.current = exportScript;
  const loadRef = useRef(loadFlow);
  loadRef.current = loadFlow;
  useEffect(() => {
    if (!embedded || !loaded) return;
    const off = onHostMessage((m) => {
      if (m.type === "koma-flow:request-save") return exportRef.current();
      try {
        const f = parseFlowFile(m.source, m.name ?? "");
        loadRef.current(m.name ? { ...f, name: f.name || m.name } : f);
      } catch (e) {
        setLogs([{ nodeId: "-", label: "Open", status: "error", message: (e as Error).message }]);
      }
    });
    postToHost({ type: "koma-flow:ready" });
    return off;
  }, [embedded, loaded]);

  const reset = () => {
    const { n, e } = seed();
    setNodes(n);
    setEdges(e);
    setSelId(null);
    setLogs([]);
  };

  return (
    <div
      className="wf-shell"
      data-palette={paletteOpen ? "open" : "closed"}
      data-inspector={inspectorOpen ? "open" : "closed"}
    >
      <header className="wf-top site-header">
        <div className="flex flex-row gap-1 flex-1 bg-transparent">
          {/* <img src="/icon.png" alt="KOMA" className="wf-logo w-6 h-6" /> */}
          <span className="koma-mark koma-mark--inline " aria-label="KOMA">
            <span aria-hidden="true">
              KO<i className="comma " aria-hidden="true"></i>MA
            </span>
          </span>
          <h2 className="text-xl tracking-wide text-accent">flow</h2>
        </div>
        <div className="flex flex-row gap-1">
          <input
            className="wf-input wf-conn"
            aria-label="Flow name"
            placeholder="Flow name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="wf-input wf-conn"
            placeholder="Project URL"
            value={conn.url}
            onChange={(e) => setConn({ ...conn, url: e.target.value.trim() })}
          />
          <input
            className="wf-input wf-conn"
            type="password"
            placeholder="ANON_KEY / PUBLISHABLE_KEY"
            value={conn.anonKey}
            onChange={(e) => setConn({ ...conn, anonKey: e.target.value.trim() })}
          />
          <div className="flex-1" />
          <button className="wf-btn-ghost" onClick={reset}>
            Reset
          </button>
          <button
            className="wf-btn-ghost"
            onClick={openFile}
            title="Open an exported flow (.mjs) to edit it"
          >
            Open…
          </button>
          <button
            className="wf-btn-ghost"
            onClick={exportScript}
            title={
              embedded
                ? "Save this flow to KOMA Home as a runnable door"
                : "Download a standalone Node/Bun script named after the flow (keys read from env). Reopen it with Open…"
            }
          >
            {embedded ? "⤓ Save to KOMA Home" : "⤓ Export"}
          </button>
          <button
            className="wf-btn-ghost"
            onClick={runDurable}
            disabled={running}
            title="Run on the server with Workflow SDK: each node is a durable, retried step"
          >
            ⟳ Durable run
          </button>
          <button className="wf-btn" onClick={run} disabled={running}>
            {running ? "Running…" : "▶ Run"}
          </button>
        </div>
      </header>

      <aside className="wf-palette" data-open={paletteOpen ? "true" : "false"} aria-label="Nodes">
        <div className="wf-aside-bar">
          {paletteOpen && <div className="wf-section">Nodes</div>}
          <CollapseButton
            open={paletteOpen}
            side="left"
            label="nodes"
            onClick={() => setPaletteOpen((open) => !open)}
          />
        </div>
        {!paletteOpen && <span className="wf-aside-label">Nodes</span>}
        {paletteOpen && (Object.keys(NODE_META) as NodeKind[]).map((k) => {
          const Icon = NODE_META[k].icon;
          return (
            <Button
              key={k}
              variant="ghost"
              className="wf-pal-item"
              data-kind={k}
              draggable
              onDragStart={(e) => e.dataTransfer.setData("application/wf", k)}
              onClick={() => addNode(k)}
            >
              {Icon ? <Icon size={16} /> : <span className="wf-dot" />}
              <span>{NODE_META[k].title}</span>
              <code>{NODE_META[k].sdk}</code>
            </Button>
          );
        })}
        {paletteOpen && (
          <p className="wf-help">
            Drag onto the canvas. Use <code>{"{{prev.field}}"}</code> or{" "}
            <code>{"{{nodeId.field}}"}</code> in any field.
          </p>
        )}
      </aside>

      <main
        className="wf-canvas"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const k = e.dataTransfer.getData("application/wf") as NodeKind;
          if (k && rf) addNode(k, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onInit={setRf}
          onNodeClick={(_, n) => {
            setSelId(n.id);
            setInspectorOpen(true);
          }}
          onPaneContextMenu={(e) => openMenu(e, null)}
          onNodeContextMenu={(e, n) => openMenu(e, n.id)}
          onPaneClick={() => setSelId(null)}
          fitView
          colorMode="dark"
          deleteKeyCode={["Backspace", "Delete"]}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        </ReactFlow>
      </main>

      <aside className="wf-inspector" data-open={inspectorOpen ? "true" : "false"} aria-label="Inspector">
        <div className="wf-aside-bar">
          <CollapseButton
            open={inspectorOpen}
            side="right"
            label="inspector"
            onClick={() => setInspectorOpen((open) => !open)}
          />
          {inspectorOpen && <div className="wf-section">Inspector</div>}
        </div>
        {!inspectorOpen && <span className="wf-aside-label">Inspector</span>}
        {inspectorOpen && sel ? (
          <>
            <div className="wf-section">
              {NODE_META[sel.data.kind].title} <span className="wf-id">#{sel.id}</span>
            </div>
            <p className="wf-help">{NODE_META[sel.data.kind].hint}</p>
            <label className="wf-label">Label</label>
            <input
              className="wf-input"
              value={sel.data.label}
              onChange={(e) => patch(sel.id, { label: e.target.value })}
            />
            {(FIELDS[sel.data.kind] as readonly AnyFieldSpec[]).map((f) => {
              const config = sel.data.config as Record<string, string | undefined> | undefined;
              const v = config?.[f.key] ?? "";
              const set = (val: string) => setConfigField(sel.id, f.key, val);
              return (
                <div key={f.key}>
                  <label className="wf-label">{f.label}</label>
                  {f.type === "area" ? (
                    <textarea
                      className="wf-input wf-area"
                      value={v}
                      onChange={(e) => set(e.target.value)}
                      spellCheck={false}
                    />
                  ) : f.type === "select" ? (
                    <select className="wf-input" value={v} onChange={(e) => set(e.target.value)}>
                      {f.options!.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="wf-input"
                      type={f.type === "password" ? "password" : "text"}
                      value={v}
                      onChange={(e) => set(e.target.value)}
                    />
                  )}
                </div>
              );
            })}
            {sel.data.kind === "condition" && (
              <ConditionRules
                rules={sel.data.config.rules}
                onChange={(rules, removedId) => {
                  setNodes((ns) =>
                    ns.map((n) =>
                      n.id === sel.id && n.data.kind === "condition"
                        ? { ...n, data: { ...n.data, config: { ...n.data.config, rules } } }
                        : n,
                    ),
                  );
                  if (removedId)
                    setEdges((es) =>
                      es.filter((e) => !(e.source === sel.id && e.sourceHandle === removedId)),
                    );
                }}
              />
            )}
            {sel.data.kind === "http" && (
              <p className="wf-help">
                In the browser the target must allow CORS; the exported script and durable runs have
                no such limit.
              </p>
            )}
            {sel.data.kind === "hook" && (
              <p className="wf-help">
                Canvas run: a Trigger button appears in the log. Exported script: listens on
                127.0.0.1 for a request to /hook/{sel.id}. Durable run: POST to the trigger URL
                shown in the log. The request body becomes the output; on timeout the timeout branch
                fires.
              </p>
            )}
            {sel.data.kind === "auth" && sel.data.config.role === "service_role" && (
              <p className="wf-warn">
                Service role bypasses RLS. Key stays in this browser only — never use it on shared
                machines.
              </p>
            )}
            {sel.data.result !== undefined && (
              <>
                <label className="wf-label">Last result</label>
                <pre className="wf-pre">{JSON.stringify(sel.data.result, null, 2)}</pre>
              </>
            )}
            <button className="wf-btn-danger" onClick={() => deleteNode(sel.id)}>
              Delete node
            </button>
          </>
        ) : (
          inspectorOpen && <div className="wf-help">Select a node to configure it.</div>
        )}
      </aside>

      <footer className="wf-log">
        <div className="wf-section">Run log</div>
        {hookWait && (
          <div className="wf-hookwait" role="status">
            <div className="wf-log-row" data-status="running">
              <span className="wf-dot" />
              <b>{hookWait.label}</b>
              <span className="wf-msg">
                waiting for a trigger · times out in{" "}
                {Math.max(0, Math.ceil((hookWait.deadline - now) / 1000))}s
              </span>
            </div>
            <textarea
              className="wf-input wf-area"
              aria-label="Trigger payload (JSON)"
              value={hookPayload}
              onChange={(e) => setHookPayload(e.target.value)}
              spellCheck={false}
            />
            <div className="flex flex-row gap-1">
              <button className="wf-btn" onClick={triggerHook}>
                Trigger
              </button>
              <button
                className="wf-btn-ghost"
                onClick={() => hookFinish.current?.({ timedOut: true })}
              >
                Time out now
              </button>
            </div>
          </div>
        )}
        {logs.length === 0 && <div className="wf-help">No runs yet.</div>}
        {logs.map((l, i) => (
          <div
            key={i}
            className="wf-log-row"
            data-status={l.status}
            onClick={() => l.nodeId !== "-" && setSelId(l.nodeId)}
          >
            <span className="wf-dot" />
            <b>{l.label}</b>
            {l.ms !== undefined && <span className="wf-ms">{l.ms}ms</span>}
            <span className="wf-msg">{l.message}</span>
          </div>
        ))}
      </footer>
      {menu && (
        <div
          ref={menuRef}
          className="wf-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {menu.nodeId ? (
            <>
              <button type="button" role="menuitem" onClick={() => { duplicateNode(menu.nodeId!); setMenu(null); }}>
                Duplicate
              </button>
              <button type="button" role="menuitem" onClick={() => { exportNode(menu.nodeId!); setMenu(null); }}>
                Export node
              </button>
              <button type="button" role="menuitem" data-danger onClick={() => { deleteNode(menu.nodeId!); setMenu(null); }}>
                Delete
              </button>
            </>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => { autoLayout(); setMenu(null); }}>
                Auto layout
              </button>
              <button type="button" role="menuitem" onClick={() => { exportScript(); setMenu(null); }}>
                Export
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
