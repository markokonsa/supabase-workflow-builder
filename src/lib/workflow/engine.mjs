// Workflow engine — plain JavaScript on purpose.
// The browser app imports it (types live in engine.d.ts), the exporter embeds this
// exact source into the standalone CLI script (via the virtual:workflow-engine-source
// module from engine-source.plugin.ts), and the durable steps in src/workflows/steps.ts
// call executeNode() — so the canvas, the exported script and Workflow SDK runs all
// share the same node logic.
// Keep it dependency-free apart from @supabase/supabase-js, and never read
// process/window globals here: callers pass everything in.
import { createClient } from "@supabase/supabase-js";

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Error that should not be retried (bad config, 4xx responses). */
function fatal(message, status) {
  const e = new Error(message);
  e.fatal = true;
  if (status !== undefined) e.status = status;
  return e;
}

/** True when retrying cannot help: config errors and 4xx responses. */
export function isFatalError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.fatal) return true;
  const status = Number(err.status ?? err.statusCode);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** Replace {{prev.x}} / {{nodeId.x}} tokens with values from scope. */
export function template(input, scope) {
  return String(input ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, p) => {
    const v = getPath(scope, p);
    return typeof v === "string" ? v : JSON.stringify(v ?? null);
  });
}

export function parseJson(src, scope, field) {
  const s = template(src || "{}", scope).trim();
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    throw fatal(`Invalid JSON in ${field}: ${s.slice(0, 80)}`);
  }
}

/** "30s" / "5m" / "1h" / "2d" / "250ms" / plain milliseconds → ms. Mirrors parseDuration() in graph.ts. */
export function parseDuration(value, fallbackMs = 5 * 60_000) {
  if (value === undefined || value === null || value === "") return fallbackMs;
  if (typeof value === "number") return value;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(String(value).trim());
  if (!m) throw fatal(`Invalid duration "${value}" (use e.g. 30s, 5m, 1h)`);
  const unit = (m[2] || "ms").toLowerCase();
  return Math.round(Number(m[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]);
}

/**
 * Whether an edge carries a value: its source produced output and, for branching nodes
 * (condition, hook), the edge leaves from a branch that fired. Mirrors edgeActive() in graph.ts.
 */
export function edgeActive(e, ctx, branches) {
  if (ctx[e.source] === undefined) return false;
  const fired = branches[e.source];
  return !e.sourceHandle || !fired || fired.includes(e.sourceHandle);
}

const asNumber = (s) => (s.trim() !== "" && !Number.isNaN(Number(s)) ? Number(s) : null);

/** Evaluate one condition rule. Both sides are templated to strings first. */
export function evaluateRule(rule, scope) {
  const left = template(rule.left, scope);
  const right = template(rule.right ?? "", scope);
  const a = asNumber(left);
  const b = asNumber(right);
  const both = a !== null && b !== null;
  switch (rule.op) {
    case "==":
      return both ? a === b : left === right;
    case "!=":
      return both ? a !== b : left !== right;
    case ">":
      return both ? a > b : left > right;
    case ">=":
      return both ? a >= b : left >= right;
    case "<":
      return both ? a < b : left < right;
    case "<=":
      return both ? a <= b : left <= right;
    case "contains":
      return left.includes(right);
    case "not_contains":
      return !left.includes(right);
    case "matches":
      try {
        return new RegExp(right).test(left);
      } catch {
        throw fatal(`Invalid regex in condition "${rule.label || rule.id}": ${right}`);
      }
    case "exists":
      return left !== "" && left !== "null";
    case "empty":
      return ["", "null", "[]", "{}", '""'].includes(left.trim());
    default:
      throw fatal(`Unknown condition operator: ${rule.op}`);
  }
}

/** Node kinds that talk to Supabase and need a client. */
export const NEEDS_CLIENT = new Set(["edge", "rpc", "query"]);

export function topo(nodes, edges) {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  edges.forEach((e) => indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1));
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    edges
      .filter((e) => e.source === id)
      .forEach((e) => {
        indeg.set(e.target, indeg.get(e.target) - 1);
        if (indeg.get(e.target) === 0) q.push(e.target);
      });
  }
  if (order.length !== nodes.length) throw fatal("Workflow contains a cycle");
  return order;
}

