import type { ElementType } from "react";
import { Code, Database, FileOutput, Globe, Hourglass, Search, Server, Split, User, Webhook } from "lucide-react";

/** Persisted node ids — keep stable, saved workflows and CSS `data-kind` selectors use them. */
export type NodeKind =
  | "start"
  | "auth"
  | "edge"
  | "rpc"
  | "query"
  | "transform"
  | "condition"
  | "http"
  | "hook"
  | "output";

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

export type ConditionOp =
  | "=="
  | "!="
  | ">"
  | ">="
  | "<"
  | "<="
  | "contains"
  | "not_contains"
  | "matches"
  | "exists"
  | "empty";

/** One branch of a condition node. `id` is also the id of its output handle. */
export interface ConditionRule {
  id: string;
  label: string;
  /** Templated value, e.g. `{{prev.status}}`. */
  left: string;
  op: ConditionOp;
  /** Templated value to compare with; unused by `exists` / `empty`. */
  right?: string;
}

/** 1 input, one output per rule plus `else` ("condition"). */
export interface ConditionConfig {
  /** `first`: only the first matching rule fires; `all`: every matching rule fires. */
  mode: "first" | "all";
  rules: ConditionRule[];
}

/** fetch() ("http"). */
export interface HttpConfig {
  method: HttpMethod;
  url: string;
  headers?: string;
  /** JSON (sent as application/json) or plain text; ignored for GET. */
  body?: string;
  /** `fail`: non-2xx is an error; `continue`: non-2xx is returned as output. */
  onError?: "fail" | "continue";
}

/** Waits for a trigger or times out ("hook"). Outputs: `event`, `timeout`. */
export interface HookConfig {
  /** 30s, 5m, 1h, 2d or milliseconds. */
  timeout: string;
  /** Exported script only: local port to listen on (empty = any free port). */
  port?: string;
}

/** Output handle ids of the branching nodes. */
export const ELSE_HANDLE = "else";
export const HOOK_EVENT = "event";
export const HOOK_TIMEOUT = "timeout";

export const CONDITION_OPS: { op: ConditionOp; label: string; unary?: boolean }[] = [
  { op: "==", label: "equals" },
  { op: "!=", label: "not equals" },
  { op: ">", label: ">" },
  { op: ">=", label: "≥" },
  { op: "<", label: "<" },
  { op: "<=", label: "≤" },
  { op: "contains", label: "contains" },
  { op: "not_contains", label: "doesn't contain" },
  { op: "matches", label: "matches regex" },
  { op: "exists", label: "exists", unary: true },
  { op: "empty", label: "is empty", unary: true },
];

/** "output" has no settings. */
export type ResultConfig = Record<string, never>;

export interface NodeConfigMap {
  start: WebhookConfig;
  auth: AuthConfig;
  edge: EdgeFunctionConfig;
  rpc: DbFunctionConfig;
  query: DatabaseConfig;
  transform: ScriptConfig;
  condition: ConditionConfig;
  http: HttpConfig;
  hook: HookConfig;
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
export type ResolveKind<K extends NodeConfigKey> = K extends keyof NodeKindAlias
  ? NodeKindAlias[K]
  : K;

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
    icon: Code,
    title: "Script",
    sdk: "js",
    defaults: { code: "return { ...prev, at: Date.now() };" },
    hint: "JS body. Access `prev` and `ctx` (all node outputs by id)",
  },
  condition: {
    icon: Split,
    title: "Condition",
    sdk: "if",
    defaults: {
      mode: "first",
      rules: [{ id: "r1", label: "match", left: "{{prev.status}}", op: "==", right: "" }],
    },
    hint: "Branch on a comparison. Unmatched values take the else output",
  },
  http: {
    icon: Globe,
    title: "HTTP",
    sdk: "fetch",
    defaults: { method: "GET", url: "https://", headers: "{}", body: "", onError: "fail" },
    hint: "Call any URL. The response body is the output",
  },
  hook: {
    icon: Hourglass,
    title: "Wait",
    sdk: "hook",
    defaults: { timeout: "5m", port: "" },
    hint: "Pause until something triggers this node, or the timeout fires",
  },
  output: {
    icon: FileOutput,
    title: "Result",
    sdk: "=",
    defaults: {},
    hint: "Collects the final value",
  },
};
