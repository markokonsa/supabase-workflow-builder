import type { ElementType } from "react";
import { Database, Search, Server, User, Webhook } from "lucide-react";

/** Persisted node ids — keep stable, saved workflows and CSS `data-kind` selectors use them. */
export type NodeKind = "start" | "auth" | "edge" | "rpc" | "query" | "transform" | "output";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AuthRole = "anon" | "authenticated" | "service_role";
export type QueryOp = "select" | "insert" | "update" | "delete";

// ---------------------------------------------------------------------------
// Per-node configs. Values that are JSON or templated (`{{prev.x}}`) stay strings.
// ---------------------------------------------------------------------------

/** Webhook / entrypoint ("start"). */
export interface WebhookConfig {
  method?: HttpMethod;
  body?: string;
  headers?: string;
  /** JSON emitted by the node when no input is passed in. */
  payload?: string;
}

/** Role switch for downstream nodes ("auth"). */
export interface AuthConfig {
  role: AuthRole;
  email?: string;
  password?: string;
  serviceKey?: string;
}

/** supabase.functions.invoke ("edge"). */
export interface EdgeFunctionConfig {
  name: string;
  method: HttpMethod;
  body?: string;
  headers?: string;
}

/** supabase.rpc ("rpc"). */
export interface DbFunctionConfig {
  schema?: string;
  fn: string;
  args?: string;
}

/** supabase.from(table) ("query"). */
export interface DatabaseConfig {
  schema?: string;
  table: string;
  op: QueryOp;
  columns?: string;
  /** One filter per line: `col op value`. */
  filters?: string;
  /** JSON for insert/update. */
  values?: string;
  limit?: string;
}

/** JS function body with `prev` and `ctx` in scope ("transform"). */
export interface ScriptConfig {
  code: string;
}

/** "output" has no settings. */
export type ResultConfig = Record<string, never>;

export interface NodeConfigMap {
  start: WebhookConfig;
  auth: AuthConfig;
  edge: EdgeFunctionConfig;
  rpc: DbFunctionConfig;
  query: DatabaseConfig;
  transform: ScriptConfig;
  output: ResultConfig;
}

/** Readable names for the node kinds, usable anywhere a kind is: NodeConfig<"database">. */
export interface NodeKindAlias {
  webhook: "start";
  function: "rpc";
  database: "query";
  script: "transform";
  result: "output";
}

export type NodeConfigKey = NodeKind | keyof NodeKindAlias;
export type ResolveKind<K extends NodeConfigKey> = K extends keyof NodeKindAlias ? NodeKindAlias[K] : K;

/**
 * Config for one node kind, e.g. `NodeConfig<"database">`, `NodeConfig<"auth">`,
 * `NodeConfig<"webhook">`. Without a parameter it is the union of all configs.
 */
export type NodeConfig<K extends NodeConfigKey = NodeKind> = NodeConfigMap[ResolveKind<K>];

export type NodeStatus = "idle" | "running" | "success" | "error";

export interface WFNodeDataBase {
  label: string;
  status?: NodeStatus;
  result?: unknown;
  [key: string]: unknown;
}

/** Node data for one kind: `kind` and `config` always match. */
export type WFNodeDataOf<K extends NodeKind> = WFNodeDataBase & { kind: K; config: NodeConfig<K> };

/** Discriminated union: checking `data.kind` narrows `data.config`. */
export type WFNodeData = { [K in NodeKind]: WFNodeDataOf<K> }[NodeKind];

export interface Connection {
  url: string;
  anonKey: string;
}

export interface NodeMeta<K extends NodeKind> {
  icon?: ElementType;
  title: string;
  sdk: string;
  schema?: string;
  defaults: NodeConfig<K>;
  hint: string;
}

export const NODE_META: { [K in NodeKind]: NodeMeta<K> } = {
  start: {
    icon: Webhook,
    title: "Webhook",
    sdk: "http",
    defaults: {
      method: "POST",
      body: JSON.stringify({ name: "Entrypoint Trigger" }),
      headers: JSON.stringify({ "Content-Type": "application/json" }),
    },
    hint: "Receive HTTP requests",
  },
  auth: {
    icon: User,
    title: "Role / Auth",
    sdk: "supabase.auth",
    defaults: { role: "anon", email: "", password: "", serviceKey: "" },
    hint: "Switch the client role for downstream nodes",
  },
  edge: {
    icon: Server,
    title: "Edge Function",
    sdk: "JS",
    defaults: { name: "hello-world", method: "POST", body: '{ "name": "{{prev.name}}" }', headers: "{}" },
    hint: "supabase.functions.invoke(name, { body })",
  },
  rpc: {
    icon: Database,
    title: "DB: Function",
    sdk: "pg",
    defaults: { schema: "public", fn: "my_function", args: "{}" },
    hint: "supabase.rpc(fn, args)",
  },
  query: {
    icon: Search,
    title: "DB: Query",
    sdk: "SQL",
    defaults: { schema: "public", table: "profiles", op: "select", columns: "*", filters: "", values: "{}", limit: "10" },
    hint: "select.filter",
  },
  transform: {
    title: "Script",
    sdk: "js",
    defaults: { code: "return { ...prev, at: Date.now() };" },
    hint: "JS body. Access `prev` and `ctx` (all node outputs by id)",
  },
  output: { title: "Result", sdk: "=", defaults: {}, hint: "Collects the final value" },
};