const mkClient = (url, key) =>
  createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

/**
 * Build a Supabase client for an auth state.
 * auth: { role, email?, password?, serviceKey? } — password/serviceKey fall back to conn.
 * Returns { client, info } where info is safe to log/persist (no secrets).
 */
export async function clientForAuth(auth, conn) {
  if (!conn.url || !conn.anonKey) throw fatal("Set your project URL and anon key first");
  const role = auth?.role ?? "anon";
  if (role === "service_role") {
    const key = auth.serviceKey || conn.serviceKey;
    if (!key) throw fatal("Service role key required");
    return { client: mkClient(conn.url, key), info: { role } };
  }
  if (role === "authenticated") {
    const client = mkClient(conn.url, conn.anonKey);
    const { data, error } = await client.auth.signInWithPassword({
      email: auth.email || "",
      password: auth.password || conn.password || "",
    });
    if (error) throw error;
    return { client, info: { role, user_id: data.user?.id, email: data.user?.email } };
  }
  return { client: mkClient(conn.url, conn.anonKey), info: { role: "anon" } };
}

/**
 * Execute one node.
 * env: { client, conn, prev, ctx, input?, nodeId?, waitForHook? }
 * Returns { out }; auth nodes add { auth, client } (the new auth state for downstream nodes);
 * branching nodes add { branches } (the output handles that fired) and { note } for the log.
 */
export async function executeNode(data, env) {
  const c = data.config || {};
  const { prev, ctx } = env;
  const scope = { ...ctx, prev, ctx };
  switch (data.kind) {
    case "start":
      return { out: env.input !== undefined ? env.input : parseJson(c.payload, scope, "payload") };
    case "auth": {
      const auth = {
        role: c.role || "anon",
        email: template(c.email, scope),
        password: c.password,
        serviceKey: c.serviceKey,
      };
      const { client, info } = await clientForAuth(auth, env.conn);
      return { out: { ...prev, _auth: info }, auth, client };
    }
    case "edge": {
      const { data: out, error } = await env.client.functions.invoke(template(c.name, scope), {
        method: c.method || "POST",
        body: c.method === "GET" ? undefined : parseJson(c.body, scope, "body"),
        headers: parseJson(c.headers, scope, "headers"),
      });
      if (error) {
        let detail = error.message;
        try {
          detail += " — " + (await error.context?.text());
        } catch {
          /* no body */
        }
        const e = new Error(detail);
        e.status = error.context?.status;
        throw e;
      }
      return { out };
    }
    case "rpc": {
      const db = c.schema ? env.client.schema(c.schema) : env.client;
      const { data: out, error } = await db.rpc(template(c.fn, scope), parseJson(c.args, scope, "args"));
      if (error) throw error;
      return { out };
    }
    case "query": {
      const table = template(c.table, scope);
      const filters = template(c.filters || "", scope)
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [col, op, ...rest] = l.split(/\s+/);
          return { col, op, val: rest.join(" ") };
        });
      const db = c.schema ? env.client.schema(c.schema) : env.client;
      let b = db.from(table);
      if (c.op === "insert") b = b.insert(parseJson(c.values, scope, "values")).select();
      else if (c.op === "update") b = b.update(parseJson(c.values, scope, "values"));
      else if (c.op === "delete") b = b.delete();
      else b = b.select(c.columns || "*");
      for (const f of filters) b = b.filter(f.col, f.op, f.val);
      if (c.op === "update" || c.op === "delete") b = b.select();
      if (c.op === "select" && c.limit) b = b.limit(Number(c.limit));
      const { data: out, error } = await b;
      if (error) throw error;
      return { out };
    }
    case "transform": {
      const fn = new Function("prev", "ctx", c.code);
      return { out: await fn(prev, ctx) };
    }
    case "condition": {
      const rules = Array.isArray(c.rules) ? c.rules : [];
      const matched = [];
      for (const rule of rules) {
        if (!evaluateRule(rule, scope)) continue;
        matched.push(rule.id);
        if (c.mode !== "all") break;
      }
      const branches = matched.length ? matched : ["else"];
      const names = branches.map((id) => (id === "else" ? "else" : rules.find((r) => r.id === id)?.label || id));
      return { out: prev, branches, note: `→ ${names.join(", ")}` };
    }
    case "http": {
      const url = template(c.url, scope).trim();
      if (!url) throw fatal("URL is required");
      const method = c.method || "GET";
      const headers = { ...parseJson(c.headers, scope, "headers") };
      let body;
      if (method !== "GET" && c.body && c.body.trim()) {
        body = template(c.body, scope);
        const hasType = Object.keys(headers).some((h) => h.toLowerCase() === "content-type");
        if (!hasType) {
          try {
            JSON.parse(body);
            headers["Content-Type"] = "application/json";
          } catch {
            headers["Content-Type"] = "text/plain";
          }
        }
      }
      const res = await fetch(url, { method, headers, body });
      const text = await res.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON: keep the text */
      }
      const out = { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), body: parsed };
      if (!res.ok && c.onError !== "continue") {
        const e = new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
        e.status = res.status;
        throw e;
      }
      return { out, note: `${method} ${res.status}` };
    }
    case "hook": {
      if (!env.waitForHook) throw fatal("This runner can't wait for hooks");
      const timeoutMs = parseDuration(c.timeout);
      const r = await env.waitForHook({ nodeId: env.nodeId ?? "", label: data.label, timeoutMs, port: c.port || "" });
      if (r.timedOut) return { out: { timedOut: true, prev }, branches: ["timeout"], note: `timed out after ${c.timeout || "5m"}` };
      return { out: r.payload ?? null, branches: ["event"], note: "triggered" };
    }
    case "output":
      return { out: prev };
    default:
      throw fatal(`Unknown node kind: ${data.kind}`);
  }
}

export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err?.message ?? err);
}

/**
 * Run a whole graph in-process (browser canvas and exported CLI).
 * conn: { url, anonKey, serviceKey?, password? } — serviceKey/password are fallbacks
 *   used when an auth node leaves those fields empty (the exported CLI fills them from env).
 * opts.input: when defined, Start nodes emit this value instead of their configured payload.
 * opts.waitForHook({ nodeId, label, timeoutMs, port }) → { payload } | { timedOut: true }:
 *   how this runner receives hook triggers (a button in the canvas, a local HTTP server in the CLI).
 */
export async function runWorkflow(nodes, edges, conn, onStatus, log, opts = {}) {
  // Created on first use, so flows without Supabase nodes need no keys.
  let client;
  const ctx = {};
  const branches = {};
  const order = topo(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  for (const id of order) {
    const d = byId.get(id).data;
    const incoming = edges.filter((e) => e.target === id);
    const live = incoming.filter((e) => edgeActive(e, ctx, branches));
    if (incoming.length && !live.length) {
      log({ nodeId: id, label: d.label, status: "idle", message: "skipped (branch not taken or upstream failed)" });
      continue;
    }
    const prev = live.length ? ctx[live[0].source] : undefined;
    onStatus(id, "running");
    const t0 = performance.now();
    try {
      if (!client && NEEDS_CLIENT.has(d.kind)) client = (await clientForAuth({ role: "anon" }, conn)).client;
      const r = await executeNode(d, { client, conn, prev, ctx, input: opts.input, nodeId: id, waitForHook: opts.waitForHook });
      if (r.client) client = r.client;
      if (r.branches) branches[id] = r.branches;
      ctx[id] = r.out ?? null;
      const ms = Math.round(performance.now() - t0);
      onStatus(id, "success", r.out);
      const json = JSON.stringify(r.out)?.slice(0, 300) ?? "null";
      log({ nodeId: id, label: d.label, status: "success", message: r.note ? `${r.note} · ${json}` : json, ms });
    } catch (err) {
      const message = errorMessage(err);
      onStatus(id, "error", { error: message });
      log({ nodeId: id, label: d.label, status: "error", message, ms: Math.round(performance.now() - t0) });
    }
  }
  return ctx;
}
